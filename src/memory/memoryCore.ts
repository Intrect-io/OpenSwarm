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
  } catch (error) {
    embeddingConfigError = error instanceof Error ? error : new Error(String(error));
    // Defaults cannot throw; they only stand in until the deferred error fires.
    return resolveEmbeddingConfig({});
  }
}

const EMBEDDING_SPEC: EmbeddingModelSpec = resolveSpecDeferringFailure();
export const EMBEDDING_DIM = EMBEDDING_SPEC.dim;

// Cache weights outside node_modules so reinstalling OpenSwarm does not discard
// them (the library default lives inside its own package directory).
transformersEnv.cacheDir = modelCacheDir();

// Pipeline singleton (Promise-based init to prevent race conditions)
let embeddingPipeline: FeatureExtractionPipeline | null = null;
let pipelineInitPromise: Promise<FeatureExtractionPipeline> | null = null;
let pipelineInitFailed = false;
let pipelineInitError: Error | null = null;

// TTL settings (milliseconds)
const TTL_JOURNAL = 14 * 24 * 60 * 60 * 1000; // 14 days
const TTL_REPOMAP = 30 * 24 * 60 * 60 * 1000; // 30 days

// Permanent retention sentinel (year 9999) - used instead of null (LanceDB schema inference compat)
export const PERMANENT_EXPIRY = new Date('9999-12-31T23:59:59Z').getTime();

/**
 * Normalize records before LanceDB createTable.
 *
 * v3 keeps only fields that are actively used by save/search/recall. Older
 * v2 columns such as revisionCount/decay/stability/contradicts/supports are
 * intentionally not copied so compaction can rewrite the table to the lean
 * schema.
 */
export function normalizeRecords(records: any[]): CognitiveMemoryRecord[] {
  const now = Date.now();
  return records.map(r => ({
    id: String(r.id || `unknown-${now}-${Math.random().toString(36).slice(2, 6)}`),
    type: String(r.type || 'journal') as MemoryType,
    content: String(r.content || ''),
    vector: Array.isArray(r.vector) ? r.vector.map(Number) : Array.from({ length: EMBEDDING_DIM }, () => 0),

    importance: clamp01(r.importance, 0.5),
    confidence: clamp01(r.confidence, 0.7),
    createdAt: Number(r.createdAt) || now,
    lastUpdated: Number(r.lastUpdated) || now,
    lastAccessed: Number(r.lastAccessed) || now,
    derivedFrom: String(r.derivedFrom || 'unknown'),

    repo: String(r.repo || 'unknown'),
    title: String(r.title || ''),
    metadata: typeof r.metadata === 'string' ? r.metadata : JSON.stringify(r.metadata || {}),
    trust: clamp01(r.trust, 0.5),
    expiresAt: Number(r.expiresAt) || PERMANENT_EXPIRY,
  }));
}

export function clamp01(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  // Legacy callers used a 1-10 scale. Preserve intent instead of saturating
  // everything above 1 to 1.00.
  if (n > 1 && n <= 10) return n / 10;
  return Math.max(0, Math.min(1, n));
}

export function safeParseMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function normalizedL2DistanceToSimilarity(distance: unknown): number {
  const d = Number(distance);
  if (!Number.isFinite(d)) return 0;
  return Math.max(-1, Math.min(1, 1 - d / 2));
}

// Memory types
export type CognitiveMemoryType = 'belief' | 'strategy' | 'user_model' | 'system_pattern' | 'constraint';

// Legacy types for backward compatibility
export type LegacyMemoryType = 'decision' | 'repomap' | 'journal' | 'fact';

// Combined type
export type MemoryType = CognitiveMemoryType | LegacyMemoryType;

// Lean memory schema. Existing LanceDB rows may still contain older v2 columns,
// but new writes and compaction no longer emit them.
export interface CognitiveMemoryRecord {
  [key: string]: unknown;
  id: string;
  type: MemoryType;
  content: string;              // normalized semantic statement
  vector: number[];

  importance: number;           // 0-1, impact on reasoning
  confidence: number;           // 0-1, certainty level
  createdAt: number;
  lastUpdated: number;
  lastAccessed: number;
  derivedFrom: string;          // source conversation/session ID

  repo: string;
  title: string;
  metadata: string;
  trust: number;
  expiresAt: number;
}

