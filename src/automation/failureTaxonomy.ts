// ============================================
// OpenSwarm - Weekly failure taxonomy (AGT-4812)
// ============================================
//
// The factory should stop repeating the same failure. Park reasons, reviewer
// rejections and questions to the operator are already recorded — attempts and
// park events in the run ledger, questions on the coordination board — but
// nothing aggregates them. When the same question comes back week after week,
// that is an infrastructure gap, not noise.
//
// Once a week this groups those records by a normalised cause. Every cause
// seen at least `minSignals` times across at least `minIssues` issues becomes
// one candidate: a prompt rule, a guard, a readiness check or a config change,
// with the sessions that produced it. Each candidate is filed as a Backlog
// issue. Nothing is applied: a person reads the evidence and decides, and
// Backlog keeps the heartbeat from picking the proposal up on its own.
//
// Named causes come first (ordered rules below); anything else falls back to
// the same normalised-error fingerprint the retrospective lane uses, so an
// unnamed cause that repeats still surfaces, just with a generic candidate.

import { existsSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Cron } from 'croner';
import { normalizeErrorForLoop } from '../support/stuckDetector.js';
import { coordinationFilePath } from '../coordination/coordinationPaths.js';
import { defaultAutomationDbPath } from './automationDbPath.js';

export type CandidateKind = 'prompt_rule' | 'guard' | 'readiness_check' | 'config_change';
export type SignalSource = 'attempt' | 'park' | 'question';

export interface FailureSignal {
  source: SignalSource;
  /** Linear identifier (or issue id when the ledger has none). */
  issue: string;
  /** Where to look: `<issue>#<attempt>` for a ledger attempt, the `hq-…` id for a question. */
  session: string;
  text: string;
  at: number;
}

interface CauseRule {
  id: string;
  label: string;
  kind: CandidateKind;
  proposal: string;
  match: RegExp;
}

/**
 * Ordered: the first match names the cause. Disk and credential causes come
 * before the decision rules because a question like "approve the rotation and
 * give me a test DSN" is blocked on the credential first.
 */
export const CAUSE_RULES: readonly CauseRule[] = [
  {
    id: 'host_disk_full',
    label: 'ENOSPC — host disk full',
    kind: 'guard',
    proposal: 'Check free space before claiming work or creating a verify clone, and pause dispatch below the floor instead of failing each run (see AGT-4785).',
    match: /\bENOSPC\b|no space left on device|disk (?:is )?full|디스크 여유|여유 공간/i,
  },
  {
    id: 'human_only_deploy',
    label: 'human-only deploy / production action',
    kind: 'readiness_check',
    proposal: 'Do not dispatch an issue whose remaining definition of done is a production write, deploy, release or live readback. Route it to the operator at triage instead of after a worker run.',
    match: /^human_action_only:|\b(?:deploy|release|workflow[_ ]dispatch|production (?:write|read|data|master)|live (?:publication|readback))\b|운영 (?:작업|NAS|승인)|배포/i,
  },
  {
    id: 'missing_credential',
    label: 'missing credential or test environment',
    kind: 'readiness_check',
    proposal: 'List the credentials and test services an issue needs before it becomes ready, and check they exist in the worker environment at claim time.',
    match: /\b(?:[A-Z][A-Z0-9]*_)+(?:DSN|TOKEN|KEY|SECRET|PASSWORD)\b.*(?:provide|configure|access|접근|제공|설정)|(?:provide|configure|접근|제공|설정).*\b(?:[A-Z][A-Z0-9]*_)+(?:DSN|TOKEN|KEY|SECRET|PASSWORD)\b|자격 증명|credential/i,
  },
  {
    id: 'decision_pending',
    label: 'decision pending',
    kind: 'readiness_check',
    proposal: 'An issue that still waits on a product or operator decision is not ready. Require the decision to be recorded on the issue before it can move to Todo.',
    match: /^blocked_by_dependency:|\bdecisions?\b|\bauthori[sz]e\b|\bapprov(?:e|al)\b|결정|승인|Draft PR needs a human/i,
  },
  {
    id: 'review_changes_requested',
    label: 'reviewer rejection',
    kind: 'prompt_rule',
    proposal: 'Read the recurring review objections and turn the common one into a worker prompt rule or a deterministic pipeline guard.',
    match: /^pr-review: changes requested|\bchanges requested\b|reviewer (?:rejected|requested changes)/i,
  },
  {
    id: 'verify_infra_failure',
    label: 'verification infrastructure failure',
    kind: 'config_change',
    proposal: 'Separate verify-runner infrastructure failures from test failures and size the verify slots or timeouts for the queue they serve.',
    match: /verify-runner: .*infrastructure failure|no verification slot within/i,
  },
  {
    id: 'stage_timeout',
    label: 'stage timeout or wall-clock budget',
    kind: 'config_change',
    proposal: 'Compare stage timeouts and the wall-clock budget with the measured durations of the issues that hit them.',
    match: /\btimeout after \d+ms\b|wall-clock budget spent|lease expired before a terminal transition/i,
  },
  {
    id: 'output_loop',
    label: 'repeated identical output',
    kind: 'prompt_rule',
    proposal: 'Add a worker prompt rule for the state that produced the same output repeatedly, or stop earlier with the reason.',
    match: /same output produced \d+ times/i,
  },
];

