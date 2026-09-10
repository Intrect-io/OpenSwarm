// ============================================
// OpenSwarm - Issue Tracker GraphQL Resolvers
// Created: 2026-04-03
// Purpose: Query + Mutation 리졸버
// ============================================

import { getIssueStore, type SqliteIssueStore } from '../sqliteStore.js';
import { autoLinkMemories, enrichIssueContext } from '../memoryBridge.js';
import type { Issue, IssueFilter } from '../schema.js';

const DEFAULT_ISSUE_LIMIT = 50;
const MAX_ISSUE_LIMIT = 200;
const DEFAULT_EVENT_LIMIT = 50;
const DEFAULT_RECENT_EVENT_LIMIT = 20;
const MAX_EVENT_LIMIT = 200;

/** Bound fire-and-forget auto-link jobs after createIssue. */
const AUTO_LINK_MAX_CONCURRENT = 4;
const AUTO_LINK_TIMEOUT_MS = 15_000;
let autoLinkTimeoutMs = AUTO_LINK_TIMEOUT_MS;
let autoLinkInFlight = 0;
const autoLinkWaiters: Array<() => void> = [];

function clampLimit(limit: number | undefined, defaultLimit: number, maxLimit: number): number {
  if (limit === undefined || !Number.isInteger(limit)) return defaultLimit;
  return Math.min(Math.max(limit, 1), maxLimit);
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isInteger(offset)) return 0;
  return Math.max(offset, 0);
}

function sanitizeSearch(search: string | undefined): string | undefined {
  const normalized = search
    ?.split('')
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : char;
    })
    .join('')
    .trim()
    .replace(/\s+/g, ' ');
  if (!normalized) return undefined;

  return normalized
    .split(' ')
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' AND ');
}

function normalizeIssueFilter(filter: IssueFilter | undefined): IssueFilter {
  return {
    ...filter,
    search: sanitizeSearch(filter?.search),
    limit: clampLimit(filter?.limit, DEFAULT_ISSUE_LIMIT, MAX_ISSUE_LIMIT),
    offset: clampOffset(filter?.offset),
  };
}

async function acquireAutoLinkSlot(): Promise<void> {
  if (autoLinkInFlight < AUTO_LINK_MAX_CONCURRENT) {
    autoLinkInFlight++;
    return;
  }
  await new Promise<void>((resolve) => {
    autoLinkWaiters.push(() => {
      autoLinkInFlight++;
      resolve();
    });
  });
}

function releaseAutoLinkSlot(): void {
  autoLinkInFlight = Math.max(0, autoLinkInFlight - 1);
  const next = autoLinkWaiters.shift();
  if (next) next();
}

/**
 * Supervise createIssue auto-link work: concurrency cap, deadline, and failure
 * observation — no unbounded fire-and-forget.
 *
 * Clears the timeout on settle and absorbs a late work rejection when the
 * deadline wins, so neither side can surface an unhandled rejection.
 */
function scheduleAutoLinkMemories(store: SqliteIssueStore, issue: Issue): void {
  void (async () => {
    await acquireAutoLinkSlot();
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = autoLinkMemories(store, issue);
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`autoLinkMemories timed out after ${autoLinkTimeoutMs}ms`)),
          autoLinkTimeoutMs,
        );
        timer.unref?.();
        work.then(() => resolve(), reject);
      });
    } catch (err) {
      console.warn(
        `[GraphQL] 메모리 자동 연결 실패 (issue=${issue.id}, elapsed=${Date.now() - started}ms, inFlight=${autoLinkInFlight}):`,
        err,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // If the deadline won, absorb a late rejection from the still-running work.
      void work.catch(() => {});
      releaseAutoLinkSlot();
    }
  })();
}

