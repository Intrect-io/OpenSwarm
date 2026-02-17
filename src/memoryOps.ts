/**
 * Persistent Cognitive Memory Module v2.0 - Operations
 *
 * Revision, formatting, background cognition, stats, and legacy compat.
 * Core types, save, search are in memoryCore.ts.
 */
import {
  EMBEDDING_DIM,
  PERMANENT_EXPIRY,
  normalizeRecords,
  initDatabase,
  getEmbedding,
  getDb,
  getTable,
  setTable,
  searchMemory,
  calculateStability,
  calculateFreshness,
  logWork,
  type MemoryType,
  type MemorySearchResult,
  type CognitiveMemoryRecord,
} from './memoryCore.js';

// ==============================================
// Memory Revision Loop (PRD Phase 3)
// ==============================================

/**
 * Revise existing belief with new information
 * PRD: append-only 탈피 - 기존 belief 수정
 */
export async function reviseMemory(
  memoryId: string,
  newContent: string,
  options?: {
    newConfidence?: number;
    reason?: string;
  }
): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    const db = getDb();
    if (!table || !db) return false;

    // Find existing memory
    const results = await table.search(Array.from({ length: EMBEDDING_DIM }, () => 0)).limit(10000).toArray();
    const existing = results.find((r: any) => r.id === memoryId);

    if (!existing) {
      console.log(`[Memory] Revision failed: memory ${memoryId} not found`);
      return false;
    }

    const now = Date.now();
    const newRevisionCount = (existing.revisionCount ?? 0) + 1;
    const age = now - existing.createdAt;

    // Create revised record
    const revised: CognitiveMemoryRecord = {
      ...existing,
      content: newContent,
      vector: await getEmbedding(newContent),
      lastUpdated: now,
      revisionCount: newRevisionCount,
      confidence: options?.newConfidence ?? Math.max(0.3, (existing.confidence ?? 0.7) - 0.1),
      stability: calculateStability(newRevisionCount, age),
      metadata: JSON.stringify({
        ...JSON.parse(existing.metadata || '{}'),
        lastRevision: {
          timestamp: now,
          reason: options?.reason || 'manual revision',
          previousContent: existing.content.slice(0, 200),
        },
      }),
    };

    // LanceDB doesn't support update, so we delete and re-add
    // Create new table without the old record, then add revised
    const allRecords = results.filter((r: any) => r.id !== memoryId);
    allRecords.push(revised);

    // Recreate table with updated data (정규화 적용)
    const tableName = 'cognitive_memory';
    await db.dropTable(tableName);
    const newTable = await db.createTable(tableName, normalizeRecords(allRecords));
    setTable(newTable);

    console.log(`[Memory] Revised ${memoryId} (rev: ${newRevisionCount}, stability: ${revised.stability})`);
    return true;
  } catch (error) {
    console.error('[Memory] Revision error:', error);
    return false;
  }
}

/**
 * Find contradicting memories
 * PRD: semantic conflict 탐지
 */
export async function findContradictions(content: string): Promise<MemorySearchResult[]> {
  try {
    // Search for similar content
    const similar = await searchMemory(content, {
      minSimilarity: 0.6,
      limit: 20,
    });

    // Contradiction detection heuristics
    const contradictionKeywords = [
      { positive: /항상|always|must|반드시/i, negative: /절대|never|금지|안됨/i },
      { positive: /좋|effective|works|성공/i, negative: /나쁨|ineffective|fails|실패/i },
      { positive: /사용|use|enable|활성/i, negative: /사용안함|disable|비활성/i },
    ];

    const contradictions: MemorySearchResult[] = [];

    for (const memory of similar) {
      // Check for opposite sentiment patterns
      for (const { positive, negative } of contradictionKeywords) {
        const contentHasPositive = positive.test(content);
        const contentHasNegative = negative.test(content);
        const memoryHasPositive = positive.test(memory.content);
        const memoryHasNegative = negative.test(memory.content);

        // Contradiction: one has positive, other has negative
        if ((contentHasPositive && memoryHasNegative) || (contentHasNegative && memoryHasPositive)) {
          contradictions.push(memory);
          break;
        }
      }
    }

    if (contradictions.length > 0) {
      console.log(`[Memory] Found ${contradictions.length} potential contradictions`);
    }

    return contradictions;
  } catch (error) {
    console.error('[Memory] Contradiction detection error:', error);
    return [];
  }
}

