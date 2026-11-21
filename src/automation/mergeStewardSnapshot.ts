// Created: 2026-11-21
// Purpose: gather a merge-steward StewardSnapshot for one PR from read-only gh calls and the run ledger (AGT-4803)
// Dependencies: ./mergeStewardGuards (types), ../support/branchNaming (swarm branch test), better-sqlite3 (lazy, read-only)
// Test Status: mergeStewardSnapshot.test.ts

/**
 * The collector half of the merge steward's dry run. It turns GitHub state and
 * the run ledger into the `StewardSnapshot` the pure guard engine judges. It
 * never writes: every gh call goes through `readOnlyGh`, which refuses anything
 * but `pr view`, `pr list`, `repo view` and `api` GET requests, and the ledger
 * is opened `readonly` without the ledger class (whose constructor migrates).
 *
 * Evidence sources and their binding, all fail-closed:
 * - Head: `gh pr view --json headRefOid`, re-read at the end; a moved head throws.
 * - Required checks: branch protection (`branches/{base}/protection/required_status_checks`)
 *   unioned with rulesets (`rules/branches/{base}`). When either source cannot be read
 *   (protection usually needs admin) or both are empty, every check reported on the head
 *   is required as well (stricter than any subset, but it cannot see a required check that
 *   has not started yet; the snapshot notes say so). Check runs and commit statuses are read for the head SHA only, and a
 *   run recorded on another SHA is dropped. A truncated check list yields no checks.
 * - Reviews: REST `pulls/{n}/reviews` (it carries `user.type` and `commit_id`). A full
 *   page may hide a later review, so it yields no reviews (no approval can count).
 * - Files: REST `pulls/{n}/files` (it carries `previous_filename` for renames);
 *   complete only when the count matches the PR's `changedFiles`.
 * - Siblings: open PRs on `swarm/*` branches. A list at the limit is unknown (null);
 *   a sibling whose files cannot be read is kept with an unknown file list.
 * - Risk (AGT-4804): the stricter of the ledger attempt's `changeRisk` and the body's
 *   `## Risk:` line, bound to the ledger's published head. With no ledger row the class is at least
 *   `medium` at the current head, so the engine demands a human approval on it.
 * - Reviewer verdict and completeness (AGT-4806, AGT-4786): nothing stores the reviewer's
 *   decision per head yet. The one signal the publisher derives from an approving,
 *   complete review is a non-draft PR whose body carries `Closes <issue>` and whose title
 *   is not `[partial]`. It is trusted only when bound to the ledger's published head of a
 *   run in SYNC_PENDING or DONE (a review rollback parks NEEDS_RECONCILE with the body
 *   unchanged); without a ledger row both are null and the engine refuses.
 * - gh output: REST reads project their fields with `--jq`, so a large PR does not
 *   overflow the runner's output buffer and turn into a standing refusal.
 */

import type {
  CheckConclusion,
  StewardCheck,
  StewardFileList,
  StewardPrReview,
  StewardRisk,
  StewardRiskLevel,
  StewardSiblingPr,
  StewardSnapshot,
  StewardReview,
  StewardCompleteness,
} from './mergeStewardGuards.js';
import { isSwarmBranch } from '../support/branchNaming.js';
import { existsSync } from 'node:fs';

/** Runs `gh <args>` and resolves stdout. Injected so tests use a fake. */
export type GhRunner = (args: readonly string[]) => Promise<string>;

/** The snapshot could not be gathered at all (no head, PR not open, head moved). */
export class StewardSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StewardSnapshotError';
  }
}

const FORBIDDEN_FLAGS = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'];

/**
 * Throws unless `args` is a read-only gh invocation. `gh api` with any field flag
 * turns into a POST, so field flags are refused along with an explicit method.
 */
