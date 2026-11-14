/**
 * Per-finding bookkeeping for the worker <-> reviewer revise loop. (AGT-4535)
 *
 * Reviewer revise feedback used to travel as one free-text block. The worker
 * could not answer a point, only re-run, and repetition was caught only by
 * text similarity (`similarReviewFeedback`). This ledger gives every reviewer
 * finding an id, lets the worker answer each id with `fixed` or `disputed`
 * plus evidence, and lets the reviewer rule on each id on the next pass.
 *
 * Rules, all fail-closed:
 *  - Ids come from the pipeline, never from the model. The reviewer rewords a
 *    finding from round to round, so neither model-assigned labels nor a text
 *    hash would stay stable. An issue the reviewer raises without a known id
 *    tag gets a fresh id that is never reused.
 *  - A worker `fixed`/`disputed` does not close anything. Only the reviewer
 *    closes an id (an explicit `resolved` ruling, or an approve).
 *  - An open id the worker does not answer, or answers without evidence, is
 *    recorded as `missing` — unresolved.
 *  - An open id the reviewer does not rule on during a revise stays open and
 *    counts as another round.
 *  - The same id disputed by the worker and kept open by the reviewer on
 *    consecutive rounds is a deadlock; an id open for too many reviewer rounds
 *    hits the round cap. Both end the loop as a stop, never as an approval.
 *
 * Recording is idempotent per round, so replaying a round after a restart
 * leaves the ledger unchanged.
 *
 * Pure module: no I/O, no clock. The iteration loop owns the wiring.
 */

export type FindingStatus = 'open' | 'resolved';
export type WorkerResponseKind = 'fixed' | 'disputed' | 'missing';
export type ReviewerRuling = 'resolved' | 'open';

export interface WorkerResponse {
  kind: WorkerResponseKind;
  /** Evidence the worker cited (file:line, test name, command output). Empty for `missing`. */
  evidence: string;
  /** Iteration whose worker produced this response. */
  round: number;
}

export interface Finding {
  /** Pipeline-assigned, stable for the whole run: `F1`, `F2`, ... */
  id: string;
  /** The reviewer's wording when the finding was first raised. */
  text: string;
  status: FindingStatus;
  /** Iteration whose review raised it. */
  raisedRound: number;
  /** Reviewer rounds that left this finding open (including the one that raised it). */
  openRounds: number;
  /** Consecutive reviewer rounds that kept it open right after a worker `disputed`. */
  disputeStreak: number;
  lastWorkerResponse?: WorkerResponse;
  /** The reviewer's text for this id on its latest round, when it re-raised it. */
  lastReviewerNote?: string;
  resolvedRound?: number;
}

export interface FindingLedger {
  nextSeq: number;
  findings: Finding[];
  /** Review rounds already applied; a replay of one of these is a no-op. */
  reviewRounds: number[];
  /** Worker rounds already applied; a replay of one of these is a no-op. */
  workerRounds: number[];
}

export interface ReviewRoundInput {
  round: number;
  decision: 'approve' | 'revise' | 'reject';
  issues?: string[];
  feedback?: string;
}

export type LedgerVerdict =
  | { kind: 'continue' }
  | { kind: 'deadlock'; ids: string[]; reason: string }
  | { kind: 'round_cap'; ids: string[]; reason: string };

/** Default reviewer rounds an id may stay open before the loop stops. */
export const DEFAULT_MAX_FINDING_ROUNDS = 3;
/** Consecutive dispute-and-keep-open rounds that count as a deadlock. */
export const DEADLOCK_STREAK = 2;

const MAX_TEXT = 2000;

export function createFindingLedger(): FindingLedger {
  return { nextSeq: 1, findings: [], reviewRounds: [], workerRounds: [] };
}

