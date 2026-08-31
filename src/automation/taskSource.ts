// ============================================
// OpenSwarm - Task source abstraction
// ============================================
//
// The autonomous runner was hardwired to Linear. This abstracts the runner's
// full Linear surface (fetch + state transitions + comment logging + sub-issue
// creation) behind ITaskSource so OpenSwarm runs with no external SaaS — falling
// back to the existing local SQLite issue store (INT-1577). TaskItem.source
// already supports 'local'.

import * as linear from '../linear/index.js';
import { getIssueStore } from '../issues/index.js';
import type { IIssueStore } from '../issues/sqliteStore.js';
import type { Issue, IssueStatus, IssuePriority } from '../issues/schema.js';
import { formatAutomationComment, formatPairDialogue, type CommentSection } from '../linear/format.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { enrichTaskFromState } from '../taskState/store.js';

/** The runner's task-state vocabulary (mirrors Linear's updateIssueState states). */
export type TaskState = 'In Progress' | 'In Review' | 'Done' | 'Backlog' | 'Todo';

/** Pair-completion stats (matches linear.logPairComplete). */
export interface PairCompleteStats {
  attempts: number;
  duration: number;
  filesChanged: string[];
  workerSummary?: string;
  workerCommands?: string[];
  /** Self-chosen display name of the worker agent, when it introduced itself. */
  workerName?: string;
  reviewerFeedback?: string;
  reviewerDecision?: string;
  /** Self-chosen display name of the reviewer agent. */
  reviewerName?: string;
  /** Model + token/cost usage per speaker, shown under each utterance. */
  workerUsage?: { model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number };
  reviewerUsage?: { model?: string; inputTokens?: number; outputTokens?: number; costUsd?: number; durationMs?: number };
  testResults?: { passed: number; failed: number; coverage?: number; failedTests?: string[] };
  remainingWork?: string;
  /** Hidden marker used by the durable outbox to make comment delivery idempotent. */
  idempotencyMarker?: string;
}

export type SubIssueResult = { id: string; identifier: string; title: string } | { error: string };

/** Explicit tracker lookup used only for stale durable-run reconciliation. */
export type TrackerIssueLookup =
  | { ok: true; issue: { state: string; stateType?: string; updatedAt?: number } | null }
  | { ok: false; error: string };

/** Minimal issue identity used by cache-first supervisor tracker tools. */
export type TrackerIssueResolution =
  | { ok: true; issue: { id: string; identifier: string; title: string; state: string } | null }
  | { ok: false; error: string };

/**
 * Everything the autonomous runner needs from its task tracker. LinearTaskSource
 * preserves today's behavior exactly (thin delegation); SqliteTaskSource backs
 * the same surface with the local store.
 */
export interface ITaskSource {
  readonly kind: 'linear' | 'local';
  fetchTasks(): Promise<TaskItem[]>;
  /** Fetch one issue even when terminal states are excluded from fetchTasks(). */
  lookupIssueState(issueIdOrIdentifier: string): Promise<TrackerIssueLookup>;
  /** Resolve an identifier on a cache miss without widening the normal bulk fetch. */
  resolveIssue?(issueIdOrIdentifier: string): Promise<TrackerIssueResolution>;
  /** Create a top-level task/issue (used by the /plan cockpit to seed a parent). */
  createTask(title: string, description: string, projectId?: string): Promise<SubIssueResult>;
  updateState(issueId: string, state: TaskState): Promise<boolean>;
  updateDescription?(issueId: string, description: string): Promise<void>;
  /** Mark issueId as a duplicate of canonicalIssueId in the tracker. */
  markDuplicate?(issueId: string, canonicalIssueId: string): Promise<boolean>;
  addComment(issueId: string, body: string, idempotencyKey?: string): Promise<void>;
  /** Fresh tracker discussion for execution-time context; avoids stale discovery snapshots. */
  getExecutionComments?(issueId: string): Promise<Array<{ body: string; createdAt: string }>>;
  createSubIssue(
    parentId: string,
    title: string,
    description: string,
    options?: { priority?: number; projectId?: string; estimatedMinutes?: number; idempotencyId?: string },
  ): Promise<SubIssueResult>;
  logPairStart(issueId: string, sessionId: string, projectPath: string): Promise<void>;
  logPairComplete(issueId: string, sessionId: string, stats: PairCompleteStats): Promise<void>;
  logBlocked(issueId: string, sessionName: string, reason: string): Promise<void>;
  /** Permanently park an issue the loop has given up on so it is not retried automatically. */
  logStuck(issueId: string, sessionName: string, reason: string): Promise<void>;
  /** Clear the stuck marker so the issue becomes eligible for retry again. */
  unstick(issueId: string): Promise<void>;
  logHalt(issueId: string, sessionId: string, confidence: number, iteration: number, reason: string): Promise<void>;
  markAsDecomposed(issueId: string, subIssueCount: number, totalMinutes: number, idempotencyMarker?: string): Promise<void>;
}

