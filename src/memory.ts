/**
 * Persistent Cognitive Memory Module v2.0
 *
 * PRD 기반 재설계:
 * - Semantic Distillation: 추론에 영향주는 정보만 저장
 * - Hybrid Retrieval: similarity + importance + recency + frequency
 * - Memory Evolution: append-only 탈피, belief revision 지원
 * - Background Cognition: decay, consolidation, contradiction detection
 *
 * Memory Types (PRD Schema):
 * - belief: 검증된 믿음/가설 (revision 가능)
 * - strategy: 검증된 전략/패턴
 * - user_model: 사용자 고정 성향
 * - system_pattern: 시스템 설계 철학
 * - constraint: 절대 제약조건
 *
 * Legacy Types (backward compatibility):
 * - decision, repomap, journal, fact
 */
import { connect, Table, Connection } from '@lancedb/lancedb';
import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';
import { resolve } from 'path';
import { homedir } from 'os';

// 메모리 저장 경로
const MEMORY_DIR = resolve(homedir(), '.claude-swarm/memory');

// Xenova 임베딩 설정 (로컬 실행, 외부 의존 없음)
const EMBEDDING_MODEL = 'Xenova/multilingual-e5-base';  // 768차원, 다국어 지원
const EMBEDDING_DIM = 768;

// Xenova 파이프라인 싱글톤
let embeddingPipeline: FeatureExtractionPipeline | null = null;
let pipelineInitializing = false;

// TTL 설정 (밀리초)
const TTL_JOURNAL = 14 * 24 * 60 * 60 * 1000; // 14일
const TTL_REPOMAP = 30 * 24 * 60 * 60 * 1000; // 30일

// 영구 보관 sentinel (year 9999) - null 대신 사용 (LanceDB 스키마 추론 호환)
const PERMANENT_EXPIRY = new Date('9999-12-31T23:59:59Z').getTime();

/**
 * LanceDB createTable 전 레코드 정규화
 * - 타입 추론 에러 방지 (특히 expiresAt)
 * - BigInt → Number 변환, undefined → 기본값
 */
