// ============================================
// OpenSwarm - Memory Compaction
// ============================================

import {
  getDb,
  getTable,
  initDatabase,
  EMBEDDING_DIM,
  LEGACY_MIGRATION_PAGE_SIZE,
  PERMANENT_EXPIRY,
  normalizeRecords,
  setTable,
  vectorAsNumberArray,
} from './memoryCore.js';
import type { CognitiveMemoryRecord } from './memoryCore.js';
import { isTransientReviewRejectionMemory } from './memoryFilters.js';

const MIN_IMPORTANCE = 0.1;
const CONSOLIDATION_SIMILARITY = 0.85;

/**
 * Page size for the compaction scan.
 *
 * The scan must be paged rather than one `.search().limit(N)` query: a single
 * query silently truncates at N and, once a vector index exists, returns an
 * approximate candidate set instead of every row.
 */
const COMPACTION_SCAN_PAGE_SIZE = LEGACY_MIGRATION_PAGE_SIZE;

/**
 * Ceiling on the records one compaction may rewrite.
 *
 * Survivors cannot be streamed: compaction replaces the table with a single
 * `createTable(..., { mode: 'overwrite' })` built from the deduplicated set, and
 * this client has no table rename, so the whole survivor set has to be
 * materialized (≈ EMBEDDING_DIM floats per record). Exceeding this bound refuses
 * the compaction before any mutation rather than truncating the candidate set.
 */
const COMPACTION_MAX_SURVIVORS = 100_000;

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
 * Bucket key for duplicate candidates.
 *
 * Mirrors the exact-match fields `removeDuplicates` compares before measuring
 * similarity, so bucketing can never pair records the pairwise rule would skip.
 * Keying on the fields that must be identical shrinks the candidate set to
 * plausible duplicates without hashing 768-dim vectors.
 */
function duplicateBucketKey(record: CognitiveMemoryRecord): string {
  return [
    record.repo,
    record.type,
    record.derivedFrom,
    stableMetadata(record.metadata),
  ].join('\u0000');
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
 * Incremental duplicate index.
 *
 * Holds one survivor per duplicate group and accepts records page by page, so a
 * compaction scan never has to materialize the whole table before comparing:
 * candidates only ever meet other candidates from the same bucket. Records
 * arrive in table order and survivors keep that order, which is what
 * `removeDuplicates` (its single-shot wrapper) used to produce by rescanning
 * every survivor for each record.
 */
function createDuplicateAccumulator(): {
  add: (records: CognitiveMemoryRecord[]) => void;
  candidateCount: () => number;
  survivors: () => CognitiveMemoryRecord[];
} {
  const unique: CognitiveMemoryRecord[] = [];
  const uniqueVectors: number[][] = [];
  const seen = new Set<string>();
  const buckets = new Map<string, number[]>();
  let accepted = 0;

  function add(records: CognitiveMemoryRecord[]): void {
    for (const record of records) {
      accepted++;
      // Skip if exact ID already seen
      if (seen.has(record.id)) continue;

      const key = duplicateBucketKey(record);
      const candidates = buckets.get(key);
      const vector = vectorAsNumberArray(record.vector);

      // Only same-bucket survivors can match: the bucket key is exactly the set
      // of fields the similarity rule requires to be equal.
      let duplicateOf = -1;
      for (const index of candidates ?? []) {
        if (cosineSimilarity(vector, uniqueVectors[index]) >= CONSOLIDATION_SIMILARITY) {
          duplicateOf = index;
          break;
        }
      }

      if (duplicateOf === -1) {
        buckets.set(key, [...(candidates ?? []), unique.length]);
        unique.push(record);
        uniqueVectors.push(vector);
        seen.add(record.id);
        continue;
      }

      // Keep the one with higher importance or more recent
      const existing = unique[duplicateOf];
      if (record.importance > existing.importance ||
          record.lastUpdated > existing.lastUpdated) {
        unique[duplicateOf] = record;
        uniqueVectors[duplicateOf] = vector;
        seen.add(record.id);
      }
    }
  }

  return { add, candidateCount: () => accepted, survivors: () => unique };
}

/**
 * Remove duplicate memories based on vector similarity
 */
export function removeDuplicates(records: CognitiveMemoryRecord[]): CognitiveMemoryRecord[] {
  const accumulator = createDuplicateAccumulator();
  accumulator.add(records);
  return accumulator.survivors();
}

/**
 * Compact memory table by removing expired/unimportant/noisy records,
 * deduplicating similar memories, and rewriting to the lean v3 schema.
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

    // 1. Stream records page by page.
    //
    // One `.search().limit(100_000)` query was wrong twice over: it silently
    // truncated larger stores (compaction then rewrote the table with only the
    // rows it happened to see) and, once a vector index exists, it returns an
    // approximate candidate set rather than the table. A scalar `query()` scan
    // with offset paging is complete and index-independent; deduplication runs
    // on each page but keeps its state across pages, so a duplicate pair split
    // by a page boundary is still merged.
    const now = Date.now();
    const accumulator = createDuplicateAccumulator();
    let beforeCount = 0;
    let afterFilter = 0;
    let offset = 0;

    for (;;) {
      const page = await table.query().offset(offset).limit(COMPACTION_SCAN_PAGE_SIZE).toArray();
      if (page.length === 0) break;

      beforeCount += page.length;

      // 2. Filter valid records
      const validPage = (page as CognitiveMemoryRecord[]).filter((r) => {
        if (r.id === 'init') return true;

        // Remove transient infrastructure failures that were previously stored as
        // high-importance reviewer constraints.
        if (isTransientReviewRejectionMemory(r)) return false;

        // Remove if expired
        if (Number(r.expiresAt) < PERMANENT_EXPIRY && Number(r.expiresAt) < now) return false;

        // Remove if unimportant
        if (Number(r.importance) < MIN_IMPORTANCE) return false;

        return true;
      });

      afterFilter += validPage.length;
      accumulator.add(validPage);

      if (accumulator.candidateCount() > COMPACTION_MAX_SURVIVORS) {
        throw new Error(
          `Memory compaction refused: more than ${COMPACTION_MAX_SURVIVORS} candidate records; ` +
          'the replacement table cannot be built incrementally',
        );
      }

      offset += page.length;
      if (page.length < COMPACTION_SCAN_PAGE_SIZE) break;
    }

    console.log(`[Compaction] Found ${beforeCount} records`);

    if (beforeCount === 0) {
      console.log('[Compaction] No records to compact');
      return { before: 0, after: 0, removed: 0, deduplicated: 0 };
    }

    console.log(`[Compaction] After filtering: ${afterFilter} records (removed ${beforeCount - afterFilter})`);

    // 3. Deduplicate (across page boundaries — see the accumulator)
    const deduplicated = accumulator.survivors();
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
 * Check if compaction is needed based on heuristics
 */
export async function shouldCompact(): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return false;

    const allRecords = await table
      .search(Array.from({ length: EMBEDDING_DIM }, () => 0))
      .limit(100000)
      .toArray();

    const now = Date.now();

    // Count expired/noisy records
    let expiredCount = 0;
    let noisyCount = 0;
    let legacyColumnCount = 0;

    for (const r of allRecords) {
      if (r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now) expiredCount++;
      if (isTransientReviewRejectionMemory(r)) noisyCount++;
      if ('revisionCount' in r || 'decay' in r || 'stability' in r || 'contradicts' in r || 'supports' in r) {
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