// ---- Linear-backed (delegates to the existing linear.* — behavior unchanged) ----

export class LinearTaskSource implements ITaskSource {
  readonly kind = 'linear' as const;
  /** fetch is injected so the existing service.ts fetcher closure (slim mode,
   *  comment hydration, task-state enrichment) is preserved verbatim. */
  constructor(private readonly fetch: () => Promise<TaskItem[]>) {}

  fetchTasks(): Promise<TaskItem[]> { return this.fetch(); }
  async lookupIssueState(issueIdOrIdentifier: string): Promise<TrackerIssueLookup> {
    const result = await linear.lookupIssue(issueIdOrIdentifier);
    if (!result.ok) return result;
    return {
      ok: true,
      issue: result.issue
        ? {
            state: result.issue.state,
            stateType: result.issue.stateType,
            updatedAt: result.issue.updatedAt == null
              ? undefined
              : new Date(result.issue.updatedAt).getTime(),
          }
        : null,
    };
  }
  async resolveIssue(issueIdOrIdentifier: string): Promise<TrackerIssueResolution> {
    const result = await linear.lookupIssue(issueIdOrIdentifier);
    if (!result.ok) return result;
    return {
      ok: true,
      issue: result.issue ? {
        id: result.issue.id,
        identifier: result.issue.identifier,
        title: result.issue.title,
        state: result.issue.state,
      } : null,
    };
  }
  async createTask(title: string, description: string, projectId?: string): Promise<SubIssueResult> {
    // Pass projectId so createIssue links the issue AND resolves the project's team
    // (multi-team configs would otherwise hit "teamId must be a UUID"). (INT-2210)
    const r = await linear.createIssue(title, description, [], { projectId });
    return 'error' in r ? r : { id: r.id, identifier: r.identifier, title: r.title };
  }
  updateState(issueId: string, state: TaskState): Promise<boolean> { return linear.updateIssueState(issueId, state); }
  updateDescription(issueId: string, description: string): Promise<void> { return linear.updateIssueDescription(issueId, description); }
  markDuplicate(issueId: string, canonicalIssueId: string): Promise<boolean> { return linear.markIssueDuplicate(issueId, canonicalIssueId); }
  addComment(issueId: string, body: string, idempotencyKey?: string): Promise<void> {
    return linear.addComment(issueId, body, idempotencyKey ? linear.effectCommentId(idempotencyKey) : undefined);
  }
  async getExecutionComments(issueId: string): Promise<Array<{ body: string; createdAt: string }>> {
    const issue = await linear.getIssue(issueId);
    if (!issue) throw new Error(`Could not refresh issue comments: ${issueId}`);
    return issue.comments.map(({ body, createdAt }) => ({ body, createdAt }));
  }
  createSubIssue(parentId: string, title: string, description: string, options?: { priority?: number; projectId?: string; estimatedMinutes?: number; idempotencyId?: string }): Promise<SubIssueResult> {
    return linear.createSubIssue(parentId, title, description, options);
  }
  logPairStart(issueId: string, sessionId: string, projectPath: string): Promise<void> { return linear.logPairStart(issueId, sessionId, projectPath); }
  logPairComplete(issueId: string, sessionId: string, stats: PairCompleteStats): Promise<void> { return linear.logPairComplete(issueId, sessionId, stats); }
  logBlocked(issueId: string, sessionName: string, reason: string): Promise<void> { return linear.logBlocked(issueId, sessionName, reason); }
  logStuck(issueId: string, sessionName: string, reason: string): Promise<void> { return linear.logStuck(issueId, sessionName, reason); }
  unstick(issueId: string): Promise<void> { return linear.removeIssueLabel(issueId, linear.STUCK_LABEL); }
  logHalt(issueId: string, sessionId: string, confidence: number, iteration: number, reason: string): Promise<void> { return linear.logHalt(issueId, sessionId, confidence, iteration, reason); }
  markAsDecomposed(issueId: string, subIssueCount: number, totalMinutes: number, idempotencyMarker?: string): Promise<void> {
    return linear.markAsDecomposed(issueId, subIssueCount, totalMinutes, idempotencyMarker);
  }
}