function normalizeRecords(records: any[]): CognitiveMemoryRecord[] {
  const now = Date.now();
  return records.map(r => ({
    id: String(r.id || `unknown-${now}-${Math.random().toString(36).slice(2, 6)}`),
    type: String(r.type || 'journal') as MemoryType,
    content: String(r.content || ''),
    vector: Array.isArray(r.vector) ? r.vector.map(Number) : new Array(EMBEDDING_DIM).fill(0),

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
interface CognitiveMemoryRecord {
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

// 레거시 호환용 별칭
interface MemoryRecord extends CognitiveMemoryRecord {}

// ==============================================
// Importance Score by Type (PRD Table)
// ==============================================
const BASE_IMPORTANCE: Record<CognitiveMemoryType, number> = {
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

// 싱글톤 연결
let db: Connection | null = null;
let table: Table | null = null;

/**
 * Xenova/transformers로 임베딩 생성 (로컬, 외부 의존 없음)
 */
async function getEmbedding(text: string): Promise<number[]> {
  try {
    // 파이프라인 초기화 (첫 호출 시 모델 다운로드, 이후 캐시)
    if (!embeddingPipeline && !pipelineInitializing) {
      pipelineInitializing = true;
      console.log('[Memory] Loading embedding model (first time may take a while)...');
      embeddingPipeline = await pipeline('feature-extraction', EMBEDDING_MODEL, {
        quantized: true,  // 더 빠른 로딩, 약간의 품질 손실
      });
      console.log('[Memory] Embedding model loaded:', EMBEDDING_MODEL);
      pipelineInitializing = false;
    }

    // 초기화 중이면 대기
    while (pipelineInitializing && !embeddingPipeline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!embeddingPipeline) {
      throw new Error('Embedding pipeline not initialized');
    }

    // E5 모델은 "query: " 또는 "passage: " 접두사 권장
    const input = `query: ${text.slice(0, 512)}`;  // 토큰 제한
    const result = await embeddingPipeline(input, {
      pooling: 'mean',
      normalize: true,
    });

    // Float32Array → number[]
    return Array.from(result.data as Float32Array);
  } catch (error) {
    console.error('[Memory] Embedding error:', error);
    return new Array(EMBEDDING_DIM).fill(0);
  }
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
async function initDatabase(): Promise<void> {
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
function calculateFreshness(createdAt: number, halfLifeDays: number = 7): number {
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
 * 메모리 검색 (PRD Hybrid Retrieval)
 */
export async function searchMemory(
  query: string,
  options: SearchOptions = {}
): Promise<MemorySearchResult[]> {
  try {
    await initDatabase();
    if (!table) return [];

    const {
      types,
      repo,
      minSimilarity = 0.4,
      minTrust = 0.3,
      minFreshness = 0,
      limit = 10,          // PRD 권장: 5-12
      includeExpired = false,
    } = options;

    const queryVector = await getEmbedding(query);
    const results = await table.vectorSearch(queryVector).limit(limit * 5).toArray();

    const now = Date.now();

    // Hybrid Retrieval with PRD scoring
    const scored = results
      .filter((r: any) => {
        if (r.id === 'init') return false;

        // 만료 체크
        if (!includeExpired && r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now) return false;

        // 타입 필터
        if (types && !types.includes(r.type)) return false;

        // 저장소 필터
        if (repo && r.repo !== repo && r.repo !== 'system' && r.repo !== 'cognitive') return false;

        // 신뢰도/confidence 필터
        const confidence = r.confidence ?? r.trust ?? 0;
        if (confidence < minTrust) return false;

        // 유사도 필터
        const similarity = r._distance ? 1 - r._distance : 0;
        if (similarity < minSimilarity) return false;

        return true;
      })
      .map((r: any) => {
        const similarity = r._distance ? 1 - r._distance : 0;
        const recency = calculateFreshness(r.createdAt);
        const importance = r.importance ?? calculateImportance(r.type);
        const accessCount = r.accessCount ?? 1;

        // Decay 적용
        const effectiveImportance = importance * (1 - (r.decay ?? 0));

        // PRD Hybrid Score
        const hybridScore = calculateHybridScore(
          similarity,
          effectiveImportance,
          recency,
          accessCount
        );

        return {
          record: r,
          similarity,
          recency,
          importance: effectiveImportance,
          hybridScore,
        };
      })
      // 신선도 필터
      .filter(item => item.recency >= minFreshness)
      // Hybrid Score로 정렬 (PRD: not similarity-only!)
      .sort((a, b) => b.hybridScore - a.hybridScore)
      .slice(0, limit);

    // Update last_accessed for retrieved memories (async, don't wait)
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
      score: hybridScore,           // hybrid score, not just similarity
      freshness: recency,
      // PRD additions
      importance,
      confidence: r.confidence ?? r.trust ?? 0.7,
      stability: r.stability ?? 'medium',
      revisionCount: r.revisionCount ?? 0,
      decay: r.decay ?? 0,
      similarityScore: similarity,  // raw similarity for debugging
    }));

    console.log(`[Memory] Found ${formatted.length} memories (hybrid retrieval, query: "${query.slice(0, 30)}...")`);
    return formatted;
  } catch (error) {
    console.error('[Memory] Search error:', error);
    return [];
  }
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

// ==============================================
// Memory Revision Loop (PRD Phase 3)
// ==============================================

/**
 * Revise existing belief with new information
 * PRD: append-only 탈피 - 기존 belief 수정
 */
export async function reviseMemory(
  memoryId: string,
  newContent: string,
  options?: {
    newConfidence?: number;
    reason?: string;
  }
): Promise<boolean> {
  try {
    await initDatabase();
    if (!table || !db) return false;

    // Find existing memory
    const results = await table.search(new Array(EMBEDDING_DIM).fill(0)).limit(10000).toArray();
    const existing = results.find((r: any) => r.id === memoryId);

    if (!existing) {
      console.log(`[Memory] Revision failed: memory ${memoryId} not found`);
      return false;
    }

    const now = Date.now();
    const newRevisionCount = (existing.revisionCount ?? 0) + 1;
    const age = now - existing.createdAt;

    // Create revised record
    const revised: CognitiveMemoryRecord = {
      ...existing,
      content: newContent,
      vector: await getEmbedding(newContent),
      lastUpdated: now,
      revisionCount: newRevisionCount,
      confidence: options?.newConfidence ?? Math.max(0.3, (existing.confidence ?? 0.7) - 0.1),
      stability: calculateStability(newRevisionCount, age),
      metadata: JSON.stringify({
        ...JSON.parse(existing.metadata || '{}'),
        lastRevision: {
          timestamp: now,
          reason: options?.reason || 'manual revision',
          previousContent: existing.content.slice(0, 200),
        },
      }),
    };

    // LanceDB doesn't support update, so we delete and re-add
    // Create new table without the old record, then add revised
    const allRecords = results.filter((r: any) => r.id !== memoryId);
    allRecords.push(revised);

    // Recreate table with updated data (정규화 적용)
    const tableName = 'cognitive_memory';
    await db.dropTable(tableName);
    table = await db.createTable(tableName, normalizeRecords(allRecords));

    console.log(`[Memory] Revised ${memoryId} (rev: ${newRevisionCount}, stability: ${revised.stability})`);
    return true;
  } catch (error) {
    console.error('[Memory] Revision error:', error);
    return false;
  }
}

/**
 * Find contradicting memories
 * PRD: semantic conflict 탐지
 */
export async function findContradictions(content: string): Promise<MemorySearchResult[]> {
  try {
    // Search for similar content
    const similar = await searchMemory(content, {
      minSimilarity: 0.6,
      limit: 20,
    });

    // Contradiction detection heuristics
    const contradictionKeywords = [
      { positive: /항상|always|must|반드시/i, negative: /절대|never|금지|안됨/i },
      { positive: /좋|effective|works|성공/i, negative: /나쁨|ineffective|fails|실패/i },
      { positive: /사용|use|enable|활성/i, negative: /사용안함|disable|비활성/i },
    ];

    const contradictions: MemorySearchResult[] = [];

    for (const memory of similar) {
      // Check for opposite sentiment patterns
      for (const { positive, negative } of contradictionKeywords) {
        const contentHasPositive = positive.test(content);
        const contentHasNegative = negative.test(content);
        const memoryHasPositive = positive.test(memory.content);
        const memoryHasNegative = negative.test(memory.content);

        // Contradiction: one has positive, other has negative
        if ((contentHasPositive && memoryHasNegative) || (contentHasNegative && memoryHasPositive)) {
          contradictions.push(memory);
          break;
        }
      }
    }

    if (contradictions.length > 0) {
      console.log(`[Memory] Found ${contradictions.length} potential contradictions`);
    }

    return contradictions;
  } catch (error) {
    console.error('[Memory] Contradiction detection error:', error);
    return [];
  }
}

/**
 * Mark memories as contradicting each other
 */
export async function markContradiction(memoryId1: string, memoryId2: string): Promise<boolean> {
  try {
    await initDatabase();
    if (!table || !db) return false;

    const results = await table.search(new Array(EMBEDDING_DIM).fill(0)).limit(10000).toArray();
    const memory1 = results.find((r: any) => r.id === memoryId1);
    const memory2 = results.find((r: any) => r.id === memoryId2);

    if (!memory1 || !memory2) {
      console.log('[Memory] Cannot mark contradiction: one or both memories not found');
      return false;
    }

    // Update contradicts arrays
    const contradicts1 = JSON.parse(memory1.contradicts || '[]');
    const contradicts2 = JSON.parse(memory2.contradicts || '[]');

    if (!contradicts1.includes(memoryId2)) contradicts1.push(memoryId2);
    if (!contradicts2.includes(memoryId1)) contradicts2.push(memoryId1);

    memory1.contradicts = JSON.stringify(contradicts1);
    memory2.contradicts = JSON.stringify(contradicts2);

    // Lower importance for both (PRD: 모순 발생 시 importance 감소)
    memory1.importance = Math.max(0.2, (memory1.importance ?? 0.5) - 0.15);
    memory2.importance = Math.max(0.2, (memory2.importance ?? 0.5) - 0.15);

    // Recreate table (정규화 적용)
    const tableName = 'cognitive_memory';
    await db.dropTable(tableName);
    table = await db.createTable(tableName, normalizeRecords(results));

    console.log(`[Memory] Marked contradiction between ${memoryId1} and ${memoryId2}`);
    return true;
  } catch (error) {
    console.error('[Memory] Mark contradiction error:', error);
    return false;
  }
}

/**
 * Reconcile contradicting beliefs (choose one, archive other)
 */
export async function reconcileContradiction(
  keepId: string,
  archiveId: string,
  reason: string
): Promise<boolean> {
  try {
    await initDatabase();
    if (!table || !db) return false;

    const results = await table.search(new Array(EMBEDDING_DIM).fill(0)).limit(10000).toArray();
    const keepMemory = results.find((r: any) => r.id === keepId);
    const archiveMemory = results.find((r: any) => r.id === archiveId);

    if (!keepMemory || !archiveMemory) {
      console.log('[Memory] Cannot reconcile: one or both memories not found');
      return false;
    }

    // Boost kept memory
    keepMemory.confidence = Math.min(1, (keepMemory.confidence ?? 0.7) + 0.1);
    keepMemory.stability = 'high';

    // Archive the other (set high decay, low importance)
    archiveMemory.decay = 0.9;
    archiveMemory.importance = 0.1;
    archiveMemory.metadata = JSON.stringify({
      ...JSON.parse(archiveMemory.metadata || '{}'),
      archived: {
        timestamp: Date.now(),
        reason,
        supersededBy: keepId,
      },
    });

    // Recreate table (정규화 적용)
    const tableName = 'cognitive_memory';
    await db.dropTable(tableName);
    table = await db.createTable(tableName, normalizeRecords(results));

    console.log(`[Memory] Reconciled: kept ${keepId}, archived ${archiveId}`);
    return true;
  } catch (error) {
    console.error('[Memory] Reconciliation error:', error);
    return false;
  }
}

/**
 * 메모리를 컨텍스트로 포맷 (PRD v2.0 - Cognitive + Legacy)
 */
export function formatMemoryContext(memories: MemorySearchResult[]): string {
  if (memories.length === 0) return '';

  // Cognitive + Legacy types
  const grouped: Record<string, MemorySearchResult[]> = {
    // Cognitive (PRD)
    constraint: [],
    user_model: [],
    strategy: [],
    belief: [],
    system_pattern: [],
    // Legacy
    decision: [],
    repomap: [],
    journal: [],
    fact: [],
  };

  for (const m of memories) {
    if (grouped[m.type]) {
      grouped[m.type].push(m);
    }
  }

  const sections: string[] = [];

  // PRD Cognitive Types (높은 importance 순)
  if (grouped.constraint.length > 0) {
    const items = grouped.constraint.map(m =>
      `- ⚠️ **${m.content.slice(0, 100)}** (importance: ${(m.importance * 100).toFixed(0)}%, stability: ${m.stability})`
    ).join('\n');
    sections.push(`### 🚫 제약조건 (CRITICAL)\n${items}`);
  }

  if (grouped.user_model.length > 0) {
    const items = grouped.user_model.map(m =>
      `- **${m.content.slice(0, 100)}** (confidence: ${(m.confidence * 100).toFixed(0)}%)`
    ).join('\n');
    sections.push(`### 👤 사용자 성향\n${items}`);
  }

  if (grouped.strategy.length > 0) {
    const items = grouped.strategy.map(m =>
      `- **${m.content.slice(0, 100)}** (검증됨: ${m.stability === 'high' ? '✓' : '△'})`
    ).join('\n');
    sections.push(`### 🎯 검증된 전략\n${items}`);
  }

  if (grouped.belief.length > 0) {
    const items = grouped.belief.map(m =>
      `- ${m.content.slice(0, 100)} (rev: ${m.revisionCount}, decay: ${(m.decay * 100).toFixed(0)}%)`
    ).join('\n');
    sections.push(`### 💡 Beliefs\n${items}`);
  }

  if (grouped.system_pattern.length > 0) {
    const items = grouped.system_pattern.map(m =>
      `- **${m.content.slice(0, 100)}**`
    ).join('\n');
    sections.push(`### 🏗️ 시스템 패턴\n${items}`);
  }

  // Legacy Types
  if (grouped.decision.length > 0) {
    const items = grouped.decision.map(m =>
      `- **${m.title}** (${formatDate(m.createdAt)}, 신뢰도: ${(m.trust * 100).toFixed(0)}%)\n  ${m.content.slice(0, 150)}...`
    ).join('\n');
    sections.push(`### 📋 관련 설계 결정 (참고용)\n${items}`);
  }

  if (grouped.fact.length > 0) {
    const items = grouped.fact.map(m =>
      `- **${m.title}**: ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`
    ).join('\n');
    sections.push(`### 📌 관련 팩트 (참고용)\n${items}`);
  }

  if (grouped.repomap.length > 0) {
    const items = grouped.repomap.map(m =>
      `- **${m.repo}**: ${m.title}`
    ).join('\n');
    sections.push(`### 🗂️ 저장소 구조 (참고용)\n${items}`);
  }

  if (grouped.journal.length > 0) {
    const items = grouped.journal.map(m =>
      `- [${formatDate(m.createdAt)}] **${m.title}** (신선도: ${(m.freshness * 100).toFixed(0)}%)`
    ).join('\n');
    sections.push(`### 📝 최근 작업 기록 (참고용)\n${items}`);
  }

  if (sections.length === 0) return '';

  return `## 🧠 Cognitive Memory (PRD v2.0)\n\n${sections.join('\n\n')}\n\n---\n⚠️ 위 정보는 참고용입니다. 현재 상황과 다를 수 있으니 필요시 직접 확인하세요.`;
}

/**
 * 날짜 포맷
 */
function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('ko-KR', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * 만료된 메모리 정리
 */
export async function cleanupExpired(): Promise<number> {
  try {
    await initDatabase();
    if (!table || !db) return 0;

    const now = Date.now();
    const results = await table.search(new Array(EMBEDDING_DIM).fill(0)).limit(10000).toArray();

    const expiredIds = results
      .filter((r: any) => r.expiresAt < PERMANENT_EXPIRY && r.expiresAt < now)
      .map((r: any) => r.id);

    if (expiredIds.length > 0) {
      // LanceDB는 직접 삭제가 어려워서 새 테이블로 교체 필요
      // 여기서는 로깅만
      console.log(`[Memory] Found ${expiredIds.length} expired records`);
    }

    return expiredIds.length;
  } catch (error) {
    console.error('[Memory] Cleanup error:', error);
    return 0;
  }
}

// ==============================================
// Background Cognition (PRD Phase 4)
// ==============================================

// Decay and archive thresholds
const DECAY_INCREMENT = 0.03;      // PRD: decay += 0.03 weekly if not accessed
const ARCHIVE_THRESHOLD = 0.7;    // PRD: threshold 초과 시 archive
const CONSOLIDATION_SIMILARITY = 0.85;  // 중복 판단 기준

/**
 * Apply decay to all memories (Background Worker)
 * PRD: 망각은 기능이다
 */
export async function applyMemoryDecay(daysSinceLastRun: number = 7): Promise<{
  decayed: number;
  archived: number;
}> {
  try {
    await initDatabase();
    if (!table || !db) return { decayed: 0, archived: 0 };

    const results = await table.search(new Array(EMBEDDING_DIM).fill(0)).limit(10000).toArray();
    const now = Date.now();

    let decayed = 0;
    let archived = 0;

    for (const r of results) {
      if (r.id === 'init') continue;

      // Calculate days since last access
      const lastAccess = r.lastAccessed ?? r.createdAt ?? now;
      const daysSinceAccess = (now - lastAccess) / (24 * 60 * 60 * 1000);

      // Apply decay if not accessed recently
      if (daysSinceAccess > 7) {
        const weeksNotAccessed = Math.floor(daysSinceAccess / 7);
        const decayAmount = Math.min(DECAY_INCREMENT * weeksNotAccessed * (daysSinceLastRun / 7), 0.3);
        r.decay = Math.min(1, (r.decay ?? 0) + decayAmount);
        decayed++;

        // Archive if decay exceeds threshold
        if (r.decay >= ARCHIVE_THRESHOLD) {
          r.metadata = JSON.stringify({
            ...JSON.parse(r.metadata || '{}'),
            archived: {
              timestamp: now,
              reason: 'decay_threshold_exceeded',
              finalDecay: r.decay,
            },
          });
          r.importance = 0.05;  // Near zero but not deleted
          archived++;
        }
      }
    }

    if (decayed > 0) {
      // Recreate table (정규화 적용)
      const tableName = 'cognitive_memory';
      await db.dropTable(tableName);
      table = await db.createTable(tableName, normalizeRecords(results));
      console.log(`[Memory] Decay applied: ${decayed} memories decayed, ${archived} archived`);
    }

    return { decayed, archived };
  } catch (error) {
    console.error('[Memory] Decay error:', error);
    return { decayed: 0, archived: 0 };
  }
}

/**
 * Consolidate duplicate/similar memories
 * PRD: Memory Consolidation - 중복 merge
 */
export async function consolidateMemories(): Promise<{
  merged: number;
  groups: Array<{ kept: string; merged: string[] }>;
}> {
  try {
    await initDatabase();
    if (!table || !db) return { merged: 0, groups: [] };

    const results = await table.search(new Array(EMBEDDING_DIM).fill(0)).limit(10000).toArray();
    const validMemories = results.filter((r: any) => r.id !== 'init');

    const merged: string[] = [];
    const groups: Array<{ kept: string; merged: string[] }> = [];

    // Find similar memory groups
    for (let i = 0; i < validMemories.length; i++) {
      const m1 = validMemories[i];
      if (merged.includes(m1.id)) continue;

      const similarGroup: any[] = [m1];

      for (let j = i + 1; j < validMemories.length; j++) {
        const m2 = validMemories[j];
        if (merged.includes(m2.id)) continue;
        if (m1.type !== m2.type) continue;

        // Calculate cosine similarity
        const similarity = cosineSimilarity(m1.vector, m2.vector);

        if (similarity >= CONSOLIDATION_SIMILARITY) {
          similarGroup.push(m2);
          merged.push(m2.id);
        }
      }

      // Merge if group has duplicates
      if (similarGroup.length > 1) {
        // Keep the one with highest importance * confidence
        similarGroup.sort((a, b) =>
          (b.importance ?? 0.5) * (b.confidence ?? 0.5) -
          (a.importance ?? 0.5) * (a.confidence ?? 0.5)
        );

        const kept = similarGroup[0];
        const toMerge = similarGroup.slice(1);

        // Boost kept memory
        kept.confidence = Math.min(1, (kept.confidence ?? 0.7) + 0.05 * toMerge.length);
        kept.revisionCount = (kept.revisionCount ?? 0) + toMerge.length;

        groups.push({
          kept: kept.id,
          merged: toMerge.map((m: any) => m.id),
        });

        console.log(`[Memory] Consolidated ${toMerge.length} duplicates into ${kept.id}`);
      }
    }

    if (merged.length > 0) {
      // Remove merged memories
      const remainingRecords = results.filter((r: any) => !merged.includes(r.id));

      // Recreate table (정규화 적용)
      const tableName = 'cognitive_memory';
      await db.dropTable(tableName);
      table = await db.createTable(tableName, normalizeRecords(remainingRecords));

      console.log(`[Memory] Consolidation complete: ${merged.length} memories merged`);
    }

    return { merged: merged.length, groups };
  } catch (error) {
    console.error('[Memory] Consolidation error:', error);
    return { merged: 0, groups: [] };
  }
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;

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
 * Run all background cognitive tasks
 * PRD: 6-12시간 주기 권장
 */
export async function runBackgroundCognition(): Promise<{
  decay: { decayed: number; archived: number };
  consolidation: { merged: number };
  contradictions: number;
}> {
  console.log('[Memory] Starting background cognition tasks...');

  // 1. Apply decay
  const decayResult = await applyMemoryDecay();

  // 2. Consolidate duplicates
  const consolidationResult = await consolidateMemories();

  // 3. Detect contradictions (log only, don't auto-resolve)
  const stats = await getMemoryStats();
  let contradictionCount = 0;

  // Sample check for contradictions among high-importance beliefs
  const highImportanceMemories = await searchMemory('', {
    types: ['belief', 'strategy', 'constraint'],
    minSimilarity: 0,
    limit: 50,
  });

  for (const memory of highImportanceMemories) {
    const contradictions = await findContradictions(memory.content);
    if (contradictions.length > 0) {
      contradictionCount += contradictions.length;
    }
  }

  console.log('[Memory] Background cognition complete:', {
    decayed: decayResult.decayed,
    archived: decayResult.archived,
    merged: consolidationResult.merged,
    potentialContradictions: contradictionCount,
  });

  return {
    decay: decayResult,
    consolidation: { merged: consolidationResult.merged },
    contradictions: contradictionCount,
  };
}

// Default stats object with all memory types
const DEFAULT_BY_TYPE: Record<MemoryType, number> = {
  // Cognitive types
  belief: 0,
  strategy: 0,
  user_model: 0,
  system_pattern: 0,
  constraint: 0,
  // Legacy types
  decision: 0,
  repomap: 0,
  journal: 0,
  fact: 0,
};

/**
 * 메모리 통계 (PRD v2.0)
 */
export async function getMemoryStats(): Promise<{
  total: number;
  byType: Record<MemoryType, number>;
  byRepo: Record<string, number>;
  avgImportance: number;
  avgDecay: number;
}> {
  try {
    await initDatabase();
    if (!table) return { total: 0, byType: { ...DEFAULT_BY_TYPE }, byRepo: {}, avgImportance: 0, avgDecay: 0 };

    const results = await table.search(new Array(EMBEDDING_DIM).fill(0)).limit(10000).toArray();

    const byType: Record<MemoryType, number> = { ...DEFAULT_BY_TYPE };
    const byRepo: Record<string, number> = {};
    let totalImportance = 0;
    let totalDecay = 0;
    let count = 0;

    for (const r of results) {
      if (r.id === 'init') continue;
      if (byType[r.type as MemoryType] !== undefined) {
        byType[r.type as MemoryType]++;
      }
      byRepo[r.repo] = (byRepo[r.repo] || 0) + 1;
      totalImportance += r.importance ?? 0.5;
      totalDecay += r.decay ?? 0;
      count++;
    }

    return {
      total: count,
      byType,
      byRepo,
      avgImportance: count > 0 ? totalImportance / count : 0,
      avgDecay: count > 0 ? totalDecay / count : 0,
    };
  } catch (error) {
    console.error('[Memory] Stats error:', error);
    return { total: 0, byType: { ...DEFAULT_BY_TYPE }, byRepo: {}, avgImportance: 0, avgDecay: 0 };
  }
}

// ============================================
// 레거시 호환 함수 (기존 코드 지원)
// ============================================

/**
 * 대화 저장 (레거시 호환)
 */
export async function saveConversation(
  channelId: string,
  userId: string,
  userName: string,
  content: string,
  response: string,
): Promise<void> {
  await logWork(
    'discord',
    `Chat with ${userName}`,
    `Q: ${content}\n\nA: ${response}`,
    undefined,
    channelId
  );
}

/**
 * 최근 대화 가져오기 (createdAt 기준 정렬)
 * - 시맨틱 검색이 아닌 시간순 조회
 * - channelId는 derivedFrom 필드에 저장됨 (legacy: metadata.issueRef)
 */
export async function getRecentConversations(
  channelId: string,
  limit: number = 10,
): Promise<MemorySearchResult[]> {
  try {
    await initDatabase();
    if (!table) return [];

    // journal 타입 + discord repo 필터링 후 createdAt 내림차순
    const results = await table
      .search(new Array(EMBEDDING_DIM).fill(0))  // dummy vector for full scan
      .limit(1000)  // 충분히 큰 수
      .toArray();

    // 필터: journal + discord (channelId는 느슨하게 - 기존 데이터 호환)
    const filtered = results
      .filter((r: any) => {
        if (r.type !== 'journal' || r.repo !== 'discord') return false;

        // channelId 매칭: derivedFrom 또는 metadata.issueRef
        if (!channelId) return true;  // 전체
        if (r.derivedFrom === channelId) return true;
        if (r.derivedFrom === 'unknown') return true;  // legacy 데이터 포함

        // metadata.issueRef fallback
        try {
          const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata;
          if (meta?.issueRef === channelId) return true;
        } catch { /* ignore */ }

        return false;
      })
      .sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0))  // 최신순
      .slice(0, limit);

    // MemorySearchResult 형태로 변환
    return filtered.map((r: any) => ({
      id: r.id,
      type: r.type,
      repo: r.repo,
      title: r.title,
      content: r.content,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata || '{}') : r.metadata,
      trust: r.trust,
      createdAt: r.createdAt,
      score: 1.0,  // 시간순 조회라 score 무의미
      freshness: calculateFreshness(r.createdAt),
      importance: r.importance,
      confidence: r.confidence,
      stability: r.stability,
      revisionCount: r.revisionCount,
      decay: r.decay,
      similarityScore: 1.0,
    }));
  } catch (error) {
    console.error('[Memory] getRecentConversations error:', error);
    return [];
  }
}