// Legacy compatibility alias (exported for use)
export interface MemoryRecord extends CognitiveMemoryRecord {}

// Importance score by type
export const BASE_IMPORTANCE: Record<CognitiveMemoryType, number> = {
  constraint: 0.85,
  user_model: 0.82,
  strategy: 0.78,
  belief: 0.65,
  system_pattern: 0.72,
};

// Legacy type importance (mapped to similar cognitive types)
const LEGACY_IMPORTANCE: Record<LegacyMemoryType, number> = {
  decision: 0.75,   // similar to strategy
  fact: 0.78,       // similar to constraint
  repomap: 0.6,     // lower, structural info
  journal: 0.4,     // temporary insight
};

// Search result interface
export interface MemorySearchResult {
  id: string;
  type: MemoryType;
  repo: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  trust: number;
  createdAt: number;
  score: number;              // hybrid score (not just similarity)
  freshness: number;          // recency (0-1)

  importance: number;
  confidence: number;
  derivedFrom: string;
  similarityScore: number;    // raw semantic similarity
}

// Search options
export interface SearchOptions {
  types?: MemoryType[];           // type filter (whitelist)
  repo?: string;                  // repository filter
  minSimilarity?: number;         // minimum similarity (default 0.5)
  minTrust?: number;              // minimum trust (default 0.3)
  minFreshness?: number;          // minimum freshness (default 0)
  limit?: number;                 // maximum result count
  includeExpired?: boolean;       // whether to include expired items
}

// Search result (distinguishes errors from empty results)
export interface SearchResult {
  success: boolean;
  memories: MemorySearchResult[];
  error?: string;
  errorCode?: 'DB_INIT_FAILED' | 'EMBEDDING_FAILED' | 'QUERY_FAILED' | 'UNKNOWN';
}

// Singleton connection
let db: Connection | null = null;
let table: Table | null = null;
const LEGACY_SCHEMA_COLUMNS = new Set(['revisionCount', 'decay', 'stability', 'contradicts', 'supports']);

// Singleton accessors (for memoryOps)
export function getDb(): Connection | null { return db; }
export function getTable(): Table | null { return table; }
export function setTable(t: Table | null): void { table = t; }

export async function getMemoriesByIds(ids: string[]): Promise<Array<{ id: string; content: string }>> {
  if (ids.length === 0) return [];
  await initDatabase();
  if (!table) return [];
  const quoted = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
  const rows = await table.query().where(`id IN (${quoted})`).limit(Math.min(ids.length, 1_000)).toArray();
  const byId = new Map(rows.map((row: any) => [String(row.id), String(row.content ?? '')]));
  return ids.flatMap((id) => byId.has(id) ? [{ id, content: byId.get(id)! }] : []);
}

export async function hasMemoryDerivedFrom(derivedFrom: string): Promise<boolean> {
  return (await getMemoryIdsByDerivedFrom(derivedFrom, 1)).length > 0;
}

export async function getMemoryIdsByDerivedFrom(derivedFrom: string, limit = 100): Promise<string[]> {
  await initDatabase();
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
      // Keep this matcher tight to genuine optimistic-concurrency conflicts. "Too
      // many concurrent writers" is already covered by "concurrent writers"; a bare
      // "too many" would wrongly retry unrelated validation/cardinality errors.
      const retryable = /concurrent writers|commit conflict|version conflict|retry_timeout/i.test(msg);
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
  const rows = await current.query().limit(100_000).toArray();
  let normalized = normalizeRecords(rows);
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
    console.warn('[Memory] Retrying embedding model load after previous failure:', pipelineInitError.message);
    pipelineInitFailed = false;
    pipelineInitError = null;
  }

  // If initializing, wait for existing Promise (prevents race conditions)
  if (pipelineInitPromise) {
    return pipelineInitPromise;
  }

  // Start new initialization
  pipelineInitPromise = (async () => {
    try {
      console.log(`${status.info('[Memory]')} ${c.dim('loading embedding model')} ${c.yellow('(first time may take a while)')}`);
      const loadedPipeline = await pipeline('feature-extraction', EMBEDDING_SPEC.id, {
        dtype: EMBEDDING_SPEC.dtype,
      });
      embeddingPipeline = loadedPipeline;
      pipelineInitFailed = false;
      pipelineInitError = null;
      console.log(`${status.ok('[Memory] embedding model loaded')} ${c.cyan(EMBEDDING_SPEC.id)} ${c.dim(`(${EMBEDDING_SPEC.dtype}, ${EMBEDDING_SPEC.dim}d)`)}`);
      return loadedPipeline;
    } catch (error) {
      pipelineInitFailed = true;
      pipelineInitError = error instanceof Error ? error : new Error(String(error));
      pipelineInitPromise = null;  // Allow retry on next attempt
      console.error('[Memory] CRITICAL: Embedding model load failed:', error);
      throw pipelineInitError;
    }
  })();

  return pipelineInitPromise;
}

