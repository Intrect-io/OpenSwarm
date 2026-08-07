// ============================================
// OpenSwarm - Explicit work dispatch (INT-3388)
// ============================================
//
// Backend for the issue board's "deploy N agents" flow: the user picks Linear
// issues for a repo, and each accepted issue is queued onto the runner's
// scheduler — which fans out into per-issue worktrees via the existing
// pipeline. This module owns validation and Linear-side claiming; it does not
// run pipelines itself.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { AutonomousRunner } from './autonomousRunner.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { broadcastEvent } from '../core/eventHub.js';

export interface WorkDispatchRequest {
  issueIds: string[];
  projectPath: string;
}

export interface WorkDispatchItem {
  issueId: string;
  identifier?: string;
  title?: string;
  status: 'queued' | 'skipped';
  reason?: string;
}

export interface WorkDispatchResult {
  workId: string;
  items: WorkDispatchItem[];
  queued: number;
  skipped: number;
}

export interface WorkIssueSummary {
  id: string;
  identifier: string;
  title: string;
  state: string;
  priority: number;
  labels: string[];
  url?: string;
}

/** States a user can sensibly dispatch from the board. */
const DISPATCHABLE_STATES = new Set(['todo', 'backlog', 'in progress']);

export function isDispatchableState(state: string | undefined): boolean {
  return DISPATCHABLE_STATES.has((state ?? '').toLowerCase());
}

/**
 * List a repo's open Linear issues for the board. Resolution of the Linear
 * project id comes from the repo's own openswarm.json mapping (same source
 * `openswarm add` writes).
 */
export async function listWorkIssues(projectPath: string): Promise<{
  project: string;
  source: 'linear';
  issues: WorkIssueSummary[];
}> {
  const linear = await import('../linear/linear.js');
  if (!linear.isLinearInitialized()) {
    throw new WorkDispatchError(503, 'Linear is not configured on this daemon');
  }

  const { loadRepoMetadata } = await import('../support/repoMetadata.js');
  const meta = await loadRepoMetadata(projectPath);
  const projectId = meta?.linear?.projectId;
  if (!projectId) {
    throw new WorkDispatchError(
      404,
      `No Linear project mapped for ${projectPath} (run \`openswarm add ${projectPath}\` to map it)`,
    );
  }

  const { nodes } = await linear.fetchIssuesForStates(
    linear.getClient(),
    ['Todo', 'Backlog', 'In Progress'],
    { project: { id: { eq: projectId } } },
  );

  const issues = nodes
    .map((node) => ({
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      state: node.state?.name ?? 'Unknown',
      priority: node.priority ?? 0,
      labels: node.labels?.nodes.map((l) => l.name) ?? [],
    }))
    .sort((a, b) => (a.priority || 99) - (b.priority || 99));

  return { project: projectId, source: 'linear', issues };
}

export class WorkDispatchError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

let workCounter = 0;

/**
 * Validate the requested issues, claim each accepted one on Linear (move to
 * In Progress — this is what keeps a concurrently-enabled heartbeat from
 * double-dispatching the same issue), and queue them onto the runner.
 */
