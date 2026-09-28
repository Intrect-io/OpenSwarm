/**
 * Persistent Cognitive Memory Module v3.0 - Operations
 *
 * Formatting, compaction helpers, stats, and legacy compat.
 * Core types, save, search are in memoryCore.ts.
 */
import {
  PERMANENT_EXPIRY,
  normalizeRecords,
  initDatabase,
  embedPassage,
  fetchAllTableRows,
  getTable,
  searchMemory,
  calculateFreshness,
  safeParseMetadata,
  vectorAsNumberArray,
  logWork,
  withMemoryWriteRetry,
  type MemoryType,
  type MemorySearchResult,
  type CognitiveMemoryRecord,
} from './memoryCore.js';
import { embeddingTextFor } from './embeddingConfig.js';

type MemoryTable = NonNullable<ReturnType<typeof getTable>>;
const MAX_MEMORY_REVISIONS = 20;

/** Rows deleted per Lance commit while sweeping expired records. */
const PAGE_SIZE = 10_000;

/**
 * In-process queue that serializes full read-modify-write memory mutations.
 * withMemoryWriteRetry only retries individual Lance commits; without this,
 * concurrent revise/consolidate/reconcile can overwrite each other's metadata.
 */
let memoryMutationQueue: Promise<void> = Promise.resolve();

