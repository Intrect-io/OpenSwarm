// ============================================
// OpenSwarm - Memory Compaction
// ============================================

import { getDb, getTable, initDatabase, EMBEDDING_DIM, PERMANENT_EXPIRY, normalizeRecords } from './memoryCore.js';
import type { CognitiveMemoryRecord } from './memoryCore.js';

const ARCHIVE_THRESHOLD = 0.7;
const MIN_IMPORTANCE = 0.1;
const CONSOLIDATION_SIMILARITY = 0.85;

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
 * Remove duplicate memories based on vector similarity
 */
function removeDuplicates(records: CognitiveMemoryRecord[]): CognitiveMemoryRecord[] {
  const unique: CognitiveMemoryRecord[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    // Skip if exact ID already seen
    if (seen.has(record.id)) continue;

    // Check similarity with existing unique records
    let isDuplicate = false;
    for (const existing of unique) {
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
 * Compact memory table by removing expired/decayed/unimportant records
 * and deduplicating similar memories
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

    // 1. Read all records
    const allRecords = await table
      .search(Array.from({ length: EMBEDDING_DIM }, () => 0))
      .limit(100000)
      .toArray();

    const beforeCount = allRecords.length;
    console.log(`[Compaction] Found ${beforeCount} records`);

    if (beforeCount === 0) {
      console.log('[Compaction] No records to compact');
      return { before: 0, after: 0, removed: 0, deduplicated: 0 };
    }

    // 2. Filter valid records
    const now = Date.now();
    const validRecords = allRecords.filter((r: any) => {
      // Keep if permanent (expiresAt >= PERMANENT_EXPIRY)
      if (r.expiresAt >= PERMANENT_EXPIRY) return true;

      // Remove if expired
      if (r.expiresAt < now) return false;

      // Remove if too decayed
      if (r.decay >= ARCHIVE_THRESHOLD) return false;

      // Remove if unimportant
      if (r.importance < MIN_IMPORTANCE) return false;

      return true;
    });

    const afterFilter = validRecords.length;
    console.log(`[Compaction] After filtering: ${afterFilter} records (removed ${beforeCount - afterFilter})`);

    // 3. Deduplicate
    const deduplicated = removeDuplicates(validRecords as CognitiveMemoryRecord[]);
    const afterDedup = deduplicated.length;
    console.log(`[Compaction] After deduplication: ${afterDedup} records (merged ${afterFilter - afterDedup})`);

    // 4. Drop and recreate table
    console.log('[Compaction] Dropping old table...');
    await db.dropTable('cognitive_memory');

    console.log('[Compaction] Creating new table with compacted data...');
    const normalized = normalizeRecords(deduplicated);
    await db.createTable('cognitive_memory', normalized);

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

    // Count expired/decayed records
    let expiredCount = 0;
    let decayedCount = 0;

    for (const r of allRecords) {
      if (r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now) expiredCount++;
      if (r.decay >= ARCHIVE_THRESHOLD) decayedCount++;
    }

    const totalWaste = expiredCount + decayedCount;
    const wasteRatio = totalWaste / allRecords.length;

    // Compact if > 20% waste or > 1000 records
    const shouldCompact = wasteRatio > 0.2 || allRecords.length > 1000;

    if (shouldCompact) {
      console.log(`[Compaction] Compaction recommended: ${totalWaste}/${allRecords.length} waste (${(wasteRatio * 100).toFixed(1)}%)`);
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