export function openFindings(ledger: FindingLedger | undefined): Finding[] {
  return ledger ? ledger.findings.filter((f) => f.status === 'open') : [];
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT)}…` : trimmed;
}

const ID_TAG = /^\s*(?:[-*]\s*)?\[?\b(F\d{1,4})\b\]?\s*(?:[:\-—–]\s*)?/i;

/** Split a reviewer issue line into its leading id tag (if any) and the rest. */
export function splitIdTag(issue: string): { id?: string; rest: string } {
  const m = ID_TAG.exec(issue);
  if (!m) return { rest: issue.trim() };
  return { id: m[1].toUpperCase(), rest: issue.slice(m[0].length).trim() };
}

const CLOSING_RULING = /^(?:resolved|closed|verified)\b/i;
const RULING_LINE = /\b(F\d{1,4})\b\]?\s*[:\-—–]\s*(resolved|closed|verified|still open|open|unresolved|not fixed)\b/gi;

/**
 * Explicit per-id rulings in the reviewer's feedback and issues.
 * `F2: resolved` (or `closed` / `verified`) closes; `F2: open` / `still open` /
 * `not fixed` keeps open. "fixed" alone is not a closing word: it is the
 * worker's vocabulary, and a reviewer quoting the worker must not close an id.
 * When the same id carries both, `open` wins — fail closed.
 */
export function parseReviewerRulings(text: string): Map<string, ReviewerRuling> {
  const rulings = new Map<string, ReviewerRuling>();
  for (const m of text.matchAll(RULING_LINE)) {
    const id = m[1].toUpperCase();
    const word = m[2].toLowerCase();
    const ruling: ReviewerRuling = ['resolved', 'closed', 'verified'].includes(word) ? 'resolved' : 'open';
    if (rulings.get(id) === 'open') continue;
    rulings.set(id, ruling);
  }
  return rulings;
}

const RESPONSE_LINE = /^[ \t]*(?:[-*][ \t]*)?\[?\b(F\d{1,4})\b\]?[ \t]*[:\-—–][ \t]*(fixed|disputed)\b[ \t]*(?:[:\-—–][ \t]*)?(.*)$/gim;

/**
 * The worker's per-id answers from its summary: `F1: fixed — src/a.ts:12`,
 * `F2: disputed — test/x.test.ts:40 already asserts ...`. Only ids in `known`
 * count. A `fixed`/`disputed` with no evidence is treated as `missing`.
 * Two answers for the same id resolve to `missing`, since neither can be trusted.
 */
export function parseWorkerResponses(text: string, known: ReadonlySet<string>): Map<string, { kind: WorkerResponseKind; evidence: string }> {
  const seen = new Map<string, { kind: WorkerResponseKind; evidence: string }>();
  const conflicted = new Set<string>();
  for (const m of text.matchAll(RESPONSE_LINE)) {
    const id = m[1].toUpperCase();
    if (!known.has(id)) continue;
    const evidence = clip(m[3] ?? '');
    const kind: WorkerResponseKind = evidence ? (m[2].toLowerCase() as 'fixed' | 'disputed') : 'missing';
    const prior = seen.get(id);
    if (prior && (prior.kind !== kind || prior.evidence !== evidence)) conflicted.add(id);
    seen.set(id, { kind, evidence });
  }
  for (const id of conflicted) seen.set(id, { kind: 'missing', evidence: '' });
  return seen;
}

function cloneLedger(ledger: FindingLedger): FindingLedger {
  return {
    nextSeq: ledger.nextSeq,
    findings: ledger.findings.map((f) => ({ ...f, lastWorkerResponse: f.lastWorkerResponse ? { ...f.lastWorkerResponse } : undefined })),
    reviewRounds: [...ledger.reviewRounds],
    workerRounds: [...ledger.workerRounds],
  };
}

/**
 * Apply one reviewer pass. Returns a new ledger; the input is not mutated.
 * A round that was already applied returns the ledger unchanged.
 */
export function recordReviewRound(ledger: FindingLedger, input: ReviewRoundInput): FindingLedger {
  if (ledger.reviewRounds.includes(input.round)) return ledger;
  const next = cloneLedger(ledger);
  next.reviewRounds.push(input.round);

  if (input.decision === 'approve') {
    // The reviewer's approve stays authoritative: it has seen every open id in
    // its prompt and passed the change anyway.
    for (const f of next.findings) {
      if (f.status === 'open') {
        f.status = 'resolved';
        f.resolvedRound = input.round;
      }
    }
    return next;
  }
  // A reject ends the loop on its own; nothing to track.
  if (input.decision !== 'revise') return next;

  const issues = (input.issues ?? []).map((i) => i.trim()).filter(Boolean);
  const rulings = parseReviewerRulings([input.feedback ?? '', ...issues].join('\n'));
  const reRaised = new Map<string, string>();
  const fresh: string[] = [];
  const byId = new Map(next.findings.map((f) => [f.id, f]));

  for (const issue of issues) {
    const { id, rest } = splitIdTag(issue);
    if (id && byId.has(id)) {
      // `F2: resolved` written as an issue is a ruling, not a re-raise; the
      // ruling parser above already saw it.
      if (CLOSING_RULING.test(rest)) continue;
      // Anything else under a known id is a re-raise, an `open` ruling even
      // when the feedback elsewhere says resolved.
      reRaised.set(id, rest || issue);
    } else {
      fresh.push(id ? rest || issue : issue);
    }
  }

  for (const f of next.findings) {
    const keptOpen = reRaised.has(f.id) || rulings.get(f.id) !== 'resolved';
    if (f.status === 'resolved') {
      // Re-raising a closed id reopens it; a bare ruling does not.
      if (!reRaised.has(f.id)) continue;
      f.status = 'open';
      f.resolvedRound = undefined;
    }
    if (!keptOpen) {
      f.status = 'resolved';
      f.resolvedRound = input.round;
      f.disputeStreak = 0;
      continue;
    }
    f.openRounds += 1;
    if (reRaised.has(f.id)) f.lastReviewerNote = clip(reRaised.get(f.id)!);
    const disputedThisRound = f.lastWorkerResponse?.kind === 'disputed' && f.lastWorkerResponse.round === input.round;
    f.disputeStreak = disputedThisRound ? f.disputeStreak + 1 : 0;
  }

  for (const text of fresh) addFinding(next, text, input.round);
  return next;
}

function addFinding(ledger: FindingLedger, text: string, round: number): void {
  ledger.findings.push({
    id: `F${ledger.nextSeq}`,
    text: clip(text),
    status: 'open',
    raisedRound: round,
    openRounds: 1,
    disputeStreak: 0,
  });
  ledger.nextSeq += 1;
}

/**
 * Apply one worker pass: every open id gets the worker's answer, or `missing`.
 * A round that was already applied returns the ledger unchanged.
 */
export function recordWorkerResponses(ledger: FindingLedger, input: { round: number; summary: string }): FindingLedger {
  if (ledger.workerRounds.includes(input.round)) return ledger;
  const next = cloneLedger(ledger);
  next.workerRounds.push(input.round);
  const open = next.findings.filter((f) => f.status === 'open');
  const answers = parseWorkerResponses(input.summary ?? '', new Set(open.map((f) => f.id)));
  for (const f of open) {
    const answer = answers.get(f.id);
    f.lastWorkerResponse = answer
      ? { kind: answer.kind, evidence: answer.evidence, round: input.round }
      : { kind: 'missing', evidence: '', round: input.round };
  }
  return next;
}

/** Whether the loop may continue, given the ledger after a revise. */
export function ledgerVerdict(ledger: FindingLedger, opts: { maxRounds?: number } = {}): LedgerVerdict {
  const maxRounds = Math.max(1, opts.maxRounds ?? DEFAULT_MAX_FINDING_ROUNDS);
  const open = openFindings(ledger);
  const deadlocked = open.filter((f) => f.disputeStreak >= DEADLOCK_STREAK).map((f) => f.id);
  if (deadlocked.length > 0) {
    return {
      kind: 'deadlock',
      ids: deadlocked,
      reason: `worker and reviewer disagree on ${deadlocked.join(', ')} for ${DEADLOCK_STREAK} consecutive rounds`,
    };
  }
  const capped = open.filter((f) => f.openRounds >= maxRounds).map((f) => f.id);
  if (capped.length > 0) {
    return {
      kind: 'round_cap',
      ids: capped,
      reason: `${capped.join(', ')} still open after ${maxRounds} reviewer rounds`,
    };
  }
  return { kind: 'continue' };
}

function responseLine(f: Finding): string {
  const r = f.lastWorkerResponse;
  if (!r) return 'no worker response yet';
  if (r.kind === 'missing') return `worker did not answer this id (round ${r.round})`;
  return `worker said ${r.kind} (round ${r.round}): ${r.evidence}`;
}

/** Section appended to the worker's revision prompt. Empty when nothing is open. */
export function buildWorkerFindingsSection(ledger: FindingLedger | undefined): string {
  const open = openFindings(ledger);
  if (open.length === 0) return '';
  const lines = open.map((f) => {
    const note = f.lastReviewerNote && f.lastReviewerNote !== f.text ? `\n  Reviewer's latest note: ${f.lastReviewerNote}` : '';
    return `- ${f.id}: ${f.text}${note}`;
  });
  return [
    '## Open review findings — answer each id',
    ...lines,
    '',
    'In your final summary, answer every id above on its own line, in one of these two forms:',
    '- `F<n>: fixed — <evidence: file:line, test name or command output that shows it>`',
    '- `F<n>: disputed — <evidence that the finding is wrong>`',
    'An id you do not answer, or answer without evidence, stays unresolved. Only the reviewer closes an id.',
  ].join('\n');
}

