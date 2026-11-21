// Created: 2026-11-22
// Purpose: the runner's dispatch lanes — the parallel heartbeat (enabled-project filter, decision
//          passes with backfill, admission and enqueue), the pair-mode task execution (serial and
//          scheduler paths) and the execution context handed to runnerExecution — moved out of
//          autonomousRunner.ts as host-taking functions (AGT-4867 slice G)
// Dependencies: orchestration (decisionEngine, taskScheduler), agents/pairPipeline, dispatchRamp,
//               runnerAdmissionPolicy, runnerExecution, trackerEffects, rateLimitBackoff, repoKnowledge,
//               support (repoMetadata, projectGoal), core/eventHub, locale
// Test Status: autonomousRunner.enable/pause/serialLifecycle/durable/coverage tests (runner surface),
//              runnerDispatch.test.ts (host contract, late binding)

import type { DecisionEngine, TaskItem } from '../orchestration/decisionEngine.js';
import { taskEventKey } from '../orchestration/decisionEngine.js';
import type { TaskScheduler } from '../orchestration/taskScheduler.js';
import { formatPipelineResultEmbed, type PipelineResult } from '../agents/pairPipeline.js';
import type { DefaultRolesConfig } from '../core/types.js';
import { broadcastEvent } from '../core/eventHub.js';
import { t } from '../locale/index.js';
import { recordTaskOutcome } from '../memory/repoKnowledge.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { resolveOwningProject, resolveProjectGoal } from '../support/projectGoal.js';
import { dispatchBudget, recordDispatchClaims } from './dispatchRamp.js';
import * as execution from './runnerExecution.js';
import { getTaskSource, reportToDiscord } from './runnerExecution.js';
import { decisionSelectionBudget, type RunnableCandidate } from './runnerAdmissionPolicy.js';
import { completionStats } from './trackerEffects.js';
import { globalRateLimit } from './rateLimitBackoff.js';
import type { DurableRunCoordinator, ExecutionDurabilityHooks } from './durableRunCoordinator.js';
import type { IdleBackoff } from './idleBackoff.js';
import type { RunnerPauseControl } from './runnerPauseControl.js';
import type { AutonomousConfig } from './runnerTypes.js';

/**
 * What the dispatch lanes need from the runner. The runner builds it once and every member
 * is read at call time: state through getters (and a setter for `rateLimitUntil`), every
 * method through the runner itself, so a test (or a later reassignment) of a runner member —
 * `runAvailableTasks`, `resolveProjectPath`, `executeDurably`, `engine`, `scheduler`, ... — is
 * honoured exactly as when this code lived on the class. `rampOwner` is the runner object the
 * cold-start dispatch ramp is keyed on, so the ramp state stays per runner.
 */
export interface DispatchHost {
  readonly rampOwner: object;
  readonly stopping: boolean;
  readonly config: AutonomousConfig;
  readonly engine: Pick<DecisionEngine, 'heartbeatMultiple'>;
  readonly scheduler: Pick<TaskScheduler, 'getAvailableSlots' | 'getStats' | 'enqueue'>;
  readonly durableRuns: Pick<DurableRunCoordinator, 'isPrimary' | 'getRun' | 'activeWorkerIdentifiers'>;
  readonly pauses: Pick<RunnerPauseControl, 'blocks' | 'guardSerial'>;
  readonly idle: Pick<IdleBackoff, 'markProgress'>;
  readonly enabledProjects: ReadonlySet<string>;
  readonly projectPathCache: Map<string, string>;
  readonly unresolvableIssueIds: Set<string>;
  readonly failedTaskCounts: ReadonlyMap<string, number>;
  readonly lastFetchedTasks: TaskItem[];
  rateLimitUntil: number;
  syslog(line: string): void;
  syslogSkipSummary(unmapped: Map<string, number>, disabled: Map<string, number>): void;
  shouldFilterByEnabled(): boolean;
  isProjectEnabled(resolvedPath: string): boolean;
  canQueueProjectCandidate(projectPath: string): boolean;
  enqueueCandidate(task: TaskItem, projectPath: string): boolean;
  resolveRunnableCandidates(decisionTasks: Array<{ task: TaskItem }>): Promise<RunnableCandidate[]>;
  detectSafeCandidateIds(candidates: RunnableCandidate[]): Promise<Set<string>>;
  runAvailableTasks(): Promise<void>;
  attachPriorFeedback(task: TaskItem): void;
  resolveProjectPath(task: TaskItem): Promise<string | null>;
  scheduleNextHeartbeat(): void;
  executeDurably(task: TaskItem, projectPath: string, signal?: AbortSignal): Promise<PipelineResult>;
  formatTaskContext(task: TaskItem): string;
  drainDurableOutbox(): Promise<void>;
  getRolesForProject(projectPath: string): DefaultRolesConfig | undefined;
}

