/**
 * Persistent Cognitive Memory Module v3.0 - Operations
 *
 * Formatting, compaction helpers, stats, and legacy compat.
 * Core types, save, search are in memoryCore.ts.
 */
import {
  EMBEDDING_DIM,
  PERMANENT_EXPIRY,
  normalizeRecords,
  initDatabase,
  embedPassage,
  getTable,
  searchMemory,
  calculateFreshness,
  safeParseMetadata,
  logWork,
  withMemoryWriteRetry,
  type MemoryType,
  type MemorySearchResult,
  type CognitiveMemoryRecord,
} from './memoryCore.js';
import { embeddingTextFor } from './embeddingConfig.js';

type MemoryTable = NonNullable<ReturnType<typeof getTable>>;
const MAX_MEMORY_REVISIONS = 20;

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
 *
 * The full read-modify-write is serialised under withMemoryWriteRetry so that
 * concurrent revisions do not silently overwrite each other's changes.
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
    if (!table) return false;

    // Serialise the full read-modify-write under withMemoryWriteRetry so that
    // concurrent revisions re-read the latest record before writing.
    return await withMemoryWriteRetry(async () => {
      // Re-read inside the retry loop so a contended write re-fetches the latest
      const existing = await loadMemoryById(table!, memoryId);

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

      await updateMemoryRecord(table!, revised);
      console.log(`[Memory] Revised ${memoryId}`);
      return true;
    }, 'reviseMemory');
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
        const hasPositive = positive.test(content) && negative.test(memory.content);
        const hasNegative = negative.test(content) && positive.test(memory.content);

        if (hasPositive || hasNegative) {
          contradictions.push(memory);
          break;
        }
      }
    }

    return contradictions;
  } catch (error) {
    console.error('[Memory] Contradiction search error:', error);
    return [];
  }
}

/**
 * Mark two memories as contradicting each other
 */
export async function markContradiction(memoryId1: string, memoryId2: string): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return false;

    const memory1 = await loadMemoryById(table, memoryId1);
    const memory2 = await loadMemoryById(table, memoryId2);

    if (!memory1 || !memory2) return false;

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

    return true;
  } catch (error) {
    console.error('[Memory] Mark contradiction error:', error);
    return false;
  }
}

/**
 * Reconcile contradiction by updating one memory and removing the other
 */
export async function reconcileContradiction(
  keepId: string,
  removeId: string,
  resolution: string
): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return false;

    const keep = await loadMemoryById(table, keepId);
    const remove = await loadMemoryById(table, removeId);

    if (!keep || !remove) return false;

    // Update kept memory with resolution
    const meta = safeParseMetadata(keep.metadata);
    const contradictions = Array.isArray(meta.contradictions) ? meta.contradictions : [];
    contradictions.push({
      resolvedWith: removeId,
      resolution,
      timestamp: Date.now(),
    });

    keep.metadata = JSON.stringify({
      ...meta,
      contradictions,
      resolvedContradictions: [
        ...(Array.isArray(meta.resolvedContradictions) ? meta.resolvedContradictions : []),
        removeId,
      ],
    });

    await updateMemoryRecord(table, keep);
    await deleteMemoryIds(table, [removeId]);

    return true;
  } catch (error) {
    console.error('[Memory] Reconcile contradiction error:', error);
    return false;
  }
}

/**
 * Format memory context for LLM prompt
 */
export function formatMemoryContext(memories: MemorySearchResult[]): string {
  if (memories.length === 0) return '';

  const sections: string[] = ['<memory_context>'];

  for (const memory of memories) {
    const type = memory.type ?? 'unknown';
    const title = memory.title ?? 'Untitled';
    const content = memory.content ?? '';
    const importance = memory.importance ?? 0.5;
    const confidence = memory.confidence ?? 0.5;
    const freshness = memory.freshness ?? 0;

    sections.push(
      `  <memory type="${type}" importance="${importance.toFixed(2)}" confidence="${confidence.toFixed(2)}" freshness="${freshness.toFixed(2)}">`
    );
    sections.push(`    <title>${title}</title>`);
    sections.push(`    <content>${content}</content>`);
    sections.push('  </memory>');
  }

  sections.push('</memory_context>');
  return sections.join('\n');
}

/**
 * Format date for display
 */
function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split('T')[0];
}

/**
 * Clean up expired memories
 */
export async function cleanupExpired(): Promise<number> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return 0;

    const now = Date.now();
    const rows = await table.query().limit(100_000).toArray();
    const expired = rows.filter((r: any) => {
      if (r.type === 'system_pattern') return false;
      const expiry = r.metadata?.expiresAt;
      return expiry && expiry < now;
    });

    if (expired.length === 0) return 0;

    const ids = expired.map((r: any) => r.id);
    await deleteMemoryIds(table, ids);
    console.log(`[Memory] Cleaned up ${expired.length} expired memories`);
    return expired.length;
  } catch (error) {
    console.error('[Memory] Cleanup error:', error);
    return 0;
  }
}

/**
 * Apply memory decay to reduce importance over time
 */