/**
 * Generate an embedding locally (no external service).
 *
 * Truncation is left to the tokenizer, which cuts at the encoder's real token
 * ceiling. This used to slice the input at 512 *characters* while the comment
 * claimed "token limit" — the model's limit is 512 *tokens*, which is ~2,345
 * characters of English and ~790 of Korean as measured on this store, so roughly
 * a fifth of the corpus never reached the encoder at all (worst hit: `constraint`
 * records, which lost >40% of their text). The remaining character bound is only
 * a cost guard for pathological input; see characterGuard.
 *
 * @throws Error - on embedding generation failure (zero vector fallback removed)
 */
async function embed(text: string, prefix: string): Promise<number[]> {
  // Surface a bad OPENSWARM_EMBEDDING_* value here rather than at module load.
  if (embeddingConfigError) throw embeddingConfigError;

  // Initialize pipeline (throws on failure)
  const pipe = await initEmbeddingPipeline();

  const input = `${prefix}${text.slice(0, characterGuard(EMBEDDING_SPEC))}`;
  const result = await pipe(input, {
    pooling: 'mean',
    normalize: true,
  });

  // Float32Array → number[]
  const vector = Array.from(result.data as Float32Array);

  // Validation: error if zero vector
  const vectorSum = vector.reduce((a, b) => Math.abs(a) + Math.abs(b), 0);
  if (vectorSum < 0.001) {
    throw new Error('Generated embedding is a zero vector (invalid)');
  }

  return vector;
}

/**
 * Embed text that is being STORED. E5 is trained on an asymmetric convention —
 * stored text is a "passage", the search string is a "query" — and this code
 * previously used the query prefix for both, discarding that distinction.
 */
export async function embedPassage(text: string): Promise<number[]> {
  return embed(text, EMBEDDING_SPEC.passagePrefix);
}

/** Embed a SEARCH QUERY. See embedPassage for why the two differ. */
export async function embedQuery(text: string): Promise<number[]> {
  return embed(text, EMBEDDING_SPEC.queryPrefix);
}

// Semantic distillation

/**
 * Distillation quality test
 * "Would future reasoning performance degrade if this memory disappeared?"
 */
interface DistillationResult {
  shouldStore: boolean;
  type: CognitiveMemoryType;
  importance: number;
  confidence: number;
  reason: string;
}

// Rejection patterns: never store
const REJECTION_PATTERNS = [
  /^(안녕|ㅎㅇ|ㅋㅋ|ㅎㅎ|오케이|넵|확인|감사)/,          // Chit-chat
  /^(좋아|싫어|화나|슬퍼)/,                              // Ephemeral emotions
  /(어떻게 생각|뭐가 나을까|선택해|골라)/,              // Context-dependent questions
  /^(test|테스트|asdf|qwer)/i,                           // Test data
];

// Extraction target patterns
const EXTRACTION_PATTERNS: { pattern: RegExp; type: CognitiveMemoryType; baseImportance: number }[] = [
  // Constraints (highest priority)
  { pattern: /(절대|반드시|금지|필수|MUST|NEVER|ALWAYS)/i, type: 'constraint', baseImportance: 0.9 },
  { pattern: /(제약|한계|limitation|constraint)/i, type: 'constraint', baseImportance: 0.85 },

  // User Model
  { pattern: /(선호|prefer|싫어하|좋아하|스타일|습관)/i, type: 'user_model', baseImportance: 0.85 },
  { pattern: /(나는|내가|my style|i always|i never)/i, type: 'user_model', baseImportance: 0.8 },

  // Strategy
  { pattern: /(전략|strategy|패턴|pattern|방법론|methodology)/i, type: 'strategy', baseImportance: 0.8 },
  { pattern: /(이렇게 하면|이 방식|this approach|best practice)/i, type: 'strategy', baseImportance: 0.75 },

  // System Pattern
  { pattern: /(아키텍처|architecture|설계|design|구조|structure)/i, type: 'system_pattern', baseImportance: 0.75 },
  { pattern: /(원칙|principle|규칙|rule|convention)/i, type: 'system_pattern', baseImportance: 0.7 },

  // Belief (default for verified insights)
  { pattern: /(확인됨|검증|verified|proven|tested|결론)/i, type: 'belief', baseImportance: 0.7 },
  { pattern: /(발견|찾음|알아냄|learned|discovered)/i, type: 'belief', baseImportance: 0.65 },
];