/**
 * Mark memories as contradicting each other
 */
export async function markContradiction(memoryId1: string, memoryId2: string): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    const db = getDb();
    if (!table || !db) return false;

    const results = await table.search(Array.from({ length: EMBEDDING_DIM }, () => 0)).limit(10000).toArray();
    const memory1 = results.find((r: any) => r.id === memoryId1);
    const memory2 = results.find((r: any) => r.id === memoryId2);

    if (!memory1 || !memory2) {
      console.log('[Memory] Cannot mark contradiction: one or both memories not found');
      return false;
    }

    // Update contradicts arrays
    const contradicts1 = JSON.parse(memory1.contradicts || '[]');
    const contradicts2 = JSON.parse(memory2.contradicts || '[]');

    if (!contradicts1.includes(memoryId2)) contradicts1.push(memoryId2);
    if (!contradicts2.includes(memoryId1)) contradicts2.push(memoryId1);

    memory1.contradicts = JSON.stringify(contradicts1);
    memory2.contradicts = JSON.stringify(contradicts2);

    // Lower importance for both (PRD: 모순 발생 시 importance 감소)
    memory1.importance = Math.max(0.2, (memory1.importance ?? 0.5) - 0.15);
    memory2.importance = Math.max(0.2, (memory2.importance ?? 0.5) - 0.15);

    // Recreate table (정규화 적용)
    const tableName = 'cognitive_memory';
    await db.dropTable(tableName);
    const newTable = await db.createTable(tableName, normalizeRecords(results));
    setTable(newTable);

    console.log(`[Memory] Marked contradiction between ${memoryId1} and ${memoryId2}`);
    return true;
  } catch (error) {
    console.error('[Memory] Mark contradiction error:', error);
    return false;
  }
}

/**
 * Reconcile contradicting beliefs (choose one, archive other)
 */
export async function reconcileContradiction(
  keepId: string,
  archiveId: string,
  reason: string
): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    const db = getDb();
    if (!table || !db) return false;

    const results = await table.search(Array.from({ length: EMBEDDING_DIM }, () => 0)).limit(10000).toArray();
    const keepMemory = results.find((r: any) => r.id === keepId);
    const archiveMemory = results.find((r: any) => r.id === archiveId);

    if (!keepMemory || !archiveMemory) {
      console.log('[Memory] Cannot reconcile: one or both memories not found');
      return false;
    }

    // Boost kept memory
    keepMemory.confidence = Math.min(1, (keepMemory.confidence ?? 0.7) + 0.1);
    keepMemory.stability = 'high';

    // Archive the other (set high decay, low importance)
    archiveMemory.decay = 0.9;
    archiveMemory.importance = 0.1;
    archiveMemory.metadata = JSON.stringify({
      ...JSON.parse(archiveMemory.metadata || '{}'),
      archived: {
        timestamp: Date.now(),
        reason,
        supersededBy: keepId,
      },
    });

    // Recreate table (정규화 적용)
    const tableName = 'cognitive_memory';
    await db.dropTable(tableName);
    const newTable = await db.createTable(tableName, normalizeRecords(results));
    setTable(newTable);

    console.log(`[Memory] Reconciled: kept ${keepId}, archived ${archiveId}`);
    return true;
  } catch (error) {
    console.error('[Memory] Reconciliation error:', error);
    return false;
  }
}

/**
 * 메모리를 컨텍스트로 포맷 (PRD v2.0 - Cognitive + Legacy)
 */
