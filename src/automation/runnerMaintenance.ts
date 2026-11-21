// Created: 2026-11-22
// Purpose: the heartbeat's maintenance lanes — knowledge-graph refresh, code-registry scan, skip-summary
//          logging, backlog-grooming cadence and the post-merge publication sweep — moved out of
//          autonomousRunner.ts as host-taking functions with their per-runner state (AGT-4867 slice C);
//          the ledger retrospective, decomposed-parent completion and stalled In Progress sweep joined
//          them in AGT-4867 slice F
// Dependencies: knowledge (graph refresh), registry/entityScanner, backlogGrooming, mergedPublications,
//               readinessGate (exclusions), trackerTransition, taskState/store, runnerExecution (task source),
//               ledgerRetrospective, stalledInProgress, dependentRelease, runLedgerTypes
// Test Status: autonomousRunner.coverage/enable/pause/durable/hostHealth/idleBackoff/agentEligibility/decompose
//              tests, runnerMaintenance.test.ts (host contract), runnerMaintenance.sweeps.test.ts (slice F)

import type { TaskItem } from '../orchestration/decisionEngine.js';
import { normalizeProjectPath, type TaskScheduler } from '../orchestration/taskScheduler.js';
import { broadcastEvent } from '../core/eventHub.js';
import { refreshGraph, toProjectSlug } from '../knowledge/index.js';
import { scanRepository } from '../registry/entityScanner.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { completeParentIfChildrenDone as completeParentLocally, getTaskState, updateTaskLinearState } from '../taskState/store.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getTaskSource } from './runnerExecution.js';
import {
  applyBacklogGrooming, DEFAULT_GROOMING_MUTATION_CAP,
  filterGroomableTasks, runBacklogGroomingPlanner,
  summarizeGroomingDecision,
} from './backlogGrooming.js';
import { DEFAULT_AGENT_SKIP } from './agentEligibility.js';
import { exclusionCheck, exclusionLabelsForProject } from './readinessGate.js';
import { planMergedPublicationChecks, decideMergedPublication } from './mergedPublications.js';
import { transitionWithReason } from './trackerTransition.js';
import { releaseDependentsInTracker } from './dependentRelease.js';
import { runLedgerRetrospective } from './ledgerRetrospective.js';
import { planStalledInProgress } from './stalledInProgress.js';
import { ACTIVE_LEASE_STATES } from './runLedgerTypes.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { AutonomousConfig } from './runnerTypes.js';

type TaskSource = NonNullable<ReturnType<typeof getTaskSource>>;

/**
 * Per-runner maintenance state. Each runner owns one instance (never module-global),
 * so two runners in one process keep separate throttles and in-flight maps.
 */
export interface MaintenanceState {
  readonly kgRefreshByPath: Map<string, Promise<unknown>>;
  readonly registryScanAt: Map<string, number>;
  lastSkipSummary: string;
  lastBacklogGroomingAt: number;
  /** Last merge sweep, so a 5-minute heartbeat does not pay a `gh` call per In Review issue every tick. */
  lastMergedPublicationSweepAt: number;
}

export function createMaintenanceState(): MaintenanceState {
  return {
    kgRefreshByPath: new Map<string, Promise<unknown>>(),
    registryScanAt: new Map<string, number>(),
    lastSkipSummary: '',
    lastBacklogGroomingAt: 0,
    lastMergedPublicationSweepAt: 0,
  };
}

/**
 * Keep the code-entity registry fresh for Draft File Map / registryCheck.
 * Throttled to once per 6h per project so heartbeats stay cheap; a missing
 * or empty scan still runs immediately (measured: Draft logged "0 entities"
 * for months while ~/.openswarm/registry.db sat stale since 2026-07-05).
 */
