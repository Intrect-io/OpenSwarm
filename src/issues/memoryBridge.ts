// ============================================
// OpenSwarm - Issue ↔ Memory Bridge
// Created: 2026-04-03
// Purpose: Consolidate issue events into long-term memory + enrich issue context via memory search
// Dependencies: memoryCore, sqliteStore
// ============================================

import { saveMemory, searchMemorySafe, saveCognitiveMemory, getMemoriesByIds, hasMemoryDerivedFrom, getMemoryIdsByDerivedFrom } from '../memory/memoryCore.js';
import type { SqliteIssueStore } from './sqliteStore.js';
import type { Issue } from './schema.js';
import { createHash } from 'node:crypto';
import { withDeadline } from '../mcp/mcpClient.js';

/** Upper bound (ms) of the auto-link memory search — settles on the deadline even if the search ignores AbortSignal. */
export const AUTO_LINK_SEARCH_DEADLINE_MS = 10_000;

function digestSource(kind: string, values: string[]): string {
  return `issue-event-digest:${kind}:${createHash('sha256').update(values.join('\0')).digest('hex')}`;
}

/**
 * Auto-link related memories when an issue is created
 * - Search existing memories with the issue title + description
 * - Auto-link memories with high similarity
 */
export async function autoLinkMemories(
  store: SqliteIssueStore,
  issue: Issue,
  signal?: AbortSignal,
): Promise<string[]> {
  const query = `${issue.title} ${issue.description}`.trim();
  if (query.length < 10) return [];

  let result: Awaited<ReturnType<typeof searchMemorySafe>>;
  try {
    result = await withDeadline(
      searchMemorySafe(query, {
        limit: 5,
        minSimilarity: 0.6,
        types: ['belief', 'strategy', 'system_pattern', 'constraint', 'decision'],
      }),
      AUTO_LINK_SEARCH_DEADLINE_MS,
      'autoLinkMemories search',
    );
  } catch (err) {
    // Deadline exceeded: settle as no search results — the caller and the schedule slot are not tied up by the pending search.
    if (err instanceof Error && err.message.startsWith('autoLinkMemories search timed out')) return [];
    throw err;
  }

  if (!result.success || result.memories.length === 0) return [];
  // The supervisor gave up on this job (deadline): do not write links late.
  if (signal?.aborted) return [];

  const linkedIds: string[] = [];
  for (const mem of result.memories) {
    store.linkMemory(issue.id, mem.id);
    linkedIds.push(mem.id);
  }

  console.log(`[MemoryBridge] 이슈 ${issue.id}에 ${linkedIds.length}개 기억 자동 연결`);
  return linkedIds;
}

/**
 * Save a learning memory when an issue is completed
 * - Consolidate insights gained during resolution into long-term memory
 */
