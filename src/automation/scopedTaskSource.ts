// Created: 2026-11-21
// Purpose: one task-source factory for every place that starts the autonomous runner, so the
//          AGT-3188 milestone scope cannot be dropped by a second, hand-written fetcher
// Dependencies: linear, taskState/store, core/workScope, taskSource
// Test Status: scopedTaskSource.test.ts, discord/discordHandlers.autoStart.test.ts

import * as linear from '../linear/index.js';
import { getWorkScope, recordScopedFetch } from '../core/workScope.js';
import { enrichTaskFromState, syncTaskStatesFromIssues } from '../taskState/store.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { selectTaskSource, type ITaskSource } from './taskSource.js';

/** Upper bound for one heartbeat fetch (slim mode, every state). */
export const SCOPED_FETCH_TIMEOUT_MS = 300_000;

/**
 * The Linear heartbeat fetcher. The milestone is read from getWorkScope() on every call, not
 * captured when the source is built, so the scope in force is always the one the daemon reports.
 * Errors propagate: the runner counts them, and swallowing one would look like an empty scope.
 */
export async function fetchScopedLinearTasks(): Promise<TaskItem[]> {
  await linear.ensureLinearAuthFresh(); // refresh OAuth token (no-op for API key) each heartbeat
  const milestone = getWorkScope().milestone ?? undefined;
  const issues = await linear.getMyIssues({ slim: true, timeoutMs: SCOPED_FETCH_TIMEOUT_MS, milestone });
  // getMyIssues returns [] when Linear is not initialised; that says nothing about the milestone.
  if (linear.isLinearInitialized()) recordScopedFetch(milestone, issues.length);
  // Loaded lazily, as service.ts always did: decisionEngine pulls in memory/knowledge modules.
  const { linearIssueToTask } = await import('../orchestration/decisionEngine.js');
  // One lock, one load, one write for the whole fetch — not one of each per issue (AGT-4659).
  syncTaskStatesFromIssues(issues.map((issue: any) => ({
    issueId: issue.id,
    linearState: issue.state,
    comments: issue.comments || [],
  })));
  return issues.map((issue: any) => enrichTaskFromState(linearIssueToTask({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    labels: issue.labels,
    hasChildren: issue.hasChildren,
    blockedBy: issue.blockedBy,
    updatedAt: issue.updatedAt,
    project: issue.project ? { id: issue.project.id, name: issue.project.name } : undefined,
  })));
}

/** Linear (scoped) when configured, else the local SQLite store. */
export function createScopedTaskSource(linearConfigured: boolean): ITaskSource {
  return selectTaskSource(linearConfigured, fetchScopedLinearTasks);
}