export const REGISTRY_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MERGED_PUBLICATION_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * What the maintenance lanes need from the runner. The runner builds it so every
 * member is read at call time: state through getters, and every method through
 * the runner itself, so a test (or a later reassignment) of a runner member —
 * `syslog`, `groupTasksForGrooming`, `resolveProjectPath`, ... — is honoured
 * exactly as when this code lived on the class.
 */
export interface MaintenanceHost {
  readonly maintenance: MaintenanceState;
  readonly config: Pick<AutonomousConfig, 'allowedProjects' | 'backlogGrooming' | 'plannerModel' | 'plannerTimeoutMs' | 'skip' | 'projectAgents' | 'retrospectiveProjectId' | 'stalledInProgressHours'>;
  readonly scheduler: Pick<TaskScheduler, 'isTaskQueued' | 'isTaskRunning'>;
  readonly durableRuns: Pick<DurableRunCoordinator, 'getRun' | 'recordPullRequestState' | 'isPrimary'>;
  /** The runner's shutdown flag, read at call time: a stopping runner files no retrospective. */
  readonly stopping: boolean;
  syslog(line: string): void;
  resolveProjectPath(task: TaskItem): Promise<string | null>;
  resolveRegistryProjectId(projectPath: string): string;
  groupTasksForGrooming(tasks: TaskItem[]): Promise<Map<string, TaskItem[]>>;
  completeParentIfChildrenMerged(childIssueId: string, source: TaskSource): Promise<void>;
}

export function refreshKnowledgeGraphs(host: MaintenanceHost): void {
  for (const projectPath of host.config.allowedProjects) {
    const resolvedPath = normalizeProjectPath(projectPath);
    // Coalesce concurrent heartbeats: one in-flight refresh per project.
    if (host.maintenance.kgRefreshByPath.has(resolvedPath)) continue;

    const flight = refreshGraph(resolvedPath).then(graph => {
      if (graph) {
        const slug = toProjectSlug(resolvedPath);
        broadcastEvent({
          type: 'knowledge:updated',
          data: { projectSlug: slug, nodeCount: graph.nodeCount, edgeCount: graph.edgeCount },
        });
      }
      return graph;
    }).catch((e) => {
      console.error(`[AutonomousRunner] Knowledge graph refresh failed for ${resolvedPath}:`, e);
      return null;
    }).finally(() => {
      if (host.maintenance.kgRefreshByPath.get(resolvedPath) === flight) {
        host.maintenance.kgRefreshByPath.delete(resolvedPath);
      }
    });

    host.maintenance.kgRefreshByPath.set(resolvedPath, flight);
  }
}

export function refreshCodeRegistries(host: MaintenanceHost): void {
  for (const projectPath of host.config.allowedProjects) {
    const resolvedPath = normalizeProjectPath(projectPath);
    const last = host.maintenance.registryScanAt.get(resolvedPath) ?? 0;
    if (Date.now() - last < REGISTRY_SCAN_INTERVAL_MS) continue;
    if (!existsSync(join(resolvedPath, '.git'))) continue;

    const projectId = host.resolveRegistryProjectId(resolvedPath);
    host.maintenance.registryScanAt.set(resolvedPath, Date.now());
    void scanRepository(resolvedPath, projectId, { timeoutMs: 180_000 })
      .then((result) => {
        if (result.incomplete) {
          host.syslog(
            `Registry scan ${projectId} was INCOMPLETE after ${result.durationMs}ms: `
            + result.incompleteReasons.slice(0, 5).join('; '),
          );
        }
        host.syslog(
          `Registry scan ${projectId}: ${result.extracted} entities `
          + `(+${result.registered}/~${result.updated}) in ${result.durationMs}ms`,
        );
      })
      .catch((e) => {
        console.error(`[AutonomousRunner] Registry scan failed for ${resolvedPath}:`, e);
        host.maintenance.registryScanAt.delete(resolvedPath);
      });
  }
}

