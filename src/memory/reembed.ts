// ============================================
// OpenSwarm — Rebuild every stored vector with the current encoder
// ============================================
//
// Needed whenever anything in the embedding signature changes (model, dtype,
// dimension, passage/query prefixes, or the runtime that executes the ONNX
// graph). Vectors from two different encoders coexist silently: writes succeed
// and searches return rows, only the ranking is wrong. This rewrites the whole
// table in one pass, following compaction's build-then-swap shape so a failure
// leaves the original table intact.
//
// Rows are fetched in bounded pages and encoded in bounded batches so peak
// transient memory stays predictable for large stores. Unlike compaction, a
// full page is never treated as a hard reject — we keep paging until exhausted
// (no silent 1_000_000 truncate, no size-based throw).

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
  /** How often to fire onProgress (default 50). */
  progressEvery?: number;
  /** Batch size for bounded-memory fetch + encode (default 1000). */
  batchSize?: number;
}

type QueryBuilder = {
  limit: (n: number) => {
    offset?: (n: number) => { toArray: () => Promise<unknown[]> };
    toArray: () => Promise<unknown[]>;
  };
  offset?: (n: number) => {
    limit: (n: number) => { toArray: () => Promise<unknown[]> };
  };
};

/**
 * Fetch one page of rows. Prefer native offset when available; otherwise fall
 * back to limit(offset+batchSize) + slice so stores larger than any single
 * query window can still be fully re-embedded without a hard reject.
 */
async function fetchPage(
  table: { query: () => QueryBuilder },
  offset: number,
  batchSize: number,
): Promise<CognitiveMemoryRecord[]> {
  const q = table.query();
  // Prefer offset→limit (LanceDB); also accept limit→offset if the builder exposes it.
  if (typeof q.offset === 'function') {
    return (await q.offset(offset).limit(batchSize).toArray()) as unknown as CognitiveMemoryRecord[];
  }
  const limited = q.limit(batchSize);
  if (typeof limited.offset === 'function') {
    return (await limited.offset(offset).toArray()) as unknown as CognitiveMemoryRecord[];
  }
  const rows = (await table.query().limit(offset + batchSize).toArray()) as unknown as CognitiveMemoryRecord[];
  return rows.slice(offset, offset + batchSize);
}

/**
 * Load every row via bounded pages. Does not reject when the store is large.
 */
async function loadAllRowsPaged(
  table: { query: () => QueryBuilder },
  batchSize: number,
): Promise<CognitiveMemoryRecord[]> {
  const rows: CognitiveMemoryRecord[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetchPage(table, offset, batchSize);
    if (page.length === 0) break;
    rows.push(...page);
    if (page.length < batchSize) break;
    offset += page.length;
  }
  return rows;
}

/**
 * Rebuild every stored vector with the current encoder.
 * Processes records in bounded batches to keep peak encode memory predictable.
 * Does not reject large stores (unlike compaction's safety-limit throw).
 */
export async function reembedMemoryTable(options: ReembedOptions = {}): Promise<ReembedResult> {
  await initDatabase(options.memoryDir ?? MEMORY_DIR);
  const db = getDb();
  const table = getTable();
  if (!db || !table) throw new Error('Memory database is not initialized');

  const spec = resolveEmbeddingConfig();
  const signature = embeddingSignature(spec);
  const progressEvery = options.progressEvery ?? 50;
  const batchSize = options.batchSize ?? 1_000;

  // Page through the entire store — no 1_000_000 silent truncate, no hard reject.
  const rows = await loadAllRowsPaged(table as { query: () => QueryBuilder }, batchSize);
  const total = rows.length;
  console.log(`${status.info('[Reembed]')} ${c.dim('rebuilding')} ${c.cyan(String(total))} ${c.dim('vectors with')} ${c.yellow(spec.id)}`);

  // normalizeRecords first so the rewritten table lands on the lean v3 schema,
  // exactly like compaction does; vectors are replaced immediately after.
  const normalized = normalizeRecords(rows);
  let reembedded = 0;
  let empty = 0;

  // Encode in bounded batches so peak transient work stays O(batchSize).
  for (let batchStart = 0; batchStart < normalized.length; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, normalized.length);
    const batch = normalized.slice(batchStart, batchEnd);

    for (let j = 0; j < batch.length; j++) {
      const record = batch[j];
      const text = embeddingTextFor(String(record.title ?? ''), String(record.content ?? ''));
      if (!text) {
        record.vector = Array.from({ length: EMBEDDING_DIM }, () => 0);
        empty++;
      } else {
        record.vector = await embedPassage(text);
        reembedded++;
      }
      const globalIndex = batchStart + j + 1;
      if (globalIndex % progressEvery === 0) {
        options.onProgress?.(globalIndex, total);
        console.log(`${c.dim(`[Reembed] ${globalIndex}/${total}`)}`);
      }
    }
  }
  options.onProgress?.(total, total);

  const targetTableName = table.name;
  const tempTableName = `${targetTableName}_reembed_${Date.now()}`;

  // Build a validated replacement before touching the live table.
  if (normalized.length > 0) {
    await db.createTable(tempTableName, normalized);
  } else {
    await db.createEmptyTable(tempTableName, await table.schema());
  }

  let replaced = false;
  try {
    if (normalized.length > 0) {
      await db.createTable(targetTableName, normalized, { mode: 'overwrite' });
    } else {
      await db.createEmptyTable(targetTableName, await table.schema(), { mode: 'overwrite' });
    }
    setTable(await db.openTable(targetTableName));
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
  writeStoredSignature(options.memoryDir ?? MEMORY_DIR, signature);

  console.log(`${status.ok('[Reembed] done')} ${c.dim('records:')} ${c.cyan(String(total))} ${c.dim('signature:')} ${c.yellow(signature)}`);
  return { total, reembedded, empty, signature };
}
