// ============================================
// OpenSwarm — Rebuild every stored vector with the current encoder
// ============================================
//
// Needed whenever anything in the embedding signature changes (model, dtype,
// dimension, passage/query prefixes, or the runtime that executes the ONNX
// graph). Vectors from two different encoders coexist silently: writes succeed
// and searches return rows, only the ranking is wrong. This rewrites the whole
// table batch by batch, following compaction's build-then-swap shape:
//
// - The whole build and swap runs under the cross-process memory mutation
//   lock, so writers in other processes (reviewer subprocesses, the daemon)
//   wait instead of committing a row the swap would silently discard. Right
//   before the swap the source is re-read through a freshly opened handle and
//   the swap is refused if its version or row count moved anyway.
// - A failure while building leaves the live table untouched and drops the
//   temp table.
// - LanceDB (0.22) has no streaming single-commit overwrite, so the swap is an
//   overwrite followed by appends. Before it starts, a marker file naming the
//   complete `<table>_reembed_<ms>` replacement is written durably; it is
//   cleared only after the swapped table is verified. A later run that finds
//   the marker, or any leftover `_reembed_` table, refuses and says how to
//   recover instead of building on a possibly partial live table.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { makeArrowTable } from '@lancedb/lancedb';
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
  withCrossProcessMemoryMutationLock,
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
  /** Base delay before retrying a failed encode; doubled per retry. */
  embedRetryDelayMs?: number;
}

/** Rows held in memory at once while re-embedding. */
export const REEMBED_BATCH_SIZE = 1_000;

/** Extra attempts per row after the first encode failure. */
export const REEMBED_EMBED_RETRIES = 2;

/** Marker naming the replacement table while a swap is in progress. */
export const REEMBED_SWAP_MARKER = '.reembed-swap.json';

export interface ReembedSwapMarker {
  liveTable: string;
  tempTable: string;
  sourceRows: number;
  sourceVersion: number;
  startedAt: string;
}

function writeMarkerDurably(path: string, marker: ReembedSwapMarker): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, `${JSON.stringify(marker, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function readMarker(path: string): ReembedSwapMarker | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ReembedSwapMarker;
  } catch {
    // An unreadable marker still means a swap was started; refuse all the same.
    return { liveTable: '?', tempTable: '?', sourceRows: -1, sourceVersion: -1, startedAt: '?' };
  }
}

/**
 * Refuse to start while an earlier run's swap is unfinished or its temp table
 * is still around: building on top of either could discard the only complete
 * copy of the vectors.
 */
function assertNoInterruptedRun(markerPath: string, liveTable: string, tableNames: string[]): void {
  const marker = readMarker(markerPath);
  if (marker) {
    throw new Error(
      `Re-embed refused: an earlier swap into '${marker.liveTable}' was interrupted (started ${marker.startedAt}). ` +
      `The live table may be missing rows; the complete replacement is table '${marker.tempTable}' ` +
      `(${marker.sourceRows} rows; the live table was at version ${marker.sourceVersion} before the swap). ` +
      `Restore by copying '${marker.tempTable}' over '${marker.liveTable}' (or restoring '${marker.liveTable}' to ` +
      `version ${marker.sourceVersion}), then drop '${marker.tempTable}' and delete ${markerPath}.`,
    );
  }
  const orphans = tableNames.filter((name) => name.startsWith(`${liveTable}_reembed_`));
  if (orphans.length > 0) {
    throw new Error(
      `Re-embed refused: leftover table(s) ${orphans.join(', ')} from an earlier re-embed. No swap marker exists, ` +
      `so the live table '${liveTable}' was not being replaced. Drop the leftover table(s) and run again.`,
    );
  }
}

/** Lean v3 schema with the current vector width, inferred the same way record writes infer it. */
function leanSchema() {
  const placeholder = normalizeRecords([{ id: 'schema', type: 'belief', vector: new Array(EMBEDDING_DIM).fill(0) }]);
  return makeArrowTable(placeholder as unknown as Record<string, unknown>[]).schema;
}

async function embedWithRetry(text: string, baseDelayMs: number): Promise<number[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await embedPassage(text);
    } catch (error) {
      if (attempt >= REEMBED_EMBED_RETRIES) throw error;
      const delay = baseDelayMs * 2 ** attempt;
      console.warn(`[Reembed] encode failed (attempt ${attempt + 1}/${REEMBED_EMBED_RETRIES + 1}) — retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

type Db = NonNullable<ReturnType<typeof getDb>>;
type LanceTable = Awaited<ReturnType<Db['openTable']>>;

