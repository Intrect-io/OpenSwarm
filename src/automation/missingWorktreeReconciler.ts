// ============================================
// OpenSwarm — missing-worktree reconciliation that stops repeating itself
// ============================================
//
// A ledger row can point at a worktree that is gone. Before admission sees it,
// the heartbeat asks origin whether the branch was pushed and GitHub whether a
// PR exists, then clears or parks the row (missingWorktreeDisposition.ts).
//
// The origin lookup used to swallow its error (`catch { failed = true }`),
// retry every heartbeat with no backoff and no state change, and await each
// `git ls-remote` (30 s timeout) one after another at the front of the
// heartbeat. Round-1 redteam B-F3 (2026-11-03) measured the result on the live
// daemon: 22,204 of a day's 68,629 log lines (32%) were "Origin branch lookup
// failed … retaining pointer" — 61 issues × 364 — with the cause nowhere.
//
// Now a failed lookup is classified:
//   - permanent (authentication, no such remote/repository, the project path
//     is gone): the row parks NEEDS_HUMAN with the cause, which also clears
//     the pointer, so it is never probed again;
//   - transient (network, timeout, anything unrecognised): logged once with
//     its cause, then backed off per run — 5 min doubling to 6 h — in a table
//     of the automation database, so a restart does not reset it.
// Probes run concurrently (CONCURRENCY at a time) and a row inside its backoff
// is skipped without a probe or a log line.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { defaultAutomationDbPath } from './automationDbPath.js';
import { missingWorktreeDisposition } from './missingWorktreeDisposition.js';
import type { RunRecord } from './runLedgerTypes.js';

const execFileAsync = promisify(execFile);

const CONCURRENCY = 4;
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;

export type OriginLookupFailureKind = 'permanent' | 'transient';

const PERMANENT_PATTERNS: RegExp[] = [
  /authentication failed/i,
  /could not read (?:username|password)/i,
  /terminal prompts disabled/i,
  /permission denied \(publickey/i,
  /\b403\b/,
  /repository not found/i,
  /does not appear to be a git repository/i,
  /no such remote/i,
  /not a git repository/i,
  /cannot change to/i,
  /no such file or directory/i,
];

/** Permanent failures no retry can fix; everything else is treated as transient. */
export function classifyOriginLookupFailure(error: unknown): { kind: OriginLookupFailureKind; cause: string } {
  const err = error as { message?: string; stderr?: string; code?: string | number; killed?: boolean } | undefined;
  const text = `${err?.stderr ?? ''}\n${err?.message ?? String(error)}`;
  // The last informative line, not the whole `Command failed: git -C …` echo.
  const cause = text.split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Command failed:')).pop()
    ?? (err?.killed ? 'timed out' : 'unknown error');
  if (err?.killed || err?.code === 'ETIMEDOUT') return { kind: 'transient', cause: `timed out after ${PROBE_TIMEOUT_MS / 1000}s` };
  if (err?.code === 'ENOENT') return { kind: 'permanent', cause: 'git is not installed or the project path is gone' };
  return { kind: PERMANENT_PATTERNS.some((pattern) => pattern.test(text)) ? 'permanent' : 'transient', cause: cause.slice(0, 300) };
}

/** Delay after the `failures`-th consecutive transient failure. */
export function originLookupBackoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(16, failures - 1)));
}

export interface OriginLookupBackoff {
  failures: number;
  nextAt: number;
  cause: string;
}

/** Per-run backoff state; durable when the automation database is available. */
export interface OriginLookupBackoffStore {
  get(issueId: string): OriginLookupBackoff | undefined;
  set(issueId: string, value: OriginLookupBackoff): void;
  clear(issueId: string): void;
  /** Drop every row whose run is not in `issueIds` (its incident ended some other way). */
  retainOnly(issueIds: ReadonlySet<string>): void;
}

export function memoryBackoffStore(): OriginLookupBackoffStore {
  const map = new Map<string, OriginLookupBackoff>();
  return {
    get: (id) => map.get(id),
    set: (id, v) => { map.set(id, v); },
    clear: (id) => { map.delete(id); },
    retainOnly: (ids) => { for (const id of map.keys()) if (!ids.has(id)) map.delete(id); },
  };
}