export function assertReadOnlyGhArgs(args: readonly string[]): void {
  const [group, verb] = args;
  const allowed = (group === 'pr' && (verb === 'view' || verb === 'list'))
    || (group === 'repo' && verb === 'view')
    || group === 'api';
  if (!allowed) throw new Error(`steward: refusing non-read-only gh command: gh ${args.join(' ')}`);
  for (const arg of args) {
    if (FORBIDDEN_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`) || (flag.length === 2 && arg.startsWith(flag) && arg.length > 2))) {
      throw new Error(`steward: refusing gh flag ${arg}: it could write`);
    }
    if (/^merge$/i.test(arg) || /\/merge(?:s)?(?:$|[/?])/i.test(arg)) {
      throw new Error(`steward: refusing gh argument ${arg}`);
    }
  }
}

/** Wrap a runner so it can only read. */
export function readOnlyGh(runner: GhRunner): GhRunner {
  return async (args) => {
    assertReadOnlyGhArgs(args);
    return runner(args);
  };
}

/** What the run ledger knows about the run that published this PR. */
export interface StewardLedgerEvidence {
  issueId: string;
  /** Tracker identifier (e.g. `AGT-123`), used to match the `Closes` line. */
  identifier?: string;
  state: string;
  /** The head the publisher pushed and classified. */
  headSha: string | null;
  /** Risk level stored with the latest attempt that recorded one. */
  changeRiskLevel: string | null;
}

export type StewardLedgerLookup = (prUrl: string) => StewardLedgerEvidence | null | Promise<StewardLedgerEvidence | null>;

function storedRiskLevel(resultJson: string | null): string | null {
  if (!resultJson) return null;
  try {
    const level = (JSON.parse(resultJson) as { changeRisk?: { level?: unknown } } | null)?.changeRisk?.level;
    return typeof level === 'string' ? level : null;
  } catch {
    return null; // a malformed row is no evidence
  }
}

/** The `changeRisk.level` of the newest attempt (rows newest first) that recorded one. */
export function latestChangeRiskLevel(resultJsonNewestFirst: ReadonlyArray<string | null>): string | null {
  for (const row of resultJsonNewestFirst) {
    const level = storedRiskLevel(row);
    if (level !== null) return level;
  }
  return null;
}

/**
 * Read-only ledger lookup. A missing database is "no evidence" (null); a database
 * that exists but cannot be opened or queried throws, and the collector notes it
 * as unreadable. Either way the engine refuses for want of a bound verdict.
 */
export function createLedgerLookup(dbPath: string): StewardLedgerLookup {
  return async (prUrl) => {
    if (!existsSync(dbPath)) return null;
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const run = db.prepare(
        'SELECT issue_id, identifier, state, head_sha FROM automation_runs WHERE pr_url = ? ORDER BY updated_at DESC LIMIT 1',
      ).get(prUrl) as { issue_id: string; identifier: string | null; state: string; head_sha: string | null } | undefined;
      if (!run) return null;
      const attempts = db.prepare(
        'SELECT result_json FROM automation_attempts WHERE issue_id = ? ORDER BY attempt_no DESC',
      ).all(run.issue_id) as Array<{ result_json: string | null }>;
      return {
        issueId: run.issue_id,
        identifier: run.identifier ?? undefined,
        state: run.state,
        headSha: run.head_sha,
        changeRiskLevel: latestChangeRiskLevel(attempts.map((a) => a.result_json)),
      };
    } finally {
      db.close();
    }
  };
}

const RISK_LEVELS: readonly StewardRiskLevel[] = ['low', 'medium', 'high'];

function asRiskLevel(value: unknown): StewardRiskLevel | null {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value) ? value as StewardRiskLevel : null;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, '\n');
}

/** The level in the body's `## Risk: <level>` heading, or null. */
export function parseRiskSection(body: string): StewardRiskLevel | null {
  const match = normalizeBody(body).match(/^## Risk: (low|medium|high)\s*$/m);
  return match ? match[1] as StewardRiskLevel : null;
}

/** Risk class bound to the head it was classified on; unknown is medium, never low. */
export function riskEvidence(ledger: StewardLedgerEvidence | null, body: string, prHead: string): { risk: StewardRisk; note: string } {
  const fromBody = parseRiskSection(body);
  if (ledger?.headSha) {
    // The stored class can belong to an older attempt (a later one threw before recording
    // one) while the body is rewritten on every publish: take the stricter of the two.
    const stored = asRiskLevel(ledger.changeRiskLevel);
    const known = [stored, fromBody].filter((l): l is StewardRiskLevel => l !== null);
    const level = known.length > 0 ? known.reduce((a, b) => (RISK_LEVELS.indexOf(b) > RISK_LEVELS.indexOf(a) ? b : a)) : 'medium';
    const source = known.length === 0 ? 'unknown, defaulted' : [stored && `ledger ${stored}`, fromBody && `PR body ${fromBody}`].filter(Boolean).join(', ');
    return { risk: { level, headSha: ledger.headSha }, note: `risk ${level} (${source}) bound to published head ${ledger.headSha.slice(0, 12)}` };
  }
  // No published head to bind to: never report low.
  const level: StewardRiskLevel = fromBody === 'high' ? 'high' : 'medium';
  return { risk: { level, headSha: prHead }, note: `risk ${level}: no ledger row for this PR, so the class is at least medium` };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Run states a publication ends in when nothing rolled it back or parked it. */
const CLEAN_PUBLISHED_STATES: ReadonlySet<string> = new Set(['SYNC_PENDING', 'DONE']);

/** Reviewer verdict and completeness, bound to the ledger's published head. */
export function reviewEvidence(
  ledger: StewardLedgerEvidence | null,
  pr: { body: string; title: string; isDraft: boolean },
): { review: StewardReview | null; completeness: StewardCompleteness | null; note: string } {
  if (!ledger?.headSha) {
    return { review: null, completeness: null, note: 'no reviewer verdict: no ledger row binds this PR to a published head' };
  }
  const headSha = ledger.headSha;
  if (!CLEAN_PUBLISHED_STATES.has(ledger.state)) {
    // e.g. NEEDS_RECONCILE after a PR-time review rollback: the body may still say Closes.
    return {
      review: { verdict: 'unknown', headSha },
      completeness: { verdict: 'unknown', headSha },
      note: `ledger run is ${ledger.state}, not cleanly published: its PR body proves no approval`,
    };
  }
  if (pr.isDraft) {
    return {
      review: { verdict: 'unknown', headSha },
      completeness: { verdict: 'unknown', headSha },
      note: 'PR is a draft: it never earned a review',
    };
  }
  const body = normalizeBody(pr.body);
  const issue = ledger.identifier ? escapeRegExp(ledger.identifier) : '[A-Z][A-Z0-9]*-\\d+';
  const closes = new RegExp(`^Closes ${issue}\\s*$`, 'm').test(body);
  const refs = new RegExp(`^Refs ${issue}\\s*$`, 'm').test(body);
  const partialTitle = /^\s*\[partial\]/i.test(pr.title);
  if (closes && !partialTitle) {
    return {
      review: { verdict: 'approve', headSha },
      completeness: { verdict: 'complete', headSha },
      note: 'reviewer approved with complete coverage (publisher wrote Closes on a non-partial PR)',
    };
  }
  return {
    review: { verdict: 'unknown', headSha },
    completeness: { verdict: refs || partialTitle ? 'partial' : 'unknown', headSha },
    note: 'no complete-coverage approval recorded on the PR',
  };
}

interface RawCheckRun {
  name?: unknown;
  head_sha?: unknown;
  status?: unknown;
  conclusion?: unknown;
}

function checkRunConclusion(run: RawCheckRun): CheckConclusion {
  if (run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'success': return 'success';
    case 'failure': case 'timed_out': case 'action_required': case 'startup_failure': case 'stale': return 'failure';
    case 'skipped': return 'skipped';
    case 'cancelled': return 'cancelled';
    case 'neutral': return 'neutral';
    default: return 'unknown';
  }
}

/** Check runs as engine inputs. Runs recorded on any SHA but the head are dropped. */
export function mapHeadCheckRuns(raw: readonly RawCheckRun[], headSha: string): StewardCheck[] {
  return raw
    .filter((run) => typeof run.name === 'string' && run.head_sha === headSha)
    .map((run) => ({ name: run.name as string, conclusion: checkRunConclusion(run), headSha }));
}

function statusConclusion(state: unknown): CheckConclusion {
  switch (state) {
    case 'success': return 'success';
    case 'failure': case 'error': return 'failure';
    case 'pending': return 'pending';
    default: return 'unknown';
  }
}

/** Commit statuses (legacy status API) for the head; the endpoint is per SHA. */
export function mapHeadStatuses(raw: readonly { context?: unknown; state?: unknown }[], headSha: string): StewardCheck[] {
  return raw
    .filter((status) => typeof status.context === 'string')
    .map((status) => ({ name: status.context as string, conclusion: statusConclusion(status.state), headSha }));
}

/** Required check names from branch protection and rulesets. */
export function parseRequiredChecks(protection: unknown, rules: unknown): string[] {
  const names = new Set<string>();
  const p = protection as { contexts?: unknown; checks?: Array<{ context?: unknown }> } | null;
  if (p && Array.isArray(p.contexts)) for (const c of p.contexts) if (typeof c === 'string') names.add(c);
  if (p && Array.isArray(p.checks)) for (const c of p.checks) if (typeof c?.context === 'string') names.add(c.context);
  if (Array.isArray(rules)) {
    for (const rule of rules as Array<{ type?: unknown; parameters?: { required_status_checks?: Array<{ context?: unknown }> } }>) {
      if (rule?.type !== 'required_status_checks') continue;
      for (const c of rule.parameters?.required_status_checks ?? []) if (typeof c?.context === 'string') names.add(c.context);
    }
  }
  return [...names];
}

const PAGE = 100;
const MAX_FILE_PAGES = 30;
const SIBLING_LIMIT = 200;

async function readJson<T>(gh: GhRunner, args: string[]): Promise<T> {
  return JSON.parse(await gh(args)) as T;
}

/** Changed paths of a PR (both sides of a rename); complete only when the count matches. */
export async function readPrFiles(gh: GhRunner, repo: string, prNumber: number, changedFiles: number | null): Promise<StewardFileList> {
  try {
    const files = new Set<string>();
    let entries = 0;
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const batch = await readJson<Array<{ filename?: unknown; previous_filename?: unknown }>>(
        gh, ['api', `repos/${repo}/pulls/${prNumber}/files?per_page=${PAGE}&page=${page}`, '--jq', '[.[] | {filename, previous_filename}]'],
      );
      if (!Array.isArray(batch)) return { files: null, complete: false };
      for (const file of batch) {
        if (typeof file.filename !== 'string') return { files: null, complete: false };
        entries++;
        files.add(file.filename);
        if (typeof file.previous_filename === 'string') files.add(file.previous_filename);
      }
      if (batch.length < PAGE) {
        return { files: [...files], complete: changedFiles !== null && entries === changedFiles };
      }
    }
    return { files: [...files], complete: false };
  } catch {
    return { files: null, complete: false };
  }
}

async function readChecks(gh: GhRunner, repo: string, headSha: string, notes: string[]): Promise<StewardCheck[]> {
  const checks: StewardCheck[] = [];
  try {
    const runs = await readJson<{ total_count?: unknown; check_runs?: RawCheckRun[] }>(
      gh, ['api', `repos/${repo}/commits/${headSha}/check-runs?per_page=${PAGE}`,
        '--jq', '{total_count, check_runs: [.check_runs[] | {name, head_sha, status, conclusion}]}'],
    );
    const list = Array.isArray(runs.check_runs) ? runs.check_runs : null;
    if (!list || typeof runs.total_count !== 'number' || runs.total_count > list.length) {
      notes.push('check runs unreadable or truncated: no check counts as green');
      return [];
    }
    checks.push(...mapHeadCheckRuns(list, headSha));
  } catch (err) {
    notes.push(`check runs unreadable (${errorText(err)}): no check counts as green`);
    return [];
  }
  try {
    const combined = await readJson<{ total_count?: unknown; statuses?: Array<{ context?: unknown; state?: unknown }> }>(
      gh, ['api', `repos/${repo}/commits/${headSha}/status?per_page=${PAGE}`,
        '--jq', '{total_count, statuses: [.statuses[] | {context, state}]}'],
    );
    const list = Array.isArray(combined.statuses) ? combined.statuses : null;
    if (!list || typeof combined.total_count !== 'number' || combined.total_count > list.length) {
      notes.push('commit statuses unreadable or truncated: no check counts as green');
      return [];
    }
    checks.push(...mapHeadStatuses(list, headSha));
  } catch (err) {
    notes.push(`commit statuses unreadable (${errorText(err)}): no check counts as green`);
    return [];
  }
  return checks;
}

async function readRequiredChecks(gh: GhRunner, repo: string, base: string, checks: readonly StewardCheck[], notes: string[]): Promise<string[]> {
  const branch = encodeURIComponent(base);
  let unreadable = 0;
  const protection = await readJson<unknown>(gh, ['api', `repos/${repo}/branches/${branch}/protection/required_status_checks`])
    .catch(() => { unreadable++; return null; });
  const rules = await readJson<unknown>(gh, ['api', `repos/${repo}/rules/branches/${branch}?per_page=${PAGE}`])
    .catch(() => { unreadable++; return null; });
  const required = parseRequiredChecks(protection, rules);
  if (required.length > 0 && unreadable === 0) {
    notes.push(`required checks from branch protection/rulesets: ${required.join(', ')}`);
    return required;
  }
  // A source that could not be read (protection usually needs admin) may hold more
  // required checks than the other one shows: require every check on the head too.
  const all = [...new Set([...required, ...checks.map((c) => c.name)])];
  notes.push(`required checks only partly readable from branch protection/rulesets (${unreadable} source(s) failed): treating all ${all.length} check(s) as required`);
  return all;
}

async function readReviews(gh: GhRunner, repo: string, prNumber: number, notes: string[]): Promise<StewardPrReview[]> {
  try {
    const raw = await readJson<Array<{ user?: { login?: unknown; type?: unknown } | null; state?: unknown; commit_id?: unknown; submitted_at?: unknown }>>(
      gh, ['api', `repos/${repo}/pulls/${prNumber}/reviews?per_page=${PAGE}`,
        '--jq', '[.[] | {user: {login: .user.login, type: .user.type}, state, commit_id, submitted_at}]'],
    );
    if (!Array.isArray(raw) || raw.length >= PAGE) {
      notes.push('PR reviews unreadable or possibly truncated: no approval counts');
      return [];
    }
    const states = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']);
    return raw
      .filter((r) => typeof r.user?.login === 'string' && typeof r.state === 'string' && states.has(r.state))
      .map((r) => ({
        login: r.user!.login as string,
        userType: typeof r.user?.type === 'string' ? r.user.type : undefined,
        state: r.state as StewardPrReview['state'],
        commitId: typeof r.commit_id === 'string' ? r.commit_id : '',
        submittedAt: typeof r.submitted_at === 'string' ? r.submitted_at : '',
      }));
  } catch (err) {
    notes.push(`PR reviews unreadable (${errorText(err)}): no approval counts`);
    return [];
  }
}

async function readSiblings(gh: GhRunner, repo: string, prNumber: number, notes: string[]): Promise<StewardSiblingPr[] | null> {
  let open: Array<{ number?: unknown; headRefName?: unknown; changedFiles?: unknown }>;
  try {
    open = await readJson(gh, ['pr', 'list', '-R', repo, '--state', 'open', '--limit', String(SIBLING_LIMIT), '--json', 'number,headRefName,changedFiles']);
  } catch (err) {
    notes.push(`open PR list unreadable (${errorText(err)})`);
    return null;
  }
  if (!Array.isArray(open) || open.length >= SIBLING_LIMIT) {
    notes.push('open PR list unreadable or at its limit');
    return null;
  }
  const siblings: StewardSiblingPr[] = [];
  for (const pr of open) {
    if (typeof pr.number !== 'number' || typeof pr.headRefName !== 'string') {
      notes.push('open PR list has a malformed entry');
      return null;
    }
    if (pr.number === prNumber || !isSwarmBranch(pr.headRefName)) continue;
    const changed = typeof pr.changedFiles === 'number' ? pr.changedFiles : null;
    siblings.push({ number: pr.number, headRefName: pr.headRefName, ...await readPrFiles(gh, repo, pr.number, changed) });
  }
  return siblings;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200);
}

interface PrView {
  number?: unknown;
  url?: unknown;
  headRefOid?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
  title?: unknown;
  body?: unknown;
  author?: { login?: unknown } | null;
  isDraft?: unknown;
  state?: unknown;
  changedFiles?: unknown;
}

export interface BuildStewardSnapshotOptions {
  /** `owner/name`. */
  repo: string;
  prNumber: number;
  /** Raw runner; it is wrapped in `readOnlyGh` here. */
  gh: GhRunner;
  ledger?: StewardLedgerLookup;
  /** Logins the factory acts as (AGT-4883 will give them a config home). */
  automationAccounts?: readonly string[];
}

export interface StewardSnapshotResult {
  snapshot: StewardSnapshot;
  prUrl: string;
  /** How each piece of evidence was obtained, for the log. */
  notes: string[];
}

interface PrHead {
  view: PrView;
  headSha: string;
  baseRef: string;
  title: string;
  body: string;
  prUrl: string;
  changedFiles: number | null;
}

async function readPrHead(gh: GhRunner, repo: string, prNumber: number): Promise<PrHead> {
  let view: PrView;
  try {
    view = await readJson<PrView>(gh, [
      'pr', 'view', String(prNumber), '-R', repo,
      '--json', 'number,url,headRefOid,headRefName,baseRefName,title,body,author,isDraft,state,changedFiles',
    ]);
  } catch (err) {
    throw new StewardSnapshotError(`cannot read PR #${prNumber} in ${repo}: ${errorText(err)}`);
  }
  const headSha = typeof view.headRefOid === 'string' ? view.headRefOid.trim() : '';
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new StewardSnapshotError(`PR #${prNumber} has no readable head SHA`);
  if (view.state !== 'OPEN') throw new StewardSnapshotError(`PR #${prNumber} is not open (state ${String(view.state)})`);
  const baseRef = typeof view.baseRefName === 'string' ? view.baseRefName : '';
  if (!baseRef) throw new StewardSnapshotError(`PR #${prNumber} has no readable base branch`);
  return {
    view,
    headSha,
    baseRef,
    title: typeof view.title === 'string' ? view.title : '',
    body: typeof view.body === 'string' ? view.body : '',
    prUrl: typeof view.url === 'string' ? view.url : `https://github.com/${repo}/pull/${prNumber}`,
    changedFiles: typeof view.changedFiles === 'number' ? view.changedFiles : null,
  };
}

/** Evidence gathered across several calls is only coherent if the head held still. */
async function assertHeadUnchanged(gh: GhRunner, repo: string, prNumber: number, headSha: string): Promise<void> {
  let after: PrView;
  try {
    after = await readJson<PrView>(gh, ['pr', 'view', String(prNumber), '-R', repo, '--json', 'headRefOid']);
  } catch (err) {
    throw new StewardSnapshotError(`cannot re-read PR #${prNumber} head: ${errorText(err)}`);
  }
  if (after.headRefOid !== headSha) {
    throw new StewardSnapshotError(`PR #${prNumber} head moved from ${headSha.slice(0, 12)} while the snapshot was read`);
  }
}

async function readLedger(lookup: StewardLedgerLookup | undefined, prUrl: string, notes: string[]): Promise<StewardLedgerEvidence | null> {
  let ledger: StewardLedgerEvidence | null = null;
  try {
    ledger = lookup ? await lookup(prUrl) : null;
  } catch (err) {
    notes.push(`ledger unreadable (${errorText(err)})`);
  }
  if (ledger) notes.push(`ledger run ${ledger.identifier ?? ledger.issueId} (${ledger.state}) published ${ledger.headSha?.slice(0, 12) ?? 'no head'}`);
  return ledger;
}

/**
 * Gather the snapshot. Throws `StewardSnapshotError` when there is nothing to
 * judge (PR unreadable, not open, no head, head moved mid-read). Every other
 * read failure degrades to evidence the engine refuses.
 */
export async function buildStewardSnapshot(options: BuildStewardSnapshotOptions): Promise<StewardSnapshotResult> {
  const gh = readOnlyGh(options.gh);
  const { repo, prNumber } = options;
  const notes: string[] = [];
  const { view, headSha, baseRef, title, body, prUrl, changedFiles } = await readPrHead(gh, repo, prNumber);

  const checks = await readChecks(gh, repo, headSha, notes);
  const requiredChecks = await readRequiredChecks(gh, repo, baseRef, checks, notes);
  const prReviews = await readReviews(gh, repo, prNumber, notes);
  const own = await readPrFiles(gh, repo, prNumber, changedFiles);
  if (!own.complete) notes.push('this PR\'s file list is unknown or truncated');
  const siblings = await readSiblings(gh, repo, prNumber, notes);

  const ledger = await readLedger(options.ledger, prUrl, notes);
  const risk = riskEvidence(ledger, body, headSha);
  notes.push(risk.note);
  const review = reviewEvidence(ledger, { body, title, isDraft: view.isDraft === true });
  notes.push(review.note);
  await assertHeadUnchanged(gh, repo, prNumber, headSha);

  const snapshot: StewardSnapshot = {
    prNumber,
    author: typeof view.author?.login === 'string' ? view.author.login : '',
    prReviews,
    automationAccounts: [...(options.automationAccounts ?? [])],
    headSha,
    title,
    requiredChecks,
    checks,
    risk: risk.risk,
    siblings,
    review: review.review,
    completeness: review.completeness,
    files: own.files,
    complete: own.complete,
  };
  return { snapshot, prUrl, notes };
}
