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
    () => table.update({ where: idPredicate(id), value: values }),
    'updateMemoryRecord',
  );
}

async function deleteMemoryIds(table: MemoryTable, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withMemoryWriteRetry(
    () => table.delete(idsPredicate(ids)),
    'deleteMemoryIds',
  );
}

/**
 * Revise a memory record by updating its content and re-embedding.
 */
export async function reviseMemory(
  id: string,
  updates: { content?: string; metadata?: Record<string, unknown>; importance?: number },
): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return false;

    const existing = await loadMemoryById(table, id);
    if (!existing) return false;

    const updated: any = { ...existing };

    if (updates.content !== undefined) {
      updated.content = updates.content;
      updated.vector = await embedPassage(updates.content);
    }

    if (updates.metadata !== undefined) {
      const existingMeta = safeParseMetadata(existing.metadata);
      updated.metadata = JSON.stringify({ ...existingMeta, ...updates.metadata });
    }

    if (updates.importance !== undefined) {
      updated.importance = updates.importance;
    }

    updated.lastUpdated = Date.now();

    await updateMemoryRecord(table, updated);
    return true;
  } catch (error) {
    console.error('[Memory] Revise error:', error);
    return false;
  }
}

/**
 * Find contradictions in memory content
 */
export async function findContradictions(content: string): Promise<MemorySearchResult[]> {
  try {
    await initDatabase();
    const vector = await embedPassage(content);
    const results = await searchMemory(vector, 10);
    return results;
  } catch (error) {
    console.error('[Memory] Contradiction search error:', error);
    return [];
  }
}

/**
 * Mark two memories as contradictory
 */
export async function markContradiction(memoryId1: string, memoryId2: string): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return false;

    const mem1 = await loadMemoryById(table, memoryId1);
    const mem2 = await loadMemoryById(table, memoryId2);
    if (!mem1 || !mem2) return false;

    const meta1 = safeParseMetadata(mem1.metadata);
    const meta2 = safeParseMetadata(mem2.metadata);

    const contradictions1: string[] = Array.isArray(meta1.contradictions) ? meta1.contradictions : [];
    const contradictions2: string[] = Array.isArray(meta2.contradictions) ? meta2.contradictions : [];

    if (!contradictions1.includes(memoryId2)) {
      contradictions1.push(memoryId2);
    }
    if (!contradictions2.includes(memoryId1)) {
      contradictions2.push(memoryId1);
    }

    mem1.metadata = JSON.stringify({ ...meta1, contradictions: contradictions1 });
    mem2.metadata = JSON.stringify({ ...meta2, contradictions: contradictions2 });

    await updateMemoryRecord(table, mem1);
    await updateMemoryRecord(table, mem2);

    return true;
  } catch (error) {
    console.error('[Memory] Mark contradiction error:', error);
    return false;
  }
}

/**
 * Reconcile a contradiction by updating one memory and removing the other
 */
export async function reconcileContradiction(
  keepId: string,
  removeId: string,
  resolution?: string,
): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return false;

    const keep = await loadMemoryById(table, keepId);
    const remove = await loadMemoryById(table, removeId);
    if (!keep || !remove) return false;

    const keepMeta = safeParseMetadata(keep.metadata);
    const contradictions: string[] = Array.isArray(keepMeta.contradictions) ? keepMeta.contradictions : [];

    if (resolution) {
      keep.content = resolution;
      keep.vector = await embedPassage(resolution);
    }

    keep.metadata = JSON.stringify({
      ...keepMeta,
      contradictions: contradictions.filter((id: string) => id !== removeId),
      resolvedContradictions: [
        ...(Array.isArray(keepMeta.resolvedContradictions) ? keepMeta.resolvedContradictions : []),
        removeId,
      ],
    });

    keep.lastUpdated = Date.now();
    await updateMemoryRecord(table, keep);
    await deleteMemoryIds(table, [removeId]);

    return true;
  } catch (error) {
    console.error('[Memory] Reconcile contradiction error:', error);
    return false;
  }
}