// ---- SQLite-backed (local issue store, no external account) ----

const PRIORITY_TO_NUM: Record<IssuePriority, number> = { urgent: 1, high: 2, medium: 3, low: 4, none: 4 };
const STATUS_TO_STATE: Record<IssueStatus, TaskState> = {
  backlog: 'Backlog', todo: 'Todo', in_progress: 'In Progress', in_review: 'In Review', done: 'Done', cancelled: 'Backlog',
};
const STATE_TO_STATUS: Record<TaskState, IssueStatus> = {
  'In Progress': 'in_progress', 'In Review': 'in_review', Done: 'done', Backlog: 'backlog', Todo: 'todo',
};

function inlineCode(s: string): string {
  return `\`${s.replaceAll('`', '\\`')}\``;
}

/** Map a local SQLite Issue → the runner's TaskItem. */
export function issueToTask(issue: Issue): TaskItem {
  return {
    id: issue.id,
    source: 'local',
    title: issue.title,
    description: issue.description,
    priority: PRIORITY_TO_NUM[issue.priority] ?? 3,
    issueId: issue.id,
    issueIdentifier: issue.linearIdentifier ?? issue.id,
    linearState: STATUS_TO_STATE[issue.status],
    parentId: issue.parentId,
    estimatedMinutes: issue.estimateMinutes,
    createdAt: new Date(issue.createdAt).getTime(),
    trackerUpdatedAt: new Date(issue.updatedAt).getTime(),
  };
}

export class SqliteTaskSource implements ITaskSource {
  readonly kind = 'local' as const;
  constructor(private readonly store: IIssueStore, private readonly defaultProjectId = 'local') {}

