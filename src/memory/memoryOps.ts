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
    `update ${id}`,
  );
}

async function deleteMemoryIds(table: MemoryTable, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withMemoryWriteRetry(
    () => table.delete(idsPredicate(ids)),
    `delete ${ids.length} ids`,
  );
}

/**
 * Revise a memory record by updating its content and metadata.
 * Creates a new revision entry in the revision history.
 */
export async function reviseMemory(
  memoryId: string,
  newContent: string,
  newMetadata?: Record<string, unknown>,
): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return false;

    const existing = await loadMemoryById(table, memoryId);
    if (!existing) return false;

    const revisions: any[] = existing.revisions ?? [];
    revisions.push({
      content: existing.content,
      metadata: existing.metadata,
      timestamp: Date.now(),
    });

    // Cap revision history
    if (revisions.length > MAX_MEMORY_REVISIONS) {
      revisions.splice(0, revisions.length - MAX_MEMORY_REVISIONS);
    }

    const update: Record<string, unknown> = {
      content: newContent,
      revisions,
      lastUpdated: Date.now(),
    };

    if (newMetadata) {
      update.metadata = JSON.stringify(newMetadata);
    }

    await withMemoryWriteRetry(
      () => table.update({ where: idPredicate(memoryId), value: update }),
      `revise ${memoryId}`,
    );

    return true;
  } catch (error) {
    console.error('[Memory] Revise error:', error);
    return false;
  }
}

/**
 * Find contradictions in memory
 */
export async function findContradictions(content: string): Promise<MemorySearchResult[]> {
  try {
    await initDatabase();
    const embedding = await embedPassage(content);
    if (!embedding) return [];

    const results = await searchMemory(embedding, 20, 0.7);
    return results.filter((r) => r.type === 'contradiction');
  } catch (error) {
    console.error('[Memory] Find contradictions error:', error);
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

    const m1 = await loadMemoryById(table, memoryId1);
    const m2 = await loadMemoryById(table, memoryId2);
    if (!m1 || !m2) return false;

    const contradictions1: string[] = m1.contradictions ?? [];
    const contradictions2: string[] = m2.contradictions ?? [];

    if (!contradictions1.includes(memoryId2)) {
      contradictions1.push(memoryId2);
      await withMemoryWriteRetry(
        () => table.update({ where: idPredicate(memoryId1), value: { contradictions: contradictions1 } }),
        `mark contradiction ${memoryId1}`,
      );
    }

    if (!contradictions2.includes(memoryId1)) {
      contradictions2.push(memoryId1);
      await withMemoryWriteRetry(
        () => table.update({ where: idPredicate(memoryId2), value: { contradictions: contradictions2 } }),
        `mark contradiction ${memoryId2}`,
      );
    }

    return true;
  } catch (error) {
    console.error('[Memory] Mark contradiction error:', error);
    return false;
  }
}

/**
 * Reconcile a contradiction by updating one memory and removing the contradiction marker
 */
export async function reconcileContradiction(
  keepId: string,
  removeId: string,
  reconciledContent: string,
): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return false;

    const keep = await loadMemoryById(table, keepId);
    if (!keep) return false;

    // Update kept memory with reconciled content
    await withMemoryWriteRetry(
      () => table.update({
        where: idPredicate(keepId),
        value: {
          content: reconciledContent,
          lastUpdated: Date.now(),
          contradictions: (keep.contradictions ?? []).filter((id: string) => id !== removeId),
        },
      }),
      `reconcile keep ${keepId}`,
    );

    // Remove contradiction marker from the removed memory
    const remove = await loadMemoryById(table, removeId);
    if (remove) {
      await withMemoryWriteRetry(
        () => table.update({
          where: idPredicate(removeId),
          value: {
            contradictions: (remove.contradictions ?? []).filter((id: string) => id !== keepId),
          },
        }),
        `reconcile remove ${removeId}`,
      );
    }

    return true;
  } catch (error) {
    console.error('[Memory] Reconcile contradiction error:', error);
    return false;
  }
}

/**
 * Format memories for context
 */
export function formatMemoryContext(memories: MemorySearchResult[]): string {
  if (memories.length === 0) return '';

  return memories
    .map((m) => {
      const date = formatDate(m.createdAt);
      const meta = m.metadata ? ` (${JSON.stringify(m.metadata)})` : '';
      return `[${m.type}] ${m.title || 'Untitled'} (${date})${meta}\n${m.content}`;
    })
    .join('\n\n---\n\n');
}

