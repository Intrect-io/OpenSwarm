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

// 메모리 저장 경로
const MEMORY_DIR = resolve(homedir(), '.claude-swarm/memory');

// Xenova 임베딩 설정 (로컬 실행, 외부 의존 없음)
const EMBEDDING_MODEL = 'Xenova/multilingual-e5-base';  // 768차원, 다국어 지원
export const EMBEDDING_DIM = 768;

// Xenova 파이프라인 싱글톤 (Promise 기반 초기화로 race condition 방지)
let embeddingPipeline: FeatureExtractionPipeline | null = null;
let pipelineInitPromise: Promise<FeatureExtractionPipeline> | null = null;
let pipelineInitFailed = false;
let pipelineInitError: Error | null = null;

// TTL 설정 (밀리초)
const TTL_JOURNAL = 14 * 24 * 60 * 60 * 1000; // 14일
const TTL_REPOMAP = 30 * 24 * 60 * 60 * 1000; // 30일

// 영구 보관 sentinel (year 9999) - null 대신 사용 (LanceDB 스키마 추론 호환)
export const PERMANENT_EXPIRY = new Date('9999-12-31T23:59:59Z').getTime();

/**
 * LanceDB createTable 전 레코드 정규화
 * - 타입 추론 에러 방지 (특히 expiresAt)
 * - BigInt → Number 변환, undefined → 기본값
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
  importance: number;           // 0-1, 추론 영향도
  confidence: number;           // 0-1, 확신도
  createdAt: number;
  lastUpdated: number;
  lastAccessed: number;
  revisionCount: number;
  decay: number;                // 0-1, 망각 정도

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

// 레거시 호환용 별칭 (export하여 사용 가능)
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

// 검색 결과 인터페이스 (PRD Enhanced)
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

// 검색 옵션
export interface SearchOptions {
  types?: MemoryType[];           // 타입 필터 (whitelist)
  repo?: string;                  // 저장소 필터
  minSimilarity?: number;         // 최소 유사도 (기본 0.5)
  minTrust?: number;              // 최소 신뢰도 (기본 0.3)
  minFreshness?: number;          // 최소 신선도 (기본 0)
  limit?: number;                 // 최대 결과 수
  includeExpired?: boolean;       // 만료된 항목 포함 여부
}

// 검색 결과 (에러와 empty 구분)
export interface SearchResult {
  success: boolean;
  memories: MemorySearchResult[];
  error?: string;
  errorCode?: 'DB_INIT_FAILED' | 'EMBEDDING_FAILED' | 'QUERY_FAILED' | 'UNKNOWN';
}

// 싱글톤 연결
let db: Connection | null = null;
let table: Table | null = null;

// 싱글톤 접근자 (memoryOps용)
export function getDb(): Connection | null { return db; }
export function getTable(): Table | null { return table; }
export function setTable(t: Table | null): void { table = t; }

/**
 * 임베딩 파이프라인 초기화 (Promise 기반, race condition 방지)
 */
async function initEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  // 이미 초기화됨
  if (embeddingPipeline) {
    return embeddingPipeline;
  }

  // 이전에 초기화 실패했으면 같은 에러 반환
  if (pipelineInitFailed && pipelineInitError) {
    throw pipelineInitError;
  }

  // 초기화 중이면 기존 Promise 대기 (race condition 방지)
  if (pipelineInitPromise) {
    return pipelineInitPromise;
  }

  // 새로 초기화 시작
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
      pipelineInitPromise = null;  // 다음 시도에서 재시도 가능하도록
      console.error('[Memory] CRITICAL: Embedding model load failed:', error);
      throw pipelineInitError;
    }
  })();

  return pipelineInitPromise;
}

/**
 * Xenova/transformers로 임베딩 생성 (로컬, 외부 의존 없음)
 * @throws Error - 임베딩 생성 실패 시 (zero vector fallback 제거됨)
 */
