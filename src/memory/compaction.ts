// ============================================
// OpenSwarm - Memory Compaction
// ============================================

import { getDb, getTable, initDatabase, PERMANENT_EXPIRY, normalizeRecords, setTable } from './memoryCore.js';
import type { CognitiveMemoryRecord } from './memoryCore.js';
import { isTransientReviewRejectionMemory } from './memoryFilters.js';

const MIN_IMPORTANCE = 0.1;
const CONSOLIDATION_SIMILARITY = 0.85;

/** Page size for full-table scans: a single `.limit(100_000)` truncates larger stores. */
const PAGE_SIZE = 10_000;

/** v2 columns that force a compaction rewrite to the lean v3 schema. */
const LEGACY_SCHEMA_COLUMNS: Record<string, true> = {
  revisionCount: true,
  decay: true,
  stability: true,
  contradicts: true,
  supports: true,
};

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
 * Records are bucketed by a stable hash of their non-vector identity fields
 * (repo, type, derivedFrom, canonical metadata) before merging, so duplicates
 * that straddle a pagination boundary still land in the same bucket and are
 * compared. Within a bucket, records are ranked by importance then recency and
 * a record is dropped only when it is a near-duplicate of an already-kept one —
 * so the survivor does not depend on the order the pages were read in.
 */
export function removeDuplicates(records: CognitiveMemoryRecord[]): CognitiveMemoryRecord[] {
  // 1. Bucket by identity BEFORE any merging so cross-page duplicates meet.
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

  // 2. Reduce each bucket, dropping only near-duplicates of a kept record.
  for (const bucket of buckets.values()) {
    // Rank by quality so the survivor of a near-duplicate cluster does not
    // depend on input order (and therefore not on page order either).
    bucket.sort(
      (a, b) => b.importance - a.importance || b.lastUpdated - a.lastUpdated
    );

    const kept: CognitiveMemoryRecord[] = [];

    for (const record of bucket) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);

      // Identity fields must match for vectors to be comparable at all, and the
      // bucket key is exactly those fields — so comparing within the bucket is
      // equivalent to the old whole-table scan, minus the page-order dependence.
      const isDuplicate = kept.some(
        (existing) => cosineSimilarity(record.vector, existing.vector) >= CONSOLIDATION_SIMILARITY
      );
      if (isDuplicate) continue;

      kept.push(record);
      unique.push(record);
    }
  }

  return unique;
}

/**
 * Order-independent hash (FNV-1a over canonical JSON) used as the dedup key.
 * The JSON length is mixed into the result so distinct inputs that collide on
 * the 32-bit hash remain separable in practice.
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
 * Decide whether a raw Lance row survives compaction.
 *
 * Lance hands back schema-erased rows, so the fields this decision reads are
 * validated here and the result is a type predicate — the caller then works
 * with a validated CognitiveMemoryRecord instead of re-asserting the shape.
 */
function isValidCompactionRow(row: unknown, now: number): row is CognitiveMemoryRecord {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Partial<CognitiveMemoryRecord>;
  if (typeof r.id !== 'string') return false;
  // `init` is the schema seed row: always retained, never a merge candidate.
  if (r.id === 'init') return true;

  // Remove transient infrastructure failures that were previously stored as
  // high-importance reviewer constraints.
  if (isTransientReviewRejectionMemory(r)) return false;

  // Remove if expired, or if unimportant.
  if (typeof r.expiresAt === 'number' && r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now) return false;
  if (typeof r.importance === 'number' && r.importance < MIN_IMPORTANCE) return false;

  return true;
}

