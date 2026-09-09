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

  if (normA === 0 || normB === 0) return 0;

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

const LEGACY_SCHEMA_COLUMNS = new Set([
  'embedding', 'v2_metadata', 'v2_tags', 'v2_category',
]);

/**
 * Remove duplicate records using exact cosine similarity on all candidates
 * — not lossy LSH band match — so all candidates are evaluated precisely.
 */
export function removeDuplicates(records: CognitiveMemoryRecord[]): CognitiveMemoryRecord[] {
  const unique: CognitiveMemoryRecord[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    // Skip if exact ID already seen
    if (seen.has(record.id)) continue;

    // Check similarity with existing unique records
    let isDuplicate = false;
    for (const existing of unique) {
      if (
        record.repo !== existing.repo ||
        record.type !== existing.type ||
        record.derivedFrom !== existing.derivedFrom ||
        stableMetadata(record.metadata) !== stableMetadata(existing.metadata)
      ) {
        continue;
      }

      // Exact cosine similarity on normalized vectors — not lossy LSH band match
      const similarity = cosineSimilarity(record.vector, existing.vector);

      if (similarity >= CONSOLIDATION_SIMILARITY) {
        // Keep the one with higher importance or more recent
        if (record.importance > existing.importance ||
            record.lastUpdated > existing.lastUpdated) {
          // Replace existing with current
          const index = unique.indexOf(existing);
          unique[index] = record;
          seen.add(record.id);
        }
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      unique.push(record);
      seen.add(record.id);
    }
  }

  return unique;
}

/**
 * Compact memory table by removing expired/unimportant/noisy records,
 * deduplicating similar memories, and rewriting to the lean v3 schema.
 *
 * Uses paginated scanning to keep memory bounded — never loads the full
 * table into a single toArray() call before deduplication.
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

    // 1. Count total records via countRows (bounded, no full load)
    const beforeCount = await table.countRows();
    console.log(`[Compaction] Found ${beforeCount} records`);

    if (beforeCount === 0) {
      console.log('[Compaction] No records to compact');
      return { before: 0, after: 0, removed: 0, deduplicated: 0 };
    }

    // 2. Paginated scan: process records in batches to keep memory bounded
    const PAGE_SIZE = 10_000;
    const allValid: CognitiveMemoryRecord[] = [];
    const now = Date.now();
    let offset = 0;
    let totalRead = 0;

    while (true) {
      const page = await table
        .query()
        .limit(PAGE_SIZE)
        .offset(offset)
        .toArray();

      if (page.length === 0) break;
      totalRead += page.length;

      // Filter valid records within each page
      for (const r of page) {
        if (r.id === 'init') {
          allValid.push(r as CognitiveMemoryRecord);
          continue;
        }

        // Remove transient infrastructure failures
        if (isTransientReviewRejectionMemory(r)) continue;

        // Remove if expired
        if (r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now) continue;

        // Remove if unimportant
        if (r.importance < MIN_IMPORTANCE) continue;

        allValid.push(r as CognitiveMemoryRecord);
      }

      offset += page.length;
    }

    const afterFilter = allValid.length;
    console.log(`[Compaction] After filtering: ${afterFilter} records (removed ${beforeCount - afterFilter})`);

    if (afterFilter === 0) {
      console.log('[Compaction] No valid records after filtering');
      return { before: beforeCount, after: 0, removed: beforeCount, deduplicated: 0 };
    }

    // 3. Deduplicate using exact cosine similarity on all candidates
    const deduplicated = removeDuplicates(allValid);
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
      await db.createTable(tempTableName, []);
    }

    // 5. Swap tables atomically: use db.dropTable() (not table.drop()) for
    //    LanceDB compatibility — Table.drop() does not exist on the type.
    await setTable(null);
    await db.dropTable(targetTableName);
    const newTable = await db.openTable(tempTableName);
    await setTable(newTable);

    console.log(`[Compaction] Complete: ${beforeCount} -> ${afterDedup} records`);
    return {
      before: beforeCount,
      after: afterDedup,
      removed: beforeCount - afterFilter,
      deduplicated: afterFilter - afterDedup,
    };

  } catch (error) {
    console.error('[Compaction] Failed:', error);
    return { before: 0, after: 0, removed: 0, deduplicated: 0 };
  }
}

/**
 * Check if compaction should run based on table size and waste ratio.
 */
export async function shouldCompact(): Promise<boolean> {
  try {
    await initDatabase();
    const table = getTable();
    if (!table) return false;

    // Use countRows for total count (bounded, no full load)
    const totalRows = await table.countRows();
    if (totalRows === 0) return false;

    // Sample-based waste estimation: scan first 10k records
    const sample = await table.query().limit(10_000).toArray();
    const now = Date.now();
    let totalWaste = 0;

    for (const r of sample) {
      if (r.id === 'init') continue;
      if (isTransientReviewRejectionMemory(r)) { totalWaste++; continue; }
      if (r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now) { totalWaste++; continue; }
      if (r.importance < MIN_IMPORTANCE) { totalWaste++; continue; }
    }

    const wasteRatio = totalRows <= 10_000
      ? totalWaste / totalRows
      : totalWaste / sample.length;

    // Check for legacy v2 columns
    const schema = await table.schema();
    const legacyColumnCount = schema.fields.filter(
      (f: any) => LEGACY_SCHEMA_COLUMNS.has(f.name)
    ).length;

    // Compact if > 20% waste, > 1000 records, or legacy v2 fields are still
    // present and need a schema rewrite.
    const shouldCompact = wasteRatio > 0.2 || totalRows > 1000 || legacyColumnCount > 0;

    console.log(`[Compaction] Check: ${totalRows} rows, ${(wasteRatio * 100).toFixed(1)}% waste, ${legacyColumnCount} legacy columns → ${shouldCompact ? 'compact' : 'skip'}`);
    return shouldCompact;
  } catch (error) {
    console.error('[Compaction] Check error:', error);
    return false;
  }
}

/**
 * Clean up backup files from previous compaction runs
 */
export async function cleanupBackupFiles(): Promise<number> {
  try {
    const { readdir, unlink } = await import('fs/promises');
    const path = await import('path');
    const os = await import('os');
    const tmpDir = os.tmpdir();

    const files = await readdir(tmpDir);
    let removed = 0;

    for (const file of files) {
      if (file.startsWith('memory_backup_') || file.startsWith('memory_compact_')) {
        const fullPath = path.join(tmpDir, file);
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