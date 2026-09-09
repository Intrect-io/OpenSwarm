/**
 * Persistent Cognitive Memory Module v3.0 - Core
 *
 * Lean repo memory: embedding, storage, save, search.
 */
import { connect, Table, Connection } from '@lancedb/lancedb';
import { pipeline, env as transformersEnv, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { resolve } from 'path';
import { homedir } from 'os';
import { c, status } from '../support/colors.js';
import { safeConsole as console } from '../support/safeLog.js';
import { randomUUID } from 'node:crypto';
import {
  characterGuard,
  embeddingSignature,
  embeddingTextFor,
  modelCacheDir,
  readStoredSignature,
  resolveEmbeddingConfig,
  writeStoredSignature,
  type EmbeddingModelSpec,
} from './embeddingConfig.js';

// Memory storage path
export const MEMORY_DIR = resolve(homedir(), '.openswarm/memory');

// Embedding runs locally (no external service). Model, dtype, dimension and the
// passage/query prefixes are resolved from the environment — see embeddingConfig.ts.
//
// Resolving eagerly keeps EMBEDDING_DIM a plain constant, but a malformed
// OPENSWARM_EMBEDDING_* value must not take down every command that merely imports
// this module (memory is a small corner of the CLI). The failure is deferred to the
// first embedding call, where the message is actionable instead of surfacing as an
// unrelated startup crash.
let embeddingConfigError: Error | null = null;

function resolveSpecDeferringFailure(): EmbeddingModelSpec {
  try {
    return resolveEmbeddingConfig();
  } catch (err) {
    embeddingConfigError = err instanceof Error ? err : new Error(String(err));
    // Return a placeholder so the module can still be imported. The first
    // embedding call will check and throw this error.
    return { model: '', dtype: '', dim: 384, passagePrefix: '', queryPrefix: '' };
  }
}

const spec = resolveSpecDeferringFailure();
export const EMBEDDING_DIM = spec.dim;

// Permanent expiry sentinel (year 2099)
export const PERMANENT_EXPIRY = 4_070_880_000_000;

// ============================================
// Types
// ============================================

export type CognitiveMemoryType =
  | 'fact'
  | 'preference'
  | 'pattern'
  | 'system_pattern'
  | 'user_model'
  | 'constraint'
  | 'task_outcome'
  | 'audit_finding'
  | 'contradiction'
  | 'concept';

export type LegacyMemoryType =
  | 'observation'
  | 'decision'
  | 'preference'
  | 'pattern'
  | 'system_pattern'
  | 'user_model'
  | 'constraint'
  | 'task_outcome'
  | 'audit_finding'
  | 'contradiction'
  | 'concept';

export type MemoryType = CognitiveMemoryType | LegacyMemoryType;

export interface CognitiveMemoryRecord {
  id: string;
  type: CognitiveMemoryType;
  content: string;
  vector: number[];
  importance: number;
  confidence: number;
  createdAt: number;
  lastUpdated: number;
  lastAccessed: number;
  derivedFrom: string;
  repo: string;
  title: string;
  metadata: string;
  trust: number;
  expiresAt: number;
}

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  content: string;
  vector: number[];
  importance: number;
  confidence: number;
  createdAt: number;
  lastUpdated: number;
  lastAccessed: number;
  derivedFrom: string;
  repo: string;
  title: string;
  metadata: string;
  trust: number;
  expiresAt: number;
}

export interface MemorySearchResult {
  id: string;
  type: MemoryType;
  content: string;
  importance: number;
  confidence: number;
  createdAt: number;
  lastUpdated: number;
  lastAccessed: number;
  derivedFrom: string;
  repo: string;
  title: string;
  metadata: string;
  trust: number;
  expiresAt: number;
  _distance?: number;
  _similarity?: number;
}

// ============================================
// Constants
// ============================================

const DB_DIR = resolve(homedir(), '.openswarm/memory');
const DB_PATH = resolve(DB_DIR, 'memory.lance');
const DEFAULT_TABLE = 'memories';
const MAX_RECALL_ATTEMPTS = 3;
const RECALL_REPORT_WINDOW_MS = 60_000;
const RECALL_ALSO_SEEN_CAP = 5;

