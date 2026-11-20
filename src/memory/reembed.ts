// ============================================
// OpenSwarm — Rebuild every stored vector with the current encoder
// ============================================
//
// Needed whenever anything in the embedding signature changes (model, dtype,
// dimension, passage/query prefixes, or the runtime that executes the ONNX
// graph). Vectors from two different encoders coexist silently: writes succeed
// and searches return rows, only the ranking is wrong. This rewrites the whole
// table batch by batch, following compaction's build-then-swap shape: a failure
// while building leaves the live table untouched. The swap itself is an
// overwrite followed by appends, so a failure during it can leave the live
// table partly written — the complete replacement is then kept as
// `<table>_reembed_<ms>` for recovery.

import { join } from 'node:path';
import { withFileLock } from '../support/fileLock.js';
import { c, status } from '../support/colors.js';
import {
  EMBEDDING_DIM,
  MEMORY_DIR,
  embedPassage,
  getDb,
  getTable,
  initDatabase,
  normalizeRecords,
  setTable,
  type CognitiveMemoryRecord,
} from './memoryCore.js';
import {
  embeddingSignature,
  embeddingTextFor,
  resolveEmbeddingConfig,
  writeStoredSignature,
} from './embeddingConfig.js';

export interface ReembedResult {
  total: number;
  /** Rows whose vector was recomputed from text. */
  reembedded: number;
  /** Rows with no title and no content — nothing to encode, zero vector written. */
  empty: number;
  signature: string;
}

export interface ReembedOptions {
  memoryDir?: string;
  /** Progress callback, invoked every `progressEvery` records. */
  onProgress?: (done: number, total: number) => void;
  progressEvery?: number;
  /** Rows read, encoded and written per batch. Defaults to REEMBED_BATCH_SIZE. */
  batchSize?: number;
}

/** Rows held in memory at once while re-embedding. */
export const REEMBED_BATCH_SIZE = 1_000;

export async function reembedMemoryTable(options: ReembedOptions = {}): Promise<ReembedResult> {
  const memoryDir = options.memoryDir ?? MEMORY_DIR;
  const lockPath = join(memoryDir, '.reembed.lock');

  return withFileLock(lockPath, async () => {
    await initDatabase();
    const db = getDb();
    const table = getTable();
    if (!db || !table) throw new Error('Memory database is not initialized');

    const spec = resolveEmbeddingConfig();
    const signature = embeddingSignature(spec);
    const progressEvery = options.progressEvery ?? 50;

    const batchSize = Math.max(1, Math.floor(options.batchSize ?? REEMBED_BATCH_SIZE));
    const total = await table.countRows();
    console.log(`${status.info('[Reembed]')} ${c.dim('rebuilding')} ${c.cyan(String(total))} ${c.dim('vectors with')} ${c.yellow(spec.id)}`);

    const targetTableName = table.name;
    const tempTableName = `${targetTableName}_reembed_${Date.now()}`;

    // Build the replacement batch by batch: read `batchSize` rows, encode them,
    // append them to the temp table, and let them go. Holding the whole table in
    // memory exhausted large stores, and a fixed `.limit(1_000_000)` silently
    // truncated anything bigger.
    let tempTable: Awaited<ReturnType<typeof db.openTable>> | null = null;
    let read = 0;
    let reembedded = 0;
    let empty = 0;
    let built = false;
    try {
      for (;;) {
        const page = (await table.query().offset(read).limit(batchSize).toArray()) as unknown as CognitiveMemoryRecord[];
        if (page.length === 0) break;
        // normalizeRecords first so the rewritten table lands on the lean v3 schema,
        // exactly like compaction does; vectors are replaced immediately after.
        const normalized = normalizeRecords(page);
        for (const record of normalized) {
          const text = embeddingTextFor(String(record.title ?? ''), String(record.content ?? ''));
          if (!text) {
            record.vector = Array.from({ length: EMBEDDING_DIM }, () => 0);
            empty++;
          } else {
            record.vector = await embedPassage(text);
            reembedded++;
          }
          const done = reembedded + empty;
          if (done % progressEvery === 0) {
            options.onProgress?.(done, total);
            console.log(`${c.dim(`[Reembed] ${done}/${total}`)}`);
          }
        }
        if (tempTable) {
          await tempTable.add(normalized);
        } else {
          tempTable = await db.createTable(tempTableName, normalized);
        }
        read += page.length;
        if (page.length < batchSize) break;
      }
      if (!tempTable) {
        tempTable = await db.createEmptyTable(tempTableName, await table.schema());
      }

      // The store changed under us, or a page went missing: the replacement is
      // not the table we meant to rewrite, so the live table stays as it is.
      const builtRows = await tempTable.countRows();
      if (read !== total || builtRows !== total) {
        throw new Error(
          `Re-embed refused: source has ${total} rows but ${read} were read and ${builtRows} built; live table left unchanged`,
        );
      }
      built = true;
    } finally {
      if (!built && tempTable) {
        try {
          await db.dropTable(tempTableName);
        } catch (cleanupError) {
          console.warn(`[Reembed] Failed to drop incomplete temporary table ${tempTableName}:`, cleanupError);
        }
      }
    }
    options.onProgress?.(total, total);
    if (!tempTable) throw new Error('Re-embed did not build a replacement table');
    const replacement = tempTable;

    // Copy the validated replacement over the live table, again batch by batch.
    // If this fails partway the temp table is kept so the vectors are recoverable.
    let replaced = false;
    try {
      if (total === 0) {
        await db.createEmptyTable(targetTableName, await table.schema(), { mode: 'overwrite' });
      } else {
        let target: Awaited<ReturnType<typeof db.openTable>> | null = null;
        for (let copied = 0; copied < total; ) {
          // Rows read back from Lance carry Arrow vectors; writing them as-is
          // zeroed embeddings once already (see compaction.store.test.ts), so
          // the copy goes through the same normalisation as the build.
          const page = normalizeRecords(await replacement.query().offset(copied).limit(batchSize).toArray());
          if (page.length === 0) break;
          if (target) {
            await target.add(page);
          } else {
            target = await db.createTable(targetTableName, page, { mode: 'overwrite' });
          }
          copied += page.length;
        }
      }
      const swapped = await db.openTable(targetTableName);
      const swappedRows = await swapped.countRows();
      if (swappedRows !== total) {
        throw new Error(`Re-embed swap wrote ${swappedRows} rows, expected ${total}`);
      }
      setTable(swapped);
      replaced = true;
    } finally {
      if (replaced) {
        try {
          await db.dropTable(tempTableName);
        } catch (cleanupError) {
          console.warn(`[Reembed] Failed to drop temporary table ${tempTableName}:`, cleanupError);
        }
      } else {
        console.warn(`[Reembed] Replacement failed; retained recoverable table ${tempTableName}`);
      }
    }

    // Only claim the new signature once the swap actually succeeded — otherwise the
    // store would advertise vectors it does not have.
    writeStoredSignature(memoryDir, signature);

    console.log(`${status.ok('[Reembed] done')} ${c.dim('records:')} ${c.cyan(String(total))} ${c.dim('signature:')} ${c.yellow(signature)}`);
    return { total, reembedded, empty, signature };
  });
}