export async function withMemoryMutationLock<T>(op: () => Promise<T>): Promise<T> {
  let result!: T;
  let failure: unknown;
  const run = memoryMutationQueue.then(async () => {
    try {
      result = await op();
    } catch (error) { // cxt-ignore: error_swallow,exception_hiding — rethrown after the queue settles
      failure = error;
    }
  });
  memoryMutationQueue = run.then(() => undefined, () => undefined);
  await run;
  if (failure) throw failure;
  return result;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function idPredicate(id: string): string {
  return `id = ${sqlString(id)}`;
}

function idsPredicate(ids: string[]): string {
  return `id IN (${ids.map(sqlString).join(', ')})`;
}

async function loadMemoryById(table: MemoryTable, id: string): Promise<any | null> {
  const rows = await table.query().where(idPredicate(id)).limit(1).toArray();
  return rows[0] ?? null;
}

async function updateMemoryRecord(table: MemoryTable, record: any): Promise<void> {
  const normalized = normalizeRecords([record])[0];
  const { id, ...values } = normalized;
  await withMemoryWriteRetry(
    () => table.update({ where: idPredicate(id), values: values as Record<string, any> }),
    'updateMemoryRecord',
  );
}

async function deleteMemoryIds(table: MemoryTable, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withMemoryWriteRetry(() => table.delete(idsPredicate(ids)), 'deleteMemoryIds');
}

/**
 * Revise existing memory content. v3 keeps revision history in metadata rather
 * than maintaining unused top-level revision/stability columns.
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
    return await withMemoryMutationLock(async () => {
      await initDatabase();
      const table = getTable();
      if (!table) return false;

      // Find existing memory
      const existing = await loadMemoryById(table, memoryId);

      if (!existing) {
        console.log(`[Memory] Revision failed: memory ${memoryId} not found`);
        return false;
      }

      const now = Date.now();
      const meta = safeParseMetadata(existing.metadata);
      const revisions = Array.isArray(meta.revisions) ? meta.revisions : [];

      // Create revised record
      const revised: CognitiveMemoryRecord = {
        ...existing,
        content: newContent,
        vector: await embedPassage(embeddingTextFor(String(existing.title ?? ''), newContent)),
        lastUpdated: now,
        confidence: options?.newConfidence ?? Math.max(0.3, (existing.confidence ?? 0.7) - 0.1),
        metadata: JSON.stringify({
          ...meta,
          revisions: [
            ...revisions,
            {
              timestamp: now,
              reason: options?.reason || 'manual revision',
              previousContent: existing.content.slice(0, 200),
            },
          ].slice(-MAX_MEMORY_REVISIONS),
          lastRevision: {
            timestamp: now,
            reason: options?.reason || 'manual revision',
            previousContent: existing.content.slice(0, 200),
          },
        }),
      };

      await updateMemoryRecord(table, revised);

      console.log(`[Memory] Revised ${memoryId}`);
      return true;
    });
  } catch (error) {
    console.error('[Memory] Revision error:', error);
    return false;
  }
}

/**
 * Find contradicting memories
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
    return await withMemoryMutationLock(async () => {
      await initDatabase();
      const table = getTable();
      if (!table) return false;

      const memory1 = await loadMemoryById(table, memoryId1);
      const memory2 = await loadMemoryById(table, memoryId2);

      if (!memory1 || !memory2) {
        console.log('[Memory] Cannot mark contradiction: one or both memories not found');
        return false;
      }

      const meta1 = safeParseMetadata(memory1.metadata);
      const meta2 = safeParseMetadata(memory2.metadata);
      const contradicts1 = Array.isArray(meta1.contradicts) ? meta1.contradicts : [];
      const contradicts2 = Array.isArray(meta2.contradicts) ? meta2.contradicts : [];

      if (!contradicts1.includes(memoryId2)) contradicts1.push(memoryId2);
      if (!contradicts2.includes(memoryId1)) contradicts2.push(memoryId1);

      // Lower importance for both (PRD: decrease importance on contradiction)
      memory1.importance = Math.max(0.2, (memory1.importance ?? 0.5) - 0.15);
      memory2.importance = Math.max(0.2, (memory2.importance ?? 0.5) - 0.15);
      memory1.metadata = JSON.stringify({ ...meta1, contradicts: contradicts1 });
      memory2.metadata = JSON.stringify({ ...meta2, contradicts: contradicts2 });

      await updateMemoryRecord(table, memory1);
      await updateMemoryRecord(table, memory2);

      console.log(`[Memory] Marked contradiction between ${memoryId1} and ${memoryId2}`);
      return true;
    });
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
    return await withMemoryMutationLock(async () => {
      await initDatabase();
      const table = getTable();
      if (!table) return false;

      const keepMemory = await loadMemoryById(table, keepId);
      const archiveMemory = await loadMemoryById(table, archiveId);

      if (!keepMemory || !archiveMemory) {
        console.log('[Memory] Cannot reconcile: one or both memories not found');
        return false;
      }

      // Boost kept memory
      keepMemory.confidence = Math.min(1, (keepMemory.confidence ?? 0.7) + 0.1);

      // Archive the other via metadata + low importance. v3 does not maintain a
      // top-level decay field.
      archiveMemory.importance = 0.1;
      archiveMemory.metadata = JSON.stringify({
        ...safeParseMetadata(archiveMemory.metadata),
        archived: {
          timestamp: Date.now(),
          reason,
          supersededBy: keepId,
        },
      });

      await updateMemoryRecord(table, keepMemory);
      await updateMemoryRecord(table, archiveMemory);

      console.log(`[Memory] Reconciled: kept ${keepId}, archived ${archiveId}`);
      return true;
    });
  } catch (error) {
    console.error('[Memory] Reconciliation error:', error);
    return false;
  }
}

/**
 * Format memories as prompt context.
 */
export function formatMemoryContext(memories: MemorySearchResult[]): string {
  if (memories.length === 0) return '';

  // Cognitive + Legacy types
  const grouped: Record<string, MemorySearchResult[]> = {
    // Cognitive
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

  // Cognitive types (ordered by importance, highest first)
  if (grouped.constraint.length > 0) {
    const items = grouped.constraint.map(m =>
      `- ⚠️ **${m.content.slice(0, 100)}** (importance: ${(m.importance * 100).toFixed(0)}%, confidence: ${(m.confidence * 100).toFixed(0)}%)`
    ).join('\n');
    sections.push(`### 🚫 Constraints (CRITICAL)\n${items}`);
  }

  if (grouped.user_model.length > 0) {
    const items = grouped.user_model.map(m =>
      `- **${m.content.slice(0, 100)}** (confidence: ${(m.confidence * 100).toFixed(0)}%)`
    ).join('\n');
    sections.push(`### 👤 User Preferences\n${items}`);
  }

  if (grouped.strategy.length > 0) {
    const items = grouped.strategy.map(m =>
      `- **${m.content.slice(0, 100)}** (confidence: ${(m.confidence * 100).toFixed(0)}%)`
    ).join('\n');
    sections.push(`### 🎯 Verified Strategies\n${items}`);
  }

  if (grouped.belief.length > 0) {
    const items = grouped.belief.map(m =>
      `- ${m.content.slice(0, 100)} (importance: ${(m.importance * 100).toFixed(0)}%)`
    ).join('\n');
    sections.push(`### 💡 Beliefs\n${items}`);
  }

  if (grouped.system_pattern.length > 0) {
    const items = grouped.system_pattern.map(m =>
      `- **${m.content.slice(0, 100)}**`
    ).join('\n');
    sections.push(`### 🏗️ System Patterns\n${items}`);
  }

  // Legacy Types
  if (grouped.decision.length > 0) {
    const items = grouped.decision.map(m =>
      `- **${m.title}** (${formatDate(m.createdAt)}, trust: ${(m.trust * 100).toFixed(0)}%)\n  ${m.content.slice(0, 150)}...`
    ).join('\n');
    sections.push(`### 📋 Related Design Decisions (reference)\n${items}`);
  }

  if (grouped.fact.length > 0) {
    const items = grouped.fact.map(m =>
      `- **${m.title}**: ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`
    ).join('\n');
    sections.push(`### 📌 Related Facts (reference)\n${items}`);
  }

  if (grouped.repomap.length > 0) {
    const items = grouped.repomap.map(m =>
      `- **${m.repo}**: ${m.title}`
    ).join('\n');
    sections.push(`### 🗂️ Repository Structure (reference)\n${items}`);
  }

  if (grouped.journal.length > 0) {
    const items = grouped.journal.map(m =>
      `- [${formatDate(m.createdAt)}] **${m.title}** (freshness: ${(m.freshness * 100).toFixed(0)}%)`
    ).join('\n');
    sections.push(`### 📝 Recent Work Log (reference)\n${items}`);
  }

  if (sections.length === 0) return '';

  return `## 🧠 Repository Memory\n\n${sections.join('\n\n')}\n\n---\n⚠️ The above information is for reference only. It may differ from the current state; verify directly if needed.`;
}

/**
 * Format date
 */
function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Clean up expired memories.
 *
 * Scans the whole table in fixed-offset pages and then deletes the expired
 * rows in bounded batches; the previous single `.limit(10_000)` silently left
 * the remainder of larger stores behind. Deleting only after the scan
 * completes keeps the page offsets stable — deleting mid-scan shifts every
 * later row and makes the cursor skip records. The sweep runs inside
 * withMemoryWriteRetry so a concurrent writer that wins a version race
 * retries it instead of failing part-way; deletes are idempotent.
 */
export async function cleanupExpired(): Promise<number> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return 0;

    const now = Date.now();

    return await withMemoryWriteRetry(async () => {
      const rows = await fetchAllTableRows(table);

      const expiredIds: string[] = [];
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue;
        const r = row as Partial<CognitiveMemoryRecord>;
        if (typeof r.id !== 'string') continue;
        if (typeof r.expiresAt === 'number' && r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now) {
          expiredIds.push(r.id);
        }
      }

      for (let i = 0; i < expiredIds.length; i += PAGE_SIZE) {
        await table.delete(idsPredicate(expiredIds.slice(i, i + PAGE_SIZE)));
      }

      if (expiredIds.length > 0) {
        console.log(`[Memory] Cleanup complete: ${expiredIds.length} expired records deleted`);
      }

      return expiredIds.length;
    }, 'cleanupExpired');
  } catch (error) {
    console.error('[Memory] Cleanup error:', error);
    return 0;
  }
}