export async function heartbeatParallel(host: DispatchHost, tasks: TaskItem[]): Promise<void> {
  if (host.stopping) return;
  const availableSlots = host.scheduler.getAvailableSlots();
  const runningCount = host.scheduler.getStats().running;
  host.syslog(`  Parallel mode | slots: ${availableSlots} free / ${host.config.maxConcurrentTasks} max | running: ${runningCount}`);

  if (availableSlots === 0) {
    host.syslog(`⏳ All slots busy (${runningCount} tasks running), waiting...`);
    return;
  }

  const maxSlots = dispatchBudget(host.rampOwner, host.config.dispatchRampClaims, availableSlots, host.config.heartbeatSchedule); // free slots, capped by the cold-start ramp

  // Pre-filter tasks to enabled projects only (before DecisionEngine selection)
  // This prevents DecisionEngine from wasting its max-slot budget on non-enabled projects.
  // AGT-4257: Backlog is a queue when slots are free. Terminal Linear
  // states are still dropped later by the decision engine.
  const executableTasks = (host.config.includeBacklog ?? false)
    ? tasks
    : tasks.filter(t => t.linearState !== 'Backlog');

  let tasksForEngine = executableTasks;
  if (host.shouldFilterByEnabled()) {
    // Explicit repo↔Linear mapping — match fetched issues to repos by the Linear
    // projectId the user picked in `openswarm add` (written to <repo>/openswarm.json),
    // NOT by guessing from the repo directory name. Built fresh each cycle so a
    // newly-mapped repo is picked up without a restart. Name matching stays only as
    // a best-effort fallback for repos that never ran the picker.
    const byProjectId = new Map<string, string>();
    for (const repoPath of host.enabledProjects) {
      try {
        const meta = await loadRepoMetadata(repoPath);
        if (meta?.linear?.projectId) byProjectId.set(meta.linear.projectId, repoPath);
      } catch (e) {
        host.syslog(`  ⚠ openswarm.json unreadable for ${repoPath.split('/').pop()}: ${(e as Error).message}`);
      }
    }

    // Aggregate skip reasons per project instead of logging one line per issue —
    // dozens of unmapped issues used to flood the LIVE LOG every heartbeat.
    const skippedUnmapped = new Map<string, number>();
    const skippedDisabled = new Map<string, number>();
    tasksForEngine = executableTasks.filter(task => {
      const projName = task.linearProject?.name;
      const projId = task.linearProject?.id;
      // 1) Explicit projectId mapping (openswarm.json) wins.
      const mappedPath = projId ? byProjectId.get(projId) : undefined;
      // 2) Fallback: repo-name path cache (only for repos without an explicit mapping).
      const cachedPath = mappedPath
        ?? (projName && (host.projectPathCache.get(projName)
          ?? host.projectPathCache.get(projName.toLowerCase())
          ?? host.projectPathCache.get(projName.replace(/-/g, ' '))));
      if (!cachedPath) {
        const key = projName ?? projId ?? 'unknown';
        skippedUnmapped.set(key, (skippedUnmapped.get(key) ?? 0) + 1);
        return false;
      }
      const enabled = host.isProjectEnabled(cachedPath);
      if (!enabled) {
        skippedDisabled.set(projName ?? cachedPath, (skippedDisabled.get(projName ?? cachedPath) ?? 0) + 1);
      }
      return enabled;
    });
    host.syslogSkipSummary(skippedUnmapped, skippedDisabled);
    if (tasksForEngine.length === 0) {
      host.syslog(`⚠ No enabled tasks (${executableTasks.length} executable, ${tasks.length - executableTasks.length} backlog)`);
      host.syslog(`  Path cache: [${[...host.projectPathCache.entries()].map(([k,v]) => `${k}→${v}`).join(', ')}]`);
      host.syslog(`  Enabled: [${[...host.enabledProjects].join(', ')}]`);
      return;
    }
    host.syslog(`  Tasks: ${tasksForEngine.length} enabled-or-uncached / ${executableTasks.length} executable / ${tasks.length} total`);
  }

  let enqueuedCount = 0;
  let skippedCount = 0;
  const consideredTaskIds = new Set<string>();
  let pass = 0;

  while (enqueuedCount < maxSlots) {
    if (host.stopping) return;
    const remainingSlots = maxSlots - enqueuedCount;
    const selectableTasks = tasksForEngine.filter(task => !consideredTaskIds.has(task.id));
    const selectionBudget = decisionSelectionBudget(remainingSlots, selectableTasks.length);
    if (selectionBudget === 0) break;

    host.syslog(pass === 0
      ? '⟳ Decision Engine evaluating tasks...'
      : `⟳ Backfill pass (${remainingSlots} slot(s) open)...`);

    const decision = await host.engine.heartbeatMultiple(
      selectableTasks,
      selectionBudget,
      [] // No project exclusion — worktree mode isolates each task
    );
    if (host.stopping) return;

    console.log(`[AutonomousRunner] Decision: ${decision.action} — ${decision.reason} (${decision.tasks?.length ?? 0} tasks)`);
    skippedCount += decision.skippedCount ?? 0;
    if (decision.action === 'skip' || decision.action === 'defer') {
      host.syslog(`→ Decision: ${decision.action} — ${decision.reason}`);
      break;
    }

    for (const { task } of decision.tasks) {
      consideredTaskIds.add(task.id);
    }

    const candidates = await host.resolveRunnableCandidates(decision.tasks);
    if (host.stopping) return;
    const safeTasks = await host.detectSafeCandidateIds(candidates);
    if (host.stopping) return;

    for (const { task, projectPath } of candidates) {
      if (host.stopping) return;
      if (enqueuedCount >= maxSlots) break;
      if (!safeTasks.has(task.id) || host.pauses.blocks(projectPath)) continue;
      if (!host.canQueueProjectCandidate(projectPath)) {
        host.syslog(`  Project cap reached: ${projectPath}`);
        continue;
      }

      if (host.enqueueCandidate(task, projectPath)) {
        enqueuedCount++;
      }
    }

    pass++;

    if (enqueuedCount >= maxSlots) break;
    if (decision.tasks.length === 0) break;
    // NOTE: no "selectionBudget >= selectableTasks.length ⇒ break" here — that
    // used to short-circuit the WHOLE heartbeat the instant selectionBudget
    // covered the full candidate pool (the common case whenever free slots
    // exceed the candidate count), even when every one of decision.tasks
    // turned out already-running/queued and got discarded above (`before`).
    // A single hard-to-satisfy task occupying one slot for hours then starved
    // every other free slot forever: same task re-selected + discarded each
    // 5-min heartbeat, no backfill pass ever tried the rest of the pool. The
    // loop's own progress guarantee is enough — consideredTaskIds grows by
    // decision.tasks.length every pass, so selectableTasks strictly shrinks
    // each iteration and the top-of-loop `selectionBudget === 0` check (line
    // ~1197) is what actually terminates once nothing candidate remains.
    // (INT-2570 follow-up, observed live: INT-2061 held a WAVE slot for 4h+
    // while 7/8 scheduler slots sat idle with 18 executable tasks waiting.)
  }

  if (enqueuedCount === 0 && skippedCount > 0) {
    host.syslog(`— No new tasks queued (skipped: ${skippedCount})`);
  } else {
    host.syslog(`✓ Enqueued ${enqueuedCount} task(s) | skipped: ${skippedCount}`);
  }
  recordDispatchClaims(host.rampOwner, enqueuedCount); // only claiming passes advance the cold-start ramp

  // Execute tasks
  if (!host.stopping) await host.runAvailableTasks();
}