/**
 * Semantic Distillation: evaluate whether content is worth storing
 */
export function distillContent(content: string, context?: {
  isRepeated?: boolean;      // Whether it appeared repeatedly
  isVerified?: boolean;      // Whether verified in practice
  source?: string;           // Source (conversation, code, external)
}): DistillationResult {
  const normalizedContent = content.trim().toLowerCase();

  // 1. Check rejection patterns
  for (const pattern of REJECTION_PATTERNS) {
    if (pattern.test(normalizedContent)) {
      return {
        shouldStore: false,
        type: 'belief',
        importance: 0,
        confidence: 0,
        reason: 'Matches rejection pattern (noise)',
      };
    }
  }

  // 2. Minimum length check (too short is usually noise)
  if (content.length < 20) {
    return {
      shouldStore: false,
      type: 'belief',
      importance: 0,
      confidence: 0,
      reason: 'Content too short (likely noise)',
    };
  }

  // 3. Extraction pattern matching
  for (const { pattern, type, baseImportance } of EXTRACTION_PATTERNS) {
    if (pattern.test(content)) {
      let importance = baseImportance;
      let confidence = 0.7;

      // Adjustment: increase importance on repeated appearance
      if (context?.isRepeated) {
        importance = Math.min(1, importance + 0.1);
        confidence = Math.min(1, confidence + 0.1);
      }

      // Adjustment: increase confidence when verified
      if (context?.isVerified) {
        confidence = Math.min(1, confidence + 0.15);
      }

      return {
        shouldStore: true,
        type,
        importance,
        confidence,
        reason: `Matches extraction pattern for ${type}`,
      };
    }
  }

  // 4. Default: store as belief if long enough and seems meaningful (low importance)
  if (content.length > 100) {
    return {
      shouldStore: true,
      type: 'belief',
      importance: 0.5,
      confidence: 0.5,
      reason: 'Default: moderately significant content',
    };
  }

  // 5. Do not store
  return {
    shouldStore: false,
    type: 'belief',
    importance: 0,
    confidence: 0,
    reason: 'Does not meet storage criteria',
  };
}

/**
 * Calculate importance score.
 */
export function calculateImportance(
  type: MemoryType,
  options?: {
    isRepeated?: boolean;
    isVerified?: boolean;
    age?: number;           // milliseconds since creation
    hasContradiction?: boolean;
  }
): number {
  // Base importance by type
  let importance = (BASE_IMPORTANCE[type as CognitiveMemoryType] ??
                   LEGACY_IMPORTANCE[type as LegacyMemoryType] ?? 0.5);

  // Increase: repeated appearance. Keep this small so repeated broad audit
  // summaries do not flatten the score distribution.
  if (options?.isRepeated) {
    importance = Math.min(0.95, importance + 0.05);
  }

  // Verification should raise confidence at the call site, not force every
  // verified item to maximum importance.

  // Decrease: aged (subtract 0.1 if older than 30 days)
  if (options?.age && options.age > 30 * 24 * 60 * 60 * 1000) {
    importance = Math.max(0.3, importance - 0.1);
  }

  // Decrease: contradiction detected
  if (options?.hasContradiction) {
    importance = Math.max(0.2, importance - 0.2);
  }

  return importance;
}

/**
 * Initialize database
 */