/** Overwrite the live table with the replacement, one batch per commit. */
async function copyReplacementOver(
  db: Db,
  replacement: LanceTable,
  targetTableName: string,
  total: number,
  batchSize: number,
): Promise<void> {
  if (total === 0) {
    await db.createEmptyTable(targetTableName, leanSchema(), { mode: 'overwrite' });
    return;
  }
  let target: LanceTable | null = null;
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

export async function reembedMemoryTable(options: ReembedOptions = {}): Promise<ReembedResult> {
  const memoryDir = options.memoryDir ?? MEMORY_DIR;
  const markerPath = join(memoryDir, REEMBED_SWAP_MARKER);

  // Initialise outside the lock: nothing inside may take it again (the file
  // lock is not reentrant for this process).
  await initDatabase();
  return withCrossProcessMemoryMutationLock(async () => {
    const db = getDb();
    const current = getTable();
    if (!db || !current) throw new Error('Memory database is not initialized');
    const targetTableName = current.name;
    assertNoInterruptedRun(markerPath, targetTableName, await db.tableNames());

    // A freshly opened handle sees the latest committed version; the cached
    // handle may still sit on the snapshot taken when this process opened it.
    const table = await db.openTable(targetTableName);

    const spec = resolveEmbeddingConfig();
    const signature = embeddingSignature(spec);
    const progressEvery = options.progressEvery ?? 50;
    const retryDelayMs = options.embedRetryDelayMs ?? 250;

    const batchSize = Math.max(1, Math.floor(options.batchSize ?? REEMBED_BATCH_SIZE));
    const sourceVersion = await table.version();
    const total = await table.countRows();
    console.log(`${status.info('[Reembed]')} ${c.dim('rebuilding')} ${c.cyan(String(total))} ${c.dim('vectors with')} ${c.yellow(spec.id)}`);

    const tempTableName = `${targetTableName}_reembed_${Date.now()}`;

    // Build the replacement batch by batch: read `batchSize` rows, encode them,
    // append them to the temp table, and let them go. Holding the whole table in
    // memory exhausted large stores, and a fixed `.limit(1_000_000)` silently
    // truncated anything bigger.
    let tempTable: LanceTable | null = null;
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
            record.vector = await embedWithRetry(text, retryDelayMs);
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
        tempTable = await db.createEmptyTable(tempTableName, leanSchema());
      }

      // The store changed under us, or a page went missing: the replacement is
      // not the table we meant to rewrite, so the live table stays as it is.
      const builtRows = await tempTable.countRows();
      if (read !== total || builtRows !== total) {
        throw new Error(
          `Re-embed refused: source has ${total} rows but ${read} were read and ${builtRows} built; live table left unchanged`,
        );
      }
      // Paged reads stay on the start snapshot, so the count check above cannot
      // see a commit made by a writer that ignored the lock. Reopen and compare.
      const fresh = await db.openTable(targetTableName);
      const freshVersion = await fresh.version();
      const freshRows = await fresh.countRows();
      if (freshVersion !== sourceVersion || freshRows !== total) {
        throw new Error(
          `Re-embed refused: source table changed during the run (version ${sourceVersion} -> ${freshVersion}, ` +
          `rows ${total} -> ${freshRows}); live table left unchanged`,
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

    // From here the live table is rewritten in several commits. The marker is
    // what lets a later run notice a swap that never finished.
    writeMarkerDurably(markerPath, {
      liveTable: targetTableName,
      tempTable: tempTableName,
      sourceRows: total,
      sourceVersion,
      startedAt: new Date().toISOString(),
    });

    // Copy the validated replacement over the live table, again batch by batch.
    // If this fails partway the temp table and the marker are kept.
    let swapped: LanceTable;
    try {
      await copyReplacementOver(db, replacement, targetTableName, total, batchSize);
      swapped = await db.openTable(targetTableName);
      const swappedRows = await swapped.countRows();
      if (swappedRows !== total) {
        throw new Error(`Re-embed swap wrote ${swappedRows} rows, expected ${total}`);
      }
    } catch (error) {
      console.warn(
        `[Reembed] Replacement failed; retained recoverable table ${tempTableName} and marker ${markerPath}`,
      );
      throw error;
    }
    setTable(swapped);

    try {
      await db.dropTable(tempTableName);
    } catch (cleanupError) {
      console.warn(`[Reembed] Failed to drop temporary table ${tempTableName}:`, cleanupError);
    }
    unlinkSync(markerPath);

    // Only claim the new signature once the swap actually succeeded — otherwise the
    // store would advertise vectors it does not have.
    writeStoredSignature(memoryDir, signature);

    // The batched overwrite leaves one fragment per batch; compact them. A
    // failure here costs read speed, not data, so it only warns.
    try {
      await swapped.optimize();
    } catch (optimizeError) {
      console.warn(`[Reembed] Failed to optimize ${targetTableName} after the swap:`, optimizeError);
    }

    console.log(`${status.ok('[Reembed] done')} ${c.dim('records:')} ${c.cyan(String(total))} ${c.dim('signature:')} ${c.yellow(signature)}`);
    return { total, reembedded, empty, signature };
  });
}