export function formatMemoryContext(memories: MemorySearchResult[]): string {
  if (memories.length === 0) return '';

  // Cognitive + Legacy types
  const grouped: Record<string, MemorySearchResult[]> = {
    // Cognitive (PRD)
    constraint: [],
    user_model: [],
    strategy: [],
    belief: [],
    system_pattern: [],
    // Legacy
    decision: [],
    repomap: [],
    journal: [],
    fact: [],
  };

  for (const m of memories) {
    if (grouped[m.type]) {
      grouped[m.type].push(m);
    }
  }

  const sections: string[] = [];

  // PRD Cognitive Types (높은 importance 순)
  if (grouped.constraint.length > 0) {
    const items = grouped.constraint.map(m =>
      `- ⚠️ **${m.content.slice(0, 100)}** (importance: ${(m.importance * 100).toFixed(0)}%, stability: ${m.stability})`
    ).join('\n');
    sections.push(`### 🚫 제약조건 (CRITICAL)\n${items}`);
  }

  if (grouped.user_model.length > 0) {
    const items = grouped.user_model.map(m =>
      `- **${m.content.slice(0, 100)}** (confidence: ${(m.confidence * 100).toFixed(0)}%)`
    ).join('\n');
    sections.push(`### 👤 사용자 성향\n${items}`);
  }

  if (grouped.strategy.length > 0) {
    const items = grouped.strategy.map(m =>
      `- **${m.content.slice(0, 100)}** (검증됨: ${m.stability === 'high' ? '✓' : '△'})`
    ).join('\n');
    sections.push(`### 🎯 검증된 전략\n${items}`);
  }

  if (grouped.belief.length > 0) {
    const items = grouped.belief.map(m =>
      `- ${m.content.slice(0, 100)} (rev: ${m.revisionCount}, decay: ${(m.decay * 100).toFixed(0)}%)`
    ).join('\n');
    sections.push(`### 💡 Beliefs\n${items}`);
  }

  if (grouped.system_pattern.length > 0) {
    const items = grouped.system_pattern.map(m =>
      `- **${m.content.slice(0, 100)}**`
    ).join('\n');
    sections.push(`### 🏗️ 시스템 패턴\n${items}`);
  }

  // Legacy Types
  if (grouped.decision.length > 0) {
    const items = grouped.decision.map(m =>
      `- **${m.title}** (${formatDate(m.createdAt)}, 신뢰도: ${(m.trust * 100).toFixed(0)}%)\n  ${m.content.slice(0, 150)}...`
    ).join('\n');
    sections.push(`### 📋 관련 설계 결정 (참고용)\n${items}`);
  }

  if (grouped.fact.length > 0) {
    const items = grouped.fact.map(m =>
      `- **${m.title}**: ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`
    ).join('\n');
    sections.push(`### 📌 관련 팩트 (참고용)\n${items}`);
  }

  if (grouped.repomap.length > 0) {
    const items = grouped.repomap.map(m =>
      `- **${m.repo}**: ${m.title}`
    ).join('\n');
    sections.push(`### 🗂️ 저장소 구조 (참고용)\n${items}`);
  }

  if (grouped.journal.length > 0) {
    const items = grouped.journal.map(m =>
      `- [${formatDate(m.createdAt)}] **${m.title}** (신선도: ${(m.freshness * 100).toFixed(0)}%)`
    ).join('\n');
    sections.push(`### 📝 최근 작업 기록 (참고용)\n${items}`);
  }

  if (sections.length === 0) return '';

  return `## 🧠 Cognitive Memory (PRD v2.0)\n\n${sections.join('\n\n')}\n\n---\n⚠️ 위 정보는 참고용입니다. 현재 상황과 다를 수 있으니 필요시 직접 확인하세요.`;
}

/**
 * 날짜 포맷
 */