export async function applyMemoryDecay(daysSinceLastRun = 7): Promise<{
  decayed: number;
  archived: number;
}> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return { decayed: 0, archived: 0 };

    const now = Date.now();
    const decayThreshold = now - daysSinceLastRun * 24 * 60 * 60 * 1000;
    const archiveThreshold = now - daysSinceLastRun * 30 * 24 * 60 * 60 * 1000;

    const rows = await table.query().limit(100_000).toArray();
    let decayed = 0;
    let archived = 0;

    for (const row of rows) {
      if (row.type === 'system_pattern') continue;

      const lastAccessed = row.lastAccessed ?? row.createdAt ?? 0;
      if (lastAccessed < archiveThreshold) {
        // Archive: reduce importance significantly
        row.importance = Math.max(0.1, (row.importance ?? 0.5) * 0.5);
        row.metadata = JSON.stringify({
          ...safeParseMetadata(row.metadata),
          archived: true,
          archivedAt: now,
        });
        await updateMemoryRecord(table, row);
        archived++;
      } else if (lastAccessed < decayThreshold) {
        // Decay: reduce importance slightly
        row.importance = Math.max(0.2, (row.importance ?? 0.5) * 0.9);
        await updateMemoryRecord(table, row);
        decayed++;
      }
    }

    console.log(`[Memory] Decay applied: ${decayed} decayed, ${archived} archived`);
    return { decayed, archived };
  } catch (error) {
    console.error('[Memory] Decay error:', error);
    return { decayed: 0, archived: 0 };
  }
}

/**
 * Consolidate duplicate memories by merging similar entries.
 *
 * The full read-merge-write is serialised under withMemoryWriteRetry so that
 * concurrent consolidation runs do not race on the same records.
 */
const CONSOLIDATION_SIMILARITY = 0.92;

export async function consolidateMemories(): Promise<{
  merged: number;
  groups: Array<{ kept: string; merged: string[] }>;
}> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return { merged: 0, groups: [] };

    // Serialise the full read-merge-write under withMemoryWriteRetry so that
    // concurrent consolidation runs re-read the latest state before writing.
    return await withMemoryWriteRetry(async () => {
      const results = await table!.search(Array.from({ length: EMBEDDING_DIM }, () => 0)).limit(10000).toArray();
      const validMemories = results.filter((r: any) => r.id !== 'init');

      const merged: string[] = [];
      const groups: Array<{ kept: string; merged: string[] }> = [];
      const updatedKept: any[] = [];

      // Find similar memory groups
      for (let i = 0; i < validMemories.length; i++) {
        const m1 = validMemories[i];
        if (merged.includes(m1.id)) continue;

        const similarGroup: any[] = [m1];

        for (let j = i + 1; j < validMemories.length; j++) {
          const m2 = validMemories[j];
          if (merged.includes(m2.id)) continue;
          if (m1.type !== m2.type || m1.repo !== m2.repo) continue;

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
          const meta = safeParseMetadata(kept.metadata);
          kept.metadata = JSON.stringify({
            ...meta,
            consolidatedFrom: [
              ...(Array.isArray(meta.consolidatedFrom) ? meta.consolidatedFrom : []),
              ...toMerge.map((m: any) => m.id),
            ].slice(-MAX_MEMORY_REVISIONS),
          });
          updatedKept.push(kept);

          groups.push({
            kept: kept.id,
            merged: toMerge.map((m: any) => m.id),
          });

          console.log(`[Memory] Consolidated ${toMerge.length} duplicates into ${kept.id}`);
        }
      }

      if (merged.length > 0) {
        for (const record of updatedKept) {
          await updateMemoryRecord(table!, record);
        }
        await deleteMemoryIds(table!, merged);

        console.log(`[Memory] Consolidation complete: ${merged.length} memories merged`);
      }

      return { merged: merged.length, groups };
    }, 'consolidateMemories');
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

/**
 * Get memory statistics
 */
export async function getMemoryStats(): Promise<{
  total: number;
  byType: Record<string, number>;
  avgImportance: number;
  avgConfidence: number;
  oldest: number;
  newest: number;
}> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) {
      return { total: 0, byType: {}, avgImportance: 0, avgConfidence: 0, oldest: 0, newest: 0 };
    }

    const rows = await table.query().limit(100_000).toArray();
    const total = rows.length;
    const byType: Record<string, number> = {};
    let totalImportance = 0;
    let totalConfidence = 0;
    let oldest = Infinity;
    let newest = 0;

    for (const row of rows) {
      byType[row.type] = (byType[row.type] ?? 0) + 1;
      totalImportance += row.importance ?? 0.5;
      totalConfidence += row.confidence ?? 0.5;
      if (row.createdAt < oldest) oldest = row.createdAt;
      if (row.createdAt > newest) newest = row.createdAt;
    }

    return {
      total,
      byType,
      avgImportance: total / totalImportance,
      avgConfidence: total / totalConfidence,
      oldest: oldest === Infinity ? 0 : oldest,
      newest,
    };
  } catch (error) {
    console.error('[Memory] Stats error:', error);
    return { total: 0, byType: {}, avgImportance: 0, avgConfidence: 0, oldest: 0, newest: 0 };
  }
}

/**
 * Get recent conversations (for context window)
 */
export async function getRecentConversations(limit = 10): Promise<MemorySearchResult[]> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return [];

    const rows = await table.query().limit(limit).toArray();
    const filtered = rows
      .filter((r: any) => r.type === 'conversation' || r.type === 'decision')
      .sort((a: any, b: any) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, limit);

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