/**
 * Compact memory table by removing expired/unimportant/noisy records,
 * deduplicating similar memories, and rewriting to the lean v3 schema.
 *
 * Reads records in offset/limit pages rather than one capped query, then
 * deduplicates the full set so duplicates straddling a page boundary are
 * still compared.
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

    // 1. Read all records across pagination boundaries. Lance returns
    //    schema-erased rows here; `unknown` keeps the boundary honest until
    //    the per-row filter below narrows the fields it actually reads.
    const allRecords: unknown[] = [];
    for (;;) {
      const page = await table.query().limit(PAGE_SIZE).offset(allRecords.length).toArray();
      if (page.length === 0) break;
      allRecords.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const beforeCount = allRecords.length;
    console.log(`[Compaction] Found ${beforeCount} records`);

    if (beforeCount === 0) {
      console.log('[Compaction] No records to compact');
      return { before: 0, after: 0, removed: 0, deduplicated: 0 };
    }

    // 2. Filter valid records
    const now = Date.now();
    const validRecords = allRecords.filter(
      (row): row is CognitiveMemoryRecord => isValidCompactionRow(row, now)
    );

    const afterFilter = validRecords.length;
    console.log(`[Compaction] After filtering: ${afterFilter} records (removed ${beforeCount - afterFilter})`);

    // 3. Deduplicate the whole set so cross-page duplicates are caught.
    const deduplicated = removeDuplicates(validRecords);
    const afterDedup = deduplicated.length;
    console.log(`[Compaction] After deduplication: ${afterDedup} records (merged ${afterFilter - afterDedup})`);

    // 4. Validate replacement before touching the live table
    const normalized = normalizeRecords(deduplicated);
    const targetTableName = table.name;
    const tempTableName = `${targetTableName}_compact_${Date.now()}`;

    console.log(`[Compaction] Creating validated replacement for ${targetTableName}...`);
    if (normalized.length > 0) {
      await db.createTable(tempTableName, normalized);
    } else {
      await db.createEmptyTable(tempTableName, await table.schema());
    }

    let replaced = false;
    try {
      console.log(`[Compaction] Replacing ${targetTableName} with compacted data...`);
      if (normalized.length > 0) {
        await db.createTable(targetTableName, normalized, { mode: 'overwrite' });
      } else {
        await db.createEmptyTable(targetTableName, await table.schema(), { mode: 'overwrite' });
      }
      const newTable = await db.openTable(targetTableName);
      setTable(newTable);
      replaced = true;
    } finally {
      if (replaced) {
        try {
          await db.dropTable(tempTableName);
        } catch (cleanupError) {
          console.warn(`[Compaction] Failed to drop temporary table ${tempTableName}:`, cleanupError);
        }
      } else {
        console.warn(`[Compaction] Replacement failed; retained recoverable table ${tempTableName}`);
      }
    }

    const stats = {
      before: beforeCount,
      after: afterDedup,
      removed: beforeCount - afterDedup,
      deduplicated: afterFilter - afterDedup,
    };

    console.log('[Compaction] Complete:', stats);
    return stats;

  } catch (error) {
    console.error('[Compaction] Failed:', error);
    throw error;
  }
}

/**
 * Check if compaction is needed based on table size and waste ratio.
 */
export async function shouldCompact(): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return false;

    // Bounded total via countRows — never a full-table load.
    const totalRows = await table.countRows();
    if (totalRows === 0) return false;

    // Waste is estimated from the first page only; a full scan here would
    // cost as much as the compaction this check is trying to avoid.
    const sample = await table.query().limit(PAGE_SIZE).toArray();

    const now = Date.now();

    // Count expired/noisy records
    let expiredCount = 0;
    let noisyCount = 0;

    for (const row of sample) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Partial<CognitiveMemoryRecord>;
      if (r.id === 'init') continue;
      if (typeof r.expiresAt === 'number' && r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now) expiredCount++;
      if (isTransientReviewRejectionMemory(r)) noisyCount++;
    }

    const totalWaste = expiredCount + noisyCount;
    const wasteRatio = sample.length > 0 ? totalWaste / sample.length : 0;

    // Legacy v2 columns live in the schema, not in row values, so detect them
    // there — a v2 table needs the rewrite regardless of its waste ratio.
    const schema = await table.schema();
    const legacyColumnCount = schema.fields.filter(
      (field) => LEGACY_SCHEMA_COLUMNS[field.name] === true
    ).length;

    // Compact if > 20% waste, > 1000 records, or legacy v2 fields are still
    // present and need a schema rewrite.
    const shouldCompact = wasteRatio > 0.2 || totalRows > 1000 || legacyColumnCount > 0;

    if (shouldCompact) {
      console.log(`[Compaction] Compaction recommended: ${totalWaste}/${sample.length} sampled waste (${(wasteRatio * 100).toFixed(1)}% of ${totalRows} rows), ${legacyColumnCount} legacy columns`);
    }

    return shouldCompact;

  } catch (error) {
    console.error('[Compaction] shouldCompact check failed:', error);
    return false;
  }
}

/**
 * Clean up backup and corrupted memory files
 */
export async function cleanupBackupFiles(): Promise<number> {
  const { readdir, unlink } = await import('fs/promises');
  const { resolve } = await import('path');
  const { homedir } = await import('os');

  const memoryDir = resolve(homedir(), '.openswarm/memory');

  try {
    const files = await readdir(memoryDir);
    let removed = 0;

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
