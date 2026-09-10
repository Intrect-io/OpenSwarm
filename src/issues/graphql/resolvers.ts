// ============================================
// OpenSwarm - Issue Tracker GraphQL Resolvers
// Created: 2026-04-03
// Purpose: Query + Mutation 리졸버
// ============================================

import { getIssueStore } from '../sqliteStore.js';
import { autoLinkMemories, enrichIssueContext } from '../memoryBridge.js';
import type { Issue } from '../schema.js';
import type { IssueFilter } from '../schema.js';
import type { SqliteIssueStore } from '../sqliteStore.js';

const DEFAULT_ISSUE_LIMIT = 50;
const MAX_ISSUE_LIMIT = 200;
const DEFAULT_EVENT_LIMIT = 50;
const DEFAULT_RECENT_EVENT_LIMIT = 20;
const MAX_EVENT_LIMIT = 200;

/** Wall-clock ceiling for a single auto-link job. */
export const AUTO_LINK_TIMEOUT_MS = 30_000;
/** Cap concurrent fire-and-forget auto-links from createIssue. */
export const MAX_BACKGROUND_AUTO_LINKS = 2;

const autoLinkByIssueId = new Map<string, Promise<string[]>>();
let backgroundAutoLinkActive = 0;
const backgroundAutoLinkWaiters: Array<() => void> = [];

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

async function acquireBackgroundAutoLinkSlot(): Promise<void> {
  // Re-check after each wake: a concurrent acquire can take the freed slot
  // between release() waking us and our increment, which would otherwise
  // push backgroundAutoLinkActive past MAX_BACKGROUND_AUTO_LINKS.
  for (;;) {
    if (backgroundAutoLinkActive < MAX_BACKGROUND_AUTO_LINKS) {
      backgroundAutoLinkActive++;
      return;
    }
    await new Promise<void>((resolve) => backgroundAutoLinkWaiters.push(resolve));
  }
}

function releaseBackgroundAutoLinkSlot(): void {
  backgroundAutoLinkActive = Math.max(0, backgroundAutoLinkActive - 1);
  const next = backgroundAutoLinkWaiters.shift();
  if (next) next();
}

/**
 * Run autoLinkMemories under a deadline timer that is always cleared on settle.
 * Exported for unit tests covering timeout slot recovery.
 */
export async function runAutoLinkWithDeadline(
  store: SqliteIssueStore,
  issue: Issue,
  timeoutMs: number = AUTO_LINK_TIMEOUT_MS,
  linkFn: typeof autoLinkMemories = autoLinkMemories,
): Promise<string[]> {
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  try {
    deadlineTimer = setTimeout(
      () => controller.abort(new Error(`autoLinkMemories timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    return await Promise.race([
      linkFn(store, issue),
      new Promise<string[]>((_, reject) => {
        const onAbort = () => reject(controller.signal.reason ?? new Error('autoLinkMemories aborted'));
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

function scheduleBackgroundAutoLink(
  store: SqliteIssueStore,
  issue: Issue,
  linkFn: typeof autoLinkMemories = autoLinkMemories,
): void {
  if (autoLinkByIssueId.has(issue.id)) return;

  const flight = (async () => {
    await acquireBackgroundAutoLinkSlot();
    try {
      return await runAutoLinkWithDeadline(store, issue, AUTO_LINK_TIMEOUT_MS, linkFn);
    } catch (err) {
      console.warn('[GraphQL] 메모리 자동 연결 실패:', err);
      return [] as string[];
    } finally {
      releaseBackgroundAutoLinkSlot();
    }
  })().finally(() => {
    if (autoLinkByIssueId.get(issue.id) === flight) {
      autoLinkByIssueId.delete(issue.id);
    }
  });

  autoLinkByIssueId.set(issue.id, flight);
}

/**
 * Test-only: fire a background auto-link with an injectable linker and return
 * the in-flight promise so timeout/slot-recovery cases can be asserted.
 */
export function scheduleBackgroundAutoLinkForTests(
  store: SqliteIssueStore,
  issue: Issue,
  linkFn: typeof autoLinkMemories,
): Promise<string[]> {
  scheduleBackgroundAutoLink(store, issue, linkFn);
  const flight = autoLinkByIssueId.get(issue.id);
  if (!flight) throw new Error('expected background auto-link flight');
  return flight;
}

async function resolveAutoLinkMemories(store: SqliteIssueStore, issueId: string): Promise<string[]> {
  const issue = store.getIssue(issueId);
  if (!issue) throw new Error(`Issue ${issueId} not found`);

  const existing = autoLinkByIssueId.get(issueId);
  if (existing) return existing;

  const flight = runAutoLinkWithDeadline(store, issue).finally(() => {
    if (autoLinkByIssueId.get(issueId) === flight) {
      autoLinkByIssueId.delete(issueId);
    }
  });
  autoLinkByIssueId.set(issueId, flight);
  return flight;
}

/** Test-only: reset in-flight bookkeeping between cases. */
export function resetAutoLinkSchedulerForTests(): void {
  autoLinkByIssueId.clear();
  backgroundAutoLinkActive = 0;
  backgroundAutoLinkWaiters.length = 0;
}

/** Test-only: observe how many background slots are held. */
export function getBackgroundAutoLinkActiveForTests(): number {
  return backgroundAutoLinkActive;
}

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

      // Bounded background auto-link (slots + deadline); failure must not fail create.
      scheduleBackgroundAutoLink(store, issue);

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
      return resolveAutoLinkMemories(getIssueStore(), issueId);
    },
  },
};
