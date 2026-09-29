// ============================================
// OpenSwarm — durable reuse of an already-computed review verdict (Tier 1)
// ============================================
//
// Measured over the recorded review history (530 records, 512 with a verdict):
// 68 pairs share an identical file set with every file hash equal, and 15 of
// those are same-mode repeats — 8 direct→direct, 7 pr→pr. Replaying the same
// diff through the same reviewer returned the same verdict in 10 of the 15; the
// other 53 pairs pair a CLI review with a publication review, where the prompt,
// the base and the tool exposure all differ, so they are NOT the same review and
// are deliberately not reachable from one key. Reviewer cost is ~$0.26 and p50
// 93s / max 340s per call, so those 10 are real money and real wall clock.
//
// The in-process Set in publicationReviewHook.ts:28 covers only repeats inside
// one process, and the failure census records 141 `owner_process_exited` + 157
// `shutdown_cancelled` — every daemon restart throws that memory away and pays
// again for a diff whose verdict is already known.
//
// Its own table in automation.db rather than a column on `automation_runs`: that
// row is keyed by issue and rewritten as the run moves (`registerRun`, the
// scheduling observator), while this key is the review's identity and must be
// reachable by a process that has no run row at all — `openswarm review` in CI
// against a checkout the daemon has never seen.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import type { ReviewResult } from '../agents/agentPair.js';
import { defaultAutomationDbPath } from './automationDbPath.js';
import { DEFAULT_BUSY_TIMEOUT_MS, enableWalWithRetry } from '../support/sqliteWal.js';

// This package is ESM, so `require` does not exist here, and the native module is
// loaded at open time rather than at import time. `openswarm review` runs on
// machines that have never opened a database, and a missing or ABI-mismatched
// better-sqlite3 must cost those runs a recomputed verdict, not a crash. Same
// reasoning (and same shape) as coordinationTrace.ts:27.
const require = createRequire(import.meta.url);

/** What `reviewPublishedPullRequest` returns (prPublicationReview.ts:20). */
export interface PublicationReviewOutcome {
  success: boolean;
  error?: string;
  gateRan?: boolean;
  changesRequested?: boolean;
}

/**
 * The identity of a review — what its verdict actually depends on.
 *
 * `kind` is the review mode ('direct' | 'pr' | ... as recorded in
 * `.openswarm/review-history`), `base` the ref it diffed against, `digest` the
 * exact content it read. All three belong here: the same tree reviewed as a CLI
 * direct review and as a PR review is not the same review (measured 15 of 53
 * cross-mode repeats flipped), and the same content diffed against a different
 * base is not either.
 */
export interface ReviewVerdictKey {
  kind: string;
  base: string;
  digest: string;
  /** Context only, never part of the key: which publication this verdict came from. */
  prUrl?: string;
  headSha?: string;
}

/** The mode a publication review is stored under. A CLI review can never share it. */
export const PUBLICATION_REVIEW_KIND = 'publication';

/**
 * How long a stored verdict stays usable.
 *
 * The digest pins the reviewed content, so staleness of the diff itself is
 * impossible. What can move underneath a row is everything else the reviewer's
 * answer depended on: the base branch the PR is now diffed against, the prompt,
 * the model, the history context. This is the bound on that window — long enough
 * to span a redeploy and RETRY_AT backoff (the gap it exists to cross), short
 * enough that a verdict cannot be replayed a day later into a different world.
 * Same shape and same reasoning as DRAFT_CACHE_TTL_MS (draftCache.ts:47).
 */
export const REVIEW_VERDICT_TTL_MS = 12 * 60 * 60 * 1000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The digest for a tree review, or undefined when the hashes do not cover every
 * file that was reviewed.
 *
 * An incomplete hash set is not a weaker identity, it is the wrong one: two
 * unrelated reviews whose hashes are both empty (an injected history stub, a
 * caller that never computed them) would share a digest, and the second would
 * replay the first's verdict for a diff it never saw. A miss costs one review;
 * a false hit costs the gate.
 */
export function reviewContentDigest(
  files: Iterable<string>,
  contentHashes: Record<string, string>,
): string | undefined {
  // Normalized the way reviewHistory.ts does, because these come from different
  // checkouts on different platforms and `./a.ts` vs `a.ts` must not be two
  // different reviews.
  const normalize = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '');
  const normalized = [...new Set([...files].map(normalize))].sort();
  if (normalized.length === 0) return undefined;
  // The hash map is normalized too, not just the file list: the two arrive from
  // different callers (`captureReviewFileHashes`, an injected history stub) and a
  // spelling mismatch between them would silently drop a file from the digest
  // and make the whole set incomplete — a miss, never a wrong hit, but a miss
  // this cache exists to avoid.
  const hashByPath = new Map(Object.entries(contentHashes).map(([path, hash]) => [normalize(path), hash]));
  const lines: string[] = [];
  for (const file of normalized) {
    const hash = hashByPath.get(file);
    if (typeof hash !== 'string' || hash.length === 0) return undefined;
    lines.push(`${file}\u0000${hash}`);
  }
  return sha256(lines.join('\n'));
}