/**
 * Record a ledger attempt already names a question it is waiting on. The
 * question itself is the better text, so the attempt is dropped when the
 * board has that question.
 */
const WAITING_ON_QUESTION = /Waiting for operator answer \((hq-[0-9a-f]+)\)/;

export interface CauseClassification {
  id: string;
  label: string;
  kind: CandidateKind;
  proposal: string;
}

export function classifyCause(text: string): CauseClassification {
  const trimmed = text.trim();
  for (const rule of CAUSE_RULES) {
    if (rule.match.test(trimmed)) return { id: rule.id, label: rule.label, kind: rule.kind, proposal: rule.proposal };
  }
  const fingerprint = normalizeErrorForLoop(trimmed).slice(0, 80);
  return {
    id: `other:${fingerprint}`,
    label: fingerprint,
    kind: 'guard',
    proposal: 'An unnamed cause that repeats. Read the sessions, name the cause, and decide whether it needs a guard, a prompt rule, a readiness check or a config change.',
  };
}

export interface TaxonomyCandidate extends CauseClassification {
  signals: number;
  issues: string[];
  sessions: string[];
  sources: Partial<Record<SignalSource, number>>;
  example: string;
}

/** Group signals by cause; keep the causes at or above both floors, largest first. */
export function aggregateTaxonomy(
  signals: readonly FailureSignal[],
  options: { minSignals?: number; minIssues?: number } = {},
): TaxonomyCandidate[] {
  const minSignals = options.minSignals ?? 3;
  const minIssues = options.minIssues ?? 2;
  const byCause = new Map<string, TaxonomyCandidate & { issueSet: Set<string>; sessionSet: Set<string> }>();
  for (const signal of signals) {
    if (!signal.text.trim()) continue;
    const cause = classifyCause(signal.text);
    let entry = byCause.get(cause.id);
    if (!entry) {
      entry = { ...cause, signals: 0, issues: [], sessions: [], sources: {}, example: signal.text, issueSet: new Set(), sessionSet: new Set() };
      byCause.set(cause.id, entry);
    }
    entry.signals += 1;
    entry.sources[signal.source] = (entry.sources[signal.source] ?? 0) + 1;
    entry.issueSet.add(signal.issue);
    entry.sessionSet.add(signal.session);
  }
  return [...byCause.values()]
    .filter(entry => entry.signals >= minSignals && entry.issueSet.size >= minIssues)
    .map(({ issueSet, sessionSet, ...entry }) => ({ ...entry, issues: [...issueSet].sort(), sessions: [...sessionSet].sort() }))
    .sort((a, b) => b.signals - a.signals || b.issues.length - a.issues.length);
}

interface AttemptRow { identifier: string | null; issue_id: string; attempt_no: number; error_message: string; finished_at: number }
interface ParkRow { identifier: string | null; issue_id: string; attempt_no: number | null; data_json: string | null; created_at: number }

