// ============================================
// Claude Swarm - GitHub Integration (via gh CLI)
// ============================================

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { getDateLocale } from './locale/index.js';

const execAsync = promisify(exec);

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
    const { stdout } = await execAsync(
      `gh run list -R ${repo} -s failure --json databaseId,name,headBranch,createdAt,url -L ${limit}`
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
  const results = await Promise.all(
    repos.map((repo) => getFailedRuns(repo, limit))
  );
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
    const { stdout } = await execAsync(
      `gh api /notifications --jq '.[] | {id, reason, title: .subject.title, type: .subject.type, repo: .repository.full_name, updated: .updated_at, url: .subject.url}'`
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
    await execAsync(`gh api -X PATCH /notifications/threads/${threadId}`);
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
    const { stdout } = await execAsync(
      `gh run view ${runId} -R ${repo} --json jobs`
    );
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
    const { stdout } = await execAsync(
      `gh run view ${runId} -R ${repo} --log-failed 2>/dev/null | tail -100`
    );
    return stdout;
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
): Promise<{ name: string; status: string; conclusion: string }[]> {
  try {
    const { stdout } = await execAsync(
      `gh pr checks ${prNumber} -R ${repo} --json name,state,conclusion`
    );
    return JSON.parse(stdout);
  } catch (err) {
    console.error(`Failed to get PR checks for ${repo}#${prNumber}:`, err);
    return [];
  }
}

/**
 * Generate CI failure summary
 */
export async function summarizeCIFailures(repos: string[]): Promise<string> {
  const failures = await getAllFailedRuns(repos, 3);

  if (failures.length === 0) {
    return '✅ 모든 CI 통과';
  }

  const summary = failures.map((f) => {
    const time = new Date(f.createdAt).toLocaleString(getDateLocale());
    return `❌ **${f.repo}** - ${f.name}\n   브랜치: ${f.branch}\n   시간: ${time}`;
  });

  return `**CI 실패 ${failures.length}건:**\n\n${summary.join('\n\n')}`;
}

/**
 * Generate GitHub notification summary
 */
export async function summarizeNotifications(): Promise<string> {
  const notifications = await getNotifications(10);

  if (notifications.length === 0) {
    return '📭 새 알림 없음';
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

  return `**GitHub 알림 ${notifications.length}건** (${breakdown})\n\n${recent.join('\n')}`;
}

// ============================================
// CI State Monitoring (state-based)
// ============================================

const CI_STATE_PATH = resolve(homedir(), '.claude-swarm', 'ci-state.json');

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

/** Load CI state */
export async function loadCIState(): Promise<CIState> {
  try {
    const data = await readFile(CI_STATE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { repos: {}, updatedAt: new Date().toISOString() };
  }
}

/** Save CI state */
export async function saveCIState(state: CIState): Promise<void> {
  await mkdir(resolve(homedir(), '.claude-swarm'), { recursive: true });
  state.updatedAt = new Date().toISOString();
  await writeFile(CI_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Get active failures for a repo.
 * Checks only the latest run per workflow+branch; returns only those with failure conclusion.
 * Ignores failures older than maxAgeDays (stale branch filter).
 * Returns null on error (to avoid state changes).
 */
export async function getActiveFailures(repo: string, maxAgeDays: number = 30): Promise<ActiveFailure[] | null> {
  try {
    const { stdout } = await execAsync(
      `gh run list -R ${repo} --json databaseId,name,headBranch,createdAt,conclusion,url -L 20`
    );
    const runs = JSON.parse(stdout);
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
      if (run.conclusion === 'failure') {
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
    console.error(`[GitHub] Failed to get active failures for ${repo}:`, err);
    return null;
  }
}

/**
 * Check repo health and detect state transitions.
 * Preserves existing state on error (to prevent false positives).
 */
export async function checkRepoHealth(
  repo: string,
  current?: RepoHealth
): Promise<{ health: RepoHealth; transition: HealthTransition | null }> {
  const now = new Date().toISOString();
  const prevStatus = current?.status ?? 'unknown';

  const activeFailures = await getActiveFailures(repo);

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

// ============================================
// PR API Functions
// ============================================

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
 * Get open PR list for a specific repo
 */
export async function getOpenPRs(repo: string): Promise<PRInfo[]> {
  try {
    const { stdout } = await execAsync(
      `gh pr list -R ${repo} --state open --json number,title,headRefName,createdAt,url`
    );
    const prs = JSON.parse(stdout);
    return prs.map((pr: any) => ({
      repo,
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      createdAt: pr.createdAt,
      url: pr.url,
    }));
  } catch (err) {
    console.error(`[GitHub] Failed to get open PRs for ${repo}:`, err);
    return [];
  }
}

/**
 * Get PR details (view + diff + checks)
 */
export async function getPRContext(repo: string, prNumber: number): Promise<PRDetails | null> {
  try {
    const [viewResult, diffResult, checks] = await Promise.all([
      execAsync(`gh pr view ${prNumber} -R ${repo} --json title,headRefName,createdAt,url,body,author`),
      execAsync(`gh pr diff ${prNumber} -R ${repo}`).catch(() => ({ stdout: '' })),
      getPRChecks(repo, prNumber),
    ]);

    const view = JSON.parse(viewResult.stdout);
    const failedChecks = checks.filter(
      (c) => c.conclusion === 'failure' || c.conclusion === 'timed_out'
    );

    let failedLogs = '';
    if (failedChecks.length > 0) {
      failedLogs = await getPRFailedLogs(repo, prNumber);
    }

    return {
      repo,
      number: prNumber,
      title: view.title,
      branch: view.headRefName,
      createdAt: view.createdAt,
      url: view.url,
      body: view.body || '',
      author: view.author?.login || 'unknown',
      diff: diffResult.stdout,
      failedChecks: failedChecks.length > 0 ? failedChecks : undefined,
      failedLogs: failedLogs || undefined,
    };
  } catch (err) {
    console.error(`[GitHub] Failed to get PR context for ${repo}#${prNumber}:`, err);
    return null;
  }
}

/**
 * Post a comment on a PR (piped via stdin to avoid shell escaping)
 */
export async function commentOnPR(repo: string, prNumber: number, body: string): Promise<void> {
  try {
    const { spawn: spawnCmd } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      const proc = spawnCmd('gh', ['pr', 'comment', String(prNumber), '-R', repo, '--body-file', '-'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      proc.stdin.write(body);
      proc.stdin.end();
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`gh pr comment exited with code ${code}`));
      });
      proc.on('error', reject);
    });
  } catch (err) {
    console.error(`[GitHub] Failed to comment on PR ${repo}#${prNumber}:`, err);
  }
}

/**
 * Get recent failed run logs for a PR branch
 */
export async function getPRFailedLogs(repo: string, prNumber: number): Promise<string> {
  try {
    // Get the PR's head branch
    const { stdout: prInfo } = await execAsync(
      `gh pr view ${prNumber} -R ${repo} --json headRefName`
    );
    const { headRefName } = JSON.parse(prInfo);

    // Get the most recent failed run for this branch
    const { stdout: runsStr } = await execAsync(
      `gh run list -R ${repo} -b ${headRefName} -s failure --json databaseId -L 1`
    );
    const runs = JSON.parse(runsStr);
    if (runs.length === 0) return '';

    // Get failed logs
    const { stdout: logs } = await execAsync(
      `gh run view ${runs[0].databaseId} -R ${repo} --log-failed 2>/dev/null | tail -150`
    );
    return logs;
  } catch (err) {
    console.error(`[GitHub] Failed to get PR failed logs for ${repo}#${prNumber}:`, err);
    return '';
  }
}