/** The identity of a publication review: the PR and the commit it reviewed. */
export function publicationReviewKey(input: { prUrl: string; headSha: string }): ReviewVerdictKey {
  return {
    kind: PUBLICATION_REVIEW_KIND,
    base: '',
    digest: sha256(`${input.prUrl}\u0000${input.headSha}`),
    prUrl: input.prUrl,
    headSha: input.headSha,
  };
}

/** The identity of a CLI review of a tree. Undefined when the content cannot be pinned. */
export function cliReviewKey(input: {
  kind: string;
  base?: string;
  files: Iterable<string>;
  contentHashes: Record<string, string>;
}): ReviewVerdictKey | undefined {
  const digest = reviewContentDigest(input.files, input.contentHashes);
  if (!digest) return undefined;
  return { kind: input.kind, base: input.base ?? '', digest };
}

function parsePublicationOutcome(json: string): PublicationReviewOutcome | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Unparseable is a miss, not a delete: whatever wrote a half row will
    // overwrite it, and a reader that cannot parse must not also be one that
    // prunes. The row is simply never a hit.
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const outcome = parsed as PublicationReviewOutcome;
  // Every field the hook decides on is type-checked, because these three decide
  // whether a publication is rolled back. A row whose shape we do not recognise
  // must be a miss: reading `changesRequested: undefined` off a mangled row would
  // replay a rejection as an approval, which is the one direction this store is
  // not allowed to be wrong in.
  if (typeof outcome.success !== 'boolean') return undefined;
  if (outcome.error !== undefined && typeof outcome.error !== 'string') return undefined;
  if (outcome.gateRan !== undefined && typeof outcome.gateRan !== 'boolean') return undefined;
  if (outcome.changesRequested !== undefined && typeof outcome.changesRequested !== 'boolean') return undefined;
  return outcome;
}

function parseReviewResult(json: string): ReviewResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const review = parsed as ReviewResult;
  // Minimal on purpose: the store only ever reads back what `record` wrote, so
  // what needs checking is the field the gate, the exit code and `--json` all
  // branch on. Optional sections are read defensively everywhere downstream.
  if (review.decision !== 'approve' && review.decision !== 'revise' && review.decision !== 'reject') return undefined;
  if (typeof review.feedback !== 'string') return undefined;
  return review;
}

/**
 * A verdict, remembered across process restarts.
 *
 * One row per review identity; the last writer wins, and a later verdict for the
 * same identity replaces the earlier one rather than accumulating. Reads never
 * throw out of a caller that would rather review than reuse — that policy lives
 * in `readStoredVerdict`/`recordStoredVerdict`, which both call sites use so it
 * is stated in exactly one place.
 */
export class ReviewVerdictStore {
  private readonly db: Database.Database;
  private closed = false;