/**
 * Format memory context for display
 */
export function formatMemoryContext(memories: MemorySearchResult[]): string {
  if (!memories || memories.length === 0) return 'No relevant memories found.';

  return memories.map((m, i) => {
    const age = Date.now() - m.lastUpdated;
    const ageStr = age < 3600000 ? `${Math.round(age / 60000)}m ago`
      : age < 86400000 ? `${Math.round(age / 3600000)}h ago`
      : `${Math.round(age / 86400000)}d ago`;
    return `[${i + 1}] ${m.title ?? 'Untitled'} (${ageStr}, confidence: ${(m.confidence ?? 0).toFixed(2)})\n${m.content ?? ''}`;
  }).join('\n\n');
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Clean up expired memory records.
 *
 * The entire sweep runs inside the project's optimistic-concurrency
 * write-retry wrapper (`withMemoryWriteRetry`), so a concurrent writer that
 * wins a version race retries the whole sweep instead of leaving partial or
 * lost deletes.  Records are processed in pages of 10,000 and the sweep loops
 * until no expired rows remain, so stores larger than 10K rows are fully
 * cleaned in a single call.
 */
export async function cleanupExpired(): Promise<number> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return 0;

    return await withMemoryWriteRetry(async () => {
      const now = Date.now();
      const pageSize = 10_000;
      let totalDeleted = 0;
      let page: any[];

      // Paginate through all expired rows — a single .limit(10000) would miss
      // rows beyond the first 10K.
      do {
        page = await table
          .search(Array.from({ length: EMBEDDING_DIM }, () => 0))
          .limit(pageSize)
          .offset(totalDeleted)
          .toArray();

        const expiredIds = page
          .filter((r: any) => r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now)
          .map((r: any) => r.id);

        if (expiredIds.length === 0) {
          // No expired rows on this page: every remaining row is live, so the
          // sweep is complete.  This also stops the loop from spinning on a
          // full page of live rows.
          break;
        }

        // The whole sweep is already wrapped in withMemoryWriteRetry, so a
        // version conflict retries the sweep rather than losing deletes.
        await table.delete(idsPredicate(expiredIds));
        totalDeleted += expiredIds.length;
        console.log(`[Memory] Deleted ${expiredIds.length} expired records (cumulative ${totalDeleted})`);
      } while (page.length === pageSize);

      if (totalDeleted > 0) {
        console.log(`[Memory] Cleanup complete: ${totalDeleted} expired records deleted`);
      }

      return totalDeleted;
    }, 'cleanupExpired');
  } catch (error) {
    console.error('[Memory] Cleanup error:', error);
    return 0;
  }
}

// Maintenance
const CONSOLIDATION_SIMILARITY = 0.85;  // Duplicate detection threshold

/**
 * Consolidate duplicate/similar memories.
 *
 * Reads records in pages of 10,000 and loops until no more rows remain, so
 * stores larger than 10K rows are fully processed in a single call.  The
 * entire sweep runs inside the project's optimistic-concurrency write-retry
 * wrapper, so a concurrent writer that wins a version race retries the whole
 * sweep instead of leaving partial or lost deletes.
 */
