// ============================================
// OpenSwarm - GitHub Integration (via gh CLI)
// ============================================

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { atomicWriteFile } from '../support/atomicFile.js';
import { getDateLocale } from '../locale/index.js';

const execFileAsync = promisify(execFile);

/** Safe gh CLI execution (no shell interpolation) */
async function ghExec(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function ghExecLarge(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const REPO_SCAN_CONCURRENCY = 5;
const BLOCKING_CONCLUSIONS = new Set([
  'failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale',
]);

export function isBlockingConclusion(conclusion: string): boolean {
  return BLOCKING_CONCLUSIONS.has(conclusion.toLowerCase());
}

export type PRCheck = { name: string; status: string; conclusion: string };

function normalizePRCheck(c: any): PRCheck {
  const name = String(c.name ?? c.context ?? 'unknown');
  const bucket = String(c.bucket ?? '').toLowerCase();
  const state = String(c.state ?? c.status ?? '').toLowerCase();
  const conclusion = String(c.conclusion ?? '').toLowerCase();
  // `gh pr checks` supplies bucket+state. `gh pr view`'s statusCheckRollup
  // instead supplies status+conclusion for CheckRun entries and state for
  // StatusContext entries. Prefer a completed check's conclusion so both
  // surfaces normalize to the same durable shape.
  const signal = bucket || (state === 'completed' ? conclusion : state) || conclusion;

  switch (signal) {
    case 'pass':
    case 'success':
      return { name, status: 'completed', conclusion: 'success' };
    case 'fail':
    case 'failure':
    case 'startup_failure':
      return { name, status: 'completed', conclusion: 'failure' };
    case 'timed_out':
      return { name, status: 'completed', conclusion: 'timed_out' };
    case 'pending':
    case 'queued':
    case 'in_progress':
    case 'requested':
    case 'waiting':
      return { name, status: 'pending', conclusion: 'pending' };
    case 'action_required':
      return { name, status: 'completed', conclusion: 'action_required' };
    case 'stale':
      return { name, status: 'completed', conclusion: 'stale' };
    case 'skipping':
    case 'skipped':
    case 'neutral':
      return { name, status: 'completed', conclusion: 'skipped' };
    case 'cancel':
    case 'cancelled':
      return { name, status: 'completed', conclusion: 'cancelled' };
    default:
      return { name, status: state || 'unknown', conclusion: conclusion || state || 'unknown' };
  }
}

/**
 * Failed Workflow Run
 */
export type FailedRun = {
  id: number;
  name: string;
  branch: string;
  repo: string;
  createdAt: string;
  url: string;
};

/**
 * GitHub Notification
 */
export type GitHubNotification = {
  id: string;
  reason: string;
  title: string;
  repo: string;
  type: string;
  updatedAt: string;
  url?: string;
};

/**
 * Get failed workflow runs for a specific repo
 */
export async function getFailedRuns(
  repo: string,
  limit: number = 5
): Promise<FailedRun[]> {
  try {
    const stdout = await ghExec(
      'run', 'list', '-R', repo, '-s', 'failure',
      '--json', 'databaseId,name,headBranch,createdAt,url', '-L', String(limit)
    );

    const runs = JSON.parse(stdout);
    return runs.map((run: any) => ({
      id: run.databaseId,
      name: run.name,
      branch: run.headBranch,
      repo,
      createdAt: run.createdAt,
      url: run.url ?? `https://github.com/${repo}/actions/runs/${run.databaseId}`,
    }));
  } catch (err) {
    console.error(`Failed to get failed runs for ${repo}:`, err);
    return [];
  }
}

/**
 * Get failed runs across all registered repos
 */
export async function getAllFailedRuns(
  repos: string[],
  limit: number = 3
): Promise<FailedRun[]> {
  const results: FailedRun[][] = Array.from({ length: repos.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(REPO_SCAN_CONCURRENCY, repos.length) }, async () => {
    while (next < repos.length) {
      const index = next++;
      results[index] = await getFailedRuns(repos[index], limit);
    }
  });
  await Promise.all(workers);
  return results.flat().sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Get GitHub notifications
 */
export async function getNotifications(
  limit: number = 10
): Promise<GitHubNotification[]> {
  try {
    const stdout = await ghExec(
      'api', '/notifications', '--jq',
      '.[] | {id, reason, title: .subject.title, type: .subject.type, repo: .repository.full_name, updated: .updated_at, url: .subject.url}'
    );

    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.slice(0, limit).map((line) => {
      const n = JSON.parse(line);
      return {
        id: n.id,
        reason: n.reason,
        title: n.title,
        repo: n.repo,
        type: n.type,
        updatedAt: n.updated,
        url: n.url,
      };
    });
  } catch (err) {
    console.error('Failed to get notifications:', err);
    return [];
  }
}

/**
 * Filter CI-related notifications only
 */
export async function getCINotifications(): Promise<GitHubNotification[]> {
  const notifications = await getNotifications(50);
  return notifications.filter(
    (n) => n.reason === 'ci_activity' || n.title.toLowerCase().includes('failed')
  );
}

/**
 * Mark a specific notification as read
 */
export async function markNotificationRead(threadId: string): Promise<void> {
  try {
    await ghExec('api', '-X', 'PATCH', `/notifications/threads/${threadId}`);
  } catch (err) {
    console.error(`Failed to mark notification ${threadId} as read:`, err);
  }
}

/**
 * Get workflow run details
 */
export async function getRunDetails(
  repo: string,
  runId: number
): Promise<{ jobs: { name: string; conclusion: string; steps: any[] }[] } | null> {
  try {
    const stdout = await ghExec('run', 'view', String(runId), '-R', repo, '--json', 'jobs');
    return JSON.parse(stdout);
  } catch (err) {
    console.error(`Failed to get run details for ${runId}:`, err);
    return null;
  }
}

/**
 * Get workflow run logs (failed jobs only)
 */
export async function getFailedJobLogs(
  repo: string,
  runId: number
): Promise<string> {
  try {
    const stdout = await ghExec('run', 'view', String(runId), '-R', repo, '--log-failed');
    // Limit output to last 100 lines (replaces shell `tail -100`)
    return stdout.split('\n').slice(-100).join('\n');
  } catch (err) {
    console.error(`Failed to get failed job logs for ${runId}:`, err);
    return '';
  }
}

/**
 * Get PR check statuses
 */
export async function getPRChecks(
  repo: string,
  prNumber: number
): Promise<PRCheck[]> {
  try {
    const stdout = await ghExec('pr', 'checks', String(prNumber), '-R', repo, '--json', 'name,state,bucket');
    const checks = JSON.parse(stdout);
    return checks.map(normalizePRCheck);
  } catch (err) {
    console.error(`Failed to get PR checks for ${repo}#${prNumber}:`, err);
    return [];
  }
}

export type PRCISnapshot =
  | { identity: 'known'; headSha: string; checks: PRCheck[] }
  | { identity: 'unknown'; reason: 'head_unavailable' | 'checks_unavailable' };

/**
 * Read the PR head and its check rollup in one GitHub observation.
 *
 * Fetching `headRefOid` separately from `gh pr checks` leaves a race where the
 * branch advances between the two commands and a green result for head A is
 * attributed to head B. `statusCheckRollup` keeps identity and evidence in the
 * same response, and malformed or unavailable identity stays explicitly
 * unknown instead of degrading to an empty (eventually successful) check set.
 */
export async function getPRCISnapshot(repo: string, prNumber: number): Promise<PRCISnapshot> {
  try {
    const stdout = await ghExec(
      'pr', 'view', String(prNumber), '-R', repo,
      '--json', 'headRefOid,statusCheckRollup',
    );
    const view = JSON.parse(stdout) as {
      headRefOid?: unknown;
      statusCheckRollup?: unknown;
    };
    const headSha = typeof view.headRefOid === 'string' ? view.headRefOid.trim() : '';
    if (!headSha) return { identity: 'unknown', reason: 'head_unavailable' };
    if (!Array.isArray(view.statusCheckRollup)) {
      return { identity: 'unknown', reason: 'checks_unavailable' };
    }
    return {
      identity: 'known',
      headSha,
      checks: view.statusCheckRollup.map(normalizePRCheck),
    };
  } catch (err) {
    console.error(`Failed to get PR CI snapshot for ${repo}#${prNumber}:`, err);
    return { identity: 'unknown', reason: 'head_unavailable' };
  }
}

/**
 * Generate CI failure summary
 */
export async function summarizeCIFailures(repos: string[]): Promise<string> {
  const failures = await getAllFailedRuns(repos, 3);

  if (failures.length === 0) {
    return '✅ All CI checks passed';
  }

  const summary = failures.map((f) => {
    const time = new Date(f.createdAt).toLocaleString(getDateLocale());
    return `❌ **${f.repo}** - ${f.name}\n   Branch: ${f.branch}\n   Time: ${time}`;
  });

  return `**${failures.length} CI failure(s):**\n\n${summary.join('\n\n')}`;
}

/**
 * Generate GitHub notification summary
 */
export async function summarizeNotifications(): Promise<string> {
  const notifications = await getNotifications(10);

  if (notifications.length === 0) {
    return '📭 No new notifications';
  }

  const byReason: Record<string, number> = {};
  for (const n of notifications) {
    byReason[n.reason] = (byReason[n.reason] || 0) + 1;
  }

  const breakdown = Object.entries(byReason)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ');

  const recent = notifications.slice(0, 3).map((n) => {
    const emoji = n.reason === 'ci_activity' ? '🔴' : '📬';
    return `${emoji} [${n.repo}] ${n.title}`;
  });

  return `**${notifications.length} GitHub notification(s)** (${breakdown})\n\n${recent.join('\n')}`;
}

// CI State Monitoring (state-based)

const CI_STATE_PATH = resolve(homedir(), '.openswarm', 'ci-state.json');

/** Per-repo health status */
export type RepoHealthStatus = 'healthy' | 'broken' | 'unknown';

/** Active failure per workflow+branch */
export type ActiveFailure = {
  workflow: string;
  branch: string;
  runId: number;
  url: string;
  createdAt: string;
};

/** Repo health state */
export type RepoHealth = {
  repo: string;
  status: RepoHealthStatus;
  activeFailures: ActiveFailure[];
  brokenSince?: string;
  lastReminder?: string;
  lastChecked: string;
};

/** Overall CI state (persisted to file) */
export type CIState = {
  repos: Record<string, RepoHealth>;
  updatedAt: string;
};

/** Health state transition */
export type HealthTransition = {
  repo: string;
  from: RepoHealthStatus;
  to: RepoHealthStatus;
  activeFailures: ActiveFailure[];
  resolvedFailures?: ActiveFailure[];
  brokenSince?: string;
};

/**
 * Load CI state.
 *
 * A missing file is the normal first-run case and stays silent. Anything else —
 * malformed JSON, a permission error — means real brokenSince/lastReminder
 * history is being discarded, silently resetting every repo's health timeline,
 * so it is logged rather than swallowed by a bare catch.
 */
export async function loadCIState(): Promise<CIState> {
  const empty = (): CIState => ({ repos: {}, updatedAt: new Date().toISOString() });
  let data: string;
  try {
    data = await readFile(CI_STATE_PATH, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[CI] Could not read CI state, starting fresh:', err instanceof Error ? err.message : err);
    }
    return empty();
  }
  try {
    return JSON.parse(data);
  } catch (err) {
    console.warn(
      `[CI] CI state at ${CI_STATE_PATH} is corrupt — repo health history is being reset:`,
      err instanceof Error ? err.message : err,
    );
    return empty();
  }
}

/**
 * Save CI state.
 *
 * Atomic because two independent callers (core/service.ts checkGitHubCI and
 * automation/ciWorker.ts) each run their own load → modify → save cycle against
 * this file with no lock. An in-place write lets the other one read a
 * half-written file, which loadCIState would then treat as "no state" and wipe
 * the health history. write-temp + rename means a concurrent reader always sees
 * either the old file or the new one, never a torn one. (This does not make the
 * read-modify-write sequence itself atomic — overlapping runs can still lose an
 * update — but it removes the corruption path.)
 */
export async function saveCIState(state: CIState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await atomicWriteFile(CI_STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Get active failures for a repo.
 * Checks only the latest run per workflow+branch; returns only those with failure conclusion.
 * Ignores failures older than maxAgeDays (stale branch filter).
 * Returns null on error (to avoid state changes).
 */
export async function getActiveFailures(repo: string, maxAgeDays: number = 30): Promise<ActiveFailure[] | null> {
  try {
    const since = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const stdout = await ghExec(
      'api', '--method', 'GET', '--paginate',
      `repos/${repo}/actions/runs`, '-f', 'per_page=100', '-f', `created=>=${since}`,
      '--jq', '.workflow_runs[] | {databaseId: .id, name: .name, headBranch: .head_branch, createdAt: .created_at, conclusion: .conclusion, url: .html_url}',
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    // `gh api --paginate --jq` emits one compact JSON value per matching run.
    // Keep array parsing for tests and older gh versions that aggregate output.
    let runs: any[];
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      runs = Array.isArray(parsed) ? parsed as any[] : [parsed as any];
    } catch {
      runs = trimmed.split('\n').filter(Boolean).map((line) => JSON.parse(line) as any);
    }
    if (runs.length === 0) return [];

    // Keep only the latest run per workflow+branch (gh run list returns newest first)
    const latest = new Map<string, any>();
    for (const run of runs) {
      const key = `${run.name}::${run.headBranch}`;
      if (!latest.has(key)) {
        latest.set(key, run);
      }
    }

    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const failures: ActiveFailure[] = [];
    for (const [, run] of latest) {
      if (isBlockingConclusion(String(run.conclusion ?? ''))) {
        // Ignore old failures from stale branches
        const age = Date.now() - new Date(run.createdAt).getTime();
        if (age > maxAgeMs) continue;
        failures.push({
          workflow: run.name,
          branch: run.headBranch,
          runId: run.databaseId,
          url: run.url ?? `https://github.com/${repo}/actions/runs/${run.databaseId}`,
          createdAt: run.createdAt,
        });
      }
    }

    return failures;
  } catch (err) {
    // ChildProcess errors may retain multi-megabyte stdout/stderr buffers. Passing
    // the whole object to console.error makes Node inspect/stringify those buffers
    // and synchronously flush them to the daemon log, blocking heartbeat/lease
    // timers for seconds. The message carries the actionable command/error code.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[GitHub] Failed to get active failures for ${repo}: ${message}`);
    return null;
  }
}

/**
 * Check repo health and detect state transitions.
 * Preserves existing state on error (to prevent false positives).
 */
export async function checkRepoHealth(
  repo: string,
  current?: RepoHealth,
  maxAgeDays: number = 30,
): Promise<{ health: RepoHealth; transition: HealthTransition | null }> {
  const now = new Date().toISOString();
  const prevStatus = current?.status ?? 'unknown';

  const activeFailures = await getActiveFailures(repo, maxAgeDays);

  // gh CLI error -> preserve existing state
  if (activeFailures === null) {
    const fallback: RepoHealth = current ?? {
      repo,
      status: 'unknown',
      activeFailures: [],
      lastChecked: now,
    };
    return { health: fallback, transition: null };
  }

  const isBroken = activeFailures.length > 0;
  const newStatus: RepoHealthStatus = isBroken ? 'broken' : 'healthy';

  const health: RepoHealth = {
    repo,
    status: newStatus,
    activeFailures,
    brokenSince: isBroken ? (current?.brokenSince ?? now) : undefined,
    lastReminder: isBroken ? current?.lastReminder : undefined,
    lastChecked: now,
  };

  let transition: HealthTransition | null = null;

  if (prevStatus !== newStatus) {
    const resolvedFailures = current?.activeFailures?.filter(
      (prev) => !activeFailures.some(
        (curr) => curr.workflow === prev.workflow && curr.branch === prev.branch
      )
    );

    transition = {
      repo,
      from: prevStatus,
      to: newStatus,
      activeFailures,
      resolvedFailures: resolvedFailures?.length ? resolvedFailures : undefined,
      brokenSince: current?.brokenSince,
    };
  }

  return { health, transition };
}

/** Check if a reminder is needed (default: 24 hours) */
export function needsReminder(health: RepoHealth, intervalHours: number = 24): boolean {
  if (health.status !== 'broken') return false;
  if (!health.lastReminder) return true;

  const lastReminder = new Date(health.lastReminder).getTime();
  const hoursSince = (Date.now() - lastReminder) / (1000 * 60 * 60);
  return hoursSince >= intervalHours;
}

// PR API Functions

/**
 * PR basic info
 */
export type PRInfo = {
  repo: string;
  number: number;
  title: string;
  branch: string;
  createdAt: string;
  url: string;
  author?: string;
  /** True when the PR's head branch lives in a different repo (a fork). */
  isFork?: boolean;
  /** Target branch when the listing surface requested it. */
  baseBranch?: string;
  /** Immutable identity of the head observed by the listing surface. */
  headSha?: string;
};

export type PRMergeability = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export type PRLifecycle = {
  repo: string;
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  branch: string;
  baseBranch: string;
  headOid?: string;
  mergedAt?: string;
  mergeCommitOid?: string;
};

/**
 * PR detailed info
 */
export type PRDetails = PRInfo & {
  body: string;
  author: string;
  diff: string;
  failedChecks?: { name: string; status: string; conclusion: string }[];
  failedLogs?: string;
};

/**
 * Get open PR list for a specific repo. `limit` defaults to gh's own default
 * (30) — this is the daemon cron scan's read, called every cycle, and
 * raising it by default would grow that scan from a light periodic check
 * into something that can exhaust API limits and occupy the processor for
 * an entire schedule. `pr review --all` (the one caller that means "every
 * open PR") passes an explicit higher limit instead of changing this default.
 */
export async function getOpenPRs(repo: string, limit = 30): Promise<PRInfo[]> {
  try {
    return await getOpenPRsOrThrow(repo, limit);
  } catch (err) {
    console.error(`[GitHub] Failed to get open PRs for ${repo}:`, err);
    return [];
  }
}

/**
 * Same as {@link getOpenPRs}, but propagates failure instead of returning an
 * empty list. Swallowing to `[]` is right for the cron scan loop (best-effort,
 * retried next cycle), but a one-shot caller that means to act on "every open
 * PR" would otherwise read a `gh` auth/network failure as "repo has zero open
 * PRs" and silently do nothing instead of erroring.
 */
export async function getOpenPRsOrThrow(repo: string, limit = 30): Promise<PRInfo[]> {
  const stdout = await ghExec(
    'pr', 'list', '-R', repo, '--state', 'open', '--limit', String(limit),
    '--json', 'number,title,headRefName,baseRefName,headRefOid,createdAt,url,author,isCrossRepository'
  );
  const prs = JSON.parse(stdout);
  return prs.map((pr: any) => ({
    repo,
    number: pr.number,
    title: pr.title,
    branch: pr.headRefName,
    createdAt: pr.createdAt,
    url: pr.url,
    author: pr.author?.login,
    isFork: !!pr.isCrossRepository,
    baseBranch: pr.baseRefName,
    headSha: pr.headRefOid || undefined,
  }));
}

/**
 * Read lifecycle fields needed to identify immutable merge events in one API
 * call (rather than polling every owned PR separately).
 * Unlike the best-effort list helpers this propagates GitHub/auth failures:
 * callers must not record a merge as processed when its identity was unknown.
 */
export async function getMergedPRsOrThrow(repo: string, limit = 100): Promise<PRLifecycle[]> {
  const stdout = await ghExec(
    'pr', 'list', '-R', repo, '--state', 'merged', '--limit', String(limit),
    '--json', 'number,headRefName,baseRefName,headRefOid,mergedAt,mergeCommit',
  );
  const views = JSON.parse(stdout) as Array<{
    number?: number;
    headRefName?: string;
    baseRefName?: string;
    headRefOid?: string;
    mergedAt?: string | null;
    mergeCommit?: { oid?: string } | null;
  }>;
  return views.map((view) => {
    if (!view.number || !view.headRefName || !view.baseRefName) {
      throw new Error(`gh pr list returned incomplete merged PR data for ${repo}`);
    }
    return {
      repo,
      number: view.number,
      state: 'MERGED' as const,
      branch: view.headRefName,
      baseBranch: view.baseRefName,
      headOid: view.headRefOid || undefined,
      mergedAt: view.mergedAt || undefined,
      mergeCommitOid: view.mergeCommit?.oid || undefined,
    };
  });
}

/**
 * Get PR details (view + diff + checks)
 */
export async function getPRContext(repo: string, prNumber: number): Promise<PRDetails | null> {
  try {
    const [viewStdout, diffStdout, checks] = await Promise.all([
      ghExec('pr', 'view', String(prNumber), '-R', repo, '--json', 'title,headRefName,headRefOid,createdAt,url,body,author'),
      ghExecLarge('pr', 'diff', String(prNumber), '-R', repo),
      getPRChecks(repo, prNumber),
    ]);

    const view = JSON.parse(viewStdout);
    const failedChecks = checks.filter((c) => isBlockingConclusion(c.conclusion));

    let failedLogs = '';
    if (failedChecks.length > 0) {
      failedLogs = await getPRFailedLogs(repo, prNumber);
    }

    return {
      repo,
      number: prNumber,
      title: view.title,
      branch: view.headRefName,
      headSha: view.headRefOid || undefined,
      createdAt: view.createdAt,
      url: view.url,
      body: view.body || '',
      author: view.author?.login || 'unknown',
      diff: diffStdout,
      failedChecks: failedChecks.length > 0 ? failedChecks : undefined,
      failedLogs: failedLogs || undefined,
    };
  } catch (err) {
    console.error(`[GitHub] Failed to get PR context for ${repo}#${prNumber}:`, err);
    return null;
  }
}

/**
 * PR Review Comment
 */
export type PRReviewComment = {
  id: number;
  author: string;
  body: string;
  path?: string;
  line?: number;
  createdAt: string;
  state?: 'PENDING' | 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED';
};

/**
 * Get PR review comments
 */
export async function getPRReviews(repo: string, prNumber: number): Promise<PRReviewComment[]> {
  try {
    const stdout = await ghExec(
      'api', `/repos/${repo}/pulls/${prNumber}/reviews`,
      '--jq', '.[] | {id, author: .user.login, body, state, createdAt: .submitted_at}'
    );

    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch (err) {
    console.error(`[GitHub] Failed to get PR reviews for ${repo}#${prNumber}:`, err);
    return [];
  }
}

/**
 * Get PR review comments (inline code comments)
 */
export async function getPRReviewComments(repo: string, prNumber: number): Promise<PRReviewComment[]> {
  try {
    const stdout = await ghExec(
      'api', `/repos/${repo}/pulls/${prNumber}/comments`,
      '--jq', '.[] | {id, author: .user.login, body, path, line, createdAt: .created_at}'
    );

    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch (err) {
    console.error(`[GitHub] Failed to get PR review comments for ${repo}#${prNumber}:`, err);
    return [];
  }
}

/**
 * Post a comment on a PR (piped via stdin to avoid shell escaping).
 *
 * The stdin 'error' listener is not optional. If gh exits before draining the
 * pipe — unauthenticated, a bad repo, a rate limit — writing to it emits EPIPE
 * on the stream. An 'error' event with no listener is rethrown by Node as an
 * uncaught exception, and because it arrives asynchronously the surrounding
 * try/catch never sees it: the daemon dies instead of logging a failed comment.
 * Reporting is left to the 'close' handler, which has gh's actual exit code;
 * this listener only has to keep the event from going unhandled.
 */
function execGhComment(repo: string, prNumber: number, body: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('gh', ['pr', 'comment', String(prNumber), '-R', repo, '--body-file', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdin.on('error', (err) => {
      console.error(`[GitHub] stdin closed while sending comment to ${repo}#${prNumber}:`, err);
    });
    proc.stdin.write(body);
    proc.stdin.end();
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gh pr comment exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

export async function commentOnPR(repo: string, prNumber: number, body: string): Promise<void> {
  try {
    await execGhComment(repo, prNumber, body);
  } catch (err) {
    console.error(`[GitHub] Failed to comment on PR ${repo}#${prNumber}:`, err);
  }
}

/**
 * Same as {@link commentOnPR}, but propagates failure instead of swallowing
 * it. Fire-and-forget logging is right for a status ping a caller doesn't
 * block on, but wrong for a caller whose whole job IS posting this comment —
 * silently eating a `gh` auth/permission/network failure there would let it
 * report success (or a review verdict) despite never actually telling anyone.
 */
export async function commentOnPROrThrow(repo: string, prNumber: number, body: string): Promise<void> {
  await execGhComment(repo, prNumber, body);
}

/**
 * Get PR comments (not review comments, but general issue comments on the PR)
 */
export async function getPRComments(repo: string, prNumber: number): Promise<Array<{
  author: string;
  body: string;
  createdAt: string;
}>> {
  try {
    const stdout = await ghExec(
      'pr', 'view', String(prNumber), '-R', repo,
      '--json', 'comments'
    );
    const data = JSON.parse(stdout);
    return data.comments.map((c: any) => ({
      author: c.author?.login || 'unknown',
      body: c.body || '',
      createdAt: c.createdAt || new Date().toISOString(),
    }));
  } catch (err) {
    console.error(`[GitHub] Failed to get PR comments for ${repo}#${prNumber}:`, err);
    return [];
  }
}

/**
 * Get recent failed run logs for a PR branch
 */
export async function getPRFailedLogs(repo: string, prNumber: number): Promise<string> {
  try {
    // Get the PR's head branch
    const prInfo = await ghExec('pr', 'view', String(prNumber), '-R', repo, '--json', 'headRefName');
    const { headRefName } = JSON.parse(prInfo);

    // Get the most recent failed run for this branch
    const runsStr = await ghExec('run', 'list', '-R', repo, '-b', headRefName, '-s', 'failure', '--json', 'databaseId', '-L', '1');
    const runs = JSON.parse(runsStr);
    if (runs.length === 0) return '';

    // Get failed logs (limit to last 150 lines in JS instead of shell pipe)
    const logs = await ghExec('run', 'view', String(runs[0].databaseId), '-R', repo, '--log-failed');
    return logs.split('\n').slice(-150).join('\n');
  } catch (err) {
    console.error(`[GitHub] Failed to get PR failed logs for ${repo}#${prNumber}:`, err);
    return '';
  }
}

/**
 * Get the base branch of a PR
 */
export async function getPRBaseBranch(repo: string, prNumber: number): Promise<string> {
  try {
    const stdout = await ghExec(
      'pr', 'view', String(prNumber), '-R', repo, '--json', 'baseRefName'
    );
    const { baseRefName } = JSON.parse(stdout);
    return baseRefName || 'main';
  } catch (err) {
    console.error(`[GitHub] Failed to get base branch for ${repo}#${prNumber}:`, err);
    return 'main';
  }
}

/**
 * Get the base branch of a PR, without the `main`-on-any-failure fallback
 * above. That fallback is fine for conflict resolution (a wrong base just
 * fails the rebase visibly), but silently swapping in the wrong base branch
 * for a diff computation makes the diff wrong instead of failing — the
 * reviewer would then read the PR's changes plus every unrelated commit
 * between the real base and `main` as if it were all part of the PR. Callers
 * that feed the result straight into a diff should use this and propagate
 * the failure instead.
 */
export async function getPRBaseBranchOrThrow(repo: string, prNumber: number): Promise<string> {
  const stdout = await ghExec('pr', 'view', String(prNumber), '-R', repo, '--json', 'baseRefName');
  const { baseRefName } = JSON.parse(stdout);
  if (!baseRefName) throw new Error(`gh pr view returned no baseRefName for ${repo}#${prNumber}`);
  return baseRefName;
}

// PR Auto-Fix Support

/**
 * Check if PR has merge conflicts
 */
export async function checkPRConflicts(repo: string, prNumber: number): Promise<boolean> {
  return (await getPRMergeability(repo, prNumber)) === 'CONFLICTING';
}

/** Preserve GitHub's tri-state response instead of treating UNKNOWN as clean. */
export async function getPRMergeability(repo: string, prNumber: number): Promise<PRMergeability> {
  try {
    const stdout = await ghExec(
      'pr', 'view', String(prNumber), '-R', repo, '--json', 'mergeable'
    );
    const { mergeable } = JSON.parse(stdout) as { mergeable?: string };
    return mergeable === 'MERGEABLE' || mergeable === 'CONFLICTING' ? mergeable : 'UNKNOWN';
  } catch (err) {
    console.error(`[GitHub] Failed to check PR mergeability for ${repo}#${prNumber}:`, err);
    return 'UNKNOWN';
  }
}

/**
 * CI status result
 */
export type CIStatus =
  | { status: 'pending'; headSha: string }
  | { status: 'success'; headSha: string }
  | { status: 'failure'; headSha: string; failedChecks: { name: string; conclusion: string }[] }
  | {
      status: 'unknown';
      reason: 'head_unavailable' | 'expected_head_unavailable' | 'head_mismatch' | 'checks_unavailable';
      expectedHeadSha?: string;
      observedHeadSha?: string;
    };

/**
 * Check current CI status for a PR
 */
export async function checkPRCIStatus(
  repo: string,
  prNumber: number,
  expectedHeadSha?: string,
): Promise<CIStatus> {
  const expected = expectedHeadSha?.trim();
  if (expectedHeadSha !== undefined && !expected) {
    return { status: 'unknown', reason: 'expected_head_unavailable' };
  }

  const snapshot = await getPRCISnapshot(repo, prNumber);
  if (snapshot.identity === 'unknown') {
    return { status: 'unknown', reason: snapshot.reason, expectedHeadSha: expected };
  }
  if (expected && snapshot.headSha !== expected) {
    return {
      status: 'unknown',
      reason: 'head_mismatch',
      expectedHeadSha: expected,
      observedHeadSha: snapshot.headSha,
    };
  }

  const { checks, headSha } = snapshot;
  if (checks.length === 0) {
    return { status: 'pending', headSha };
  }

  const pending = checks.some(c => c.status === 'in_progress' || c.status === 'queued' || c.status === 'pending');
  if (pending) {
    return { status: 'pending', headSha };
  }

  const failed = checks.filter(c => isBlockingConclusion(c.conclusion));
  if (failed.length > 0) {
    return {
      status: 'failure',
      headSha,
      failedChecks: failed.map(c => ({ name: c.name, conclusion: c.conclusion }))
    };
  }

  const indeterminate = checks.some(
    c => c.conclusion !== 'success' && c.conclusion !== 'skipped',
  );
  if (indeterminate) {
    return {
      status: 'unknown',
      reason: 'checks_unavailable',
      expectedHeadSha: expected,
      observedHeadSha: headSha,
    };
  }

  return { status: 'success', headSha };
}

/**
 * Wait for CI checks to complete (polling with timeout)
 * @param repo Repository name (owner/repo)
 * @param prNumber PR number
 * @param options Polling options
 * @returns Final CI status
 */
export async function waitForCICompletion(
  repo: string,
  prNumber: number,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    /** Exact published commit this wait is allowed to accept. */
    expectedHeadSha?: string;
    onProgress?: (status: CIStatus, elapsed: number) => void;
  } = {}
): Promise<CIStatus> {
  const timeoutMs = options.timeoutMs ?? 600_000; // 10 minutes default
  const pollIntervalMs = options.pollIntervalMs ?? 30_000; // 30 seconds default
  const startTime = Date.now();
  let expectedHeadSha = options.expectedHeadSha?.trim();
  let lastPending: Extract<CIStatus, { status: 'pending' }> | undefined;

  while (true) {
    const elapsed = Date.now() - startTime;

    if (elapsed >= timeoutMs) {
      console.log(`[GitHub] CI timeout for ${repo}#${prNumber} (${elapsed}ms)`);
      return lastPending ?? {
        status: 'unknown',
        reason: expectedHeadSha ? 'head_unavailable' : 'expected_head_unavailable',
        expectedHeadSha,
      };
    }

    const status = await checkPRCIStatus(repo, prNumber, expectedHeadSha);

    // Legacy callers that did not provide an expected SHA are pinned to the
    // first head they actually observe. A later push can no longer replace a
    // pending head A with a green head B inside the same wait.
    if (!expectedHeadSha && status.status !== 'unknown') {
      expectedHeadSha = status.headSha;
    }

    if (options.onProgress) {
      options.onProgress(status, elapsed);
    }

    if (status.status !== 'pending') {
      return status;
    }
    lastPending = status;

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}