export async function initDatabase(): Promise<void> {
  if (db && table) return;

  try {
    const fs = await import('fs/promises');
    await fs.mkdir(MEMORY_DIR, { recursive: true });

    db = await connect(MEMORY_DIR);
    const tableNames = await db.tableNames();

    // v3.0: lean cognitive memory table. Existing v2 tables are read
    // compatibly and rewritten by compaction.
    if (tableNames.includes('cognitive_memory')) {
      table = await db.openTable('cognitive_memory');
      table = await migrateLeanSchemaIfNeeded(db, table);
      console.log(`${status.info('[Memory]')} ${c.dim('loaded table')} ${c.cyan('cognitive_memory v3.0')}`);
    } else if (tableNames.includes('devmemory')) {
      // Legacy table - will migrate later
      table = await db.openTable('devmemory');
      console.log(`${status.warn('[Memory] loaded legacy table')} ${c.cyan('devmemory')}`);
    } else {
      // Create new table (v3.0 schema)
      const now = Date.now();
      const initialRecord: CognitiveMemoryRecord = {
        id: 'init',
        type: 'system_pattern',
        content: 'Cognitive memory system initialized with v3 lean schema',
        vector: await embedPassage('Cognitive memory system initialized'),

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
      };

      table = await db.createTable('cognitive_memory', [initialRecord]);
      // Freshly built by the current encoder, so the signature is true by construction.
      writeStoredSignature(MEMORY_DIR, embeddingSignature(EMBEDDING_SPEC));
      console.log(`${status.ok('[Memory] created table')} ${c.cyan('cognitive_memory v3.0')}`);
    }

    warnOnEmbeddingDrift();
  } catch (error) {
    console.error('[Memory] Database init error:', error);
    throw error;
  }
}

/**
 * Warn when the stored vectors were not produced by the currently configured
 * encoder.
 *
 * Mixing vector spaces is a silent failure: writes succeed, searches return
 * results, and only the ranking is quietly wrong. A missing signature means the
 * store predates this check and therefore was built by the old stack, which is a
 * mismatch too. Detection only — rebuilding is an explicit, user-run migration.
 */
export function warnOnEmbeddingDrift(memoryDir: string = MEMORY_DIR): boolean {
  const current = embeddingSignature(EMBEDDING_SPEC);
  const stored = readStoredSignature(memoryDir);
  if (stored?.signature === current) return false;

  console.warn(
    `${status.warn('[Memory] embedding mismatch')} ${c.dim('stored vectors were built with')} ` +
      `${c.yellow(stored?.signature ?? 'an unrecorded configuration')}${c.dim(', now using')} ${c.yellow(current)}`,
  );
  console.warn(`${c.dim('  search ranking is unreliable until you run')} ${c.cyan('openswarm memory reembed')}`);
  return true;
}

/**
 * Calculate freshness (0-1, higher for more recent)
 */
export function calculateFreshness(createdAt: number, halfLifeDays: number = 7): number {
  const ageMs = Date.now() - createdAt;
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
  return Math.exp(-ageMs / halfLifeMs);
}

/**
 * Save memory with distillation.
 */
export async function saveMemory(
  type: MemoryType,
  repo: string,
  title: string,
  content: string,
  options?: {
    metadata?: Record<string, unknown>;
    trust?: number;
    ttlDays?: number;
    importance?: number;
    confidence?: number;
    skipDistillation?: boolean;   // Force save (bypass distillation)
    isRepeated?: boolean;
    isVerified?: boolean;
    derivedFrom?: string;
  }
): Promise<string | null> {
  await initDatabase();
  if (!table) throw new Error('Table not initialized');

  // Semantic distillation (unless bypassed)
  if (!options?.skipDistillation) {
    const distillation = distillContent(content, {
      isRepeated: options?.isRepeated,
      isVerified: options?.isVerified,
    });

    if (!distillation.shouldStore) {
      console.log(`${status.warn('[Memory] rejected by distillation')} ${distillation.reason}`);
      return null;
    }

    // Distillation may refine the type for UNVERIFIED content — a best-effort
    // classification the caller didn't firmly assert. But when the caller marks
    // the memory isVerified, its explicit type is authoritative and must not be
    // overridden (e.g. system_pattern / constraint silently downgraded to
    // belief). Previously the only escape was skipDistillation, a trap for any
    // caller that didn't know the flag (see repoKnowledge.ts). Contract: explicit
    // type + isVerified wins; unverified content is still auto-refined.
    if (!options?.isVerified && distillation.type !== type && isCognitiveType(distillation.type)) {
      console.log(`${status.info('[Memory] type adjusted by distillation')} ${c.yellow(type)} → ${c.yellow(distillation.type)}`);
      type = distillation.type;
    }
  }

  const now = Date.now();
  const id = `${type}-${repo}-${now}-${randomUUID()}`;

  // Default TTL by type
  let expiresAt: number = PERMANENT_EXPIRY;
  if (type === 'journal') {
    expiresAt = now + (options?.ttlDays ? options.ttlDays * 24 * 60 * 60 * 1000 : TTL_JOURNAL);
  } else if (type === 'repomap') {
    expiresAt = now + (options?.ttlDays ? options.ttlDays * 24 * 60 * 60 * 1000 : TTL_REPOMAP);
  }

  // Calculate importance
  const importance = clamp01(options?.importance,
    calculateImportance(type, {
      isRepeated: options?.isRepeated,
      isVerified: options?.isVerified,
    }));
  const confidence = clamp01(options?.confidence, 0.7);
  const trust = clamp01(options?.trust, 0.8);

  const record: CognitiveMemoryRecord = {
    id,
    type,
    content,
    vector: await embedPassage(embeddingTextFor(title, content)),

    importance,
    confidence,
    createdAt: now,
    lastUpdated: now,
    lastAccessed: now,
    derivedFrom: options?.derivedFrom || 'unknown',

    // Legacy compatibility
    repo,
    title,
    metadata: JSON.stringify(options?.metadata || {}),
    trust,
    expiresAt,
  };

  await withMemoryWriteRetry(() => table!.add([record]), `saveMemory(${type})`);
  console.log(`${status.ok(`[Memory] saved ${type}`)} ${c.yellow(`importance: ${importance.toFixed(2)}`)} ${c.dim('repo:')} ${c.cyan(repo)} ${c.dim('title:')} ${title}`);
  return id;
}