let sqliteStore: { path: string; store: OriginLookupBackoffStore } | undefined;

/** Backoff rows in the automation database; falls back to memory if it cannot be opened. */
export function sqliteBackoffStore(path = defaultAutomationDbPath()): OriginLookupBackoffStore {
  if (sqliteStore?.path === path) return sqliteStore.store;
  let store: OriginLookupBackoffStore;
  try {
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS automation_origin_lookup_backoff (
        issue_id TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        next_at INTEGER NOT NULL,
        cause TEXT NOT NULL
      );
    `);
    const get = db.prepare('SELECT failures, next_at AS nextAt, cause FROM automation_origin_lookup_backoff WHERE issue_id = ?');
    const set = db.prepare(`
      INSERT INTO automation_origin_lookup_backoff(issue_id, failures, next_at, cause) VALUES (?, ?, ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET failures = excluded.failures, next_at = excluded.next_at, cause = excluded.cause
    `);
    const clear = db.prepare('DELETE FROM automation_origin_lookup_backoff WHERE issue_id = ?');
    const ids = db.prepare('SELECT issue_id AS id FROM automation_origin_lookup_backoff');
    store = {
      get: (id) => get.get(id) as OriginLookupBackoff | undefined,
      set: (id, v) => { set.run(id, v.failures, v.nextAt, v.cause); },
      clear: (id) => { clear.run(id); },
      retainOnly: (keep) => {
        const stale = (ids.all() as Array<{ id: string }>).map((row) => row.id).filter((id) => !keep.has(id));
        if (stale.length) db.transaction(() => { for (const id of stale) clear.run(id); })();
      },
    };
  } catch (error) {
    console.warn('[Reconciler] Origin lookup backoff store unavailable, keeping it in memory:', error instanceof Error ? error.message : error);
    store = memoryBackoffStore();
  }
  sqliteStore = { path, store };
  return store;
}

/** Drop the cached handle so the next call re-resolves the path. Tests redirect the DB. */
export function resetOriginLookupBackoffForTests(): void {
  sqliteStore = undefined;
}

type ReconcileRun = Pick<RunRecord, 'issueId' | 'identifier' | 'state' | 'stateVersion' | 'worktreePath' | 'branchName' | 'projectPath'>;

export interface MissingWorktreeReconcileDeps {
  durableRuns: {
    isPrimary: boolean;
    listRuns(): ReconcileRun[];
    reconcileMissingWorktree(run: ReconcileRun, disposition: 'published' | 'needs_human' | 'clear', reason: string, clearHeadSha: boolean): boolean;
  };
  stopping: () => boolean;
  findPullRequestForBranch: (projectPath: string, branch: string) => Promise<{ url: string; isDraft?: boolean } | null | undefined>;
  findDuplicateIssuePRs: (projectPath: string, identifier: string, branch: string) => Promise<unknown[]>;
  /** Defaults to `git ls-remote origin refs/heads/<branch>` in the project. */
  lsRemote?: (projectPath: string, branch: string) => Promise<string>;
  worktreeExists?: (path: string) => boolean;
  store?: OriginLookupBackoffStore;
  now?: () => number;
  log?: Pick<Console, 'log' | 'warn'>;
}

async function defaultLsRemote(projectPath: string, branch: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', projectPath, 'ls-remote', 'origin', `refs/heads/${branch}`], { timeout: PROBE_TIMEOUT_MS });
  return stdout;
}

/** Run `task` over `items`, at most `limit` at a time. */
async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

type Probe = { run: ReconcileRun; branchOnOrigin: boolean } | null;

/** Sweep stale ledger pointers before artifact recovery or pruning can act on them. */
export async function reconcileMissingWorktrees(deps: MissingWorktreeReconcileDeps): Promise<void> {
  const { durableRuns } = deps;
  if (!durableRuns.isPrimary || deps.stopping()) return;
  const log = deps.log ?? console;
  const now = deps.now ?? Date.now;
  const store = deps.store ?? sqliteBackoffStore();
  const exists = deps.worktreeExists ?? existsSync;
  const lsRemote = deps.lsRemote ?? defaultLsRemote;
  const terminal = new Set(['DONE', 'DECOMPOSED', 'CANCELLED']);

  const candidates = durableRuns.listRuns().filter((run) => !terminal.has(run.state)
    && run.worktreePath && !exists(run.worktreePath)
    && ['READY', 'RETRY_AT', 'NEEDS_HUMAN'].includes(run.state));
  // A run whose pointer cleared, whose worktree came back, or that finished
  // another way ends its incident; its backoff must not carry over to the next
  // one, which would then start silent at the long delay (round-2 redteam B-F3).
  store.retainOnly(new Set(candidates.map((run) => run.issueId)));

  const probes = await pool<ReconcileRun, Probe>(candidates, CONCURRENCY, async (run) => {
    if (deps.stopping()) return null;
    const label = run.identifier ?? run.issueId;
    if (!run.branchName) return { run, branchOnOrigin: false };
    const backoff = store.get(run.issueId);
    if (backoff && backoff.nextAt > now()) return null;
    try {
      const branchOnOrigin = Boolean((await lsRemote(run.projectPath, run.branchName)).trim());
      if (backoff) {
        store.clear(run.issueId);
        log.log(`[Reconciler] Origin branch lookup for ${label} works again after ${backoff.failures} failure(s)`);
      }
      return { run, branchOnOrigin };
    } catch (error) {
      const { kind, cause } = classifyOriginLookupFailure(error);
      if (kind === 'permanent') {
        store.clear(run.issueId);
        const reason = `Origin branch lookup for the missing worktree failed and retrying cannot fix it: ${cause}. `
          + 'Check the repository remote and the daemon\'s git credentials, then release the run.';
        if (durableRuns.reconcileMissingWorktree(run, 'needs_human', reason, false)) {
          log.warn(`[Reconciler] ${label}: parked for a person — origin lookup fails permanently (${cause})`);
        }
        return null;
      }
      const failures = (backoff?.failures ?? 0) + 1;
      const delay = originLookupBackoffMs(failures);
      store.set(run.issueId, { failures, nextAt: now() + delay, cause });
      if (failures === 1) {
        log.warn(`[Reconciler] Origin branch lookup failed for missing worktree ${label} (${cause}); retaining pointer, next try in ${Math.round(delay / 60_000)} min with backoff`);
      }
      return null;
    }
  });

  for (const probe of probes) {
    if (deps.stopping()) return;
    if (!probe) continue;
    const { run, branchOnOrigin } = probe;
    const label = run.identifier ?? run.issueId;
    let pr;
    if (run.branchName) {
      try {
        pr = await deps.findPullRequestForBranch(run.projectPath, run.branchName);
      } catch (error) {
        log.warn(`[Reconciler] GitHub lookup failed for missing worktree ${label}; retaining pointer:`, error);
        continue;
      }
    }
    const prefix = `Worktree gone before publication; branch \`${run.branchName ?? '(none)'}\` ${branchOnOrigin ? 'is on origin' : 'is not on origin'}`;
    // Only a draft on a RETRY_AT row can be the leftover of an unfinished
    // attempt, so only then pay for the sibling lookup (AGT-4664).
    const siblingPullRequestCount = pr?.isDraft && run.state === 'RETRY_AT' && run.identifier && run.branchName
      ? (await deps.findDuplicateIssuePRs(run.projectPath, run.identifier, run.branchName)).length
      : 0;
    const disposition = missingWorktreeDisposition({
      state: run.state,
      hasPullRequest: Boolean(pr),
      pullRequestIsDraft: Boolean(pr?.isDraft),
      siblingPullRequestCount,
    });
    if (durableRuns.reconcileMissingWorktree(run, disposition, pr ? `${prefix}; PR exists: ${pr.url}` : prefix, !branchOnOrigin)) {
      log.log(`[Reconciler] ${label}: cleared missing worktree pointer (${disposition})`);
    }
  }
}