export async function saveCompletionInsight(
  store: SqliteIssueStore,
  issue: Issue,
): Promise<string | null> {
  const derivedFrom = `issue:${issue.id}`;
  const existingIds = await getMemoryIdsByDerivedFrom(derivedFrom, 1);
  if (existingIds[0]) {
    store.linkMemory(issue.id, existingIds[0]);
    return existingIds[0];
  }
  // Collect the issue event history
  const events = store.getEvents(issue.id, 100);
  if (events.length === 0) return null;

  // Extract comments from the events
  const comments = events
    .filter((e) => e.type === 'commented' && e.content)
    .map((e) => e.content!)
    .join('\n');

  // State transition history
  const statusChanges = events
    .filter((e) => e.type === 'status_changed')
    .map((e) => `${e.oldValue} → ${e.newValue}`)
    .join(', ');

  // Build summary content for the issue
  const content = [
    `## 이슈 해결: ${issue.title}`,
    `프로젝트: ${issue.projectId}`,
    `우선순위: ${issue.priority}`,
    issue.complexity ? `복잡도: ${issue.complexity}` : '',
    statusChanges ? `상태 전이: ${statusChanges}` : '',
    issue.relevantFiles.length > 0 ? `관련 파일: ${issue.relevantFiles.join(', ')}` : '',
    comments ? `\n### 코멘트\n${comments}` : '',
    issue.acceptanceCriteria.length > 0
      ? `\n### 수용 기준\n${issue.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');

  // Save to long-term memory
  const memoryId = await saveMemory('decision', issue.projectId, issue.title, content, {
    trust: 0.85,
    importance: issue.priority === 'urgent' ? 0.95 : issue.priority === 'high' ? 0.85 : 0.7,
    isVerified: true,
    skipDistillation: true,
    derivedFrom,
    metadata: {
      issueId: issue.id,
      projectId: issue.projectId,
      labels: issue.labels,
      complexity: issue.complexity,
      relevantFiles: issue.relevantFiles,
    },
  });

  if (memoryId) {
    store.linkMemory(issue.id, memoryId);
    console.log(`[MemoryBridge] 이슈 완료 인사이트 저장: ${memoryId}`);
  }

  return memoryId;
}

/**
 * Save a constraint memory when an issue is blocked
 * - Save the blocking cause as a constraint type -> prevents similar issues in the future
 */
export async function saveBlockingConstraint(
  store: SqliteIssueStore,
  issue: Issue,
  reason: string,
): Promise<string | null> {
  const content = `이슈 "${issue.title}" (${issue.projectId}) 블로킹 원인: ${reason}`;

  const memoryId = await saveCognitiveMemory('constraint', content, {
    importance: 0.85,
    confidence: 0.8,
    derivedFrom: `issue:${issue.id}`,
  });

  // linkMemory already emits a single memory_linked event — do not add a second one.
  if (memoryId) {
    store.linkMemory(issue.id, memoryId);
  }

  return memoryId;
}

/**
 * Enrich issue context: look up related memories + similar issues
 */
export async function enrichIssueContext(
  store: SqliteIssueStore,
  issue: Issue,
): Promise<{
  linkedMemories: Array<{ id: string; content: string; score: number }>;
  similarIssues: Issue[];
}> {
  const linkedMemories: Array<{ id: string; content: string; score: number }> = [];
  const linkedIds = store.getLinkedMemories(issue.id);
  for (const memory of await getMemoriesByIds(linkedIds)) {
    linkedMemories.push({ ...memory, score: 1 });
  }
  const seenMemoryIds = new Set(linkedIds);

  // 2. Search semantically similar memories
  const query = `${issue.title} ${issue.description}`;
  const result = await searchMemorySafe(query, {
    limit: 10,
    minSimilarity: 0.5,
  });

  if (result.success) {
    for (const mem of result.memories) {
      if (seenMemoryIds.has(mem.id)) continue;
      seenMemoryIds.add(mem.id);
      linkedMemories.push({
        id: mem.id,
        content: mem.content,
        score: mem.score,
      });
    }
  }

  // 3. Search similar issues (FTS)
  const searchTerms = issue.title.split(/\s+/).filter((t) => t.length > 2).slice(0, 3);
  const similarIssues: Issue[] = [];

  if (searchTerms.length > 0) {
    const seen = new Set<string>([issue.id]);
    for (const term of searchTerms) {
      const { issues } = store.listIssues({
        search: term,
        limit: 5,
        offset: 0,
      });
      for (const si of issues) {
        if (!seen.has(si.id)) {
          seen.add(si.id);
          similarIssues.push(si);
        }
        if (similarIssues.length >= 5) {
          break;
        }
      }
      if (similarIssues.length >= 5) {
        break;
      }
    }
  }

  return { linkedMemories, similarIssues };
}

/**
 * Event stream -> memory consolidation (background)
 * - Periodically analyze recent events to create pattern/strategy memories
 */
export async function digestRecentEvents(
  store: SqliteIssueStore,
  limit = 50,
): Promise<number> {
  const events = store.getRecentEvents(limit);
  if (events.length === 0) return 0;

  // Pattern analysis: repeated blocking. IssueStatus has no blocked state, so
  // base this on the blocked/stuck comment events that local automation actually leaves.
  const blockEvents = events.filter((e) => (
    e.type === 'commented'
    && (/\b(blocked|stuck)\b/i.test(e.content ?? '') || /블로킹|차단/.test(e.content ?? ''))
  ));
  if (blockEvents.length >= 3) {
    const reasons = blockEvents
      .map((e) => e.content || '')
      .filter(Boolean);

    if (reasons.length > 0) {
      const derivedFrom = digestSource('blocking', reasons);
      if (!(await hasMemoryDerivedFrom(derivedFrom))) await saveCognitiveMemory('strategy', [
        '반복 블로킹 패턴 감지:',
        ...reasons.map((r) => `- ${r}`),
        `총 ${blockEvents.length}건 (최근 ${limit}개 이벤트 중)`,
      ].join('\n'), {
        importance: 0.85,
        confidence: 0.75,
        derivedFrom,
      });
    }
  }

  // Pattern analysis: frequent priority changes
  const priorityChanges = events.filter((e) => e.type === 'priority_changed');
  if (priorityChanges.length >= 5) {
    const derivedFrom = digestSource('priority', priorityChanges.map((event) => `${event.id}:${event.oldValue}:${event.newValue}`));
    if (await hasMemoryDerivedFrom(derivedFrom)) return events.length;
    await saveCognitiveMemory('system_pattern', [
      `최근 우선순위 변경 빈도 높음 (${priorityChanges.length}건)`,
      '우선순위 기준 재검토 필요',
    ].join('\n'), {
      importance: 0.7,
      confidence: 0.6,
      derivedFrom,
    });
  }

  return events.length;
}