function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('ko-KR', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * 만료된 메모리 정리
 */
export async function cleanupExpired(): Promise<number> {
  try {
    await initDatabase();
    const table = getTable();
    const db = getDb();
    if (!table || !db) return 0;

    const now = Date.now();
    const results = await table.search(Array.from({ length: EMBEDDING_DIM }, () => 0)).limit(10000).toArray();

    const expiredIds = results
      .filter((r: any) => r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now)
      .map((r: any) => r.id);

    if (expiredIds.length > 0) {
      // LanceDB는 직접 삭제가 어려워서 새 테이블로 교체 필요
      // 여기서는 로깅만
      console.log(`[Memory] Found ${expiredIds.length} expired records`);
    }

    return expiredIds.length;
  } catch (error) {
    console.error('[Memory] Cleanup error:', error);
    return 0;
  }
}

// ==============================================
// Background Cognition (PRD Phase 4)
// ==============================================

// Decay and archive thresholds
const DECAY_INCREMENT = 0.03;      // PRD: decay += 0.03 weekly if not accessed
const ARCHIVE_THRESHOLD = 0.7;    // PRD: threshold 초과 시 archive
const CONSOLIDATION_SIMILARITY = 0.85;  // 중복 판단 기준

/**
 * Apply decay to all memories (Background Worker)
 * PRD: 망각은 기능이다
 */
export async function applyMemoryDecay(daysSinceLastRun: number = 7): Promise<{
  decayed: number;
  archived: number;
}> {
  try {
    await initDatabase();
    const table = getTable();
    const db = getDb();
    if (!table || !db) return { decayed: 0, archived: 0 };

    const results = await table.search(Array.from({ length: EMBEDDING_DIM }, () => 0)).limit(10000).toArray();
    const now = Date.now();

    let decayed = 0;
    let archived = 0;

    for (const r of results) {
      if (r.id === 'init') continue;

      // Calculate days since last access
      const lastAccess = r.lastAccessed ?? r.createdAt ?? now;
      const daysSinceAccess = (now - lastAccess) / (24 * 60 * 60 * 1000);

      // Apply decay if not accessed recently
      if (daysSinceAccess > 7) {
        const weeksNotAccessed = Math.floor(daysSinceAccess / 7);
        const decayAmount = Math.min(DECAY_INCREMENT * weeksNotAccessed * (daysSinceLastRun / 7), 0.3);
        r.decay = Math.min(1, (r.decay ?? 0) + decayAmount);
        decayed++;

        // Archive if decay exceeds threshold
        if (r.decay >= ARCHIVE_THRESHOLD) {
          r.metadata = JSON.stringify({
            ...JSON.parse(r.metadata || '{}'),
            archived: {
              timestamp: now,
              reason: 'decay_threshold_exceeded',
              finalDecay: r.decay,
            },
          });
          r.importance = 0.05;  // Near zero but not deleted
          archived++;
        }
      }
    }

    if (decayed > 0) {
      // Recreate table (정규화 적용)
      const tableName = 'cognitive_memory';
      await db.dropTable(tableName);
      const newTable = await db.createTable(tableName, normalizeRecords(results));
      setTable(newTable);
      console.log(`[Memory] Decay applied: ${decayed} memories decayed, ${archived} archived`);
    }

    return { decayed, archived };
  } catch (error) {
    console.error('[Memory] Decay error:', error);
    return { decayed: 0, archived: 0 };
  }
}

/**
 * Consolidate duplicate/similar memories
 * PRD: Memory Consolidation - 중복 merge
 */
export async function consolidateMemories(): Promise<{
  merged: number;
  groups: Array<{ kept: string; merged: string[] }>;
}> {
  try {
    await initDatabase();
    const table = getTable();
    const db = getDb();
    if (!table || !db) return { merged: 0, groups: [] };

    const results = await table.search(Array.from({ length: EMBEDDING_DIM }, () => 0)).limit(10000).toArray();
    const validMemories = results.filter((r: any) => r.id !== 'init');

    const merged: string[] = [];
    const groups: Array<{ kept: string; merged: string[] }> = [];

    // Find similar memory groups
    for (let i = 0; i < validMemories.length; i++) {
      const m1 = validMemories[i];
      if (merged.includes(m1.id)) continue;

      const similarGroup: any[] = [m1];

      for (let j = i + 1; j < validMemories.length; j++) {
        const m2 = validMemories[j];
        if (merged.includes(m2.id)) continue;
        if (m1.type !== m2.type) continue;

        // Calculate cosine similarity
        const similarity = cosineSimilarity(m1.vector, m2.vector);

        if (similarity >= CONSOLIDATION_SIMILARITY) {
          similarGroup.push(m2);
          merged.push(m2.id);
        }
      }

      // Merge if group has duplicates
      if (similarGroup.length > 1) {
        // Keep the one with highest importance * confidence
        similarGroup.sort((a, b) =>
          (b.importance ?? 0.5) * (b.confidence ?? 0.5) -
          (a.importance ?? 0.5) * (a.confidence ?? 0.5)
        );

        const kept = similarGroup[0];
        const toMerge = similarGroup.slice(1);

        // Boost kept memory
        kept.confidence = Math.min(1, (kept.confidence ?? 0.7) + 0.05 * toMerge.length);
        kept.revisionCount = (kept.revisionCount ?? 0) + toMerge.length;

        groups.push({
          kept: kept.id,
          merged: toMerge.map((m: any) => m.id),
        });

        console.log(`[Memory] Consolidated ${toMerge.length} duplicates into ${kept.id}`);
      }
    }

    if (merged.length > 0) {
      // Remove merged memories
      const remainingRecords = results.filter((r: any) => !merged.includes(r.id));

      // Recreate table (정규화 적용)
      const tableName = 'cognitive_memory';
      await db.dropTable(tableName);
      const newTable = await db.createTable(tableName, normalizeRecords(remainingRecords));
      setTable(newTable);

      console.log(`[Memory] Consolidation complete: ${merged.length} memories merged`);
    }

    return { merged: merged.length, groups };
  } catch (error) {
    console.error('[Memory] Consolidation error:', error);
    return { merged: 0, groups: [] };
  }
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Run all background cognitive tasks
 * PRD: 6-12시간 주기 권장
 */
export async function runBackgroundCognition(): Promise<{
  decay: { decayed: number; archived: number };
  consolidation: { merged: number };
  contradictions: number;
}> {
  console.log('[Memory] Starting background cognition tasks...');

  // 1. Apply decay
  const decayResult = await applyMemoryDecay();

  // 2. Consolidate duplicates
  const consolidationResult = await consolidateMemories();

  // 3. Detect contradictions (log only, don't auto-resolve)
  const _stats = await getMemoryStats(); // 향후 확장용
  let contradictionCount = 0;

  // Sample check for contradictions among high-importance beliefs
  const highImportanceMemories = await searchMemory('', {
    types: ['belief', 'strategy', 'constraint'],
    minSimilarity: 0,
    limit: 50,
  });

  for (const memory of highImportanceMemories) {
    const contradictions = await findContradictions(memory.content);
    if (contradictions.length > 0) {
      contradictionCount += contradictions.length;
    }
  }

  console.log('[Memory] Background cognition complete:', {
    decayed: decayResult.decayed,
    archived: decayResult.archived,
    merged: consolidationResult.merged,
    potentialContradictions: contradictionCount,
  });

  return {
    decay: decayResult,
    consolidation: { merged: consolidationResult.merged },
    contradictions: contradictionCount,
  };
}

// Default stats object with all memory types
const DEFAULT_BY_TYPE: Record<MemoryType, number> = {
  // Cognitive types
  belief: 0,
  strategy: 0,
  user_model: 0,
  system_pattern: 0,
  constraint: 0,
  // Legacy types
  decision: 0,
  repomap: 0,
  journal: 0,
  fact: 0,
};

/**
 * 메모리 통계 (PRD v2.0)
 */
export async function getMemoryStats(): Promise<{
  total: number;
  byType: Record<MemoryType, number>;
  byRepo: Record<string, number>;
  avgImportance: number;
  avgDecay: number;
}> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return { total: 0, byType: { ...DEFAULT_BY_TYPE }, byRepo: {}, avgImportance: 0, avgDecay: 0 };

    const results = await table.search(Array.from({ length: EMBEDDING_DIM }, () => 0)).limit(10000).toArray();

    const byType: Record<MemoryType, number> = { ...DEFAULT_BY_TYPE };
    const byRepo: Record<string, number> = {};
    let totalImportance = 0;
    let totalDecay = 0;
    let count = 0;

    for (const r of results) {
      if (r.id === 'init') continue;
      if (byType[r.type as MemoryType] !== undefined) {
        byType[r.type as MemoryType]++;
      }
      byRepo[r.repo] = (byRepo[r.repo] || 0) + 1;
      totalImportance += r.importance ?? 0.5;
      totalDecay += r.decay ?? 0;
      count++;
    }

    return {
      total: count,
      byType,
      byRepo,
      avgImportance: count > 0 ? totalImportance / count : 0,
      avgDecay: count > 0 ? totalDecay / count : 0,
    };
  } catch (error) {
    console.error('[Memory] Stats error:', error);
    return { total: 0, byType: { ...DEFAULT_BY_TYPE }, byRepo: {}, avgImportance: 0, avgDecay: 0 };
  }
}