export function resolveRegistryProjectId(projectPath: string): string {
  const normalized = projectPath.replace(/\/+$/, '');
  const wt = normalized.match(/^(.*)\/worktree\/[^/]+$/);
  const repoRoot = wt ? wt[1] : normalized;
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { name?: unknown };
    if (typeof pkg.name === 'string' && pkg.name) return pkg.name.replace(/^@[^/]+\//, '');
  } catch { /* basename fallback */ }
  return repoRoot.split('/').pop() ?? repoRoot;
}

/**
 * Log unmapped/disabled project skips as one aggregate line per category,
 * and stay silent while the summary is identical to the previous heartbeat.
 */
export function syslogSkipSummary(host: MaintenanceHost, unmapped: Map<string, number>, disabled: Map<string, number>): void {
  const fmt = (m: Map<string, number>) => [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} (${n})`)
    .join(', ');
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const lines: string[] = [];
  if (unmapped.size > 0) {
    lines.push(`  ⚠ Skipped ${total(unmapped)} issue(s) in ${unmapped.size} unmapped project(s): ${fmt(unmapped)} — run \`openswarm add\` to map`);
  }
  if (disabled.size > 0) {
    lines.push(`  ⚠ Skipped ${total(disabled)} issue(s) in ${disabled.size} disabled project(s): ${fmt(disabled)}`);
  }
  const summary = lines.join('\n');
  if (summary === host.maintenance.lastSkipSummary) return;
  host.maintenance.lastSkipSummary = summary;
  for (const line of lines) host.syslog(line);
}

export async function groupTasksForGrooming(host: MaintenanceHost, tasks: TaskItem[]): Promise<Map<string, TaskItem[]>> {
  const byProjectId = new Map<string, string>();
  for (const repoPath of host.config.allowedProjects) {
    try {
      const resolvedPath = normalizeProjectPath(repoPath);
      const meta = await loadRepoMetadata(resolvedPath);
      if (meta?.linear?.projectId) byProjectId.set(meta.linear.projectId, resolvedPath);
    } catch {
      // Grooming is advisory; unreadable metadata should not block normal work.
    }
  }

  const groups = new Map<string, TaskItem[]>();
  for (const task of tasks) {
    const projectPath = task.projectPath
      ?? (task.linearProject?.id ? byProjectId.get(task.linearProject.id) : undefined)
      ?? undefined;
    if (!projectPath) continue;
    const list = groups.get(projectPath) ?? [];
    list.push(task);
    groups.set(projectPath, list);
  }
  return groups;
}

