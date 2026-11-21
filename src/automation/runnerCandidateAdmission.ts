// Created: 2026-11-22
// Purpose: candidate admission for the parallel heartbeat — resolve runnable candidates, hold declined
//          drafts before any claim, and pick the conflict-safe set — moved out of autonomousRunner.ts as
//          host-taking functions (AGT-4867 slice B)
// Dependencies: conflictDetector (scope conflicts), draftCache (durable drafted scopes), preClaimHold
//               (pre-claim hold + draft activity), runnerExecution (pre-admission draft), runnerAdmissionPolicy
// Test Status: autonomousRunner.coverage/preClaimDraft/enable/pause tests, runnerCandidateAdmission.test.ts (host contract)

import type { TaskItem } from '../orchestration/decisionEngine.js';
import { normalizeProjectPath, type TaskScheduler } from '../orchestration/taskScheduler.js';
import { resolveProjectGoal } from '../support/projectGoal.js';
import * as execution from './runnerExecution.js';
import { getTaskSource } from './runnerExecution.js';
import { DRAFT_SCOPE_KEY_VERSION, draftFingerprint, readDraftCache, writeDraftCache } from './draftCache.js';
import { cachedDraftReusable, currentDraftActivity, draftActivityStamp, holdBeforeClaim, recordDraftOutcome, type IssueActivity } from './preClaimHold.js';
import { isScopeDeclined } from '../agents/draftScope.js';
import {
  describeScopeConflict,
  detectFileConflicts,
  resolveTaskFileScope,
  type ScopeConflictReason,
} from '../orchestration/conflictDetector.js';
import type { AutonomousConfig } from './runnerTypes.js';
import {
  describeConflictCause,
  failClosedConflictFallback,
  taskLabel,
  type RunnableCandidate,
} from './runnerAdmissionPolicy.js';

export type CachedDraftScope = {
  fingerprint: string;
  fileScope: string[];
  draft: NonNullable<TaskItem['preAdmissionDraft']>;
  description?: string;
  executionCommentsLoaded?: boolean; activity?: string; // issue activity for a declined draft (AGT-4784)
};

/**
 * What candidate admission needs from the runner. The runner builds it so every
 * member is read at call time: state through getters, and every method through
 * the runner itself, so a test (or a later reassignment) of a runner member —
 * `resolveProjectPath`, `holdDeclinedBeforeClaim`, ... — is honoured exactly as
 * when this code lived on the class.
 */
export interface CandidateAdmissionHost {
  readonly stopping: boolean;
  readonly config: Pick<AutonomousConfig, 'projectAgents' | 'unknownScopeAdmission'>;
  readonly scheduler: Pick<TaskScheduler, 'isTaskQueued' | 'isTaskRunning' | 'isProjectBusy' | 'getRunningTasks'>;
  readonly unresolvableIssueIds: Set<string>;
  readonly projectPathCache: Map<string, string>;
  readonly preAdmissionScopeCache: Map<string, CachedDraftScope>;
  readonly unknownScopeDebt: Set<string>;
  syslog(line: string): void;
  resolveProjectPath(task: TaskItem): Promise<string | null>;
  shouldFilterByEnabled(): boolean;
  isProjectEnabled(resolvedPath: string): boolean;
  holdDeclinedBeforeClaim(group: RunnableCandidate[], draftFailed: ReadonlySet<string>): Promise<RunnableCandidate[]>;
  getExecCtx(): execution.ExecutionContext;
}

export async function resolveRunnableCandidates(host: CandidateAdmissionHost, decisionTasks: Array<{ task: TaskItem }>): Promise<RunnableCandidate[]> {
  const candidates: { task: TaskItem; projectPath: string }[] = [];
  for (const { task } of decisionTasks) {
    if (host.stopping) return candidates;
    if (host.scheduler.isTaskQueued(task.id) || host.scheduler.isTaskRunning(task.id)) {
      host.syslog(`  Skip (already queued/running): ${task.issueIdentifier || task.id.slice(0, 8)} ${task.title}`);
      continue;
    }

    const projectPath = await host.resolveProjectPath(task);
    if (!projectPath) {
      host.syslog(`✗ Cannot resolve project path for "${task.linearProject?.name || task.title}" — skipping`);
      // Record so it isn't re-picked every heartbeat (starvation). (INT-1875)
      host.unresolvableIssueIds.add(task.issueId || task.id);
      continue;
    }

    if (task.linearProject?.name) {
      host.projectPathCache.set(task.linearProject.name, projectPath);
    }

    if (host.scheduler.isProjectBusy(projectPath)) {
      host.syslog(`  Project busy: ${projectPath}`);
      continue;
    }

    if (host.shouldFilterByEnabled() && !host.isProjectEnabled(projectPath)) {
      host.syslog(`  Project not enabled: ${projectPath}`);
      continue;
    }

    candidates.push({ task, projectPath });
  }

  return candidates;
}

/**
 * Hold, before any claim, every candidate whose draft declined it (`human_action_only`,
 * `decision_pending`, ...) or could not be made, for every project (AGT-4784): see preClaimHold.ts.
 */