// ============================================
// 레거시 호환 함수 (기존 코드 지원)
// ============================================

/**
 * 대화 저장 (레거시 호환)
 */
export async function saveConversation(
  channelId: string,
  userId: string,
  userName: string,
  content: string,
  response: string,
): Promise<void> {
  await logWork(
    'discord',
    `Chat with ${userName}`,
    `Q: ${content}\n\nA: ${response}`,
    undefined,
    channelId
  );
}

/**
 * 최근 대화 가져오기 (createdAt 기준 정렬)
 * - 시맨틱 검색이 아닌 시간순 조회
 * - channelId는 derivedFrom 필드에 저장됨 (legacy: metadata.issueRef)
 */
export async function getRecentConversations(
  channelId: string,
  limit: number = 10,
): Promise<MemorySearchResult[]> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return [];

    // journal 타입 + discord repo 필터링 후 createdAt 내림차순
    const results = await table
      .search(Array.from({ length: EMBEDDING_DIM }, () => 0))  // dummy vector for full scan
      .limit(1000)  // 충분히 큰 수
      .toArray();

    // 필터: journal + discord (channelId는 느슨하게 - 기존 데이터 호환)
    const filtered = results
      .filter((r: any) => {
        if (r.type !== 'journal' || r.repo !== 'discord') return false;

        // channelId 매칭: derivedFrom 또는 metadata.issueRef
        if (!channelId) return true;  // 전체
        if (r.derivedFrom === channelId) return true;
        if (r.derivedFrom === 'unknown') return true;  // legacy 데이터 포함

        // metadata.issueRef fallback
        try {
          const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;
          if (meta?.issueRef === channelId) return true;
        } catch { /* ignore */ }

        return false;
      })
      .sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0))  // 최신순
      .slice(0, limit);

    // MemorySearchResult 형태로 변환
    return filtered.map((r: any) => ({
      id: r.id,
      type: r.type,
      repo: r.repo,
      title: r.title,
      content: r.content,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata || '{}') : r.metadata,
      trust: r.trust,
      createdAt: r.createdAt,
      score: 1.0,  // 시간순 조회라 score 무의미
      freshness: calculateFreshness(r.createdAt),
      importance: r.importance,
      confidence: r.confidence,
      stability: r.stability,
      revisionCount: r.revisionCount,
      decay: r.decay,
      similarityScore: 1.0,
    }));
  } catch (error) {
    console.error('[Memory] getRecentConversations error:', error);
    return [];
  }
}