export async function maybeRunBacklogGrooming(host: MaintenanceHost, tasks: TaskItem[]): Promise<TaskItem[]> {
  const cfg = host.config.backlogGrooming;
  if (!cfg?.enabled) return tasks;

  const cadenceMs = Math.max(1, cfg.cadenceHours ?? 24) * 60 * 60 * 1000;
  const now = Date.now();
  if (host.maintenance.lastBacklogGroomingAt && now - host.maintenance.lastBacklogGroomingAt < cadenceMs) return tasks;

  const source = getTaskSource();
  if (!source) {
    host.syslog('⚠ Backlog grooming skipped: no task source');
    return tasks;
  }

  const groomable = filterGroomableTasks(tasks);
  if (groomable.length === 0) return tasks;

  const mode = cfg.mode ?? 'comment';
  const moved = new Set<string>();
  const groups = await host.groupTasksForGrooming(groomable);
  if (groups.size === 0) {
    host.syslog('⚠ Backlog grooming skipped: no mapped project paths');
    return tasks;
  }

  let successfulPlannerRuns = 0; const mutationBudget = { remaining: DEFAULT_GROOMING_MUTATION_CAP }; // AGT-4603: one cap per grooming run
  for (const [projectPath, groupTasks] of groups) {
    host.syslog(`⟳ Backlog grooming: ${groupTasks.length} issue(s) in ${projectPath.split('/').pop()}`);
    const result = await runBacklogGroomingPlanner({
      tasks: groupTasks,
      projectPath,
      projectName: groupTasks[0]?.linearProject?.name,
      model: cfg.plannerModel ?? host.config.plannerModel,
      timeoutMs: cfg.plannerTimeoutMs ?? host.config.plannerTimeoutMs,
      maxIssues: cfg.maxIssues,
      onLog: (line) => broadcastEvent({ type: 'log', data: { taskId: 'system', stage: 'groom', line } }),
    });
    if (!result.success) {
      host.syslog(`⚠ Backlog grooming failed: ${result.error ?? 'unknown error'}`);
      continue;
    }
    successfulPlannerRuns++;
    const validIssueIds = new Set(groupTasks.map(task => task.issueId || task.id));
    const applied = await applyBacklogGrooming(source, result, mode, validIssueIds, { mutationBudget, trustedIssues: new Map(groupTasks.map(t => [t.issueId || t.id, { state: t.linearState, labels: t.labels }])), exclusionLabels: exclusionLabelsForProject((host.config.skip ?? DEFAULT_AGENT_SKIP).labels, host.config.projectAgents, projectPath) }); // AGT-4784
    for (const issueId of applied.movedIssueIds) moved.add(issueId);
    host.syslog(`✓ Backlog grooming: ${result.decisions.length} decision(s), ${applied.commented} comment(s), ${applied.failedComments} comment failure(s), ${applied.updatedDescriptions} description update(s), ${applied.moved} moved, ${applied.skippedUnknown} unknown skipped, ${applied.skippedOpenPr} open-PR skipped, ${applied.skippedByCap} over the cap, ${applied.skippedProtected} protected`);
    for (const decision of result.decisions.slice(0, 5)) {
      host.syslog(`  ${summarizeGroomingDecision(decision)}`);
    }
  }

  if (successfulPlannerRuns > 0) host.maintenance.lastBacklogGroomingAt = now;
  if (moved.size === 0) return tasks;
  return tasks.filter(task => !moved.has(task.issueId || task.id));
}

/**
 * Done means merged (AGT-4409). A publication leaves the issue In Review;
 * this moves it on once GitHub says the PR merged (→ Done, unless the
 * description still has unticked criteria) or closed unmerged (→ Backlog).
 * Only issues whose PR this daemon published, only from In Review, re-read
 * right before the write so a person's later move is never overwritten.
 */
