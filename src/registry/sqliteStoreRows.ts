// ============================================
// OpenSwarm - Registry SQLite row mapping helpers
// ============================================
//
// Row shapes and conversion logic extracted from sqliteStore.ts (AGT-3421
// LOC split) — pure mapping over better-sqlite3 rows, no store state.

import type { Database } from 'better-sqlite3';
import type {
  CodeEntity, EntityEvent, EntityEventType, EntityKind, EntityStatus, EntityTag, EntityWarning,
  RiskLevel, WarningCategory, WarningSeverity,
} from './schema.js';

/** Chunk size for `IN (...)` batch loads — SQLite's host-parameter cap is 999. */
export const SQLITE_IN_CHUNK_SIZE = 500;

// ============ DB Row 타입 (better-sqlite3 반환값) ============

export interface EntityRow {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  signature: string | null;
  status: string;
  deprecated_at: string | null;
  deprecated_reason: string | null;
  has_tests: number;
  test_file: string | null;
  author: string | null;
  maintainer: string | null;
  complexity_score: number | null;
  risk_level: string;
  description: string | null;
  notes: string | null;
  knowledge_node_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarningRow {
  id: string;
  entity_id: string;
  severity: string;
  category: string;
  message: string;
  resolved: number;
  resolved_at: string | null;
  created_at: string;
}

export interface EventRow {
  id: string;
  entity_id: string;
  type: string;
  old_value: string | null;
  new_value: string | null;
  content: string | null;
  actor: string;
  created_at: string;
}

export interface TagRow {
  tag: string;
  value: string | null;
}

export interface RelationRow {
  target_id: string;
  target_name: string;
  relation_type: string;
}

export interface CountRow {
  cnt: number;
}

export interface KindCountRow {
  kind: string;
  cnt: number;
}

export interface StatusCountRow {
  status: string;
  cnt: number;
}

export interface IssueLinkRow {
  entity_id: string;
  issue_id: string;
}

export interface MemoryLinkRow {
  entity_id: string;
  memory_id: string;
}

/** Relation loaders the single-row conversion needs (satisfied by the store). */
export interface EntityRelationLoaders {
  getTags(entityId: string): EntityTag[];
  getWarnings(entityId: string): EntityWarning[];
  getLinkedIssues(entityId: string): string[];
  getLinkedMemories(entityId: string): string[];
}

export function rowToWarning(row: WarningRow): EntityWarning {
  return {
    id: row.id,
    entityId: row.entity_id,
    severity: row.severity as WarningSeverity,
    category: row.category as WarningCategory,
    message: row.message,
    resolved: row.resolved === 1,
    resolvedAt: row.resolved_at ?? undefined,
    createdAt: row.created_at,
  };
}

export function rowToEvent(row: EventRow): EntityEvent {
  return {
    id: row.id,
    entityId: row.entity_id,
    type: row.type as EntityEventType,
    oldValue: row.old_value ?? undefined,
    newValue: row.new_value ?? undefined,
    content: row.content ?? undefined,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

export function buildEntity(
  row: EntityRow,
  tags: EntityTag[],
  warnings: EntityWarning[],
  linkedIssueIds: string[],
  linkedMemoryIds: string[],
): CodeEntity {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as EntityKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    lineStart: row.line_start ?? undefined,
    lineEnd: row.line_end ?? undefined,
    signature: row.signature ?? undefined,
    status: row.status as EntityStatus,
    deprecatedAt: row.deprecated_at ?? undefined,
    deprecatedReason: row.deprecated_reason ?? undefined,
    hasTests: row.has_tests === 1,
    testFile: row.test_file ?? undefined,
    author: row.author ?? undefined,
    maintainer: row.maintainer ?? undefined,
    complexityScore: row.complexity_score ?? undefined,
    riskLevel: row.risk_level as RiskLevel,
    description: row.description ?? '',
    notes: row.notes ?? '',
    knowledgeNodeId: row.knowledge_node_id ?? undefined,
    tags,
    warnings,
    linkedIssueIds,
    linkedMemoryIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 단일 엔티티 변환 (개별 서브쿼리 — 단건 조회용) */
export function rowToEntity(
  db: Database,
  row: EntityRow,
  loaders: EntityRelationLoaders,
): CodeEntity {
  const id = row.id;
  return buildEntity(
    row,
    loaders.getTags(id),
    loaders.getWarnings(id),
    loaders.getLinkedIssues(id),
    loaders.getLinkedMemories(id),
  );
}

/** 배치 엔티티 변환 (N+1 방지 — 리스트 조회용) */
export function rowsToEntities(db: Database, rows: EntityRow[]): CodeEntity[] {
  if (rows.length === 0) return [];

  const ids = rows.map(r => r.id);
  const loadByIds = <T>(sqlForPlaceholders: (placeholders: string) => string): T[] => {
    const loaded: T[] = [];
    for (let i = 0; i < ids.length; i += SQLITE_IN_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + SQLITE_IN_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      loaded.push(...db.prepare(sqlForPlaceholders(placeholders)).all(...chunk) as T[]);
    }
    return loaded;
  };

  // 배치 태그 로딩
  const tagRows = loadByIds<TagRow & { entity_id: string }>(
    placeholders => `SELECT entity_id, tag, value FROM code_entity_tags WHERE entity_id IN (${placeholders})`
  );
  const tagsByEntity = new Map<string, EntityTag[]>();
  for (const r of tagRows) {
    const list = tagsByEntity.get(r.entity_id) ?? [];
    list.push({ tag: r.tag, value: r.value ?? undefined });
    tagsByEntity.set(r.entity_id, list);
  }

  // 배치 경고 로딩
  const warningRows = loadByIds<WarningRow>(
    placeholders => `SELECT * FROM code_entity_warnings WHERE entity_id IN (${placeholders}) ORDER BY created_at DESC`
  );
  const warningsByEntity = new Map<string, EntityWarning[]>();
  for (const r of warningRows) {
    const list = warningsByEntity.get(r.entity_id) ?? [];
    list.push(rowToWarning(r));
    warningsByEntity.set(r.entity_id, list);
  }

  // 배치 이슈 링크 로딩
  const issueRows = loadByIds<IssueLinkRow>(
    placeholders => `SELECT entity_id, issue_id FROM code_entity_issue_links WHERE entity_id IN (${placeholders}) ORDER BY linked_at`
  );
  const issuesByEntity = new Map<string, string[]>();
  for (const r of issueRows) {
    const list = issuesByEntity.get(r.entity_id) ?? [];
    list.push(r.issue_id);
    issuesByEntity.set(r.entity_id, list);
  }

  // 배치 메모리 링크 로딩
  const memoryRows = loadByIds<MemoryLinkRow>(
    placeholders => `SELECT entity_id, memory_id FROM code_entity_memory_links WHERE entity_id IN (${placeholders}) ORDER BY linked_at`
  );
  const memorysByEntity = new Map<string, string[]>();
  for (const r of memoryRows) {
    const list = memorysByEntity.get(r.entity_id) ?? [];
    list.push(r.memory_id);
    memorysByEntity.set(r.entity_id, list);
  }

  return rows.map(row => buildEntity(
    row,
    tagsByEntity.get(row.id) ?? [],
    warningsByEntity.get(row.id) ?? [],
    issuesByEntity.get(row.id) ?? [],
    memorysByEntity.get(row.id) ?? [],
  ));
}