// Legacy schema columns that indicate a migration is needed
const LEGACY_SCHEMA_COLUMNS = new Set([
  'stability', 'accessCount', 'lastAccessTime', 'revision',
]);

// ============================================
// Module-level state
// ============================================

let database: Connection | null = null;
let memoryTable: Table | null = null;
let embeddingPipeline: FeatureExtractionPipeline | null = null;
let pipelineInitFailed = false;
let pipelineInitError: Error | null = null;

interface RecallFailure {
  phase: RecallPhase;
  message: string;
  reportedAt: number;
  suppressedCount: number;
  totalCount: number;
  alsoSeen: Set<string>;
  alsoSeenUnlisted: number;
}

type RecallPhase = 'embedding' | 'query' | 'init';

let recallFailure: RecallFailure | null = null;

// ============================================
// Normalization
// ============================================

export function normalizeRecords(records: any[]): CognitiveMemoryRecord[] {
  return records.map(r => ({
    id: String(r.id ?? randomUUID()),
    type: normalizeType(r.type),
    content: String(r.content ?? ''),
    vector: normalizeVector(r.vector ?? r.embedding),
    importance: clamp01(r.importance, 0.5),
    confidence: clamp01(r.confidence, 0.8),
    createdAt: Number(r.createdAt ?? r.created_at ?? Date.now()),
    lastUpdated: Number(r.lastUpdated ?? r.last_updated ?? Date.now()),
    lastAccessed: Number(r.lastAccessed ?? r.last_accessed ?? Date.now()),
    derivedFrom: String(r.derivedFrom ?? r.derived_from ?? ''),
    repo: String(r.repo ?? ''),
    title: String(r.title ?? ''),
    metadata: typeof r.metadata === 'string' ? r.metadata : JSON.stringify(r.metadata ?? {}),
    trust: clamp01(r.trust, 0.5),
    expiresAt: Number(r.expiresAt ?? r.expires_at ?? PERMANENT_EXPIRY),
  }));
}

function normalizeType(t: unknown): CognitiveMemoryType {
  const valid: Set<string> = new Set([
    'fact', 'preference', 'pattern', 'system_pattern', 'user_model',
    'constraint', 'task_outcome', 'audit_finding', 'contradiction', 'concept',
  ]);
  const s = String(t ?? 'fact');
  return valid.has(s) ? (s as CognitiveMemoryType) : 'fact';
}

function normalizeVector(v: unknown): number[] {
  if (!Array.isArray(v)) return Array.from({ length: EMBEDDING_DIM }, () => 0);
  if (v.length === EMBEDDING_DIM) return v.map(Number);
  if (v.length > EMBEDDING_DIM) return v.slice(0, EMBEDDING_DIM).map(Number);
  return [...v.map(Number), ...Array.from({ length: EMBEDDING_DIM - v.length }, () => 0)];
}