/** Section appended to the reviewer's report. Empty when nothing is open. */
export function buildReviewerFindingsSection(ledger: FindingLedger | undefined): string {
  const open = openFindings(ledger);
  if (open.length === 0) return '';
  const lines = open.map((f) => `  - ${f.id}: ${f.text}\n    ${responseLine(f)}`);
  return [
    '- **Open findings from earlier review rounds (rule on each id):**',
    ...lines,
    '  In your feedback, give one line per id: `F<n>: resolved` when you verified the fix (or accept the dispute), `F<n>: open` when it still stands. '
      + 'Start any issue that restates an open finding with its id (`F<n>: ...`); new findings go without an id. An id you do not rule on stays open.',
  ].join('\n');
}

/** One-paragraph summary for logs and the feedback carried to a later attempt. */
export function describeLedgerStop(ledger: FindingLedger, verdict: Exclude<LedgerVerdict, { kind: 'continue' }>): string {
  const byId = new Map(ledger.findings.map((f) => [f.id, f]));
  const detail = verdict.ids.map((id) => {
    const f = byId.get(id);
    return f ? `- ${id}: ${f.text}\n  ${responseLine(f)}` : `- ${id}`;
  });
  return [`Review loop stopped (${verdict.kind}): ${verdict.reason}.`, ...detail].join('\n');
}
