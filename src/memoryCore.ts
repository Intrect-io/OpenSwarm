/**
 * Persistent Cognitive Memory Module v2.0 - Core
 *
 * Types, embedding, distillation, database init, save, search.
 * High-level operations (revision, formatting, background) are in memoryOps.ts.
 */
import { connect, Table, Connection } from '@lancedb/lancedb';
import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';
import { resolve } from 'path';
import { homedir } from 'os';

// Memory storage path
const MEMORY_DIR = resolve(homedir(), '.claude-swarm/memory');

// Xenova embedding config (runs locally, no external dependencies)
const EMBEDDING_MODEL = 'Xenova/multilingual-e5-base';  // 768 dimensions, multilingual
export const EMBEDDING_DIM = 768;

// Xenova pipeline singleton (Promise-based init to prevent race conditions)
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
 * Normalize records before LanceDB createTable
 * - Prevents type inference errors (especially expiresAt)
 * - Converts BigInt to Number, undefined to defaults
 */
export function normalizeRecords(records: any[]): CognitiveMemoryRecord[] {
  const now = Date.now();
  return records.map(r => ({
    id: String(r.id || `unknown-${now}-${Math.random().toString(36).slice(2, 6)}`),
    type: String(r.type || 'journal') as MemoryType,
    content: String(r.content || ''),
    vector: Array.isArray(r.vector) ? r.vector.map(Number) : Array.from({ length: EMBEDDING_DIM }, () => 0),

    importance: Number(r.importance) || 0.5,
    confidence: Number(r.confidence) || 0.7,
    createdAt: Number(r.createdAt) || now,
    lastUpdated: Number(r.lastUpdated) || now,
    lastAccessed: Number(r.lastAccessed) || now,
    revisionCount: Number(r.revisionCount) || 0,
    decay: Number(r.decay) || 0,

    stability: (r.stability as StabilityLevel) || 'low',
    contradicts: typeof r.contradicts === 'string' ? r.contradicts : JSON.stringify(r.contradicts || []),
    supports: typeof r.supports === 'string' ? r.supports : JSON.stringify(r.supports || []),
    derivedFrom: String(r.derivedFrom || 'unknown'),

    repo: String(r.repo || 'unknown'),
    title: String(r.title || ''),
    metadata: typeof r.metadata === 'string' ? r.metadata : JSON.stringify(r.metadata || {}),
    trust: Number(r.trust) || 0.5,
    expiresAt: Number(r.expiresAt) || PERMANENT_EXPIRY,
  }));
}

// ==============================================
// PRD Memory Types (Cognitive Memory)
// ==============================================
export type CognitiveMemoryType = 'belief' | 'strategy' | 'user_model' | 'system_pattern' | 'constraint';

// Legacy types for backward compatibility
export type LegacyMemoryType = 'decision' | 'repomap' | 'journal' | 'fact';

// Combined type
export type MemoryType = CognitiveMemoryType | LegacyMemoryType;

// Stability levels for beliefs
export type StabilityLevel = 'low' | 'medium' | 'high';

// ==============================================
// PRD Memory Schema (Base + Extensions)
// ==============================================
export interface CognitiveMemoryRecord {
  [key: string]: unknown;
  id: string;
  type: MemoryType;
  content: string;              // normalized semantic statement
  vector: number[];

  // PRD Mandatory Fields
  importance: number;           // 0-1, impact on reasoning
  confidence: number;           // 0-1, certainty level
  createdAt: number;
  lastUpdated: number;
  lastAccessed: number;
  revisionCount: number;
  decay: number;                // 0-1, degree of forgetting

  // PRD Extensions
  stability: StabilityLevel;
  contradicts: string;          // JSON array of memory IDs
  supports: string;             // JSON array of memory IDs
  derivedFrom: string;          // source conversation/session ID

  // Legacy compatibility
  repo: string;
  title: string;
  metadata: string;
  trust: number;
  expiresAt: number;
}

// Legacy compatibility alias (exported for use)
export interface MemoryRecord extends CognitiveMemoryRecord {}

// ==============================================
// Importance Score by Type (PRD Table)
// ==============================================
export const BASE_IMPORTANCE: Record<CognitiveMemoryType, number> = {
  constraint: 0.9,
  user_model: 0.85,
  strategy: 0.8,
  belief: 0.7,
  system_pattern: 0.75,
};