/**
 * Type guard for cognitive memory types
 */
function isCognitiveType(type: MemoryType): type is CognitiveMemoryType {
  return ['belief', 'strategy', 'user_model', 'system_pattern', 'constraint'].includes(type);
}

/**
 * Save cognitive memory directly.
 */
export async function saveCognitiveMemory(
  type: CognitiveMemoryType,
  content: string,
  options?: {
    importance?: number;
    confidence?: number;
    derivedFrom?: string;
    /** Repo scope for the record. Defaults to 'cognitive' (unscoped) for back-compat. */
    repo?: string;
  }
): Promise<string | null> {
  await initDatabase();
  if (!table) throw new Error('Table not initialized');

  const now = Date.now();
  const id = `${type}-${now}-${Math.random().toString(36).slice(2, 8)}`;

  const importance = clamp01(options?.importance, BASE_IMPORTANCE[type]);
  const confidence = clamp01(options?.confidence, 0.7);
  // Derived from the head of the content, so embeddingTextFor drops it rather than
  // double-weighting the opening.
  const title = content.slice(0, 100);

  const record: CognitiveMemoryRecord = {
    id,
    type,
    content,
    vector: await embedPassage(embeddingTextFor(title, content)),

    importance,
    confidence,
    createdAt: now,
    lastUpdated: now,
    lastAccessed: now,
    derivedFrom: options?.derivedFrom || 'unknown',

    // Legacy fields (minimal)
    repo: options?.repo ?? 'cognitive',
    title,
    metadata: '{}',
    trust: confidence,
    expiresAt: PERMANENT_EXPIRY,
  };

  await withMemoryWriteRetry(() => table!.add([record]), `saveCognitiveMemory(${type})`);
  console.log(`${status.ok(`[Memory] saved cognitive ${type}`)} ${c.yellow(`importance: ${importance.toFixed(2)}`)} ${content.slice(0, 50)}...`);
  return id;
}

/**
 * Delete all memories tagged with a given `derivedFrom` value. Used to
 * refresh regenerable insights (e.g. knowledge-graph health) in place instead of
 * appending a new row every scan. Best-effort — returns false if no table.
 */
export async function deleteMemoriesByDerivedFrom(derivedFrom: string): Promise<number> {
  await initDatabase();
  if (!table) return 0;
  // Resolve matching ids in JS, then delete by the lowercase `id` column. A direct
  // predicate on the camelCase `derivedFrom` column is unreliable — datafusion
  // lowercases unquoted identifiers and the quoted form matched nothing here.
  const rows = (await table.query().limit(100_000).toArray()) as unknown as CognitiveMemoryRecord[];
  const ids = rows.filter((r) => r.derivedFrom === derivedFrom).map((r) => String(r.id));
  if (ids.length === 0) return 0;
  const list = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
  await withMemoryWriteRetry(() => table!.delete(`id IN (${list})`), 'deleteMemoriesByDerivedFrom');
  return ids.length;
}