/** Execute task in pair mode */
export async function executeTaskPairMode(host: DispatchHost, task: TaskItem): Promise<void> {
  if (host.stopping) return;
  // Serial path (maxConcurrentTasks=1) bypasses enqueueCandidate — attach the
  // prior-session feedback here too so both paths inject it (INT-2474).
  host.attachPriorFeedback(task);

  // Auto-resolve project path
  const projectPath = await host.resolveProjectPath(task);
  if (host.stopping) return;

  // Error if project path mapping failed
  if (!projectPath) {
    const errorMsg = `Failed to resolve project path for "${task.linearProject?.name || task.title}"`;
    console.error(`[AutonomousRunner] ${errorMsg}`);
    // Record so this issue isn't re-picked every heartbeat (it would starve
    // runnable tasks behind it). Cleared on restart. (INT-1875)
    host.unresolvableIssueIds.add(task.issueId || task.id);
    await reportToDiscord(t('runner.projectMappingFailed', { title: task.title, project: task.linearProject?.name || 'unknown' }));
    // Move on to the next actionable task instead of ending the heartbeat here.
    host.scheduleNextHeartbeat();
    return;
  }

  // Skip if project is not in enabled list (allow-list; empty = nothing runs)
  if (host.shouldFilterByEnabled() && !host.isProjectEnabled(projectPath)) {
    console.log(`[AutonomousRunner] Project not enabled, skipping: ${projectPath}`);
    return;
  }

  // Cache linearProjectName → resolvedPath for dashboard
  if (task.linearProject?.name) {
    host.projectPathCache.set(task.linearProject.name, projectPath);
  }

  host.idle.markProgress(); console.log(`[AutonomousRunner] projectPath: ${projectPath}`); // a task starts: only now reset the idle streak

  // Use scheduler for parallel processing mode
  if (host.config.maxConcurrentTasks && host.config.maxConcurrentTasks > 1) {
    if (host.scheduler.enqueue(task, projectPath)) {
      broadcastEvent({ type: 'task:queued', data: { taskId: taskEventKey(task), title: task.title, projectPath, issueIdentifier: task.issueIdentifier } });
    }
    await host.runAvailableTasks();
    return;
  }

  // Single execution (legacy serial path — maxConcurrentTasks <= 1).
  // The scheduler emits task:started/completed for the parallel path; this
  // path never did, so dashboards saw no lifecycle and (since INT-3402) the
  // transcript buffer was never handed to its retention timer.
  broadcastEvent({
    type: 'task:started',
    data: { taskId: taskEventKey(task), title: task.title, issueIdentifier: task.issueIdentifier },
  });
  let result: PipelineResult;
  try {
    result = await host.pauses.guardSerial(task.id, projectPath, (signal) => host.executeDurably(task, projectPath, signal)); // `now` pause reaches serial runs
  } catch (err) {
    broadcastEvent({
      type: 'task:completed',
      data: { taskId: taskEventKey(task), success: false, duration: 0 },
    });
    throw err;
  }
  broadcastEvent({
    type: 'task:completed',
    data: { taskId: taskEventKey(task), success: result.success, duration: result.totalDuration },
  });

  // Rate-limited: pause until quota resets. Return before any Discord/Linear
  // reporting or state change — no failure count, no card spam. Same as the
  // scheduler 'failed' handler's rate_limited branch. (INT-1906)
  if (result.finalStatus === 'rate_limited') {
    const resetsAt = globalRateLimit.hit(result.rateLimitResetsAt);
    host.rateLimitUntil = resetsAt;
    const waitSec = Math.max(0, Math.ceil((resetsAt - Date.now()) / 1000));
    const resetsLabel = new Date(resetsAt).toISOString();
    console.warn(`[AutonomousRunner] Rate limit hit for ${host.formatTaskContext(task)} — pausing until ${resetsLabel} (~${waitSec}s)`);
    broadcastEvent({ type: 'log', data: { taskId: taskEventKey(task), stage: 'rate_limit', line: `⏸ Rate limited — pausing ~${waitSec}s (until ${resetsLabel})` } });
    return;
  }

  await reportToDiscord(formatPipelineResultEmbed(result));

  if (result.success && task.issueId && host.durableRuns.isPrimary) {
    await host.drainDurableOutbox().catch((error) =>
      console.error('[Outbox] Serial completion delivery pass failed:', error));
    if (host.durableRuns.getRun(task.issueId)?.state !== 'DONE') {
      console.warn(`[AutonomousRunner] ${task.issueId} remains sync-pending; completion will reconcile later`);
    }
    return;
  }

  // Update Linear issue state
  if (task.issueId) {
    try {
      if (result.success) {
        // On success, move to Done
        await execution.syncSuccessState(task);
        await getTaskSource()?.logPairComplete(task.issueId, result.sessionId, completionStats(result));
        await execution.reconcileCompletionState(task);
        console.log(`[AutonomousRunner] Issue ${task.issueId} marked as Done`);

        if (result.taskContext?.projectPath) {
          await recordTaskOutcome(result.taskContext.projectPath, {
            taskTitle: task.title,
            derivedFrom: task.issueIdentifier ?? task.issueId,
            workerResult: result.workerResult,
            iterations: result.iterations,
          });
        }
      } else if (result.finalStatus === 'rejected') {
        // Change to Blocked on review rejection
        await execution.syncFailureState(
          task,
          `Review rejected: ${result.reviewResult?.feedback || t('common.fallback.noDescription')}`,
          'Todo',
        );
        await getTaskSource()?.logBlocked(task.issueId, 'autonomous-runner',
          t('runner.reviewRejected', { feedback: result.reviewResult?.feedback || t('common.fallback.noDescription') })
        );
        console.log(`[AutonomousRunner] Issue ${task.issueId} marked as Todo (blocked) (rejected)`);
      }
      // If failed, keep In Progress (retry on next heartbeat)
    } catch (err) {
      console.error(`[AutonomousRunner] Failed to update issue state:`, err);
    }
  }
}