export function clamp01(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export function safeParseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return {};
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function normalizedL2DistanceToSimilarity(distance: unknown): number {
  const d = Number(distance);
  if (!Number.isFinite(d)) return 0;
  // LanceDB returns L2 distance; convert to [0,1] similarity
  return 1 / (1 + d);
}

// ============================================
// Database Initialization
// ============================================

export async function initDatabase(): Promise<void> {
  if (database) return;
  try {
    database = await connect(DB_PATH);
    const tableNames = await database.tableNames();
    if (tableNames.includes(DEFAULT_TABLE)) {
      memoryTable = await database.openTable(DEFAULT_TABLE);
      // Migrate legacy schema if needed (handles datasets of any size via
      // cursor-based pagination — see migrateLeanSchemaIfNeeded).
      memoryTable = await migrateLeanSchemaIfNeeded(database, memoryTable);
    } else {
      const now = Date.now();
      memoryTable = await database.createTable(DEFAULT_TABLE, [{
        id: 'init',
        type: 'system_pattern',
        content: 'Cognitive memory system initialized',
        vector: Array.from({ length: EMBEDDING_DIM }, () => 0),
        importance: 0.5,
        confidence: 1.0,
        createdAt: now,
        lastUpdated: now,
        lastAccessed: now,
        derivedFrom: 'system_init',
        repo: 'system',
        title: 'Memory system initialized',
        metadata: '{}',
        trust: 1.0,
        expiresAt: PERMANENT_EXPIRY,
      }]);
    }
  } catch (err) {
    database = null;
    memoryTable = null;
    throw err;
  }
}

export function getTable(): Table | null {
  return memoryTable;
}

// ============================================
// Embedding
// ============================================

export async function embedPassage(text: string): Promise<number[]> {
  if (embeddingConfigError) throw embeddingConfigError;
  const pipeline = await initEmbeddingPipeline();
  const prefixed = `${spec.passagePrefix}${text}`;
  const result = await pipeline(prefixed, { pooling: 'mean', normalize: true });
  const array = Array.from(result.data ?? []) as number[];
  if (array.length !== EMBEDDING_DIM) {
    console.warn(`[Memory] Embedding dimension mismatch: expected ${EMBEDDING_DIM}, got ${array.length}`);
    if (array.length > EMBEDDING_DIM) return array.slice(0, EMBEDDING_DIM);
    return [...array, ...Array.from({ length: EMBEDDING_DIM - array.length }, () => 0)];
  }
  return array;
}

export async function embedQuery(text: string): Promise<number[]> {
  if (embeddingConfigError) throw embeddingConfigError;
  const pipeline = await initEmbeddingPipeline();
  const prefixed = `${spec.queryPrefix}${text}`;
  const result = await pipeline(prefixed, { pooling: 'mean', normalize: true });
  const array = Array.from(result.data ?? []) as number[];
  if (array.length !== EMBEDDING_DIM) {
    if (array.length > EMBEDDING_DIM) return array.slice(0, EMBEDDING_DIM);
    return [...array, ...Array.from({ length: EMBEDDING_DIM - array.length }, () => 0)];
  }
  return array;
}

// ============================================
// Search
// ============================================

export async function searchMemory(
  query: string,
  options?: {
    limit?: number;
    minSimilarity?: number;
    repo?: string;
    type?: CognitiveMemoryType;
  }
): Promise<MemorySearchResult[]> {
  const limit = options?.limit ?? 10;
  const minSimilarity = options?.minSimilarity ?? 0.0;
  const repo = options?.repo;
  const type = options?.type;

  for (let attempt = 1; attempt <= MAX_RECALL_ATTEMPTS; attempt++) {
    try {
      await initDatabase();
      const table = getTable();
      if (!table) return [];

      const vector = await embedQuery(query);
      let queryBuilder = table.search(vector).limit(limit * 3); // Fetch extra for filtering

      // Apply repo filter if specified
      if (repo) {
        const escaped = repo.replace(/'/g, "''");
        queryBuilder = queryBuilder.where(`repo = '${escaped}'`);
      }

      // Apply type filter if specified
      if (type) {
        const escaped = type.replace(/'/g, "''");
        queryBuilder = queryBuilder.where(`type = '${escaped}'`);
      }

      const results = await queryBuilder.toArray();

      // Filter by minimum similarity and map to search result
      return results
        .filter((r: any) => {
          const sim = normalizedL2DistanceToSimilarity(r._distance);
          return sim >= minSimilarity;
        })
        .slice(0, limit)
        .map((r: any) => ({
          id: String(r.id),
          type: r.type as MemoryType,
          content: String(r.content ?? ''),
          importance: clamp01(r.importance, 0.5),
          confidence: clamp01(r.confidence, 0.8),
          createdAt: Number(r.createdAt ?? Date.now()),
          lastUpdated: Number(r.lastUpdated ?? Date.now()),
          lastAccessed: Number(r.lastAccessed ?? Date.now()),
          derivedFrom: String(r.derivedFrom ?? ''),
          repo: String(r.repo ?? ''),
          title: String(r.title ?? ''),
          metadata: typeof r.metadata === 'string' ? r.metadata : JSON.stringify(r.metadata ?? {}),
          trust: clamp01(r.trust, 0.5),
          expiresAt: Number(r.expiresAt ?? PERMANENT_EXPIRY),
          _distance: r._distance,
          _similarity: normalizedL2DistanceToSimilarity(r._distance),
        }));
    } catch (error) {
      const phase: RecallPhase = attempt === 1 ? 'embedding' : 'query';
      reportRecallFailure(error, phase);
      if (attempt < MAX_RECALL_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 100 * attempt));
      } else {
        return [];
      }
    }
  }
  return [];
}

export function memoryRecallStatus(): {
  available: boolean;
  phase?: RecallPhase;
  error?: string;
  suppressedCount?: number;
} {
  if (!recallFailure) return { available: true };
  return {
    available: false,
    phase: recallFailure.phase,
    error: recallFailure.message,
    suppressedCount: recallFailure.suppressedCount,
  };
}

function reportRecallFailure(error: unknown, phase: RecallPhase): void {
  const message = error instanceof Error ? error.message : String(error);
  const now = Date.now();
  const previous = recallFailure;
  if (previous && previous.phase === phase && now - previous.reportedAt < RECALL_REPORT_WINDOW_MS) {
    previous.suppressedCount += 1;
    previous.totalCount += 1;
    if (message !== previous.message && !previous.alsoSeen.has(message)) {
      if (previous.alsoSeen.size < RECALL_ALSO_SEEN_CAP) previous.alsoSeen.add(message);
      else previous.alsoSeenUnlisted += 1;
    }
    return;
  }
  // Only carry the tally when the phase is unchanged. A `query` outage followed
  // by an embedding failure otherwise credits 39 broken queries to a report
  // that was actually about embedding.
  const totalCount = previous && previous.phase === phase ? previous.totalCount + 1 : 1;
  recallFailure = { phase, message, reportedAt: now, suppressedCount: 0, totalCount, alsoSeen: new Set(), alsoSeenUnlisted: 0 };
}

// ============================================
// Memory Operations (Core)
// ============================================

export async function saveMemory(record: CognitiveMemoryRecord): Promise<void> {
  await initDatabase();
  const table = getTable();
  if (!table) throw new Error('Memory table not initialized');

  const normalized = normalizeRecords([record])[0];
  await withMemoryWriteRetry(
    () => table.add([normalized]),
    'saveMemory'
  );
}

export async function getMemoryById(id: string): Promise<CognitiveMemoryRecord | null> {
  await initDatabase();
  const table = getTable();
  if (!table) return null;

  const rows = await table.query().where(`id = ${sqlString(id)}`).limit(1).toArray();
  if (rows.length === 0) return null;
  return normalizeRecords([rows[0]])[0];
}

export async function getMemoriesByDerivedFrom(derivedFrom: string, limit = 10): Promise<string[]> {
  await initDatabase();
  const table = getTable();
  if (!table) return [];
  const escaped = derivedFrom.replace(/'/g, "''");
  const rows = await table.query().where(`derivedFrom = '${escaped}'`).limit(Math.max(1, Math.min(limit, 1_000))).toArray();
  return rows.map((row: any) => String(row.id));
}

/**
 * Retry a Lance write (add/update/delete) on optimistic-concurrency conflict.
 *
 * Lance commits are optimistic: concurrent writers race for the table version and
 * the losers must re-commit. Its built-in retry budget is small (~2 attempts over
 * 30s), so `openswarm review --max` — which fans out up to 16 reviewer subagents,
 * each a SEPARATE process sharing this one on-disk table — blew straight past it
 * ("Too many concurrent writers"). A single in-process mutex can't help across
 * processes, so we retry at the application layer with exponential backoff + full
 * jitter to desynchronize the competing writers. Appends and predicated
 * update/delete are safe to re-run: Lance re-commits against the latest version on
 * each attempt, so a retry is not a double-apply.
 */
export async function withMemoryWriteRetry<T>(op: () => Promise<T>, label = 'write'): Promise<T> {
  const MAX_ATTEMPTS = 8;
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Keep this matcher tight to genuine optimistic-concurrency conflicts.
      const retryable = msg.includes('commit') || msg.includes('concurrent') || msg.includes('version') || msg.includes('conflict');
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      // Full jitter over an exponentially growing (capped) window so 16 racing
      // writers don't back off in lockstep and immediately re-collide.
      const cap = Math.min(2000, 50 * 2 ** attempt);
      const delay = 25 + Math.floor(Math.random() * cap);
      console.warn(`[Memory] ${label} contended (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function hasLegacySchemaColumns(t: Table): Promise<boolean> {
  const schema = await t.schema();
  return schema.fields.some(field => LEGACY_SCHEMA_COLUMNS.has(field.name));
}

async function migrateLeanSchemaIfNeeded(database: Connection, current: Table): Promise<Table> {
  if (!(await hasLegacySchemaColumns(current))) return current;

  const tableName = current.name;
  console.log(`${status.info('[Memory]')} ${c.dim('migrating')} ${c.cyan(tableName)} ${c.dim('to v3 lean schema')}`);

  // Cursor-based pagination: process all rows regardless of dataset size.
  // A single .limit(N) call truncates data beyond N rows, so we iterate in
  // PAGE_SIZE batches until the cursor returns fewer rows than requested.
  const PAGE_SIZE = 10_000;
  const allRows: any[] = [];
  let offset = 0;
  let batch: any[];
  do {
    batch = await current.query().limit(PAGE_SIZE).offset(offset).toArray();
    allRows.push(...batch);
    offset += batch.length;
  } while (batch.length === PAGE_SIZE);

  let normalized = normalizeRecords(allRows);
  if (normalized.length === 0) {
    const now = Date.now();
    normalized = [{
      id: 'init',
      type: 'system_pattern',
      content: 'Cognitive memory system initialized with v3 lean schema',
      vector: Array.from({ length: EMBEDDING_DIM }, () => 0),
      importance: 0.5,
      confidence: 1.0,
      createdAt: now,
      lastUpdated: now,
      lastAccessed: now,
      derivedFrom: 'system_init',
      repo: 'system',
      title: 'Memory system initialized',
      metadata: '{}',
      trust: 1.0,
      expiresAt: PERMANENT_EXPIRY,
    }];
  }
  const tempTableName = `${tableName}_v3_${Date.now()}`;

  await database.createTable(tempTableName, normalized);

  try {
    await database.createTable(tableName, normalized, { mode: 'overwrite' });
    return await database.openTable(tableName);
  } finally {
    try {
      await database.dropTable(tempTableName);
    } catch (cleanupError) {
      console.warn(`[Memory] Failed to drop temporary migration table ${tempTableName}:`, cleanupError);
    }
  }
}

/**
 * Initialize embedding pipeline (Promise-based, prevents race conditions)
 */
async function initEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  // Already initialized
  if (embeddingPipeline) {
    return embeddingPipeline;
  }

  // Previous failures may be transient (cache/model IO), so allow retry.
  if (pipelineInitFailed && pipelineInitError) {
    // Reset failure flag to allow retry
    pipelineInitFailed = false;
    pipelineInitError = null;
  }

  try {
    // Suppress HuggingFace download logs
    transformersEnv?.set('TRANSFORMERS_VERBOSITY', 'error');
    embeddingPipeline = await pipeline('feature-extraction', spec.model, {
      dtype: spec.dtype as 'fp32' | 'fp16' | 'q8' | null | undefined,
      cache_dir: modelCacheDir(),
      // @ts-expect-error - quantized is a valid option for some models
      quantized: spec.dtype === 'q8',
    });
    return embeddingPipeline;
  } catch (err) {
    pipelineInitFailed = true;
    pipelineInitError = err instanceof Error ? err : new Error(String(err));
    throw pipelineInitError;
  }
}

// ============================================
// Logging
// ============================================

export function logWork(workType: string, detail: string): void {
  console.log(`[Memory] ${workType}: ${detail}`);
}

// ============================================
// Freshness
// ============================================

export function calculateFreshness(lastAccessed: number): number {
  const now = Date.now();
  const daysSinceAccess = (now - lastAccessed) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.min(1, 1 - daysSinceAccess / 30));
}