export async function reconcileMergedPublications(host: MaintenanceHost, tasks: TaskItem[], now = Date.now()): Promise<void> {
  const source = getTaskSource(); if (source?.kind !== 'linear') return;
  if (now - host.maintenance.lastMergedPublicationSweepAt < MERGED_PUBLICATION_SWEEP_INTERVAL_MS) return;
  host.maintenance.lastMergedPublicationSweepAt = now;

  const candidates = planMergedPublicationChecks(tasks, {
    isExcluded: await exclusionCheck(tasks, host.config.skip ?? DEFAULT_AGENT_SKIP, host.config.projectAgents, (t: TaskItem) => host.resolveProjectPath(t)), // AGT-4784
    publishedPrUrl: (issueId) => host.durableRuns.getRun(issueId)?.prUrl ?? undefined,
    isSchedulerOwned: (issueId) => host.scheduler.isTaskQueued(issueId) || host.scheduler.isTaskRunning(issueId),
  });
  if (candidates.length === 0) return;

  const { parsePublishedPullRequest } = await import('./publishedPullRequest.js');
  const { getPRLifecycleOrThrow } = await import('../github/github.js');
  let moved = 0;
  for (const { task, prUrl } of candidates) {
    const issueId = task.issueId || task.id;
    const label = task.issueIdentifier ?? issueId;
    const pr = parsePublishedPullRequest(prUrl);
    if (!pr) continue;
    let lifecycle;
    try {
      lifecycle = await getPRLifecycleOrThrow(pr.repo, pr.number);
    } catch (error) {
      console.warn(`[AutonomousRunner] Could not read ${prUrl} for ${label}:`, error instanceof Error ? error.message : error);
      continue;
    }
    host.durableRuns.recordPullRequestState(issueId, prUrl, lifecycle); // AGT-4810: the digest counts merges from this record, never from tracker Done
    const decision = decideMergedPublication(lifecycle, prUrl, task.description); if (decision.action === 'none') continue;

    const refreshed = await source.lookupIssueState(label).catch(() => null);
    if (!refreshed || !refreshed.ok || !refreshed.issue || refreshed.issue.state.toLowerCase() !== 'in review') {
      console.warn(`[AutonomousRunner] Skipping merge reconciliation for ${label}: tracker state changed since the heartbeat`);
      continue;
    }

    if (decision.action === 'await-criteria') {
      const comments = source.getExecutionComments ? await source.getExecutionComments(issueId).catch(() => []) : [];
      const marker = `<!-- openswarm-effect:${decision.marker} -->`;
      if (comments.some((c) => c.body.includes(marker))) continue;
      await source.addComment(issueId, `${decision.comment}\n\n${marker}`, decision.marker).catch((error) => {
        console.warn(`[AutonomousRunner] Could not note open criteria on ${label}:`, error);
      });
      host.syslog(`⏸ ${label}: PR merged, waiting on unticked completion criteria`);
      continue;
    }

    const targetState = decision.action === 'done' ? 'Done' : 'Backlog';
    const accepted = await transitionWithReason(source, issueId, targetState, decision.comment).catch((error) => {
      console.warn(`[AutonomousRunner] Failed to move ${label} → ${targetState}:`, error);
      return false;
    });
    if (!accepted) continue;
    task.linearState = targetState;
    updateTaskLinearState(issueId, targetState);
    moved++;
    host.syslog(`${targetState === 'Done' ? '✓' : '↩'} ${label}: PR ${lifecycle.state.toLowerCase()} → ${targetState}`);

    // A parent closes when its last child has MERGED, checked against the
    // tracker — the local ledger marks children done at publication.
    if (targetState === 'Done') await host.completeParentIfChildrenMerged(issueId, source);
  }
  if (moved > 0) host.syslog(`✓ Reconciled ${moved} merged/closed publication(s)`);
}

/**
 * The retrospective lane (AGT-4181): the runner reads its own ledger and
 * files one evidence-rich issue on the largest failure bucket, so the
 * systemic fixes an operator would derive from the same queries happen
 * without one. Isolated — a lane failure must not fail the heartbeat.
 */
export async function maybeRunLedgerRetrospective(host: MaintenanceHost): Promise<void> {
  if (!host.config.retrospectiveProjectId || !host.durableRuns.isPrimary || host.stopping) return;
  try {
    const source = getTaskSource();
    if (source) {
      const outcome = await runLedgerRetrospective({ taskSource: source, projectId: host.config.retrospectiveProjectId });
      if (outcome.filed) host.syslog(`🔁 Retrospective filed ${outcome.identifier}: ${outcome.reason}`);
    }
  } catch (error) {
    console.warn('[AutonomousRunner] Ledger retrospective failed:', error instanceof Error ? error.message : error);
  }
}

export async function completeParentIfChildrenMerged(host: MaintenanceHost, childIssueId: string, source: TaskSource): Promise<void> {
  const parentState = getTaskState(childIssueId)?.parentIssueId
    ? getTaskState(getTaskState(childIssueId)!.parentIssueId!)
    : undefined;
  if (!parentState || parentState.childIssueIds.length === 0) return;
  for (const childId of parentState.childIssueIds) {
    const lookup = await source.lookupIssueState(childId).catch(() => null);
    if (!lookup || !lookup.ok || !lookup.issue || lookup.issue.state.toLowerCase() !== 'done') return;
  }
  const parent = completeParentLocally(childIssueId);
  if (!parent) return;
  const accepted = await transitionWithReason(source, parent.issueId, 'Done', `All ${parent.childIssueIds.length} child tasks merged, so this parent closes as Done.`).catch(() => false);
  if (!accepted) return;
  await releaseDependentsInTracker(source, parent.issueId); // AGT-4817: tasks waiting on the parent go to Todo in the tracker too
  host.syslog(`✓ ${parent.issueIdentifier ?? parent.issueId}: all children merged → Done`);
}