/** Failed or parked attempts, and park events, from the run ledger. */
export function collectLedgerSignals(db: Database.Database, since: number, until: number): FailureSignal[] {
  const attempts = db.prepare(`
    SELECT r.identifier, a.issue_id, a.attempt_no, a.error_message, a.finished_at
    FROM automation_attempts a JOIN automation_runs r USING (issue_id)
    WHERE a.finished_at >= ? AND a.finished_at < ?
      AND a.error_message IS NOT NULL AND a.error_message != ''
      -- A worker that declares the work human-only ends 'superseded' with
      -- success = 1; its reason is a park in all but name.
      AND (a.success IS NULL OR a.success = 0 OR a.result_status = 'superseded')
  `).all(since, until) as AttemptRow[];
  const parks = db.prepare(`
    SELECT r.identifier, e.issue_id, e.attempt_no, e.data_json, e.created_at
    FROM automation_events e JOIN automation_runs r USING (issue_id)
    WHERE e.created_at >= ? AND e.created_at < ? AND e.kind IN ('parked', 'operator_parked')
  `).all(since, until) as ParkRow[];

  const signals: FailureSignal[] = attempts.map(row => ({
    source: 'attempt',
    issue: row.identifier ?? row.issue_id,
    session: `${row.identifier ?? row.issue_id}#${row.attempt_no}`,
    text: row.error_message,
    at: row.finished_at,
  }));
  for (const row of parks) {
    let reason = '';
    try { reason = String((JSON.parse(row.data_json ?? '{}') as { reason?: unknown }).reason ?? ''); } catch { /* malformed event data has no reason */ }
    if (!reason) continue;
    signals.push({
      source: 'park',
      issue: row.identifier ?? row.issue_id,
      session: `${row.identifier ?? row.issue_id}#${row.attempt_no ?? 0}`,
      text: reason,
      at: row.created_at,
    });
  }
  return signals;
}

interface BoardEvent { kind?: unknown; timestamp?: unknown; taskLabel?: unknown; taskId?: unknown; correlationId?: unknown; summary?: unknown }

/** `human-question` events on the coordination board, read straight from its file. */
export function collectQuestionSignals(coordinationPath: string, since: number, until: number): FailureSignal[] {
  if (!existsSync(coordinationPath)) return [];
  let events: BoardEvent[] = [];
  try {
    events = ((JSON.parse(readFileSync(coordinationPath, 'utf8')) as { events?: BoardEvent[] }).events) ?? [];
  } catch { // cxt-ignore: error_swallow — an unreadable board leaves the ledger signals
    return [];
  }
  return events.flatMap((event) => {
    const at = Number(event.timestamp);
    if (event.kind !== 'human-question' || !(at >= since && at < until)) return [];
    const issue = String(event.taskLabel ?? event.taskId ?? 'unknown');
    return [{ source: 'question' as const, issue, session: String(event.correlationId ?? issue), text: String(event.summary ?? ''), at }];
  });
}

/** Drop ledger records that only point at a question the board already holds. */
export function mergeSignals(ledger: readonly FailureSignal[], questions: readonly FailureSignal[]): FailureSignal[] {
  const asked = new Set(questions.map(q => q.session));
  return [
    ...ledger.filter((signal) => {
      const waiting = WAITING_ON_QUESTION.exec(signal.text);
      return !waiting || !asked.has(waiting[1]);
    }),
    ...questions,
  ];
}

const KIND_LABEL: Record<CandidateKind, string> = {
  prompt_rule: 'prompt rule',
  guard: 'guard',
  readiness_check: 'readiness check',
  config_change: 'config change',
};

/** The filed issue: measured numbers and links only, no inference beyond the rule's proposal. */
export function composeCandidateIssue(candidate: TaxonomyCandidate, window: { since: number; until: number }): { title: string; description: string } {
  const sources = Object.entries(candidate.sources).map(([source, n]) => `${source} ${n}`).join(', ');
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const title = `[Failure taxonomy] ${KIND_LABEL[candidate.kind]} candidate: ${candidate.label}`.slice(0, 120);
  const description = [
    '## Measured (auto-filed by the weekly failure taxonomy, AGT-4812)',
    '',
    `Window ${day(window.since)} – ${day(window.until)}. This is a candidate, not a change: nothing has been applied. Approve it by moving it to Todo, or cancel it.`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Cause | \`${candidate.id}\` |`,
    `| Proposed as | ${KIND_LABEL[candidate.kind]} |`,
    `| Signals | ${candidate.signals} (${sources}) |`,
    `| Issues | ${candidate.issues.length}: ${candidate.issues.slice(0, 15).join(', ')}${candidate.issues.length > 15 ? ', …' : ''} |`,
    '',
    '**Sessions** (`<issue>#<attempt>` in the run ledger, `hq-…` on the coordination board):',
    '',
    candidate.sessions.slice(0, 40).map(s => `\`${s}\``).join(', ') + (candidate.sessions.length > 40 ? `, … (${candidate.sessions.length} in all)` : ''),
    '',
    '**Example, verbatim:**',
    '',
    '```',
    candidate.example.slice(0, 600),
    '```',
    '',
    '## Proposal',
    '',
    candidate.proposal,
  ].join('\n');
  return { title, description };
}