export async function getEmbedding(text: string): Promise<number[]> {
  // 파이프라인 초기화 (실패 시 throw)
  const pipe = await initEmbeddingPipeline();

  // E5 모델은 "query: " 또는 "passage: " 접두사 권장
  const input = `query: ${text.slice(0, 512)}`;  // 토큰 제한
  const result = await pipe(input, {
    pooling: 'mean',
    normalize: true,
  });

  // Float32Array → number[]
  const vector = Array.from(result.data as Float32Array);

  // 유효성 검증: zero vector면 에러
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
 * Distillation Quality Test (PRD 핵심)
 * "이 메모리가 사라지면 미래 추론 성능이 저하되는가?"
 */
interface DistillationResult {
  shouldStore: boolean;
  type: CognitiveMemoryType;
  importance: number;
  confidence: number;
  reason: string;
}

// 저장 금지 패턴 (PRD: NEVER store)
const REJECTION_PATTERNS = [
  /^(안녕|ㅎㅇ|ㅋㅋ|ㅎㅎ|오케이|넵|확인|감사)/,          // 잡담
  /^(좋아|싫어|화나|슬퍼)/,                              // 일회성 감정
  /(어떻게 생각|뭐가 나을까|선택해|골라)/,              // 컨텍스트 의존 질문
  /^(test|테스트|asdf|qwer)/i,                           // 테스트 데이터
];

// 저장 대상 패턴 (PRD: Extract ONLY if)
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
 * Semantic Distillation: 저장할 가치가 있는지 평가
 */
export function distillContent(content: string, context?: {
  isRepeated?: boolean;      // 반복 등장 여부
  isVerified?: boolean;      // 실전 검증 여부
  source?: string;           // 출처 (conversation, code, external)
}): DistillationResult {
  const normalizedContent = content.trim().toLowerCase();

  // 1. 거부 패턴 체크
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

  // 2. 최소 길이 체크 (너무 짧은 건 보통 노이즈)
  if (content.length < 20) {
    return {
      shouldStore: false,
      type: 'belief',
      importance: 0,
      confidence: 0,
      reason: 'Content too short (likely noise)',
    };
  }

  // 3. 추출 패턴 매칭
  for (const { pattern, type, baseImportance } of EXTRACTION_PATTERNS) {
    if (pattern.test(content)) {
      let importance = baseImportance;
      let confidence = 0.7;

      // 조정: 반복 등장 시 importance 증가
      if (context?.isRepeated) {
        importance = Math.min(1, importance + 0.1);
        confidence = Math.min(1, confidence + 0.1);
      }

      // 조정: 검증됨 시 confidence 증가
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

  // 4. 기본값: 길고 의미있어 보이면 belief로 저장 (낮은 importance)
  if (content.length > 100) {
    return {
      shouldStore: true,
      type: 'belief',
      importance: 0.5,
      confidence: 0.5,
      reason: 'Default: moderately significant content',
    };
  }

  // 5. 저장 안 함
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

  // Increase: 반복 등장
  if (options?.isRepeated) {
    importance = Math.min(1, importance + 0.1);
  }

  // Increase: 실전 검증
  if (options?.isVerified) {
    importance = Math.min(1, importance + 0.1);
  }

  // Decrease: 오래됨 (30일 이상이면 -0.1)
  if (options?.age && options.age > 30 * 24 * 60 * 60 * 1000) {
    importance = Math.max(0.3, importance - 0.1);
  }

  // Decrease: 모순 발생
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

  // 오래됐는데 수정 없으면 high
  if (ageInDays > 7 && revisionCount === 0) return 'high';

  // 최근 만들어졌거나 수정 많으면 low
  if (ageInDays < 1 || revisionCount > 3) return 'low';

  return 'medium';
}

/**
 * 데이터베이스 초기화
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
      // 새 테이블 생성 (v2.0 schema)
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
 * 신선도 계산 (0-1, 최근일수록 높음)
 */
export function calculateFreshness(createdAt: number, halfLifeDays: number = 7): number {
  const ageMs = Date.now() - createdAt;
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
  return Math.exp(-ageMs / halfLifeMs);
}

/**
 * 메모리 저장 (PRD v2.0 with Distillation)
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
    skipDistillation?: boolean;   // 강제 저장 (distillation bypass)
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

    // Distillation이 제안한 type이 더 적절하면 사용
    if (distillation.type !== type && isCognitiveType(distillation.type)) {
      console.log(`[Memory] Type adjusted by distillation: ${type} → ${distillation.type}`);
      type = distillation.type;
    }
  }

  const now = Date.now();
  const id = `${type}-${repo}-${now}`;

  // 타입별 기본 TTL 설정
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
    stability: 'low',  // 새로 생성된 건 low
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
 * Cognitive Memory 직접 저장 (PRD Schema용)
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
 * 설계 결정 기록 (ADR 스타일)
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
 * 저장소 맵 업데이트
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
 * 작업 일지 기록
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
    derivedFrom: issueRef,  // channelId 저장용
  });
  return id!;
}

/**
 * 팩트 기록 (버전, 환경 등)
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
 * PRD Hybrid Score 계산
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
 * 메모리 검색 (PRD Hybrid Retrieval) - Safe 버전
 * 에러와 empty 결과를 구분할 수 있음
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
 * 메모리 검색 (PRD Hybrid Retrieval) - 레거시 호환
 * @deprecated searchMemorySafe 사용 권장
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