/**
 * Keep Linear's In Progress column honest: it represents a scheduler-owned
 * task or a live durable lease, never an abandoned claim. The bulk heartbeat
 * fetch already carries updatedAt, so the sweep adds no read-side API calls.
 */
export async function reconcileStalledInProgress(host: MaintenanceHost, tasks: TaskItem[], now = Date.now()): Promise<TaskItem[]> {
  const source = getTaskSource(); if (source?.kind !== 'linear') return tasks;

  const staleAfterMs = (host.config.stalledInProgressHours ?? 6) * 60 * 60_000;
  const candidates = planStalledInProgress(tasks, {
    isExcluded: await exclusionCheck(tasks, host.config.skip ?? DEFAULT_AGENT_SKIP, host.config.projectAgents, (t: TaskItem) => host.resolveProjectPath(t)), // AGT-4784
    now,
    staleAfterMs,
    hasOpenSwarmClaim: (issueId) =>
      host.durableRuns.getRun(issueId) != null
      && getTaskState(issueId)?.execution.status === 'in_progress',
    isSchedulerOwned: (issueId) => host.scheduler.isTaskQueued(issueId) || host.scheduler.isTaskRunning(issueId),
    hasLiveLease: (issueId) => {
      const run = host.durableRuns.getRun(issueId);
      return Boolean(
        run
        && ACTIVE_LEASE_STATES.includes(run.state)
        && run.leaseExpiresAt != null
        && run.leaseExpiresAt > now,
      );
    },
    hasPublishedArtifact: (issueId) => Boolean(host.durableRuns.getRun(issueId)?.prUrl),
  });

  let moved = 0;
  for (const { task, targetState } of candidates) {
    const issueId = task.issueId || task.id;
    // Re-read immediately before the write. The heartbeat snapshot may be
    // minutes old; a person or another daemon could have reclaimed or edited
    // the issue since then. Linear has no conditional issue-update mutation,
    // so an exact state+updatedAt match is the strongest available optimistic
    // guard and missing evidence must fail closed.
    const refreshed = await source.lookupIssueState(task.issueIdentifier ?? issueId).catch((error) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    }));
    if (
      !refreshed.ok
      || !refreshed.issue
      || refreshed.issue.state.toLowerCase() !== 'in progress'
      || !Number.isFinite(refreshed.issue.updatedAt)
      || refreshed.issue.updatedAt !== task.trackerUpdatedAt
    ) {
      console.warn(
        `[AutonomousRunner] Skipping stale-state repair for ${task.issueIdentifier ?? issueId}: tracker ownership changed or could not be revalidated`,
      );
      continue;
    }
    const reason = `No OpenSwarm run, lease or pull request has owned this issue for ${host.config.stalledInProgressHours ?? 6}h, so it returns to ${targetState}.`;
    const accepted = await transitionWithReason(source, issueId, targetState, reason).catch((error) => {
      console.warn(`[AutonomousRunner] Failed to retire stalled ${task.issueIdentifier ?? issueId}:`, error);
      return false;
    });
    if (!accepted) {
      console.warn(`[AutonomousRunner] Tracker refused stale-state repair for ${task.issueIdentifier ?? issueId}`);
      continue;
    }
    task.linearState = targetState; updateTaskLinearState(issueId, targetState);
    moved++;
    host.syslog(`↩ ${task.issueIdentifier ?? issueId}: stale In Progress → ${targetState}`);
  }
  if (moved > 0) host.syslog(`✓ Retired ${moved} stalled In Progress issue(s)`);
  return tasks;
}
