// ============================================
// OpenSwarm - Issue ↔ Memory Bridge
// Created: 2026-04-03
// Purpose: 이슈 이벤트를 장기 기억으로 수선 + 메모리 검색으로 이슈 컨텍스트 강화
// Dependencies: memoryCore, sqliteStore
// ============================================

import { saveMemory, searchMemorySafe, saveCognitiveMemory, getMemoriesByIds, hasMemoryDerivedFrom, getMemoryIdsByDerivedFrom } from '../memory/memoryCore.js';
import type { SqliteIssueStore } from './sqliteStore.js';
import type { Issue } from './schema.js';
import { createHash } from 'node:crypto';
import { withDeadline } from '../mcp/mcpClient.js';

/** auto-link 메모리 검색 상한(ms) — 검색이 AbortSignal을 무시해도 기한에 정산된다. */
export const AUTO_LINK_SEARCH_DEADLINE_MS = 10_000;

function digestSource(kind: string, values: string[]): string {
  return `issue-event-digest:${kind}:${createHash('sha256').update(values.join('\0')).digest('hex')}`;
}

/**
 * 이슈 생성 시 관련 기억 자동 연결
 * - 이슈 제목+설명으로 기존 메모리 검색
 * - 유사도 높은 기억을 자동 링크
 */
export async function autoLinkMemories(
  store: SqliteIssueStore,
  issue: Issue,
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
    // 기한 초과: 검색 결과 없음으로 정산 — 호출자와 스케줄 슬롯이 pending 검색에 묶이지 않는다.
    if (err instanceof Error && err.message.startsWith('autoLinkMemories search timed out')) return [];
    throw err;
  }

  if (!result.success || result.memories.length === 0) return [];

  const linkedIds: string[] = [];
  for (const mem of result.memories) {
    store.linkMemory(issue.id, mem.id);
    linkedIds.push(mem.id);
  }

  console.log(`[MemoryBridge] 이슈 ${issue.id}에 ${linkedIds.length}개 기억 자동 연결`);
  return linkedIds;
}

/**
 * 이슈 완료 시 학습 기억 저장
 * - 해결 과정에서 얻은 통찰을 장기 기억으로 수선
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
  // 이슈 이벤트 히스토리 수집
  const events = store.getEvents(issue.id, 100);
  if (events.length === 0) return null;

  // 이벤트에서 코멘트 추출
  const comments = events
    .filter((e) => e.type === 'commented' && e.content)
    .map((e) => e.content!)
    .join('\n');

  // 상태 전이 히스토리
  const statusChanges = events
    .filter((e) => e.type === 'status_changed')
    .map((e) => `${e.oldValue} → ${e.newValue}`)
    .join(', ');

  // 이슈에 대한 요약 컨텐츠 생성
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

  // 장기 기억으로 저장
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
 * 이슈 블로킹 시 제약 조건 기억 저장
 * - 블로킹 원인을 constraint 타입으로 저장 → 향후 유사 이슈 방지
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

  if (memoryId) {
    store.linkMemory(issue.id, memoryId);
    store.addEvent(issue.id, 'memory_linked', {
      memoryId,
      content: `블로킹 제약 조건 기억 저장: ${reason}`,
    });
  }

  return memoryId;
}

/**
 * 이슈 컨텍스트 강화: 관련 기억 + 유사 이슈 조회
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

  // 2. 의미적으로 유사한 기억 검색
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

  // 3. 유사 이슈 검색 (FTS)
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
 * 이벤트 스트림 → 메모리 수선 (백그라운드)
 * - 주기적으로 최근 이벤트를 분석하여 패턴/전략 기억 생성
 */
export async function digestRecentEvents(
  store: SqliteIssueStore,
  limit = 50,
): Promise<number> {
  const events = store.getRecentEvents(limit);
  if (events.length === 0) return 0;

  // 패턴 분석: 반복 블로킹. IssueStatus에는 blocked가 없으므로,
  // 로컬 자동화가 실제로 남기는 blocked/stuck 코멘트 이벤트를 기준으로 본다.
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

  // 패턴 분석: 빈번한 우선순위 변경
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