export async function consolidateMemories(): Promise<{
  merged: number;
  groups: Array<{ kept: string; merged: string[] }>;
}> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return { merged: 0, groups: [] };

    return await withMemoryWriteRetry(async () => {
      const pageSize = 10_000;
      const allMemories: any[] = [];
      let offset = 0;
      let page: any[];
      do {
        page = await table
          .search(Array.from({ length: EMBEDDING_DIM }, () => 0))
          .limit(pageSize)
          .offset(offset)
          .toArray();
        allMemories.push(...page);
        offset += page.length;
      } while (page.length === pageSize);

      const validMemories = allMemories.filter((r: any) => r.id !== 'init');

      const merged: string[] = [];
      const groups: Array<{ kept: string; merged: string[] }> = [];

      for (let i = 0; i < validMemories.length; i++) {
        if (merged.includes(validMemories[i].id)) continue;

        const similar: string[] = [];
        for (let j = i + 1; j < validMemories.length; j++) {
          if (merged.includes(validMemories[j].id)) continue;

          if (
            validMemories[i].repo !== validMemories[j].repo ||
            validMemories[i].type !== validMemories[j].type
          ) continue;

          const sim = cosineSimilarity(
            validMemories[i].vector,
            validMemories[j].vector,
          );

          if (sim >= CONSOLIDATION_SIMILARITY) {
            similar.push(validMemories[j].id);
            merged.push(validMemories[j].id);
          }
        }

        if (similar.length > 0) {
          groups.push({ kept: validMemories[i].id, merged: similar });
        }
      }

      // Update kept records with merged content
      const updatedKept = validMemories.filter((r) => !merged.includes(r.id));
      for (const record of updatedKept) {
        const meta = safeParseMetadata(record.metadata);
        const mergedContents = groups
          .filter((g) => g.kept === record.id)
          .flatMap((g) => g.merged)
          .map((id) => validMemories.find((r) => r.id === id))
          .filter(Boolean)
          .map((r) => r!.content);

        if (mergedContents.length > 0) {
          record.metadata = JSON.stringify({
            ...meta,
            mergedFrom: [...(Array.isArray(meta.mergedFrom) ? meta.mergedFrom : []), ...mergedContents],
          });
        }
      }

      if (merged.length > 0) {
        for (const record of updatedKept) {
          await updateMemoryRecord(table, record);
        }
        await deleteMemoryIds(table, merged);

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

  if (normA === 0 || normB === 0) return 0;

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Apply memory decay to reduce importance of old memories.
 *
 * Reads records in pages of 10,000 and loops until no more rows remain, so
 * stores larger than 10K rows are fully processed in a single call.  The
 * entire sweep runs inside the project's optimistic-concurrency write-retry
 * wrapper, so a concurrent writer that wins a version race retries the whole
 * sweep instead of leaving partial or lost deletes.
 */
export async function applyMemoryDecay(daysSinceLastRun: number = 7): Promise<{
  decayed: number;
  removed: number;
}> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return { decayed: 0, removed: 0 };

    return await withMemoryWriteRetry(async () => {
      const pageSize = 10_000;
      const now = Date.now();
      const decayRate = 0.05 * daysSinceLastRun;
      let decayed = 0;
      let removed = 0;
      let offset = 0;
      let page: any[];

      do {
        page = await table
          .search(Array.from({ length: EMBEDDING_DIM }, () => 0))
          .limit(pageSize)
          .offset(offset)
          .toArray();

        for (const record of page) {
          if (record.id === 'init') continue;
          if (record.expiresAt >= PERMANENT_EXPIRY) continue; // Skip permanent memories

          const age = now - record.lastUpdated;
          const daysOld = age / (1000 * 60 * 60 * 24);

          if (daysOld > 30) {
            // Remove very old memories
            await deleteMemoryIds(table, [record.id]);
            removed++;
          } else if (daysOld > 7) {
            // Decay importance
            const newImportance = Math.max(0.1, (record.importance ?? 0.5) - decayRate);
            if (newImportance < 0.1) {
              await deleteMemoryIds(table, [record.id]);
              removed++;
            } else {
              await updateMemoryRecord(table, { ...record, importance: newImportance });
              decayed++;
            }
          }
        }

        offset += page.length;
      } while (page.length === pageSize);

      console.log(`[Memory] Decay applied: ${decayed} decayed, ${removed} removed`);
      return { decayed, removed };
    }, 'applyMemoryDecay');
  } catch (error) {
    console.error('[Memory] Decay error:', error);
    return { decayed: 0, removed: 0 };
  }
}