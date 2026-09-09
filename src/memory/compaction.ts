// ============================================
// OpenSwarm - Memory Compaction
// ============================================

import { getDb, getTable, initDatabase, EMBEDDING_DIM, PERMANENT_EXPIRY, normalizeRecords, setTable } from './memoryCore.js';
import type { CognitiveMemoryRecord } from './memoryCore.js';
import { isTransientReviewRejectionMemory } from './memoryFilters.js';

const MIN_IMPORTANCE = 0.1;
const CONSOLIDATION_SIMILARITY = 0.85;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function stableMetadata(value: unknown): string {
  if (typeof value !== 'string') return stableJson(value);
  try {
    return stableJson(JSON.parse(value));
  } catch {
    return JSON.stringify(value);
  }
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

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
 * Remove duplicate memories based on vector similarity.
 *
 * Records are bucketed in a Map keyed by a stable hash of their non-vector
 * fields (repo, type, derivedFrom, canonical metadata), so records read on
 * different pagination pages still land in the same bucket and are compared.
 * Within a bucket, near-identical vectors (cosine similarity >=
 * CONSOLIDATION_SIMILARITY) collapse into the single best record (highest
 * importance, then most recently updated).
 */
export function removeDuplicates(records: CognitiveMemoryRecord[]): CognitiveMemoryRecord[] {
  // 1. Bucket every record by stable hash BEFORE any merging, so duplicates
  //    across page boundaries are guaranteed to meet.
  const buckets = new Map<string, CognitiveMemoryRecord[]>();
  for (const record of records) {
    const key = stableHash([
      record.repo,
      record.type,
      record.derivedFrom,
      stableMetadata(record.metadata),
    ]);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(record);
    else buckets.set(key, [record]);
  }

  const unique: CognitiveMemoryRecord[] = [];
  const seen = new Set<string>();

  // 2. Reduce each bucket to its best record, dropping near-duplicates of it.
  for (const bucket of buckets.values()) {
    let kept: CognitiveMemoryRecord | null = null;
    for (const record of bucket) {
      if (seen.has(record.id)) continue;
      if (
        kept === null ||
        record.importance > kept.importance ||
        (record.importance === kept.importance && record.lastUpdated > kept.lastUpdated)
      ) {
        kept = record;
      }
    }
    if (kept === null) continue;
    seen.add(kept.id);
    unique.push(kept);

    for (const record of bucket) {
      if (seen.has(record.id) || record.id === kept.id) continue;
      if (cosineSimilarity(record.vector, kept.vector) >= CONSOLIDATION_SIMILARITY) {
        seen.add(record.id);
      }
    }
  }

  return unique;
}

/**
 * Order-independent hash (FNV-1a over canonical JSON) used as the dedup key.
 */
function stableHash(value: unknown): string {
  const json = stableJson(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}:${json.length.toString(16)}`;
}

/**
 * Compact memory table by removing expired/unimportant/noisy records,
 * deduplicating similar memories, and rewriting to the lean v3 schema.
 *
 * Reads records in pages to avoid single-query limits, then deduplicates
 * across the full set so records on different page boundaries are compared.
 *
 * @returns Statistics about compaction
 */
export async function compactMemoryTable(): Promise<{
  before: number;
  after: number;
  removed: number;
  deduplicated: number;
}> {
  console.log('[Compaction] Starting memory table compaction...');

  try {
    await initDatabase();
    const table = getTable();
    const db = getDb();

    if (!table || !db) {
      console.error('[Compaction] Database not initialized');
      return { before: 0, after: 0, removed: 0, deduplicated: 0 };
    }

    // 1. Read all records across pagination boundaries
    const pageSize = 10_000;
    const allRecords: any[] = [];
    let offset = 0;
    let page: any[];
    do {
      page = await table
        .search(Array.from({ length: EMBEDDING_DIM }, () => 0))
        .limit(pageSize)
        .offset(offset)
        .toArray();
      allRecords.push(...page);
      offset += page.length;
    } while (page.length === pageSize);

    const beforeCount = allRecords.length;
    console.log(`[Compaction] Found ${beforeCount} records`);

    if (beforeCount === 0) {
      console.log('[Compaction] No records to compact');
      return { before: 0, after: 0, removed: 0, deduplicated: 0 };
    }

    // 2. Filter valid records
    const now = Date.now();
    const validRecords = allRecords.filter((r: any) => {
      if (r.id === 'init') return true;

      // Remove transient infrastructure failures that were previously stored as
      // high-importance reviewer constraints.
      if (isTransientReviewRejectionMemory(r)) return false;

      // Remove if expired
      if (r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now) return false;

      // Remove if unimportant
      if (r.importance < MIN_IMPORTANCE) return false;

      return true;
    });

    const afterFilter = validRecords.length;
    console.log(`[Compaction] After filtering: ${afterFilter} records (removed ${beforeCount - afterFilter})`);

    // 3. Deduplicate — called once with ALL records from all pages,
    //    so duplicates across page boundaries are caught.
    const deduplicated = removeDuplicates(validRecords as CognitiveMemoryRecord[]);
    const afterDedup = deduplicated.length;
    console.log(`[Compaction] After deduplication: ${afterDedup} records (merged ${afterFilter - afterDedup})`);

    // 4. Validate replacement before touching the live table
    const normalized = normalizeRecords(deduplicated);
    const targetTableName = table.name;
    const tempTableName = `${targetTableName}_compact_${Date.now()}`;

    console.log(`[Compaction] Creating validated replacement for ${targetTableName}...`);
    if (normalized.length > 0) {
      await db.createTable(tempTableName, normalized[0]);
      const tempTable = getTable(tempTableName);
      if (!tempTable) {
        throw new Error(`[Compaction] Failed to create temp table ${tempTableName}`);
      }
      await tempTable.add(normalized);
    } else {
      // No records left — create an empty table with the same schema
      const schema = await table.schema();
      await db.createTable(tempTableName, schema);
    }

    // 5. Swap tables
    const tempTable = getTable(tempTableName);
    if (!tempTable) {
      throw new Error(`[Compaction] Temp table ${tempTableName} not found after creation`);
    }

    console.log(`[Compaction] Swapping ${targetTableName} -> ${tempTableName}...`);
    setTable(tempTable);
    await db.dropTable(targetTableName);
    await db.renameTable(tempTableName, targetTableName);
    setTable(getTable(targetTableName));

    console.log(`[Compaction] Compaction complete: ${beforeCount} -> ${afterDedup} records`);

    return {
      before: beforeCount,
      after: afterDedup,
      removed: beforeCount - afterFilter,
      deduplicated: afterFilter - afterDedup,
    };
  } catch (error) {
    console.error('[Compaction] Error during compaction:', error);
    return { before: 0, after: 0, removed: 0, deduplicated: 0 };
  }
}

/**
 * Check if compaction is needed
 */
export async function shouldCompact(): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return false;

    const allRecords = await table
      .search(Array.from({ length: EMBEDDING_DIM }, () => 0))
      .limit(10000)
      .toArray();

    if (allRecords.length === 0) return false;

    const now = Date.now();
    let expiredCount = 0;
    let noisyCount = 0;
    let legacyColumnCount = 0;

    for (const r of allRecords) {
      if (r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now) {
        expiredCount++;
      }
      if (r.importance < MIN_IMPORTANCE) {
        noisyCount++;
      }
      if ('revision' in r || 'stability' in r || 'supports' in r) {
        legacyColumnCount++;
      }
    }

    const totalWaste = expiredCount + noisyCount;
    const wasteRatio = totalWaste / allRecords.length;

    // Compact if > 20% waste, > 1000 records, or legacy v2 fields are still
    // present and need a schema rewrite.
    const shouldCompact = wasteRatio > 0.2 || allRecords.length > 1000 || legacyColumnCount > 0;

    if (shouldCompact) {
      console.log(`[Compaction] Compaction recommended: ${totalWaste}/${allRecords.length} waste (${(wasteRatio * 100).toFixed(1)}%), ${legacyColumnCount} legacy rows`);
    }

    return shouldCompact;

  } catch (error) {
    console.error('[Compaction] Error checking compaction:', error);
    return false;
  }
}

/**
 * Clean up backup files from previous compaction attempts
 */
export async function cleanupBackupFiles(): Promise<number> {
  const memoryDir = process.env.MEMORY_DIR || './memory';
  let removed = 0;

  try {
    const { readdir, unlink } = await import('fs/promises');
    const { resolve } = await import('path');

    const files = await readdir(memoryDir);

    for (const file of files) {
      // Remove .corrupted and .bak files/directories
      if (file.includes('.corrupted') || file.endsWith('.bak')) {
        const fullPath = resolve(memoryDir, file);
        console.log(`[Cleanup] Removing backup: ${file}`);

        try {
          // Try to remove as file first, then as directory
          await unlink(fullPath).catch(async () => {
            const { rm } = await import('fs/promises');
            await rm(fullPath, { recursive: true, force: true });
          });
          removed++;
        } catch (err) {
          console.warn(`[Cleanup] Failed to remove ${file}:`, err);
        }
      }
    }

    if (removed > 0) {
      console.log(`[Cleanup] Removed ${removed} backup files/directories`);
    }

    return removed;

  } catch (error) {
    console.error('[Cleanup] Failed to clean backup files:', error);
    return 0;
  }
}