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
}

export async function reembedMemoryTable(options: ReembedOptions = {}): Promise<ReembedResult> {
  await initDatabase();
  const db = getDb();
  const table = getTable();
  if (!db || !table) throw new Error('Memory database is not initialized');

  const spec = resolveEmbeddingConfig();
  const signature = embeddingSignature(spec);
  const progressEvery = options.progressEvery ?? 50;

  const rows = (await table.query().limit(1_000_000).toArray()) as unknown as CognitiveMemoryRecord[];
  const total = rows.length;
  console.log(`${status.info('[Reembed]')} ${c.dim('rebuilding')} ${c.cyan(String(total))} ${c.dim('vectors with')} ${c.yellow(spec.id)}`);

  // normalizeRecords first so the rewritten table lands on the lean v3 schema,
  // exactly like compaction does; vectors are replaced immediately after.
  const normalized = normalizeRecords(rows);
  let reembedded = 0;
  let empty = 0;

  for (let i = 0; i < normalized.length; i++) {
    const record = normalized[i];
    const text = embeddingTextFor(String(record.title ?? ''), String(record.content ?? ''));
    if (!text) {
      record.vector = Array.from({ length: EMBEDDING_DIM }, () => 0);
      empty++;
    } else {
      record.vector = await embedPassage(text);
      reembedded++;
    }
    if ((i + 1) % progressEvery === 0) {
      options.onProgress?.(i + 1, total);
      console.log(`${c.dim(`[Reembed] ${i + 1}/${total}`)}`);
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