/** @internal Test hooks for auto-link concurrency / timeout supervision. */
export const __autoLinkTestHooks = {
  maxConcurrent: AUTO_LINK_MAX_CONCURRENT,
  defaultTimeoutMs: AUTO_LINK_TIMEOUT_MS,
  get timeoutMs() {
    return autoLinkTimeoutMs;
  },
  get inFlight() {
    return autoLinkInFlight;
  },
  get waiterCount() {
    return autoLinkWaiters.length;
  },
  setTimeoutMs(ms: number) {
    autoLinkTimeoutMs = ms;
  },
  reset() {
    autoLinkInFlight = 0;
    autoLinkWaiters.length = 0;
    autoLinkTimeoutMs = AUTO_LINK_TIMEOUT_MS;
  },
  schedule: scheduleAutoLinkMemories,
  acquire: acquireAutoLinkSlot,
  release: releaseAutoLinkSlot,
};

export const resolvers = {
  Query: {
    issue: (_: unknown, { id }: { id: string }) => {
      return getIssueStore().getIssue(id);
    },

    issues: (_: unknown, { filter }: { filter?: IssueFilter }) => {
      return getIssueStore().listIssues(normalizeIssueFilter(filter));
    },

    labels: () => getIssueStore().listLabels(),
    milestones: () => getIssueStore().listMilestones(),

    issueEvents: (_: unknown, { issueId, limit }: { issueId: string; limit?: number }) => {
      return getIssueStore().getEvents(issueId, clampLimit(limit, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT));
    },

    recentEvents: (_: unknown, { limit }: { limit?: number }) => {
      return getIssueStore().getRecentEvents(clampLimit(limit, DEFAULT_RECENT_EVENT_LIMIT, MAX_EVENT_LIMIT));
    },

    issueStats: (_: unknown, { projectId }: { projectId?: string }) => {
      const stats = getIssueStore().getStats(projectId);
      return {
        ...stats,
        byStatus: Object.entries(stats.byStatus).map(([status, count]) => ({ status, count })),
        byPriority: Object.entries(stats.byPriority).map(([priority, count]) => ({ priority, count })),
        byProject: Object.entries(stats.byProject).map(([projectId, count]) => ({ projectId, count })),
      };
    },

    linkedMemories: (_: unknown, { issueId }: { issueId: string }) => {
      return getIssueStore().getLinkedMemories(issueId);
    },

    issueContext: async (_: unknown, { issueId }: { issueId: string }) => {
      const store = getIssueStore();
      const issue = store.getIssue(issueId);
      if (!issue) throw new Error(`Issue ${issueId} not found`);
      return enrichIssueContext(store, issue);
    },
  },

  Mutation: {
    createIssue: async (_: unknown, { input }: { input: any }) => {
      const store = getIssueStore();
      const issue = store.createIssue(input);

      // Bounded + supervised background auto-link (failure does not fail create).
      scheduleAutoLinkMemories(store, issue);

      return issue;
    },

    updateIssue: (_: unknown, { id, input }: { id: string; input: any }) => {
      return getIssueStore().updateIssue(id, input);
    },

    deleteIssue: (_: unknown, { id }: { id: string }) => {
      return getIssueStore().deleteIssue(id);
    },

    changeIssueStatus: (_: unknown, { id, status, actor }: { id: string; status: any; actor?: string }) => {
      return getIssueStore().changeStatus(id, status, actor);
    },

    addComment: (_: unknown, { issueId, content, actor }: { issueId: string; content: string; actor?: string }) => {
      return getIssueStore().addEvent(issueId, 'commented', { content, actor });
    },

    createLabel: (_: unknown, { name, color, description }: { name: string; color?: string; description?: string }) => {
      return getIssueStore().createLabel(name, color ?? undefined, description ?? undefined);
    },

    deleteLabel: (_: unknown, { id }: { id: string }) => {
      return getIssueStore().deleteLabel(id);
    },

    createMilestone: (_: unknown, { name, description, dueDate }: { name: string; description?: string; dueDate?: string }) => {
      return getIssueStore().createMilestone(name, description ?? undefined, dueDate ?? undefined);
    },

    linkMemory: (_: unknown, { issueId, memoryId }: { issueId: string; memoryId: string }) => {
      getIssueStore().linkMemory(issueId, memoryId);
      return true;
    },

    autoLinkMemories: async (_: unknown, { issueId }: { issueId: string }) => {
      const store = getIssueStore();
      const issue = store.getIssue(issueId);
      if (!issue) throw new Error(`Issue ${issueId} not found`);
      return autoLinkMemories(store, issue);
    },
  },
};