export function getExecCtx(host: DispatchHost, durability?: ExecutionDurabilityHooks): execution.ExecutionContext {
  return {
    allowedProjects: host.config.allowedProjects,
    plannerModel: host.config.plannerModel,
    plannerTimeoutMs: host.config.plannerTimeoutMs,
    // Was declared on ExecutionContext but never set — the drafter always ran
    // the adapter's built-in default, so a single-model fleet was impossible.
    draftModel: host.config.draftModel,
    pairMaxAttempts: host.config.pairMaxAttempts,
    enableDecomposition: host.config.enableDecomposition,
    decompositionThresholdMinutes: host.config.decompositionThresholdMinutes,
    decompositionMaxDepth: host.config.decomposition?.maxDepth ?? 2,
    decompositionMaxChildren: host.config.decomposition?.maxChildrenPerTask ?? 5,
    decompositionDailyLimit: host.config.decomposition?.dailyLimit ?? 20,
    decompositionAutoBacklog: host.config.decomposition?.autoBacklog ?? true,
    decomposeAfterFailures: host.config.decomposition?.decomposeAfterFailures ?? 3,
    getPriorFailures: (issueId) => host.failedTaskCounts.get(issueId) ?? 0,
    jobProfiles: host.config.jobProfiles,
    getRolesForProject: (p) => host.getRolesForProject(p),
    getProjectGoal: (p) => resolveProjectGoal(host.config.projectAgents, p),
    getProjectSetup: (p) => resolveOwningProject(host.config.projectAgents, p)?.setup,
    reportToDiscord,
    worktreeMode: host.config.worktreeMode ?? false,
    scheduleNextHeartbeat: () => host.scheduleNextHeartbeat(),
    guards: host.config.guards,
    verify: host.config.verify,
    securityAudit: host.config.securityAudit,
    maxReflections: host.config.maxReflections,
    loopAdvisor: host.config.loopAdvisor,
    advisorRole: host.config.defaultRoles?.advisor,
    durability,
    peerIssues: host.lastFetchedTasks,
    getActiveWorkerIssues: (p) => host.durableRuns.activeWorkerIdentifiers(p),
    mcpPolicies: host.config.mcpPolicies,
    adapterRouting: host.config.adapterRouting,
    workerSandbox: host.config.workerSandbox,
  };
}