export async function dispatchWork(
  runner: AutonomousRunner,
  request: WorkDispatchRequest,
): Promise<WorkDispatchResult> {
  const projectPath = resolve(request.projectPath);
  if (!existsSync(projectPath)) {
    throw new WorkDispatchError(400, `Project path does not exist: ${projectPath}`);
  }
  // Dispatch stays inside the runner's configured project boundary — an
  // authorized dashboard caller must not be able to point agents at an
  // arbitrary local directory just because it exists. Same allow-list the
  // heartbeat path honors.
  const { normalizeProjectPath } = await import('../orchestration/taskScheduler.js');
  const canonical = normalizeProjectPath(projectPath);
  const allowed = runner.getAllowedProjects().map((p) => normalizeProjectPath(p));
  if (!allowed.includes(canonical)) {
    throw new WorkDispatchError(
      403,
      `Project ${projectPath} is not in the daemon's allowed projects (config autonomous.allowedProjects)`,
    );
  }
  if (!Array.isArray(request.issueIds) || request.issueIds.length === 0) {
    throw new WorkDispatchError(400, 'issueIds must be a non-empty array');
  }

  // Fail on an unexecutable runner configuration BEFORE claiming anything on
  // Linear: enqueueIssues throws for configs whose scheduler never runs
  // (no pairMode / maxConcurrentTasks), and finding that out after moving
  // issues to In Progress would strand them claimed-but-never-worked. An
  // empty batch triggers only the config check.
  try {
    await runner.enqueueIssues([], projectPath);
  } catch (err) {
    throw new WorkDispatchError(409, err instanceof Error ? err.message : String(err));
  }

  const linear = await import('../linear/linear.js');
  if (!linear.isLinearInitialized()) {
    throw new WorkDispatchError(503, 'Linear is not configured on this daemon');
  }
  const { linearIssueToTask } = await import('../orchestration/decisionEngine.js');
  const { enrichTaskFromState } = await import('../taskState/store.js');

  // Issues must belong to the repo's own mapped Linear project — dispatching
  // some other project's issue into this repo would run its worker against
  // the wrong codebase entirely.
  const { loadRepoMetadata } = await import('../support/repoMetadata.js');
  const mappedProjectId = (await loadRepoMetadata(projectPath))?.linear?.projectId;
  if (!mappedProjectId) {
    throw new WorkDispatchError(
      404,
      `No Linear project mapped for ${projectPath} (run \`openswarm add ${projectPath}\` to map it)`,
    );
  }

  const items: WorkDispatchItem[] = [];
  const tasks: TaskItem[] = [];
  // Dedupe on the resolved Linear id, not the raw request string — the same
  // issue can be requested twice as "INT-123" and its UUID, and double
  // entries would otherwise report one phantom "queued" the scheduler never
  // accepted.
  const seenIssueIds = new Set<string>();
  // Issues THIS dispatch moved to In Progress (vs. ones already there / being
  // resumed), mapped to the workflow state they came from — rollback must
  // restore Backlog issues to Backlog, not blanket-reset everything to Todo.
  const claimedByUs = new Map<string, 'Todo' | 'Backlog'>();

  for (const rawId of request.issueIds) {
    const issue = await linear.getIssue(rawId);
    if (!issue) {
      items.push({ issueId: rawId, status: 'skipped', reason: 'not found' });
      continue;
    }
    if (seenIssueIds.has(issue.id)) {
      items.push({
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: 'skipped',
        reason: 'duplicate in request',
      });
      continue;
    }
    seenIssueIds.add(issue.id);
    if (issue.project?.id !== mappedProjectId) {
      items.push({
        issueId: rawId,
        identifier: issue.identifier,
        title: issue.title,
        status: 'skipped',
        reason: `belongs to a different Linear project than ${projectPath}'s mapping`,
      });
      continue;
    }
    if (!isDispatchableState(issue.state)) {
      items.push({
        issueId: rawId,
        identifier: issue.identifier,
        title: issue.title,
        status: 'skipped',
        reason: `state is ${issue.state}`,
      });
      continue;
    }

    // Claim before queueing: an issue already In Progress on Linear is
    // invisible to the heartbeat's Todo scan, so the two dispatch paths
    // cannot collide. A failed claim means that protection does NOT hold for
    // this issue — skip it rather than queue unprotected work.
    if ((issue.state ?? '').toLowerCase() !== 'in progress') {
      const claimed = await linear.updateIssueState(issue.id, 'In Progress').catch(() => false);
      if (!claimed) {
        items.push({
          issueId: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: 'skipped',
          reason: 'failed to claim on Linear (state transition failed)',
        });
        continue;
      }
      claimedByUs.set(issue.id, (issue.state ?? '').toLowerCase() === 'backlog' ? 'Backlog' : 'Todo');
    }

    tasks.push(enrichTaskFromState(linearIssueToTask({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      priority: issue.priority,
      state: issue.state,
      labels: issue.labels,
      project: issue.project ? { id: issue.project.id, name: issue.project.name } : undefined,
    })));
    items.push({ issueId: issue.id, identifier: issue.identifier, title: issue.title, status: 'queued' });
  }

  const workId = `work-${Date.now()}-${++workCounter}`;

  if (tasks.length > 0) {
    const { queued, rejected } = await runner.enqueueIssues(tasks, projectPath);
    const rejectedById = new Map(rejected.map((r) => [r.id, r.reason]));
    for (const item of items) {
      const rejectionReason = item.status === 'queued' ? rejectedById.get(item.issueId) : undefined;
      if (!rejectionReason) continue;
      item.status = 'skipped';
      if (rejectionReason === 'duplicate') {
        // Another live dispatch/heartbeat owns this issue on the scheduler.
        // Its In Progress claim is CORRECT — rolling it back here would reset
        // an actively-executing issue to Todo (concurrent-dispatch race).
        item.reason = 'already queued or running';
        continue;
      }
      // 'stopping': the runner is shutting down, nobody will ever run this.
      item.reason = 'runner shutting down';
      // If this dispatch made the claim, roll it back to the exact state the
      // issue came from so it is not stranded In Progress with no worker.
      // Best-effort: a failed rollback is reported rather than hidden.
      const priorState = claimedByUs.get(item.issueId);
      if (priorState) {
        const rolledBack = await linear.updateIssueState(item.issueId, priorState).catch(() => false);
        if (!rolledBack) {
          item.reason = 'runner shutting down (WARNING: issue left In Progress — manual state reset needed)';
        }
      }
    }
    broadcastEvent({
      type: 'work:queued',
      data: { workId, projectPath, taskIds: queued },
    });
  }

  const queuedCount = items.filter((i) => i.status === 'queued').length;
  return { workId, items, queued: queuedCount, skipped: items.length - queuedCount };
}