  async fetchTasks(): Promise<TaskItem[]> {
    const { issues } = this.store.listIssues({ status: ['todo', 'in_progress'], limit: 200, offset: 0 });
    // Enrich from canonical task state so planner-declared fileScope (plus
    // dependency/topoRank data) reaches the runner — mirrors the Linear path.
    return issues.map((issue) => enrichTaskFromState(issueToTask(issue)));
  }
  async lookupIssueState(issueId: string): Promise<TrackerIssueLookup> {
    const issue = this.store.getIssue(issueId);
    if (!issue) return { ok: true, issue: null };
    const stateType = issue.status === 'done'
      ? 'completed'
      : issue.status === 'cancelled' ? 'canceled' : undefined;
    return { ok: true, issue: { state: issue.status, stateType } };
  }
  async resolveIssue(issueId: string): Promise<TrackerIssueResolution> {
    const issue = this.store.getIssue(issueId) ?? this.store.getIssueByIdentifier(issueId);
    return {
      ok: true,
      issue: issue ? {
        id: issue.id,
        identifier: issue.linearIdentifier ?? issue.id,
        title: issue.title,
        state: issue.status,
      } : null,
    };
  }
  async createTask(title: string, description: string, projectId?: string): Promise<SubIssueResult> {
    try {
      const issue = this.store.createIssue({ projectId: projectId ?? this.defaultProjectId, title, description, status: 'todo' });
      return { id: issue.id, identifier: issue.id, title: issue.title };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  async updateState(issueId: string, state: TaskState): Promise<boolean> {
    return this.store.changeStatus(issueId, STATE_TO_STATUS[state]) !== null;
  }
  async updateDescription(issueId: string, description: string): Promise<void> {
    this.store.updateIssue(issueId, { description });
  }
  async markDuplicate(issueId: string, canonicalIssueId: string): Promise<boolean> {
    await this.addComment(issueId, `Duplicate of ${canonicalIssueId}; groomed during draft analysis.`);
    return this.updateState(issueId, 'Backlog');
  }
  async addComment(issueId: string, body: string, idempotencyKey?: string): Promise<void> {
    this.store.addEvent(issueId, 'commented', {
      content: body,
      idempotencyKey,
    });
  }
  async getExecutionComments(issueId: string): Promise<Array<{ body: string; createdAt: string }>> {
    return this.store.getEvents(issueId, 500)
      .filter((event) => event.type === 'commented' && event.content)
      .map((event) => ({ body: event.content!, createdAt: event.createdAt }));
  }
  async createSubIssue(parentId: string, title: string, description: string, options?: { priority?: number; projectId?: string; estimatedMinutes?: number; idempotencyId?: string }): Promise<SubIssueResult> {
    const parent = this.store.getIssue(parentId);
    const numToPriority: Record<number, IssuePriority> = { 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' };
    try {
      const issue = this.store.createIssue({
        id: options?.idempotencyId,
        projectId: options?.projectId ?? parent?.projectId ?? this.defaultProjectId,
        title,
        description,
        status: 'todo',
        priority: numToPriority[options?.priority ?? 3] ?? 'medium',
        parentId,
        estimateMinutes: options?.estimatedMinutes,
      });
      return { id: issue.id, identifier: issue.id, title: issue.title };
    } catch (err) {
      const existing = options?.idempotencyId ? this.store.getIssue(options.idempotencyId) : null;
      if (
        existing?.parentId === parentId
        && existing.title === title
        && (existing.description ?? '') === description
      ) {
        return { id: existing.id, identifier: existing.id, title: existing.title };
      }
      if (existing) {
        return { error: `Idempotent child collision for ${options!.idempotencyId}: existing artifact does not match the requested plan` };
      }
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  async logPairStart(issueId: string, _sessionId: string, _projectPath: string): Promise<void> {
    await this.addComment(issueId, formatAutomationComment({
      heading: 'Pair session started',
      summary: 'Starting work in Worker/Reviewer pair mode.',
      meta: { Session: _sessionId, Project: _projectPath },
    }));
    await this.updateState(issueId, 'In Progress');
  }
  async logPairComplete(issueId: string, sessionId: string, stats: PairCompleteStats): Promise<void> {
    const durationStr = stats.duration < 60
      ? `${stats.duration}s`
      : `${Math.floor(stats.duration / 60)}m ${stats.duration % 60}s`;
    const sections: CommentSection[] = [];
    if (stats.workerCommands && stats.workerCommands.length > 0) {
      sections.push({ label: 'Commands run', body: stats.workerCommands.slice(0, 3).map(inlineCode) });
    }
    if (stats.testResults) {
      const { passed, failed, coverage, failedTests } = stats.testResults;
      const totalTests = passed + failed;
      const passRate = totalTests > 0 ? ((passed / totalTests) * 100).toFixed(1) : '0';
      const lines = [`Passed ${passed}/${totalTests} (${passRate}%)`];
      if (coverage !== undefined) lines.push(`Coverage ${coverage.toFixed(1)}%`);
      if (failed > 0 && failedTests && failedTests.length > 0) {
        const extra = failedTests.length > 3 ? ` (+${failedTests.length - 3} more)` : '';
        lines.push(`Failed: ${failedTests.slice(0, 3).join(', ')}${extra}`);
      }
      sections.push({ label: 'Tests', body: lines });
    }
    if (stats.remainingWork) {
      sections.push({ label: 'Remaining work', body: stats.remainingWork.trim() });
    }
    sections.push({
      label: 'Changed files',
      body: stats.filesChanged.length > 0
        ? stats.filesChanged.slice(0, 10).map(inlineCode)
        : ['(none)'],
    });

    const comment = formatAutomationComment({
      heading: 'Task complete',
      summary: formatPairDialogue(stats) ?? stats.workerSummary?.trim() ?? undefined,
      sections,
      meta: {
        Session: sessionId,
        Iterations: stats.attempts,
        Duration: durationStr,
        Files: stats.filesChanged.length,
      },
      attribution: 'Worker/Reviewer/Tester pipeline',
    }) + (stats.idempotencyMarker ? `\n\n<!-- openswarm-effect:${stats.idempotencyMarker} -->` : '');
    await this.addComment(issueId, comment, stats.idempotencyMarker);
    const accepted = await this.updateState(issueId, 'Done');
    if (!accepted) throw new Error(`Local issue store refused Done transition for ${issueId}`);
  }
  async logBlocked(issueId: string, _sessionName: string, reason: string): Promise<void> {
    await this.addComment(issueId, formatAutomationComment({
      heading: 'Blocked — user intervention required',
      sections: [{ label: 'Reason', body: reason }],
      meta: { Agent: _sessionName },
    }));
    await this.updateState(issueId, 'Todo');
  }
  async logStuck(issueId: string, _sessionName: string, reason: string): Promise<void> {
    await this.addComment(issueId, formatAutomationComment({
      heading: 'Stuck — automatic retries exhausted',
      sections: [
        { label: 'Reason', body: reason },
        { label: 'How to retry', body: [
          'Move this issue back to Todo.',
          'The agent will not retry on its own until then.',
        ] },
      ],
      meta: { Agent: _sessionName },
    }));
    await this.updateState(issueId, 'Backlog');
  }
  async unstick(_issueId: string): Promise<void> {
    // Local store has no label concept; recovery is via moving the issue back to an active state.
  }
  async logHalt(issueId: string, _sessionId: string, confidence: number, iteration: number, reason: string): Promise<void> {
    await this.addComment(issueId, formatAutomationComment({
      heading: 'HALT — low confidence',
      summary: `Confidence ${confidence}% is below threshold on attempt #${iteration}; manual input needed.`,
      sections: [
        { label: 'Reason', body: reason },
        { label: 'Suggested next step', body: ['Review the task requirements', 'Provide more context', 'Break it into smaller sub-tasks'] },
      ],
      meta: { Session: _sessionId, Confidence: `${confidence}%`, Attempt: `#${iteration}` },
    }));
  }
  async markAsDecomposed(issueId: string, subIssueCount: number, totalMinutes: number, idempotencyMarker?: string): Promise<void> {
    await this.addComment(issueId, formatAutomationComment({
      heading: 'Decomposed into sub-issues',
      summary: 'The parent stays active while child issues execute.',
      sections: [{
        label: 'Result',
        body: [`Sub-issues created: ${subIssueCount}`, `Total estimated time: ${totalMinutes} min`],
      }],
      attribution: 'Planner agent',
    }), idempotencyMarker);
    const accepted = await this.updateState(issueId, 'In Progress');
    if (!accepted) throw new Error(`Local issue store refused decomposed parent transition for ${issueId}`);
  }
}

/**
 * Pick the task source: Linear when configured (preserving its fetcher closure),
 * else the local SQLite store. Called from service startup.
 */
export function selectTaskSource(linearConfigured: boolean, linearFetch: () => Promise<TaskItem[]>): ITaskSource {
  if (linearConfigured) return new LinearTaskSource(linearFetch);
  return new SqliteTaskSource(getIssueStore());
}