export async function holdDeclinedBeforeClaim(host: CandidateAdmissionHost, group: RunnableCandidate[], draftFailed: ReadonlySet<string>): Promise<RunnableCandidate[]> {
  const source = getTaskSource();
  return holdBeforeClaim(group, draftFailed, {
    log: (line) => host.syslog(line), label: taskLabel,
    comment: source?.kind === 'linear' ? (issueId, body, marker) => source.addComment(issueId, body, marker) : undefined,
  });
}

export async function detectSafeCandidateIds(host: CandidateAdmissionHost, candidates: RunnableCandidate[]): Promise<Set<string>> {
  // Group candidates by canonical repository identity for conflict detection.
  // A symlink/relative-path alias must not split one repository into two groups
  // and bypass same-repository conflict serialization.
  const byProject = new Map<string, { task: TaskItem; projectPath: string }[]>();
  for (const c of candidates) {
    const canonicalPath = normalizeProjectPath(c.projectPath);
    const group = byProject.get(canonicalPath) || [];
    group.push(c);
    byProject.set(canonicalPath, group);
  }

  // Detect file conflicts per project using Knowledge Graph
  const safeTasks = new Set<string>(); // task IDs safe to enqueue
  for (const [projPath, group] of byProject) {
    // What survives the pre-claim hold. The fail-closed fallback below must pick from this, not
    // from `group`, or an analysis failure would admit the very issue the hold just refused.
    let claimable: RunnableCandidate[] = group;
    const draftFailed = new Set<string>(); // drafts that threw or got no answer this heartbeat (AGT-4784)
    const source = getTaskSource(); const comments = source?.getExecutionComments?.bind(source);
    try {
      await Promise.all(group.map(async c => {
        const cacheKey = `${projPath}\0${c.task.id}`;
        // Title, description, goal and prompt version only: trackerUpdatedAt bumps on the daemon's own
        // writes and drove one unchanged issue to 40 re-drafts (AGT-4300). A declined draft is the one
        // exception — it also carries the issue activity (cachedDraftReusable) so an answer given as a
        // comment releases the held issue (AGT-4784).
        const fingerprint = draftFingerprint(c.task.title, c.task.description, resolveProjectGoal(host.config.projectAgents, projPath), DRAFT_SCOPE_KEY_VERSION);
        let read: Promise<IssueActivity | undefined> | undefined; const activity = () => (read ??= currentDraftActivity(c.task, comments));
        const wanted = (c.task.fileScope?.length ?? 0) === 0;
        const apply = (entry: {
          fileScope: string[]; draft: NonNullable<TaskItem['preAdmissionDraft']>;
          description?: string; executionCommentsLoaded?: boolean;
        }): void => {
          // A cached decline names no files: the scope stays unknown instead of becoming an
          // empty "drafted" one. (AGT-4784)
          if (entry.fileScope.length > 0) {
            c.task.fileScope = [...entry.fileScope];
            c.task.fileScopeSource = 'drafted';
          }
          c.task.preAdmissionDraft = { ...entry.draft, relevantFiles: [...entry.fileScope] };
          c.task.description = entry.description;
          c.task.executionCommentsLoaded = entry.executionCommentsLoaded;
        };

        const cached = host.preAdmissionScopeCache.get(cacheKey);
        const persist = (stamp: string) => { const durable = readDraftCache<NonNullable<TaskItem['preAdmissionDraft']>>(c.task.id, fingerprint); if (durable) writeDraftCache(c.task.id, { ...durable, activity: stamp }); };
        if (wanted && cached?.fingerprint === fingerprint && await cachedDraftReusable(cached, activity, persist)) {
          apply(cached);
          return;
        }
        // The in-memory map is a hot path in front of the durable row, not
        // the record itself. It holds 256 entries against ~275 active runs
        // and does not survive a restart, while RETRY_AT backoff is counted
        // in hours — so on its own it missed on nearly every retry and the
        // draft was recomputed at ~$0.0043 a call. (AGT-4286)
        if (wanted) {
          const durable = readDraftCache<NonNullable<TaskItem['preAdmissionDraft']>>(
            c.task.id, fingerprint,
          );
          if (durable && await cachedDraftReusable(durable, activity, persist)) {
            apply(durable);
            host.preAdmissionScopeCache.set(cacheKey, {
              fingerprint, fileScope: [...durable.fileScope], draft: durable.draft,
              description: durable.description, activity: durable.activity,
              executionCommentsLoaded: durable.executionCommentsLoaded,
            });
            return;
          }
        }
        await resolveTaskFileScope(c.task, projPath, {
          draftTask: () => recordDraftOutcome(draftFailed, c.task.id, () => execution.runPreAdmissionDraft(host.getExecCtx(), c.task, projPath)),
          generatedOutputRules: host.config.projectAgents?.find(
            pa => projPath.includes(pa.projectPath.replace('~', '')),
          )?.generatedOutputRules,
        });
        // A confident decline is cached like a drafted scope: it is as expensive to recompute, and
        // the pre-claim hold reads it on every heartbeat, so a held issue must cost no model call
        // after the first. It is never a 'drafted' scope — it names no files. (AGT-4784)
        const declinedDraft = !!c.task.preAdmissionDraft && isScopeDeclined(c.task.preAdmissionDraft.scope);
        if ((c.task.fileScopeSource === 'drafted' || declinedDraft) && c.task.preAdmissionDraft) {
          const entry = {
            fingerprint, fileScope: [...(c.task.fileScope ?? [])], draft: c.task.preAdmissionDraft,
            description: c.task.description,
            executionCommentsLoaded: c.task.executionCommentsLoaded,
            activity: declinedDraft ? await activity().then((a) => (a ? draftActivityStamp(a) : undefined)) : undefined,
          };
          host.preAdmissionScopeCache.delete(cacheKey);
          host.preAdmissionScopeCache.set(cacheKey, entry);
          if (host.preAdmissionScopeCache.size > 256) {
            host.preAdmissionScopeCache.delete(host.preAdmissionScopeCache.keys().next().value!);
          }
          writeDraftCache(c.task.id, entry);
        }
      }));

      // The drafts above are the first look at what an issue asks for, and they are
      // available before anything is claimed. A confident "a person has to do or decide
      // this" verdict stops the claim here instead of after a worker has started. (AGT-4784)
      claimable = await host.holdDeclinedBeforeClaim(group, draftFailed);

      // A later heartbeat must compare new candidates with workers that are
      // already editing another worktree. Candidate-vs-candidate detection
      // alone leaves a race window across heartbeat cycles.
      const active = host.scheduler.getRunningTasks()
        .filter(running => normalizeProjectPath(running.projectPath) === projPath);
      // Read the SAME policy the durable admission gate reads
      // (admitsConflictScope, runLedgerScope.ts). While this gate ignored it,
      // `unknownScopeAdmission: admit` was live on vela yet one running task
      // still deferred every other candidate — 11 of 12 slots idle with 126
      // executable tasks waiting (AGT-4233).
      const admission = host.config.unknownScopeAdmission ?? 'admit';
      const runnable = claimable.filter(candidate => {
        let blockedBy: { label: string; reason: ScopeConflictReason } | undefined;
        for (const running of active) {
          const reason = describeScopeConflict(
            candidate.task.fileScope,
            running.task.fileScope,
            admission,
          );
          if (reason) {
            blockedBy = { label: taskLabel(running.task), reason };
            break;
          }
        }
        if (blockedBy) {
          host.syslog(
            `Conflict with active worktree (${describeConflictCause(blockedBy.reason, blockedBy.label)})`
            + ` — deferring: ${taskLabel(candidate.task)} ${candidate.task.title}`,
          );
        }
        return !blockedBy;
      });
      if (runnable.length === 0) continue;

      const debtKey = (task: TaskItem) => `${projPath}\0${task.id}`;
      for (const candidate of runnable) {
        if ((candidate.task.fileScope?.length ?? 0) > 0) host.unknownScopeDebt.delete(debtKey(candidate.task));
      }
      const debtTask = active.length === 0
        ? runnable.find(candidate =>
          (candidate.task.fileScope?.length ?? 0) === 0
          && host.unknownScopeDebt.has(debtKey(candidate.task)))
        : undefined;
      const runnableTasks = runnable.map(c => c.task);
      const result = debtTask
        ? await detectFileConflicts(runnableTasks, projPath, {
          preferUnknownExclusive: true,
          preferredUnknownTaskId: debtTask.task.id,
          unknownScopeAdmission: admission,
        })
        : await detectFileConflicts(runnableTasks, projPath, {
          unknownScopeAdmission: admission,
        });

      for (const t of result.safe) {
        safeTasks.add(t.id);
        if ((t.fileScope?.length ?? 0) === 0) host.unknownScopeDebt.delete(debtKey(t));
      }
      for (const candidate of runnable) {
        if ((candidate.task.fileScope?.length ?? 0) === 0 && !safeTasks.has(candidate.task.id)) {
          host.unknownScopeDebt.add(debtKey(candidate.task));
        }
      }

      for (const cg of result.conflictGroups) {
        const ids = cg.tasks.map(t => t.issueIdentifier || t.id.slice(0, 8)).join(', ');
        host.syslog(`Conflict group: [${ids}] shared: ${cg.sharedModules.join(', ')}`);
        // Log of the conflict group's deferred tasks
        for (const t of cg.tasks) {
          if (!safeTasks.has(t.id)) {
            host.syslog(`Conflict detected — deferring: ${t.issueIdentifier || t.id.slice(0, 8)} ${t.title}`);
          }
        }
      }
    } catch (err) {
      // A failed analysis means concurrent-edit safety was not proven. Let only one
      // task per repository through to serialize them, and defer the rest to the next heartbeat.
      console.warn(`[AutonomousRunner] Conflict detection failed for ${projPath}:`, err);
      for (const id of failClosedConflictFallback(claimable)) safeTasks.add(id);
      for (const deferred of claimable.slice(1)) {
        host.syslog(`Conflict analysis unavailable — serializing: ${deferred.task.issueIdentifier || deferred.task.id.slice(0, 8)} ${deferred.task.title}`);
      }
    }
  }

  return safeTasks;
}