/**
 * Record design decision (ADR style)
 */
export async function recordDecision(
  repo: string,
  title: string,
  context: string,
  decision: string,
  consequences: string,
  alternatives?: string
): Promise<string> {
  const content = `## Context\n${context}\n\n## Decision\n${decision}\n\n## Consequences\n${consequences}${alternatives ? `\n\n## Alternatives Considered\n${alternatives}` : ''}`;

  const id = await saveMemory('decision', repo, title, content, {
    trust: 0.95,
    metadata: { context, decision, consequences, alternatives },
    skipDistillation: true,  // Legacy: explicit save
  });
  return id!;
}

/**
 * Update repository map
 */
export async function updateRepoMap(
  repo: string,
  modules: string[],
  entryPoints: string[],
  dependencies: Record<string, string>,
  notes?: string
): Promise<string> {
  const content = `## Modules\n${modules.map(m => `- ${m}`).join('\n')}\n\n## Entry Points\n${entryPoints.map(e => `- ${e}`).join('\n')}\n\n## Dependencies\n${Object.entries(dependencies).map(([k, v]) => `- ${k}: ${v}`).join('\n')}${notes ? `\n\n## Notes\n${notes}` : ''}`;

  const id = await saveMemory('repomap', repo, `Repository structure: ${repo}`, content, {
    trust: 0.9,
    metadata: { modules, entryPoints, dependencies },
    skipDistillation: true,
  });
  return id!;
}

/**
 * Log work entry
 */
export async function logWork(
  repo: string,
  summary: string,
  details: string,
  filesChanged?: string[],
  issueRef?: string
): Promise<string> {
  const content = `${details}${filesChanged ? `\n\n### Files Changed\n${filesChanged.map(f => `- ${f}`).join('\n')}` : ''}${issueRef ? `\n\n### Related Issue\n${issueRef}` : ''}`;

  const id = await saveMemory('journal', repo, summary, content, {
    trust: 0.85,
    metadata: { filesChanged, issueRef, timestamp: new Date().toISOString() },
    ttlDays: 14,
    skipDistillation: true,
    derivedFrom: issueRef,  // Used to store channelId
  });
  return id!;
}

/**
 * Record a fact (versions, environments, etc.)
 */
export async function recordFact(
  repo: string,
  title: string,
  content: string,
  category: 'version' | 'build' | 'deploy' | 'constraint' | 'other'
): Promise<string> {
  const id = await saveMemory('fact', repo, title, content, {
    trust: 0.95,
    metadata: { category },
    skipDistillation: true,
  });
  return id!;
}

// Hybrid retrieval

/**
 * Hybrid score: semantic relevance first, then curated importance and recency.
 * Removed access frequency/decay inputs because the table never maintained
 * meaningful values for them.
 */
function calculateHybridScore(
  similarity: number,
  importance: number,
  recency: number
): number {
  return (
    0.60 * similarity +
    0.25 * importance +
    0.15 * recency
  );
}

/**
 * Search memory with hybrid retrieval - safe version.
 * Distinguishes between errors and empty results
 */