// Maintenance
const CONSOLIDATION_SIMILARITY = 0.85;  // Duplicate detection threshold

/** One similarity group: a seed anchor plus the records that joined it. */
interface ConsolidationGroup {
  /** Scan position of the seed — restores the order the old all-pairs scan reported. */
  seedOrder: number;
  /** The seed's vector: the anchor every member is compared against. */
  seedVector: number[];
  members: Array<{ id: string; score: number; order: number }>;
}

/**
 * Consolidate duplicate/similar memories.
 *
 * Records are grouped by the fields the similarity rule requires to be equal
 * (`type`, `repo`) and compared only inside their own group, so the traversal is
 * no longer every record against every other while the write lock is held.
 * Buckets hold only ids, scores, and one vector per group anchor — the kept row
 * is re-read by id when it is updated.
 *
 * Grouping matches the previous all-pairs scan exactly, which matters because
 * cosine similarity is not transitive: in scan order the first record of a group
 * becomes its seed and later records join the *earliest* seed they match, so the
 * anchor stays the seed rather than whichever member currently scores highest.
 */
export async function consolidateMemories(): Promise<{
  merged: number;
  groups: Array<{ kept: string; merged: string[] }>;
}> {
  try {
    return await withMemoryMutationLock(async () => {
      await initDatabase();
      const table = getTable();
      if (!table) return { merged: 0, groups: [] };

      // Read the complete table: the previous single `.limit(10000)` vector
      // query both capped the scan and let vector ranking decide which rows were
      // eligible for merging.
      const allMemories = await fetchAllTableRows(table);

      const buckets = new Map<string, ConsolidationGroup[]>();
      let scanOrder = 0;

      for (const record of allMemories) {
        if (record.id === 'init') continue;

        const order = scanOrder++;
        const key = `${String(record.type)}\u0000${String(record.repo)}`;
        const groups = buckets.get(key) ?? [];
        if (groups.length === 0) buckets.set(key, groups);

        // Stored vectors arrive as Arrow vectors; comparing one read as a JS
        // array scores NaN, which matches nothing.
        const vector = vectorAsNumberArray(record.vector);
        let group = groups.find((candidate) =>
          cosineSimilarity(vector, candidate.seedVector) >= CONSOLIDATION_SIMILARITY);

        if (!group) {
          group = { seedOrder: order, seedVector: vector, members: [] };
          groups.push(group);
        }
        // importance * confidence, as before; ties keep the earlier record.
        group.members.push({
          id: String(record.id),
          score: (record.importance ?? 0.5) * (record.confidence ?? 0.5),
          order,
        });
      }

      const duplicateGroups = [...buckets.values()]
        .flat()
        .filter((group) => group.members.length > 1)
        .sort((a, b) => a.seedOrder - b.seedOrder);

      const groups: Array<{ kept: string; merged: string[] }> = [];
      const mergedIds: string[] = [];

      for (const group of duplicateGroups) {
        // Keep the one with highest importance * confidence
        const [kept, ...toMerge] = [...group.members].sort((a, b) => b.score - a.score || a.order - b.order);
        const mergedHere = toMerge.map((member) => member.id);

        mergedIds.push(...mergedHere);
        groups.push({ kept: kept.id, merged: mergedHere });

        console.log(`[Memory] Consolidated ${mergedHere.length} duplicates into ${kept.id}`);
      }

      if (mergedIds.length > 0) {
        for (const { kept, merged } of groups) {
          const record = await loadMemoryById(table, kept);
          if (!record) continue;

          // Boost kept memory
          record.confidence = Math.min(1, (record.confidence ?? 0.7) + 0.05 * merged.length);
          const meta = safeParseMetadata(record.metadata);
          record.metadata = JSON.stringify({
            ...meta,
            consolidatedFrom: [
              ...(Array.isArray(meta.consolidatedFrom) ? meta.consolidatedFrom : []),
              ...merged,
            ].slice(-MAX_MEMORY_REVISIONS),
          });

          await updateMemoryRecord(table, record);
        }
        await deleteMemoryIds(table, mergedIds);

        console.log(`[Memory] Consolidation complete: ${mergedIds.length} memories merged`);
      }

      return { merged: mergedIds.length, groups };
    });
  } catch (error) {
    console.error('[Memory] Consolidation error:', error);
    return { merged: 0, groups: [] };
  }
}