function formatDate(timestamp: number): string {
  try {
    return new Date(timestamp).toISOString().split('T')[0];
  } catch {
    return 'unknown';
  }
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
    const results = await table.query().limit(10_000).toArray();

    const expiredIds = results
      .filter((r: any) => r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now)
      .map((r: any) => r.id);

    if (expiredIds.length > 0) {
      await deleteMemoryIds(table, expiredIds);
      console.log(`[Memory] Deleted ${expiredIds.length} expired records`);
    }

    return expiredIds.length;
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
 * Uses a streaming, bounded-memory cursor scan over the complete table
 * (no LIMIT, no vector search) so all candidate pairs are evaluated via
 * exact cosine similarity — not lossy LSH band matches.  In-memory
 * comparison is O(g²) where g = group size per (type, repo, derivedFrom)
 * bucket, not O(n²) over the full table.
 */
export async function consolidateMemories(): Promise<{
  merged: number;
  groups: Array<{ kept: string; merged: string[] }>;
}> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return { merged: 0, groups: [] };

    // Streaming cursor: scan ALL rows (no limit) to ensure complete coverage.
    const PAGE_SIZE = 10_000;
    const allRecords: any[] = [];
    let offset = 0;
    while (true) {
      const page = await table.query().limit(PAGE_SIZE).offset(offset).toArray();
      if (page.length === 0) break;
      for (const r of page) {
        if (r.id !== 'init') allRecords.push(r);
      }
      offset += page.length;
    }

    const merged: string[] = [];
    const groups: Array<{ kept: string; merged: string[] }> = [];
    const updatedKept: any[] = [];

    // Bucket by (type, repo, derivedFrom) so each inner loop is bounded
    // by group size, not total record count.
    const buckets = new Map<string, any[]>();
    for (const r of allRecords) {
      const key = `${r.type}|${r.repo}|${r.derivedFrom ?? ''}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(r);
    }

    for (const bucket of buckets.values()) {
      for (let i = 0; i < bucket.length; i++) {
        const m1 = bucket[i];
        if (merged.includes(m1.id)) continue;

        const similarGroup: any[] = [m1];

        for (let j = i + 1; j < bucket.length; j++) {
          const m2 = bucket[j];
          if (merged.includes(m2.id)) continue;

          // Exact cosine similarity — not lossy LSH band match
          const similarity = cosineSimilarity(m1.vector, m2.vector);

          if (similarity >= CONSOLIDATION_SIMILARITY) {
            similarGroup.push(m2);
            merged.push(m2.id);
          }
        }

        if (similarGroup.length > 1) {
          // Keep the one with highest importance, merge others
          similarGroup.sort((a: any, b: any) => (b.importance || 0) - (a.importance || 0));
          const kept = similarGroup[0];
          const toMerge = similarGroup.slice(1);

          // Merge content from duplicates into kept record
          const mergedContent = toMerge
            .map((m: any) => m.content)
            .filter(Boolean)
            .join('\n---\n');
          if (mergedContent) {
            kept.content = kept.content
              ? `${kept.content}\n---\n${mergedContent}`
              : mergedContent;
          }

          // Update lastUpdated to most recent
          const maxUpdated = Math.max(...similarGroup.map((m: any) => m.lastUpdated || 0));
          if (maxUpdated > (kept.lastUpdated || 0)) {
            kept.lastUpdated = maxUpdated;
          }

          updatedKept.push(kept);
          groups.push({
            kept: kept.id,
            merged: toMerge.map((m: any) => m.id),
          });

          console.log(`[Memory] Consolidated ${toMerge.length} duplicates into ${kept.id}`);
        }
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
  } catch (error) {
    console.error('[Memory] Consolidation error:', error);
    return { merged: 0, groups: [] };
  }
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): boolean {
  if (!a || !b || a.length !== b.length) return false;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return false;

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

const DEFAULT_BY_TYPE: Record<MemoryType, number> = {
  journal: 0,
  code: 0,
  design: 0,
  decision: 0,
  contradiction: 0,
  conversation: 0,
  task: 0,
  plan: 0,
  review: 0,
  insight: 0,
  error: 0,
  warning: 0,
  info: 0,
  config: 0,
  metric: 0,
  feedback: 0,
  goal: 0,
  preference: 0,
  relationship: 0,
  reflection: 0,
  summary: 0,
  template: 0,
  pattern: 0,
  concept: 0,
  fact: 0,
  procedure: 0,
  principle: 0,
  question: 0,
  answer: 0,
  suggestion: 0,
  reminder: 0,
  bookmark: 0,
  log: 0,
  debug: 0,
  test: 0,
  build: 0,
  deploy: 0,
  monitor: 0,
  security: 0,
  performance: 0,
  dependency: 0,
  api: 0,
  ui: 0,
  data: 0,
  migration: 0,
  legacy: 0,
  archive: 0,
  draft: 0,
  proposal: 0,
  discussion: 0,
  note: 0,
  todo: 0,
  milestone: 0,
  release: 0,
  changelog: 0,
  announcement: 0,
  other: 0,
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

    // Aggregate over the COMPLETE table: paginated scalar scan (no vector
    // search, no 10k cap) so statistics never drop rows at scale.
    const byType: Record<MemoryType, number> = { ...DEFAULT_BY_TYPE };
    const byRepo: Record<string, number> = {};
    let totalImportance = 0;
    let count = 0;

    const PAGE_SIZE = 10_000;
    let offset = 0;
    while (true) {
      const page = await table.query().limit(PAGE_SIZE).offset(offset).toArray();
      if (page.length === 0) break;
      offset += page.length;

      for (const r of page) {
        if (r.id === 'init') continue;
        if (byType[r.type as MemoryType] !== undefined) {
          byType[r.type as MemoryType]++;
        }
        byRepo[r.repo] = (byRepo[r.repo] || 0) + 1;
        totalImportance += r.importance ?? 0.5;
        count++;
      }
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
    // messages count as recent.  Apply ORDER BY createdAt DESC before LIMIT
    // to guarantee globally newest entries are returned.
    const results = await table
      .query()
      .orderBy('createdAt', 'desc')
      .limit(100_000)
      .toArray();

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