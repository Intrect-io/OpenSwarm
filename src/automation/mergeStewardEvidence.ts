// Created: 2026-11-21
// Purpose: review, completeness and risk evidence for the merge steward, read from the run ledger and the steward verdict ledger (AGT-4803)
// Dependencies: ./mergeStewardGuards (types), ./stewardVerdictLedger (read-only lookup), better-sqlite3 (lazy, read-only), node:fs
// Test Status: mergeStewardEvidence.test.ts

/**
 * Evidence the steward reads from local stores, never from GitHub:
 * - the run ledger (`automation_runs` / `automation_attempts`): which run published
 *   the PR, at which head, in which state, with which stored risk class;
 * - the steward verdict ledger (`steward_verdicts`): the reviewer's decision bound
 *   to the exact commit it reviewed.
 * Both are opened read-only. A missing database is "no evidence"; one that exists
 * but cannot be read throws, and the collector notes it. Either way the engine refuses.
 */

import { existsSync } from 'node:fs';
import type {
  StewardCompleteness,
  StewardReview,
  StewardRisk,
  StewardRiskLevel,
} from './mergeStewardGuards.js';
import { lookupStewardVerdict, type StewardVerdictRecord } from './stewardVerdictLedger.js';

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

/**
 * Stored reviewer verdict for a PR: the record for `headSha` when there is one,
 * else the newest record for the PR (so a stale verdict can be named), else null.
 * Callers still compare `reviewedSha` with the head themselves.
 */
export type StewardVerdictLookup = (prUrl: string, headSha: string) => StewardVerdictRecord | null | Promise<StewardVerdictRecord | null>;

/** A verdict lookup outcome: the record (or null), or why it could not be read. */
export type StoredVerdictEvidence =
  | { record: StewardVerdictRecord | null; error?: undefined }
  | { record?: undefined; error: string };

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
 * Read-only run-ledger lookup. A missing database is "no evidence" (null); a database
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

/**
 * Read-only verdict lookup on the automation database: the exact (PR, head) row,
 * else the newest row for the PR. A missing database or table is null; a database
 * that exists but cannot be read throws.
 */
export function createVerdictLookup(dbPath: string): StewardVerdictLookup {
  return async (prUrl, headSha) => {
    const exact = lookupStewardVerdict(prUrl, headSha, dbPath);
    if (exact || !existsSync(dbPath)) return exact;
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steward_verdicts'").get();
      if (!table) return null;
      const row = db.prepare(
        'SELECT reviewed_sha, verdict, coverage, recorded_at FROM steward_verdicts WHERE pr_url = ? ORDER BY recorded_at DESC LIMIT 1',
      ).get(prUrl) as { reviewed_sha: string; verdict: StewardVerdictRecord['verdict']; coverage: StewardVerdictRecord['coverage']; recorded_at: string } | undefined;
      if (!row) return null;
      return { prUrl, reviewedSha: row.reviewed_sha, verdict: row.verdict, coverage: row.coverage, recordedAt: row.recorded_at };
    } finally {
      db.close();
    }
  };
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200);
}

/** Run a verdict lookup; a sync throw or a rejection becomes an `error`. */
export async function readStoredVerdict(lookup: StewardVerdictLookup, prUrl: string, headSha: string): Promise<StoredVerdictEvidence> {
  try {
    return { record: (await lookup(prUrl, headSha)) ?? null };
  } catch (err) {
    return { error: errorText(err) };
  }
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
export const CLEAN_PUBLISHED_STATES: ReadonlySet<string> = new Set(['SYNC_PENDING', 'DONE']);

export interface ReviewEvidenceInput {
  /** The PR's current head. */
  headSha: string;
  pr: { body: string; title: string; isDraft: boolean };
  ledger: StewardLedgerEvidence | null;
  verdict: StoredVerdictEvidence;
}

export interface ReviewEvidenceResult {
  review: StewardReview | null;
  completeness: StewardCompleteness | null;
  note: string;
}

/**
 * Reviewer verdict and completeness. Approve/complete only when ALL hold: a stored
 * 'approve' whose reviewed sha is the current head, a ledger run bound to that head
 * in a clean published state, a non-draft PR, a `Closes <issue>` line on a title not
 * marked [partial], and stored coverage that is not 'partial'. Anything else is a
 * non-approve review with a note naming why.
 */
export function reviewEvidence(input: ReviewEvidenceInput): ReviewEvidenceResult {
  const { headSha, pr, ledger, verdict } = input;
  const refuse = (note: string, completeness: StewardCompleteness['verdict'] = 'unknown', boundTo = headSha): ReviewEvidenceResult => ({
    review: { verdict: 'unknown', headSha: boundTo },
    completeness: { verdict: completeness, headSha: boundTo },
    note,
  });
  if (verdict.error !== undefined) return refuse(`stored reviewer verdict unreadable (${verdict.error}): no approval counts`);
  const record = verdict.record;
  if (!record) {
    return { review: null, completeness: null, note: `no stored reviewer verdict for head ${headSha}` };
  }
  if (record.reviewedSha !== headSha) {
    // Bound to the reviewed sha, so the guard's own binding check names both commits.
    return refuse(`stored verdict is for ${record.reviewedSha}, head is ${headSha}`, 'unknown', record.reviewedSha);
  }
  if (record.verdict !== 'approve') {
    return {
      review: { verdict: 'reject', headSha },
      completeness: { verdict: 'unknown', headSha },
      note: `stored reviewer verdict at head ${headSha.slice(0, 12)} is ${record.verdict}`,
    };
  }
  if (!ledger?.headSha) return refuse('no ledger run binds this PR to a published head');
  if (ledger.headSha !== headSha) return refuse(`ledger run published ${ledger.headSha}, head is ${headSha}`);
  if (!CLEAN_PUBLISHED_STATES.has(ledger.state)) {
    // e.g. NEEDS_RECONCILE after a PR-time review rollback: the body may still say Closes.
    return refuse(`ledger run is ${ledger.state}, not cleanly published: no approval counts`);
  }
  if (pr.isDraft) return refuse('PR is a draft: it never earned a review');
  const body = normalizeBody(pr.body);
  const issue = ledger.identifier ? escapeRegExp(ledger.identifier) : '[A-Z][A-Z0-9]*-\\d+';
  const closes = new RegExp(`^Closes ${issue}\\s*$`, 'm').test(body);
  const refs = new RegExp(`^Refs ${issue}\\s*$`, 'm').test(body);
  const partialTitle = /^\s*\[partial\]/i.test(pr.title);
  if (partialTitle) return refuse('PR title is marked [partial]', 'partial');
  if (!closes) return refuse(`PR body has no Closes ${ledger.identifier ?? '<issue>'} line`, refs ? 'partial' : 'unknown');
  if (record.coverage === 'partial') return refuse('stored reviewer coverage is partial', 'partial');
  // A null coverage is not partial: the fresh publication review never sees the issue
  // text, so it is no evidence either way, and the Closes line is the completeness signal.
  return {
    review: { verdict: 'approve', headSha },
    completeness: { verdict: 'complete', headSha },
    note: `stored reviewer approve at head ${headSha.slice(0, 12)}, coverage ${record.coverage ?? 'not recorded'}, Closes on a non-partial PR`,
  };
}