/**
 * Cosine similarity between two vectors.
 *
 * Returns a score in [-1, 1]; `0` means "cannot compare" (missing or
 * mismatched vectors, or a zero-magnitude vector). Callers compare the result
 * against a similarity threshold, so it must be a number.
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
 * Run lightweight memory maintenance.
 */
export async function runBackgroundCognition(): Promise<{
  consolidation: { merged: number };
  contradictions: number;
}> {
  console.log('[Memory] Starting memory maintenance tasks...');

  // 1. Consolidate duplicates
  const consolidationResult = await consolidateMemories();

  // 2. Detect contradictions (log only, don't auto-resolve)
  const _stats = await getMemoryStats(); // For future expansion
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
    merged: consolidationResult.merged,
    potentialContradictions: contradictionCount,
  });

  return {
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
 * Memory statistics.
 */
export async function getMemoryStats(): Promise<{
  total: number;
  byType: Record<MemoryType, number>;
  byRepo: Record<string, number>;
  avgImportance: number;
}> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return { total: 0, byType: { ...DEFAULT_BY_TYPE }, byRepo: {}, avgImportance: 0 };

    // Aggregate over the complete table: the previous `.limit(10000)` vector
    // query capped statistics at the first 10k rows and let vector ranking pick
    // which rows were counted.
    const results = await fetchAllTableRows(table);

    const byType: Record<MemoryType, number> = { ...DEFAULT_BY_TYPE };
    const byRepo: Record<string, number> = {};
    let totalImportance = 0;
    let count = 0;

    for (const row of results) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Partial<CognitiveMemoryRecord>;
      if (r.id === 'init' || typeof r.id !== 'string') continue;
      if (byType[r.type as MemoryType] !== undefined) {
        byType[r.type as MemoryType]++;
      }
      const repo = r.repo ?? 'unknown';
      byRepo[repo] = (byRepo[repo] || 0) + 1;
      totalImportance += r.importance ?? 0.5;
      count++;
    }

    return {
      total: count,
      byType,
      byRepo,
      avgImportance: count > 0 ? totalImportance / count : 0,
    };
  } catch (error) {
    console.error('[Memory] Stats error:', error);
    return { total: 0, byType: { ...DEFAULT_BY_TYPE }, byRepo: {}, avgImportance: 0 };
  }
}