// Legacy type importance (mapped to similar cognitive types)
const LEGACY_IMPORTANCE: Record<LegacyMemoryType, number> = {
  decision: 0.8,    // similar to strategy
  fact: 0.85,       // similar to constraint
  repomap: 0.6,     // lower, structural info
  journal: 0.4,     // temporary insight
};

// Search result interface (PRD Enhanced)
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

  // PRD additions
  importance: number;
  confidence: number;
  stability: StabilityLevel;
  revisionCount: number;
  decay: number;
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

// Singleton accessors (for memoryOps)
export function getDb(): Connection | null { return db; }
export function getTable(): Table | null { return table; }
export function setTable(t: Table | null): void { table = t; }

/**
 * Initialize embedding pipeline (Promise-based, prevents race conditions)
 */
async function initEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  // Already initialized
  if (embeddingPipeline) {
    return embeddingPipeline;
  }

  // If previously failed, return the same error
  if (pipelineInitFailed && pipelineInitError) {
    throw pipelineInitError;
  }

  // If initializing, wait for existing Promise (prevents race conditions)
  if (pipelineInitPromise) {
    return pipelineInitPromise;
  }

  // Start new initialization
  pipelineInitPromise = (async () => {
    try {
      console.log('[Memory] Loading embedding model (first time may take a while)...');
      const loadedPipeline = await pipeline('feature-extraction', EMBEDDING_MODEL, {
        quantized: true,
      });
      embeddingPipeline = loadedPipeline;
      console.log('[Memory] Embedding model loaded:', EMBEDDING_MODEL);
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
 * Generate embeddings via Xenova/transformers (local, no external dependencies)
 * @throws Error - on embedding generation failure (zero vector fallback removed)
 */
export async function getEmbedding(text: string): Promise<number[]> {
  // Initialize pipeline (throws on failure)
  const pipe = await initEmbeddingPipeline();

  // E5 model recommends "query: " or "passage: " prefix
  const input = `query: ${text.slice(0, 512)}`;  // Token limit
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

// ==============================================
// Semantic Distillation Engine (PRD Phase 1)
// ==============================================

/**
 * Distillation Quality Test (PRD core)
 * "Would future reasoning performance degrade if this memory disappeared?"
 */
interface DistillationResult {
  shouldStore: boolean;
  type: CognitiveMemoryType;
  importance: number;
  confidence: number;
  reason: string;
}

// Rejection patterns (PRD: NEVER store)
const REJECTION_PATTERNS = [
  /^(안녕|ㅎㅇ|ㅋㅋ|ㅎㅎ|오케이|넵|확인|감사)/,          // Chit-chat
  /^(좋아|싫어|화나|슬퍼)/,                              // Ephemeral emotions
  /(어떻게 생각|뭐가 나을까|선택해|골라)/,              // Context-dependent questions
  /^(test|테스트|asdf|qwer)/i,                           // Test data
];

// Extraction target patterns (PRD: Extract ONLY if)
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
 * Calculate importance score (PRD Table + Adjustments)
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

  // Increase: repeated appearance
  if (options?.isRepeated) {
    importance = Math.min(1, importance + 0.1);
  }

  // Increase: verified in practice
  if (options?.isVerified) {
    importance = Math.min(1, importance + 0.1);
  }

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
 * Determine stability based on revision history
 */
export function calculateStability(revisionCount: number, age: number): StabilityLevel {
  const ageInDays = age / (24 * 60 * 60 * 1000);

  // Old with no revisions = high
  if (ageInDays > 7 && revisionCount === 0) return 'high';

  // Recently created or frequently revised = low
  if (ageInDays < 1 || revisionCount > 3) return 'low';

  return 'medium';
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

    // v2.0: cognitive memory table
    if (tableNames.includes('cognitive_memory')) {
      table = await db.openTable('cognitive_memory');
      console.log('[Memory] Loaded cognitive_memory table (v2.0)');
    } else if (tableNames.includes('devmemory')) {
      // Legacy table - will migrate later
      table = await db.openTable('devmemory');
      console.log('[Memory] Loaded legacy devmemory table');
    } else {
      // Create new table (v2.0 schema)
      const now = Date.now();
      const initialRecord: CognitiveMemoryRecord = {
        id: 'init',
        type: 'system_pattern',
        content: 'Cognitive memory system initialized with PRD v2.0 schema',
        vector: await getEmbedding('Cognitive memory system initialized'),

        // PRD Mandatory Fields
        importance: 0.5,
        confidence: 1.0,
        createdAt: now,
        lastUpdated: now,
        lastAccessed: now,
        revisionCount: 0,
        decay: 0,

        // PRD Extensions
        stability: 'high',
        contradicts: '[]',
        supports: '[]',
        derivedFrom: 'system_init',

        // Legacy compatibility
        repo: 'system',
        title: 'Memory system initialized',
        metadata: '{}',
        trust: 1.0,
        expiresAt: PERMANENT_EXPIRY,
      };

      table = await db.createTable('cognitive_memory', [initialRecord]);
      console.log('[Memory] Created cognitive_memory table (v2.0)');
    }
  } catch (error) {
    console.error('[Memory] Database init error:', error);
    throw error;
  }
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
 * Save memory (PRD v2.0 with Distillation)
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
    // PRD v2.0 options
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

  // PRD: Semantic Distillation (unless bypassed)
  if (!options?.skipDistillation) {
    const distillation = distillContent(content, {
      isRepeated: options?.isRepeated,
      isVerified: options?.isVerified,
    });

    if (!distillation.shouldStore) {
      console.log(`[Memory] Rejected by distillation: ${distillation.reason}`);
      return null;
    }

    // Use distillation-suggested type if more appropriate
    if (distillation.type !== type && isCognitiveType(distillation.type)) {
      console.log(`[Memory] Type adjusted by distillation: ${type} → ${distillation.type}`);
      type = distillation.type;
    }
  }

  const now = Date.now();
  const id = `${type}-${repo}-${now}`;

  // Default TTL by type
  let expiresAt: number = PERMANENT_EXPIRY;
  if (type === 'journal') {
    expiresAt = now + (options?.ttlDays ? options.ttlDays * 24 * 60 * 60 * 1000 : TTL_JOURNAL);
  } else if (type === 'repomap') {
    expiresAt = now + (options?.ttlDays ? options.ttlDays * 24 * 60 * 60 * 1000 : TTL_REPOMAP);
  }

  // Calculate importance
  const importance = options?.importance ??
    calculateImportance(type, {
      isRepeated: options?.isRepeated,
      isVerified: options?.isVerified,
    });

  const record: CognitiveMemoryRecord = {
    id,
    type,
    content,
    vector: await getEmbedding(`${title}\n${content}`),

    // PRD Mandatory Fields
    importance,
    confidence: options?.confidence ?? 0.7,
    createdAt: now,
    lastUpdated: now,
    lastAccessed: now,
    revisionCount: 0,
    decay: 0,

    // PRD Extensions
    stability: 'low',  // Newly created starts as low
    contradicts: '[]',
    supports: '[]',
    derivedFrom: options?.derivedFrom || 'unknown',

    // Legacy compatibility
    repo,
    title,
    metadata: JSON.stringify(options?.metadata || {}),
    trust: options?.trust ?? 0.8,
    expiresAt,
  };

  await table.add([record]);
  console.log(`[Memory] Saved ${type} (importance: ${importance.toFixed(2)}) for ${repo}: ${title}`);
  return id;
}

/**
 * Type guard for cognitive memory types
 */
function isCognitiveType(type: MemoryType): type is CognitiveMemoryType {
  return ['belief', 'strategy', 'user_model', 'system_pattern', 'constraint'].includes(type);
}

/**
 * Save cognitive memory directly (for PRD Schema)
 */
export async function saveCognitiveMemory(
  type: CognitiveMemoryType,
  content: string,
  options?: {
    importance?: number;
    confidence?: number;
    derivedFrom?: string;
    supports?: string[];
    contradicts?: string[];
  }
): Promise<string | null> {
  await initDatabase();
  if (!table) throw new Error('Table not initialized');

  const now = Date.now();
  const id = `${type}-${now}-${Math.random().toString(36).slice(2, 8)}`;

  const importance = options?.importance ?? BASE_IMPORTANCE[type];

  const record: CognitiveMemoryRecord = {
    id,
    type,
    content,
    vector: await getEmbedding(content),

    importance,
    confidence: options?.confidence ?? 0.7,
    createdAt: now,
    lastUpdated: now,
    lastAccessed: now,
    revisionCount: 0,
    decay: 0,

    stability: 'low',
    contradicts: JSON.stringify(options?.contradicts || []),
    supports: JSON.stringify(options?.supports || []),
    derivedFrom: options?.derivedFrom || 'unknown',

    // Legacy fields (minimal)
    repo: 'cognitive',
    title: content.slice(0, 100),
    metadata: '{}',
    trust: options?.confidence ?? 0.7,
    expiresAt: PERMANENT_EXPIRY,
  };

  await table.add([record]);
  console.log(`[Memory] Saved cognitive ${type} (importance: ${importance.toFixed(2)}): ${content.slice(0, 50)}...`);
  return id;
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

// ==============================================
// Hybrid Retrieval (PRD Phase 2)
// ==============================================

/**
 * PRD Hybrid Score calculation
 * final_score = 0.55*similarity + 0.20*importance + 0.15*recency + 0.10*frequency
 */
function calculateHybridScore(
  similarity: number,
  importance: number,
  recency: number,
  accessFrequency: number
): number {
  return (
    0.55 * similarity +
    0.20 * importance +
    0.15 * recency +
    0.10 * Math.min(1, accessFrequency / 10)  // normalize frequency
  );
}

/**
 * Search memory (PRD Hybrid Retrieval) - Safe version
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
      queryVector = await getEmbedding(query);
    } catch (embeddingError) {
      return {
        success: false,
        memories: [],
        error: `Embedding generation failed: ${embeddingError instanceof Error ? embeddingError.message : String(embeddingError)}`,
        errorCode: 'EMBEDDING_FAILED',
      };
    }

    const results = await table.vectorSearch(queryVector).limit(limit * 5).toArray();
    const now = Date.now();

    // Hybrid Retrieval with PRD scoring
    const scored = results
      .filter((r: any) => {
        if (r.id === 'init') return false;
        if (!includeExpired && r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now) return false;
        if (types && !types.includes(r.type)) return false;
        if (repo && r.repo !== repo && r.repo !== 'system' && r.repo !== 'cognitive') return false;
        const confidence = r.confidence ?? r.trust ?? 0;
        if (confidence < minTrust) return false;
        const similarity = r._distance ? 1 - r._distance : 0;
        if (similarity < minSimilarity) return false;
        return true;
      })
      .map((r: any) => {
        const similarity = r._distance ? 1 - r._distance : 0;
        const recency = calculateFreshness(r.createdAt);
        const importance = r.importance ?? calculateImportance(r.type);
        const accessCount = r.accessCount ?? 1;
        const effectiveImportance = importance * (1 - (r.decay ?? 0));
        const hybridScore = calculateHybridScore(similarity, effectiveImportance, recency, accessCount);
        return { record: r, similarity, recency, importance: effectiveImportance, hybridScore };
      })
      .filter(item => item.recency >= minFreshness)
      .sort((a, b) => b.hybridScore - a.hybridScore)
      .slice(0, limit);

    updateAccessTime(scored.map(s => s.record.id)).catch(() => {});

    const formatted: MemorySearchResult[] = scored.map(({ record: r, similarity, recency, importance, hybridScore }) => ({
      id: r.id,
      type: r.type,
      repo: r.repo,
      title: r.title,
      content: r.content,
      metadata: JSON.parse(r.metadata || '{}'),
      trust: r.trust ?? r.confidence ?? 0.7,
      createdAt: r.createdAt,
      score: hybridScore,
      freshness: recency,
      importance,
      confidence: r.confidence ?? r.trust ?? 0.7,
      stability: r.stability ?? 'medium',
      revisionCount: r.revisionCount ?? 0,
      decay: r.decay ?? 0,
      similarityScore: similarity,
    }));

    console.log(`[Memory] Found ${formatted.length} memories (hybrid retrieval, query: "${query.slice(0, 30)}...")`);
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
 * Search memory (PRD Hybrid Retrieval) - Legacy compatible
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

/**
 * Update last_accessed timestamp for retrieved memories
 */
async function updateAccessTime(ids: string[]): Promise<void> {
  // Note: LanceDB doesn't support in-place updates easily
  // This would require table rewrite - implement in Phase 3
  // For now, just log
  if (ids.length > 0) {
    console.log(`[Memory] Access logged for ${ids.length} memories`);
  }
}