export interface TaxonomyTaskSource {
  createTask(title: string, description: string, projectId?: string): Promise<{ id: string; identifier?: string } | { error: string }>;
  updateState(issueId: string, state: 'Backlog'): Promise<boolean>;
}

export interface TaxonomyRunResult {
  ran: boolean;
  reason: string;
  candidates: TaxonomyCandidate[];
  filed: string[];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LAST_RUN_KEY = 'failure_taxonomy_last_run_at';
const FILED_KEY_PREFIX = 'failure_taxonomy_filed:';
/** A cause already filed stays quiet for four weeks, so an open candidate is not filed again each week. */
const REFILE_AFTER_MS = 4 * WEEK_MS;

/**
 * One weekly pass. With `taskSource` unset it only measures (a dry run):
 * the candidates come back and nothing is filed or stamped.
 */
export async function runFailureTaxonomy(options: {
  db: Database.Database;
  coordinationPath?: string;
  taskSource?: TaxonomyTaskSource;
  projectId?: string;
  now?: number;
  windowMs?: number;
  minSignals?: number;
  minIssues?: number;
  /** Ignore the weekly interval (dry runs and backfills). */
  force?: boolean;
}): Promise<TaxonomyRunResult> {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? WEEK_MS;
  const { db } = options;
  db.exec('CREATE TABLE IF NOT EXISTS automation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const readMeta = (key: string) => Number((db.prepare('SELECT value FROM automation_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? 0);
  const writeMeta = (key: string, value: number) => db.prepare('INSERT INTO automation_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

  if (!options.force && now - readMeta(LAST_RUN_KEY) < WEEK_MS) return { ran: false, reason: 'interval', candidates: [], filed: [] };
  // Claim the week before filing, atomically, so a second process reading the
  // same ledger cannot file the same candidates in the same minute.
  if (options.taskSource && !options.force) {
    const claimed = db.transaction(() => {
      if (now - readMeta(LAST_RUN_KEY) < WEEK_MS) return false;
      writeMeta(LAST_RUN_KEY, now);
      return true;
    }).immediate();
    if (!claimed) return { ran: false, reason: 'interval', candidates: [], filed: [] };
  }

  const since = now - windowMs;
  const ledger = collectLedgerSignals(db, since, now);
  const questions = options.coordinationPath ? collectQuestionSignals(options.coordinationPath, since, now) : [];
  const candidates = aggregateTaxonomy(mergeSignals(ledger, questions), { minSignals: options.minSignals, minIssues: options.minIssues });
  if (!options.taskSource) return { ran: true, reason: 'dry run', candidates, filed: [] };

  const filed: string[] = [];
  for (const candidate of candidates) {
    if (now - readMeta(FILED_KEY_PREFIX + candidate.id) < REFILE_AFTER_MS) continue;
    const issue = composeCandidateIssue(candidate, { since, until: now });
    const created = await options.taskSource.createTask(issue.title, issue.description, options.projectId);
    if ('error' in created) continue;
    // Backlog, explicitly: a team whose default state is Todo would otherwise
    // hand the proposal to the heartbeat — applied without approval.
    await options.taskSource.updateState(created.id, 'Backlog');
    writeMeta(FILED_KEY_PREFIX + candidate.id, now);
    filed.push(created.identifier ?? created.id);
  }
  return { ran: true, reason: `${candidates.length} candidate(s), ${filed.length} filed`, candidates, filed };
}

/**
 * Schedule the weekly pass (Monday 09:00 local). The retrospective project is
 * the opt-in, the same one the daily ledger retrospective files into: a
 * deployment that has not chosen where the daemon may file its own issues
 * gets no taxonomy issues either.
 */
export function startWeeklyFailureTaxonomy(options: {
  projectId: string;
  getTaskSource: () => TaxonomyTaskSource | null;
  dbPath?: string;
  schedule?: string;
}): Cron {
  return new Cron(options.schedule ?? '0 9 * * 1', async () => {
    const taskSource = options.getTaskSource();
    if (!taskSource) return;
    const db = new Database(options.dbPath ?? defaultAutomationDbPath());
    try {
      const result = await runFailureTaxonomy({ db, coordinationPath: coordinationFilePath(), taskSource, projectId: options.projectId });
      if (result.ran) console.log(`[FailureTaxonomy] ${result.reason}${result.filed.length ? `: ${result.filed.join(', ')}` : ''}`);
    } catch (error) { // cxt-ignore: error_swallow — a failed weekly pass must not take the daemon down
      console.warn('[FailureTaxonomy] weekly pass failed:', error instanceof Error ? error.message : error);
    } finally {
      db.close();
    }
  });
}