export async function searchMemorySafe(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult> {
  try {
    await initDatabase();
    if (!table) {
      return {
        success: false,
        memories: [],
        error: 'Database table not initialized',
        errorCode: 'DB_INIT_FAILED',
      };
    }

    const {
      types,
      repo,
      minSimilarity = 0.4,
      minTrust = 0.3,
      minFreshness = 0,
      limit = 10,
      includeExpired = false,
    } = options;

    let queryVector: number[];
    try {
      queryVector = await embedQuery(query);
    } catch (embeddingError) {
      return {
        success: false,
        memories: [],
        error: `Embedding generation failed: ${embeddingError instanceof Error ? embeddingError.message : String(embeddingError)}`,
        errorCode: 'EMBEDDING_FAILED',
      };
    }


    const now = Date.now();
    const predicates: string[] = [];
    if (types?.length) {
      predicates.push(`type IN (${types.map(sqlString).join(', ')})`);
    }
    if (repo) {
      predicates.push(`repo IN (${[repo, 'system', 'cognitive'].map(sqlString).join(', ')})`);
    }
    if (!includeExpired) {
      // Lance/DataFusion normalizes unquoted identifiers to lowercase. This
      // column is camelCase in the Arrow schema, so quote it or vector search
      // fails with "No field named expiresat".
      predicates.push(`("expiresAt" IS NULL OR "expiresAt" >= ${now} OR "expiresAt" >= ${PERMANENT_EXPIRY})`);
    }
    if (minTrust > 0) {
      predicates.push(`(confidence >= ${minTrust} OR (confidence IS NULL AND trust >= ${minTrust}))`);
    }

    const hasPostVectorFilters = Boolean(minFreshness > 0 || minSimilarity > -1);
    const resultWindow = hasPostVectorFilters
      ? Math.min(Math.max(limit * 20, 100), 1000)
      : Math.max(limit * 5, limit);
    let vectorQuery = table.vectorSearch(queryVector);
    if (predicates.length > 0) {
      vectorQuery = vectorQuery.where(predicates.join(' AND '));
    }
    const results = await vectorQuery.limit(resultWindow).toArray();

    // Hybrid retrieval scoring
    const scored = results
      .filter((r: any) => {
        if (r.id === 'init') return false;
        if (!includeExpired && r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now) return false;
        if (types && !types.includes(r.type)) return false;
        if (repo && r.repo !== repo && r.repo !== 'system' && r.repo !== 'cognitive') return false;
        const confidence = r.confidence ?? r.trust ?? 0;
        if (confidence < minTrust) return false;
        const similarity = normalizedL2DistanceToSimilarity(r._distance);
        if (similarity < minSimilarity) return false;
        return true;
      })
      .map((r: any) => {
        const similarity = normalizedL2DistanceToSimilarity(r._distance);
        const recency = calculateFreshness(r.createdAt);
        const importance = r.importance ?? calculateImportance(r.type);
        const hybridScore = calculateHybridScore(similarity, importance, recency);
        return { record: r, similarity, recency, importance, hybridScore };
      })
      .filter(item => item.recency >= minFreshness)
      .sort((a, b) => b.hybridScore - a.hybridScore)
      .slice(0, limit);

    // NOTE: we deliberately do NOT write a `lastAccessed` timestamp back here.
    // Every search used to fire a Lance `table.update()` commit, but `lastAccessed`
    // feeds nothing — retrieval recency uses `createdAt` (access-frequency/decay was
    // removed, see calculateFreshness below), and no CLI reads the field. Under
    // `openswarm review --max` (up to 16 concurrent reviewer subagents each searching
    // memory) those per-search commits collided on Lance's optimistic-concurrency
    // limit → "Too many concurrent writers … [Memory] Failed to update access time".
    // Dropping a write with no read consumer removes the contention entirely. The
    // schema field remains (set at record creation) so decay can be reintroduced with
    // a batched/serialized writer if ever needed.

    const formatted: MemorySearchResult[] = scored.map(({ record: r, similarity, recency, importance, hybridScore }) => ({
      id: r.id,
      type: r.type,
      repo: r.repo,
      title: r.title,
      content: r.content,
      metadata: safeParseMetadata(r.metadata),
      trust: r.trust ?? r.confidence ?? 0.7,
      createdAt: r.createdAt,
      score: hybridScore,
      freshness: recency,
      importance,
      confidence: r.confidence ?? r.trust ?? 0.7,
      derivedFrom: r.derivedFrom ?? 'unknown',
      similarityScore: similarity,
    }));

    console.log(`${status.info(`[Memory] found ${formatted.length} memories`)} ${c.dim('hybrid retrieval')} ${c.dim(`query: "${query.slice(0, 30)}..."`)}`);
    return { success: true, memories: formatted };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('[Memory] Search error:', error);
    return {
      success: false,
      memories: [],
      error: errorMsg,
      errorCode: 'QUERY_FAILED',
    };
  }
}

/**
 * Search memory - legacy compatible.
 * @deprecated Use searchMemorySafe instead
 */
export async function searchMemory(
  query: string,
  options: SearchOptions = {}
): Promise<MemorySearchResult[]> {
  const result = await searchMemorySafe(query, options);
  if (!result.success) {
    console.warn(`[Memory] Search failed silently: ${result.error} (code: ${result.errorCode})`);
  }
  return result.memories;
}