  constructor(dbPath: string) {
    if (!dbPath.trim()) throw new Error('ReviewVerdictStore needs an explicit database path');
    // better-sqlite3 will not create the parent directory, and ~/.openswarm does
    // not exist on a fresh install.
    mkdirSync(dirname(dbPath), { recursive: true });
    const Sqlite = require('better-sqlite3') as typeof Database;
    const db = new Sqlite(dbPath);
    try {
      // The daemon, the CLI and the dashboard open this file at the same moment,
      // so the wait policy goes in before WAL is negotiated and the one-time
      // conversion retries rather than failing the open on a busy file.
      db.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
      enableWalWithRetry(db, DEFAULT_BUSY_TIMEOUT_MS);
      db.exec(`
        CREATE TABLE IF NOT EXISTS publication_reviews (
          kind TEXT NOT NULL,
          base TEXT NOT NULL,
          content_digest TEXT NOT NULL,
          pr_url TEXT,
          head_sha TEXT,
          outcome_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (kind, base, content_digest)
        );
        CREATE INDEX IF NOT EXISTS idx_publication_reviews_created
          ON publication_reviews(created_at);
      `);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
  }

  /** The stored publication outcome, or undefined when this publication was never reviewed. */
  lookupPublication(key: ReviewVerdictKey, now: number = Date.now()): PublicationReviewOutcome | undefined {
    const row = this.readRow(key, now);
    return row === undefined ? undefined : parsePublicationOutcome(row.outcome_json);
  }

  /** The stored CLI verdict for this exact content, or undefined when there is none. */
  lookupReview(key: ReviewVerdictKey, now: number = Date.now()): ReviewResult | undefined {
    const row = this.readRow(key, now);
    return row === undefined ? undefined : parseReviewResult(row.outcome_json);
  }

  /**
   * Store a verdict under its own identity.
   *
   * The payload is serialized as given rather than rebuilt field by field: a
   * field the processor starts returning later is persisted by this line without
   * anyone remembering to add it here, and a replay that dropped it would diverge
   * from the review it replaces.
   */
  record(key: ReviewVerdictKey, payload: PublicationReviewOutcome | ReviewResult, now: number = Date.now()): void {
    this.db.prepare(`
      INSERT INTO publication_reviews(kind, base, content_digest, pr_url, head_sha, outcome_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, base, content_digest) DO UPDATE SET
        pr_url = excluded.pr_url,
        head_sha = excluded.head_sha,
        outcome_json = excluded.outcome_json,
        created_at = excluded.created_at
    `).run(
      key.kind,
      key.base,
      key.digest,
      key.prUrl ?? null,
      key.headSha ?? null,
      JSON.stringify(payload),
      now,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private readRow(key: ReviewVerdictKey, now: number): { outcome_json: string } | undefined {
    const row = this.db.prepare(`
      SELECT outcome_json, created_at FROM publication_reviews
      WHERE kind = ? AND base = ? AND content_digest = ?
    `).get(key.kind, key.base, key.digest) as { outcome_json: string; created_at: number } | undefined;
    if (!row) return undefined;
    if (now - row.created_at > REVIEW_VERDICT_TTL_MS) {
      // Expired for every reader, so it goes rather than being skipped forever.
      // Expiry is what keeps the table to the reviews that could still be reused.
      this.db.prepare('DELETE FROM publication_reviews WHERE kind = ? AND base = ? AND content_digest = ?')
        .run(key.kind, key.base, key.digest);
      return undefined;
    }
    return row;
  }
}

/** Just enough of the store for a caller that only reads and writes verdicts. */
export type ReviewVerdictStoreLike = Pick<ReviewVerdictStore, 'lookupPublication' | 'lookupReview' | 'record'>;

let store: ReviewVerdictStore | undefined;
let openedPath: string | undefined;
let unavailablePath: string | undefined;

/**
 * The shared store at the deployment's automation database, or undefined when it
 * cannot be opened.
 *
 * A cache is an optimisation. A read-only mount, a full disk or a database left
 * behind by a newer schema must cost a recomputed verdict — exactly what the
 * caller did before this existed — never a failed review. The failure is
 * remembered per path so a deployment whose database cannot be opened does not
 * pay a synchronous open attempt and a warning per review, and a path change (a
 * test redirecting OPENSWARM_AUTOMATION_DB, a deployment relocating its state)
 * gets a fresh attempt.
 */
export function getReviewVerdictStore(): ReviewVerdictStore | undefined {
  const path = defaultAutomationDbPath();
  if (store && openedPath === path) return store;
  if (store) {
    // A different file means a different deployment or a test redirect; drop the
    // old handle rather than answering from the previous database.
    try { store.close(); } catch { /* a handle being replaced anyway */ }
    store = undefined;
    openedPath = undefined;
  }
  if (unavailablePath === path) return undefined;
  try {
    store = new ReviewVerdictStore(path);
    openedPath = path;
    unavailablePath = undefined;
    return store;
  } catch (error) {
    unavailablePath = path;
    console.warn(
      '[ReviewVerdictStore] Unavailable, reviews will be recomputed:',
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

/** Drop the handle so the next call re-resolves the path. Tests redirect the database. */
export function resetReviewVerdictStoreForTests(): void {
  if (store) { try { store.close(); } catch { /* already closed */ } }
  store = undefined;
  openedPath = undefined;
  unavailablePath = undefined;
}

/**
 * A miss on any failure.
 *
 * This is the whole fail-open policy in one place: a store that cannot be read
 * must never suppress a review, and must never fail the run that asked. Both the
 * publication hook and the CLI read through here rather than each deciding for
 * themselves — a cache that fails closed is a gate that stops running work.
 */
function readOrMiss<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch (error) {
    console.warn(
      '[ReviewVerdictStore] Read failed, the review will run:',
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

/** The stored publication outcome for this exact review, or undefined to review it again. */
export function lookupStoredPublication(
  store: ReviewVerdictStoreLike | undefined,
  key: ReviewVerdictKey | undefined,
  now: number = Date.now(),
): PublicationReviewOutcome | undefined {
  if (!store || !key) return undefined;
  return readOrMiss(() => store.lookupPublication(key, now));
}

/** The stored CLI verdict for this exact content, or undefined to review it again. */
export function lookupStoredReview(
  store: ReviewVerdictStoreLike | undefined,
  key: ReviewVerdictKey | undefined,
  now: number = Date.now(),
): ReviewResult | undefined {
  if (!store || !key) return undefined;
  return readOrMiss(() => store.lookupReview(key, now));
}

/** Best-effort write: failing to remember a verdict costs one recomputation. */
export function recordStoredVerdict(
  store: ReviewVerdictStoreLike | undefined,
  key: ReviewVerdictKey | undefined,
  payload: PublicationReviewOutcome | ReviewResult,
  now: number = Date.now(),
): void {
  if (!store || !key) return;
  try {
    store.record(key, payload, now);
  } catch (error) {
    console.warn(
      '[ReviewVerdictStore] Write failed, the verdict will not be reused:',
      error instanceof Error ? error.message : error,
    );
  }
}