// Legacy compatibility functions (existing code support)

/**
 * Save conversation (legacy compatible)
 */
export async function saveConversation(
  channelId: string,
  userId: string,
  userName: string,
  content: string,
  response: string,
): Promise<void> {
  await logWork(
    'chat',  // Unified repo for both Discord and Dashboard
    `Chat with ${userName}`,
    `Q: ${content}\n\nA: ${response}`,
    undefined,
    channelId
  );
}

/**
 * Get recent conversations (sorted by createdAt)
 * - Chronological lookup, not semantic search
 * - channelId is stored in the derivedFrom field (legacy: metadata.issueRef)
 */
export async function getRecentConversations(
  channelId: string,
  limit: number = 10,
): Promise<MemorySearchResult[]> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return [];

    // Scalar scan is intentional: vector similarity must not decide which
    // messages count as recent. The final ordering uses the source timestamp.
    const results = await table.query().limit(100_000).toArray();

    // Filter: journal + chat (channelId matching is loose for legacy data compat)
    const filtered = results
      .filter((r: any) => {
        if (r.type !== 'journal' || (r.repo !== 'chat' && r.repo !== 'discord')) return false;  // Support legacy 'discord' repo

        // channelId matching: derivedFrom or metadata.issueRef
        if (!channelId) return true;  // All
        if (r.derivedFrom === channelId) return true;

        // metadata.issueRef fallback
        const meta = safeParseMetadata(r.metadata);
        if (meta.issueRef === channelId) return true;

        return false;
      })
      .sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0))  // Newest first
      .slice(0, limit);

    // Convert to MemorySearchResult format
    return filtered.map((r: any) => ({
      id: r.id,
      type: r.type,
      repo: r.repo,
      title: r.title,
      content: r.content,
      metadata: safeParseMetadata(r.metadata),
      trust: r.trust,
      createdAt: r.createdAt,
      score: 1.0,  // Score is meaningless for chronological lookup
      freshness: calculateFreshness(r.createdAt),
      importance: r.importance,
      confidence: r.confidence,
      derivedFrom: r.derivedFrom ?? 'unknown',
      similarityScore: 1.0,
    }));
  } catch (error) {
    console.error('[Memory] getRecentConversations error:', error);
    return [];
  }
}
