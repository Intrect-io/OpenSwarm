// ============================================
// OpenSwarm - Code Registry SQLite Store
// Created: 2026-04-10
// Purpose: better-sqlite3 기반 코드 엔티티 레지스트리
// Dependencies: better-sqlite3, nanoid
// ============================================

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { DEFAULT_BUSY_TIMEOUT_MS, enableWalWithRetry } from '../support/sqliteWal.js';
import type {
  CodeEntity, CodeEntityFilter, EntityKind, EntityStatus, RiskLevel,
  EntityEvent, EntityEventType, EntityWarning, EntityTag,
  WarningSeverity, WarningCategory, RelationType,
  FileBrief, RegistryStats,
} from './schema.js';
import {
  SQLITE_IN_CHUNK_SIZE,
  rowToEntity as mapRowToEntity,
  rowToEvent as mapRowToEvent,
  rowToWarning as mapRowToWarning,
  rowsToEntities as mapRowsToEntities,
  type EntityRow, type EventRow, type IssueLinkRow, type RelationRow, type WarningRow,
  type CountRow, type KindCountRow, type StatusCountRow, type TagRow, type MemoryLinkRow,
} from './sqliteStoreRows.js';

const DEFAULT_DB_PATH = resolve(homedir(), '.openswarm', 'registry.db');

/** Store-level page cap for listEntities — callers must paginate with this size. */
export const LIST_ENTITIES_MAX_LIMIT = 5_000;
export const LIST_ENTITIES_DEFAULT_LIMIT = 50;

/**
 * Store-level page cap for the risk/status helper queries (deprecated,
 * untested, high-risk). These were unbounded full-table scans; callers that
 * need more must paginate with limit/offset (the GraphQL resolvers route
 * through the bounded listEntities instead). (AGT-3421)
 */
export const HELPER_QUERY_MAX_LIMIT = 200;

/**
 * Cap on entities loaded per issue-id lookup. A scanner that links every
 * entity to one issue must not drag the whole registry (with its tags,
 * warnings, and links) into memory; callers needing more must chunk by issue.
 */
export const ISSUE_LINK_MAX_ENTITIES = 200;

function clampInteger(value: number, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
}

function toLiteralFtsQuery(search: string): string | null {
  const terms = search.split('').map((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : char;
  }).join('').trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND ');
}

// ============ 인터페이스 ============

export interface RegisterEntityInput {
  projectId: string;
  kind: EntityKind;
  name: string;
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  signature?: string;
  status?: EntityStatus;
  hasTests?: boolean;
  testFile?: string;
  author?: string;
  maintainer?: string;
  complexityScore?: number;
  riskLevel?: RiskLevel;
  description?: string;
  notes?: string;
  knowledgeNodeId?: string;
  tags?: { tag: string; value?: string }[];
}

export interface UpdateEntityInput {
  name?: string;
  lineStart?: number;
  lineEnd?: number;
  signature?: string;
  hasTests?: boolean;
  testFile?: string;
  maintainer?: string;
  complexityScore?: number;
  riskLevel?: RiskLevel;
  description?: string;
  notes?: string;
}

export interface EventData {
  oldValue?: string;
  newValue?: string;
  content?: string;
  actor?: string;
}

// ============ Store 구현 ============

export class SqliteRegistryStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = resolve(dbPath ?? DEFAULT_DB_PATH);
    mkdirSync(resolve(path, '..'), { recursive: true });
    this.db = new Database(path);

    // Install the wait policy before the WAL conversion, then retry the
    // conversion itself. The CLI, the daemon and the dashboard all open this
    // store, so a single unguarded attempt turns a concurrent open into a hard
    // crash in this constructor. See support/sqliteWal.ts.
    //
    // Setup can now fail where it previously could not, so the handle has to be
    // closed on the way out — a leaked connection would keep its own locks
    // alive for the life of the process.
    try {
      this.db.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
      enableWalWithRetry(this.db, DEFAULT_BUSY_TIMEOUT_MS);
      this.db.pragma('foreign_keys = ON');
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_entities (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_start INTEGER,
        line_end INTEGER,
        signature TEXT,
        status TEXT DEFAULT 'active',
        deprecated_at TEXT,
        deprecated_reason TEXT,
        has_tests INTEGER DEFAULT 0,
        test_file TEXT,
        author TEXT,
        maintainer TEXT,
        complexity_score INTEGER,
        risk_level TEXT DEFAULT 'low',
        description TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        knowledge_node_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS code_entity_tags (
        entity_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (entity_id, tag),
        FOREIGN KEY (entity_id) REFERENCES code_entities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS code_entity_warnings (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        resolved INTEGER DEFAULT 0,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES code_entities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS code_entity_relations (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        PRIMARY KEY (source_id, target_id, relation_type),
        FOREIGN KEY (source_id) REFERENCES code_entities(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES code_entities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS code_entity_issue_links (
        entity_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        PRIMARY KEY (entity_id, issue_id),
        FOREIGN KEY (entity_id) REFERENCES code_entities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS code_entity_memory_links (
        entity_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        PRIMARY KEY (entity_id, memory_id),
        FOREIGN KEY (entity_id) REFERENCES code_entities(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS code_entity_events (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        type TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        content TEXT,
        actor TEXT DEFAULT 'system',
        created_at TEXT NOT NULL,
        FOREIGN KEY (entity_id) REFERENCES code_entities(id) ON DELETE CASCADE
      );

      -- FTS5 전문검색
      CREATE VIRTUAL TABLE IF NOT EXISTS code_entities_fts USING fts5(
        name, qualified_name, description, notes, signature,
        content=code_entities, content_rowid=rowid
      );

      -- 인덱스
      CREATE INDEX IF NOT EXISTS idx_ce_project ON code_entities(project_id);
      CREATE INDEX IF NOT EXISTS idx_ce_kind ON code_entities(kind);
      CREATE INDEX IF NOT EXISTS idx_ce_file ON code_entities(file_path);
      CREATE INDEX IF NOT EXISTS idx_ce_status ON code_entities(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ce_project_qualified_name ON code_entities(project_id, qualified_name);
      CREATE INDEX IF NOT EXISTS idx_ce_has_tests ON code_entities(has_tests);
      CREATE INDEX IF NOT EXISTS idx_ce_risk ON code_entities(risk_level);
      CREATE INDEX IF NOT EXISTS idx_ce_knowledge ON code_entities(knowledge_node_id);
      CREATE INDEX IF NOT EXISTS idx_ce_events_entity ON code_entity_events(entity_id);
      CREATE INDEX IF NOT EXISTS idx_ce_events_created ON code_entity_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_ce_tags_tag ON code_entity_tags(tag);
      CREATE INDEX IF NOT EXISTS idx_ce_warnings_sev ON code_entity_warnings(severity);
      CREATE INDEX IF NOT EXISTS idx_ce_warnings_entity ON code_entity_warnings(entity_id);

      -- FTS 트리거
      CREATE TRIGGER IF NOT EXISTS ce_fts_ai AFTER INSERT ON code_entities BEGIN
        INSERT INTO code_entities_fts(rowid, name, qualified_name, description, notes, signature)
        VALUES (new.rowid, new.name, new.qualified_name, new.description, new.notes, new.signature);
      END;
      CREATE TRIGGER IF NOT EXISTS ce_fts_ad AFTER DELETE ON code_entities BEGIN
        INSERT INTO code_entities_fts(code_entities_fts, rowid, name, qualified_name, description, notes, signature)
        VALUES ('delete', old.rowid, old.name, old.qualified_name, old.description, old.notes, old.signature);
      END;
      CREATE TRIGGER IF NOT EXISTS ce_fts_au AFTER UPDATE ON code_entities BEGIN
        INSERT INTO code_entities_fts(code_entities_fts, rowid, name, qualified_name, description, notes, signature)
        VALUES ('delete', old.rowid, old.name, old.qualified_name, old.description, old.notes, old.signature);
        INSERT INTO code_entities_fts(rowid, name, qualified_name, description, notes, signature)
        VALUES (new.rowid, new.name, new.qualified_name, new.description, new.notes, new.signature);
      END;
    `);
  }

  // ============ 엔티티 CRUD ============

  registerEntity(input: RegisterEntityInput): CodeEntity {
    const id = nanoid(12);
    const now = new Date().toISOString();
    const qualifiedName = `${input.filePath}::${input.name}`;

    const insertEntity = this.db.prepare(`
      INSERT INTO code_entities (
        id, project_id, kind, name, qualified_name, file_path,
        line_start, line_end, signature, status,
        has_tests, test_file, author, maintainer,
        complexity_score, risk_level, description, notes,
        knowledge_node_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTag = this.db.prepare(
      'INSERT OR IGNORE INTO code_entity_tags (entity_id, tag, value) VALUES (?, ?, ?)'
    );

    const insertEvent = this.db.prepare(`
      INSERT INTO code_entity_events (id, entity_id, type, new_value, actor, created_at)
      VALUES (?, ?, 'created', ?, 'system', ?)
    `);

    const transaction = this.db.transaction(() => {
      insertEntity.run(
        id, input.projectId, input.kind, input.name, qualifiedName, input.filePath,
        input.lineStart ?? null, input.lineEnd ?? null, input.signature ?? null,
        input.status ?? 'active',
        input.hasTests ? 1 : 0, input.testFile ?? null,
        input.author ?? null, input.maintainer ?? null,
        input.complexityScore ?? null, input.riskLevel ?? 'low',
        input.description ?? '', input.notes ?? '',
        input.knowledgeNodeId ?? null, now, now,
      );

      for (const t of input.tags ?? []) {
        insertTag.run(id, t.tag, t.value ?? null);
      }

      insertEvent.run(nanoid(12), id, input.name, now);
    });

    transaction();
    const entity = this.getEntity(id);
    if (!entity) throw new Error(`Failed to register entity: ${qualifiedName} — row not found after insert`);
    return entity;
  }

  bulkRegisterEntities(inputs: RegisterEntityInput[]): CodeEntity[] {
    const results: CodeEntity[] = [];
    const transaction = this.db.transaction(() => {
      for (const input of inputs) {
        results.push(this.registerEntity(input));
      }
    });
    transaction();
    return results;
  }

  getEntity(id: string): CodeEntity | null {
    const row = this.db.prepare('SELECT * FROM code_entities WHERE id = ?').get(id) as EntityRow | undefined;
    if (!row) return null;
    return this.rowToEntity(row);
  }

  getEntityByName(qualifiedName: string, projectId?: string): CodeEntity | null {
    const row = projectId
      ? this.db.prepare(
        'SELECT * FROM code_entities WHERE project_id = ? AND qualified_name = ?'
      ).get(projectId, qualifiedName) as EntityRow | undefined
      : this.db.prepare(
        'SELECT * FROM code_entities WHERE qualified_name = ? ORDER BY project_id LIMIT 1'
      ).get(qualifiedName) as EntityRow | undefined;
    if (!row) return null;
    return this.rowToEntity(row);
  }

  updateEntity(id: string, patch: UpdateEntityInput, actor = 'system'): CodeEntity | null {
    const existing = this.getEntity(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];

    const fieldMap: Record<string, string> = {
      name: 'name', lineStart: 'line_start', lineEnd: 'line_end',
      signature: 'signature', hasTests: 'has_tests', testFile: 'test_file',
      maintainer: 'maintainer', complexityScore: 'complexity_score',
      riskLevel: 'risk_level', description: 'description', notes: 'notes',
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in patch && (patch as Record<string, unknown>)[key] !== undefined) {
        const val = (patch as Record<string, unknown>)[key];
        fields.push(`${col} = ?`);
        values.push(key === 'hasTests' ? (val ? 1 : 0) : (val ?? null));
      }
    }

    if (fields.length === 0) return existing;

    // qualified_name 갱신 (name 변경 시)
    if (patch.name && patch.name !== existing.name) {
      fields.push('qualified_name = ?');
      values.push(`${existing.filePath}::${patch.name}`);
    }

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    this.db.prepare(`UPDATE code_entities SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    this.addEvent(id, 'updated', {
      content: `fields: ${Object.keys(patch).join(', ')}`,
      actor,
    });

    return this.getEntity(id);
  }

  removeEntity(id: string): boolean {
    const result = this.db.prepare('DELETE FROM code_entities WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listEntities(filter?: CodeEntityFilter): { entities: CodeEntity[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.projectId) {
      conditions.push('e.project_id = ?');
      params.push(filter.projectId);
    }
    if (filter?.kind && filter.kind.length > 0) {
      conditions.push(`e.kind IN (${filter.kind.map(() => '?').join(',')})`);
      params.push(...filter.kind);
    }
    if (filter?.status && filter.status.length > 0) {
      conditions.push(`e.status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }
    if (filter?.filePath) {
      conditions.push('e.file_path = ?');
      params.push(filter.filePath);
    }
    if (filter?.hasTests !== undefined) {
      conditions.push('e.has_tests = ?');
      params.push(filter.hasTests ? 1 : 0);
    }
    if (filter?.riskLevel && filter.riskLevel.length > 0) {
      conditions.push(`e.risk_level IN (${filter.riskLevel.map(() => '?').join(',')})`);
      params.push(...filter.riskLevel);
    }
    if (filter?.author) {
      conditions.push('e.author = ?');
      params.push(filter.author);
    }
    if (filter?.tags && filter.tags.length > 0) {
      conditions.push(`e.id IN (
        SELECT entity_id FROM code_entity_tags WHERE tag IN (${filter.tags.map(() => '?').join(',')})
      )`);
      params.push(...filter.tags);
    }

    // FTS 전문검색
    let ftsJoin = '';
    const ftsQuery = filter?.search ? toLiteralFtsQuery(filter.search) : null;
    if (ftsQuery) {
      ftsJoin = 'INNER JOIN code_entities_fts ON code_entities_fts.rowid = e.rowid';
      conditions.push('code_entities_fts MATCH ?');
      params.push(ftsQuery);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rawLimit = filter?.limit ?? LIST_ENTITIES_DEFAULT_LIMIT;
    const limit = Math.min(
      LIST_ENTITIES_MAX_LIMIT,
      Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : LIST_ENTITIES_DEFAULT_LIMIT),
    );
    const offset = clampInteger(filter?.offset ?? 0, 0);

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM code_entities e ${ftsJoin} ${where}`
    ).get(...params) as CountRow;
    const total = countRow.cnt;

    const rows = this.db.prepare(`
      SELECT e.* FROM code_entities e ${ftsJoin} ${where}
      ORDER BY e.file_path, e.line_start NULLS LAST, e.name
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as EntityRow[];

    return {
      entities: this.rowsToEntities(rows),
      total,
    };
  }

  // ============ 상태 관리 ============

  deprecateEntity(id: string, reason?: string, actor = 'system'): CodeEntity | null {
    const existing = this.getEntity(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE code_entities SET status = 'deprecated', deprecated_at = ?, deprecated_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(now, reason ?? null, now, id);

    this.addEvent(id, 'deprecated', {
      oldValue: existing.status,
      newValue: 'deprecated',
      content: reason,
      actor,
    });

    return this.getEntity(id);
  }

  changeEntityStatus(id: string, status: EntityStatus, actor = 'system'): CodeEntity | null {
    const existing = this.getEntity(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE code_entities SET status = ?, updated_at = ? WHERE id = ?'
    ).run(status, now, id);

    this.addEvent(id, 'status_changed', {
      oldValue: existing.status,
      newValue: status,
      actor,
    });

    return this.getEntity(id);
  }

  // ============ 태그 ============

  addTag(entityId: string, tag: string, value?: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO code_entity_tags (entity_id, tag, value) VALUES (?, ?, ?)'
    ).run(entityId, tag, value ?? null);

    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE code_entities SET updated_at = ? WHERE id = ?'
    ).run(now, entityId);

    this.addEvent(entityId, 'tag_added', { newValue: tag });
  }

  removeTag(entityId: string, tag: string): void {
    const result = this.db.prepare(
      'DELETE FROM code_entity_tags WHERE entity_id = ? AND tag = ?'
    ).run(entityId, tag);

    if (result.changes > 0) {
      const now = new Date().toISOString();
      this.db.prepare('UPDATE code_entities SET updated_at = ? WHERE id = ?').run(now, entityId);
      this.addEvent(entityId, 'tag_removed', { oldValue: tag });
    }
  }

  getTags(entityId: string): EntityTag[] {
    return (this.db.prepare(
      'SELECT tag, value FROM code_entity_tags WHERE entity_id = ?'
    ).all(entityId) as TagRow[]).map(r => ({ tag: r.tag, value: r.value ?? undefined }));
  }

  // ============ 경고 ============

  addWarning(
    entityId: string, severity: WarningSeverity,
    category: WarningCategory, message: string,
  ): EntityWarning {
    const id = nanoid(12);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO code_entity_warnings (id, entity_id, severity, category, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, entityId, severity, category, message, now);

    this.db.prepare(
      'UPDATE code_entities SET updated_at = ? WHERE id = ?'
    ).run(now, entityId);

    this.addEvent(entityId, 'warning_added', {
      newValue: `${severity}:${category}`,
      content: message,
    });

    return {
      id, entityId, severity, category, message,
      resolved: false, createdAt: now,
    };
  }

  resolveWarning(warningId: string): boolean {
    const now = new Date().toISOString();
    const warning = this.db.prepare(
      'SELECT * FROM code_entity_warnings WHERE id = ?'
    ).get(warningId) as WarningRow | undefined;
    if (!warning) return false;

    this.db.prepare(
      'UPDATE code_entity_warnings SET resolved = 1, resolved_at = ? WHERE id = ?'
    ).run(now, warningId);

    this.addEvent(warning.entity_id, 'warning_resolved', {
      oldValue: `${warning.severity}:${warning.category}`,
      content: warning.message,
    });

    return true;
  }

  getWarnings(entityId: string): EntityWarning[] {
    return (this.db.prepare(
      'SELECT * FROM code_entity_warnings WHERE entity_id = ? ORDER BY created_at DESC'
    ).all(entityId) as WarningRow[]).map(this.rowToWarning);
  }

  getUnresolvedWarnings(
    severity?: WarningSeverity,
    projectId?: string,
    limit = 200,
    offset = 0,
  ): EntityWarning[] {
    const conditions = ['w.resolved = 0'];
    const params: unknown[] = [];
    if (severity) {
      conditions.push('w.severity = ?');
      params.push(severity);
    }
    if (projectId) {
      conditions.push('e.project_id = ?');
      params.push(projectId);
    }

    return (this.db.prepare(
      `SELECT w.* FROM code_entity_warnings w
       JOIN code_entities e ON e.id = w.entity_id
       WHERE ${conditions.join(' AND ')} ORDER BY
        CASE w.severity WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
        w.created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, clampInteger(limit, 200, 200), clampInteger(offset, 0)) as WarningRow[]).map(this.rowToWarning);
  }

  // ============ 관계 ============

  addRelation(sourceId: string, targetId: string, relationType: RelationType): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO code_entity_relations (source_id, target_id, relation_type) VALUES (?, ?, ?)'
    ).run(sourceId, targetId, relationType);
  }

  removeRelation(sourceId: string, targetId: string, relationType: RelationType): void {
    this.db.prepare(
      'DELETE FROM code_entity_relations WHERE source_id = ? AND target_id = ? AND relation_type = ?'
    ).run(sourceId, targetId, relationType);
  }

  getRelations(entityId: string): Array<{ targetId: string; targetName: string; relationType: RelationType }> {
    return (this.db.prepare(`
      SELECT r.target_id, e.name as target_name, r.relation_type
      FROM code_entity_relations r
      JOIN code_entities e ON e.id = r.target_id
      WHERE r.source_id = ?
    `).all(entityId) as RelationRow[]).map(r => ({
      targetId: r.target_id,
      targetName: r.target_name,
      relationType: r.relation_type as RelationType,
    }));
  }

  // ============ 이슈/메모리 연결 ============

  linkIssue(entityId: string, issueId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT OR IGNORE INTO code_entity_issue_links (entity_id, issue_id, linked_at) VALUES (?, ?, ?)'
    ).run(entityId, issueId, now);
    this.addEvent(entityId, 'issue_linked', { newValue: issueId });
  }

  unlinkIssue(entityId: string, issueId: string): void {
    this.db.prepare(
      'DELETE FROM code_entity_issue_links WHERE entity_id = ? AND issue_id = ?'
    ).run(entityId, issueId);
  }

  getLinkedIssues(entityId: string): string[] {
    return (this.db.prepare(
      'SELECT issue_id FROM code_entity_issue_links WHERE entity_id = ? ORDER BY linked_at'
    ).all(entityId) as IssueLinkRow[]).map(r => r.issue_id);
  }

  /** 이슈 ID로 연결된 엔티티 목록 반환 (역방향 조회 — 배치 로딩 + 상한 적용) */
  getEntitiesByIssueId(issueId: string, projectId?: string): CodeEntity[] {
    const linkRows = this.db.prepare(
      `SELECT l.entity_id, l.issue_id FROM code_entity_issue_links l
       JOIN code_entities e ON e.id = l.entity_id
       WHERE l.issue_id = ? ${projectId ? 'AND e.project_id = ?' : ''}
       LIMIT ?`
    ).all(...(projectId ? [issueId, projectId] : [issueId]), ISSUE_LINK_MAX_ENTITIES) as IssueLinkRow[];

    if (linkRows.length === 0) return [];

    // Batch-load the linked entities (chunked IN) instead of one getEntity()
    // call per row; preserve the linked_at order of the link rows.
    const orderedIds = [...new Set(linkRows.map(r => r.entity_id))];
    const rows: EntityRow[] = [];
    for (let i = 0; i < orderedIds.length; i += SQLITE_IN_CHUNK_SIZE) {
      const chunk = orderedIds.slice(i, i + SQLITE_IN_CHUNK_SIZE);
      rows.push(...this.db.prepare(
        `SELECT * FROM code_entities WHERE id IN (${chunk.map(() => '?').join(',')})`
      ).all(...chunk) as EntityRow[]);
    }
    const entityById = new Map(this.rowsToEntities(rows).map(e => [e.id, e]));
    return orderedIds.flatMap((id) => {
      const entity = entityById.get(id);
      return entity ? [entity] : [];
    });
  }

  linkMemory(entityId: string, memoryId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT OR IGNORE INTO code_entity_memory_links (entity_id, memory_id, linked_at) VALUES (?, ?, ?)'
    ).run(entityId, memoryId, now);
    this.addEvent(entityId, 'memory_linked', { newValue: memoryId });
  }

  getLinkedMemories(entityId: string): string[] {
    return (this.db.prepare(
      'SELECT memory_id FROM code_entity_memory_links WHERE entity_id = ? ORDER BY linked_at'
    ).all(entityId) as MemoryLinkRow[]).map(r => r.memory_id);
  }

  // ============ 이벤트 ============

  addEvent(entityId: string, type: EntityEventType, data?: EventData): EntityEvent {
    const id = nanoid(12);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO code_entity_events (id, entity_id, type, old_value, new_value, content, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, entityId, type,
      data?.oldValue ?? null, data?.newValue ?? null,
      data?.content ?? null, data?.actor ?? 'system', now,
    );
    this.db.prepare(`
      DELETE FROM code_entity_events
      WHERE entity_id = ? AND id NOT IN (
        SELECT id FROM code_entity_events WHERE entity_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 1000
      )
    `).run(entityId, entityId);

    return {
      id, entityId, type,
      oldValue: data?.oldValue,
      newValue: data?.newValue,
      content: data?.content,
      actor: data?.actor ?? 'system',
      createdAt: now,
    };
  }

  getEvents(entityId: string, limit = 50): EntityEvent[] {
    return (this.db.prepare(
      'SELECT * FROM code_entity_events WHERE entity_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(entityId, limit) as EventRow[]).map(this.rowToEvent);
  }

  // ============ 특화 쿼리 ============

  fileBrief(filePath: string, projectId?: string): FileBrief {
    const rows = projectId
      ? this.db.prepare(
        'SELECT * FROM code_entities WHERE project_id = ? AND file_path = ? ORDER BY line_start NULLS LAST, name'
      ).all(projectId, filePath) as EntityRow[]
      : this.db.prepare(
        'SELECT * FROM code_entities WHERE file_path = ? ORDER BY line_start NULLS LAST, name'
      ).all(filePath) as EntityRow[];

    const entities = this.rowsToEntities(rows);

    const deprecated = entities.filter(e => e.status === 'deprecated').length;
    const untested = entities.filter(e => !e.hasTests).length;
    const warnings = entities.reduce((sum, e) => sum + e.warnings.filter(w => !w.resolved).length, 0);
    const broken = entities.filter(e => e.status === 'broken').length;

    const parts: string[] = [`${entities.length} entities`];
    if (deprecated > 0) parts.push(`${deprecated} deprecated`);
    if (untested > 0) parts.push(`${untested} untested`);
    if (warnings > 0) parts.push(`${warnings} warnings`);
    if (broken > 0) parts.push(`${broken} broken`);

    return {
      filePath,
      summary: parts.join(', '),
      entities,
    };
  }

  deprecatedEntities(
    projectId?: string,
    limit = HELPER_QUERY_MAX_LIMIT,
    offset = 0,
  ): CodeEntity[] {
    const where = projectId
      ? "WHERE status = 'deprecated' AND project_id = ?"
      : "WHERE status = 'deprecated'";
    const params = projectId ? [projectId] : [];

    const rows = this.db.prepare(
      `SELECT * FROM code_entities ${where} ORDER BY deprecated_at DESC LIMIT ? OFFSET ?`
    ).all(...params, clampInteger(limit, HELPER_QUERY_MAX_LIMIT, HELPER_QUERY_MAX_LIMIT), clampInteger(offset, 0)) as EntityRow[];
    return this.rowsToEntities(rows);
  }

  untestedEntities(
    projectId?: string,
    limit = HELPER_QUERY_MAX_LIMIT,
    offset = 0,
  ): CodeEntity[] {
    const where = projectId
      ? "WHERE has_tests = 0 AND status = 'active' AND project_id = ?"
      : "WHERE has_tests = 0 AND status = 'active'";
    const params = projectId ? [projectId] : [];

    const rows = this.db.prepare(
      `SELECT * FROM code_entities ${where} ORDER BY
        CASE risk_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        complexity_score DESC NULLS LAST
      LIMIT ? OFFSET ?`
    ).all(...params, clampInteger(limit, HELPER_QUERY_MAX_LIMIT, HELPER_QUERY_MAX_LIMIT), clampInteger(offset, 0)) as EntityRow[];
    return this.rowsToEntities(rows);
  }

  highRiskEntities(
    projectId?: string,
    limit = HELPER_QUERY_MAX_LIMIT,
    offset = 0,
  ): CodeEntity[] {
    const where = projectId
      ? "WHERE risk_level = 'high' AND project_id = ?"
      : "WHERE risk_level = 'high'";
    const params = projectId ? [projectId] : [];

    const rows = this.db.prepare(
      `SELECT * FROM code_entities ${where} ORDER BY complexity_score DESC NULLS LAST LIMIT ? OFFSET ?`
    ).all(...params, clampInteger(limit, HELPER_QUERY_MAX_LIMIT, HELPER_QUERY_MAX_LIMIT), clampInteger(offset, 0)) as EntityRow[];
    return this.rowsToEntities(rows);
  }

  entitiesByTag(
    tag: string,
    value?: string,
    projectId?: string,
    limit = 200,
    offset = 0,
  ): CodeEntity[] {
    const projectFilter = projectId ? 'AND e.project_id = ?' : '';
    const query = value !== undefined
      ? `SELECT e.* FROM code_entities e
         JOIN code_entity_tags t ON t.entity_id = e.id
         WHERE t.tag = ? AND t.value = ? ${projectFilter}`
      : `SELECT e.* FROM code_entities e
         JOIN code_entity_tags t ON t.entity_id = e.id
         WHERE t.tag = ? ${projectFilter}`;
    const params: unknown[] = value !== undefined ? [tag, value] : [tag];
    if (projectId) params.push(projectId);

    const rows = this.db.prepare(`${query} ORDER BY e.file_path, e.line_start NULLS LAST, e.name LIMIT ? OFFSET ?`)
      .all(...params, clampInteger(limit, 200, 200), clampInteger(offset, 0)) as EntityRow[];
    return this.rowsToEntities(rows);
  }

  searchEntities(query: string, limit = 20, projectId?: string): CodeEntity[] {
    const ftsQuery = toLiteralFtsQuery(query);
    if (!ftsQuery) return [];
    // FTS5 검색 시도
    let ftsRows: EntityRow[] = [];
    try {
      const projectFilter = projectId ? 'AND e.project_id = ?' : '';
      const params = projectId ? [ftsQuery, projectId, limit] : [ftsQuery, limit];
      ftsRows = this.db.prepare(`
        SELECT e.* FROM code_entities e
        INNER JOIN code_entities_fts ON code_entities_fts.rowid = e.rowid
        WHERE code_entities_fts MATCH ?
        ${projectFilter}
        LIMIT ?
      `).all(...params) as EntityRow[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('fts5') && !msg.includes('MATCH')) {
        console.warn('[Registry] searchEntities FTS error:', msg);
      }
    }

    let results = this.rowsToEntities(ftsRows);

    // FTS 결과가 부족하면 LIKE 폴백 (camelCase, 부분 매칭)
    if (results.length < limit) {
      const escapedQuery = query.replace(/[\\%_]/g, ch => `\\${ch}`);
      const likePattern = `%${escapedQuery}%`;
      const existingIds = new Set(results.map(e => e.id));
      const projectFilter = projectId ? 'AND project_id = ?' : '';
      const params = projectId
        ? [likePattern, likePattern, likePattern, likePattern, likePattern, projectId, limit]
        : [likePattern, likePattern, likePattern, likePattern, likePattern, limit];
      const fallbackRows = this.db.prepare(`
        SELECT * FROM code_entities
        WHERE (name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR signature LIKE ? ESCAPE '\\')
        ${projectFilter}
        LIMIT ?
      `).all(...params) as EntityRow[];
      const fallback = this.rowsToEntities(fallbackRows)
        .filter(e => !existingIds.has(e.id));

      results.push(...fallback.slice(0, limit - results.length));
    }

    return results;
  }

  // ============ 통계 ============

  getStats(projectId?: string): RegistryStats {
    const where = projectId ? 'WHERE project_id = ?' : '';
    const params = projectId ? [projectId] : [];

    const total = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM code_entities ${where}`
    ).get(...params) as CountRow).cnt;

    const byKind = (this.db.prepare(
      `SELECT kind, COUNT(*) as cnt FROM code_entities ${where} GROUP BY kind`
    ).all(...params) as KindCountRow[]).map(r => ({ kind: r.kind, count: r.cnt }));

    const byStatus = (this.db.prepare(
      `SELECT status, COUNT(*) as cnt FROM code_entities ${where} GROUP BY status`
    ).all(...params) as StatusCountRow[]).map(r => ({ status: r.status, count: r.cnt }));

    const deprecated = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM code_entities ${where ? where + " AND" : "WHERE"} status = 'deprecated'`
    ).get(...params) as CountRow).cnt;

    const untested = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM code_entities ${where ? where + " AND" : "WHERE"} has_tests = 0 AND status = 'active'`
    ).get(...params) as CountRow).cnt;

    const highRisk = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM code_entities ${where ? where + " AND" : "WHERE"} risk_level = 'high'`
    ).get(...params) as CountRow).cnt;

    const withWarnings = (this.db.prepare(
      projectId
        ? `SELECT COUNT(DISTINCT w.entity_id) as cnt FROM code_entity_warnings w
           JOIN code_entities e ON e.id = w.entity_id
           WHERE w.resolved = 0 AND e.project_id = ?`
        : `SELECT COUNT(DISTINCT entity_id) as cnt FROM code_entity_warnings WHERE resolved = 0`
    ).get(...params) as CountRow).cnt;

    return { total, byKind, byStatus, deprecated, untested, highRisk, withWarnings };
  }

  // ============ 유틸 ============

  close(): void {
    this.db.close();
  }

  // Row conversion lives in sqliteStoreRows.ts (AGT-3421 LOC split); these
  // delegators keep the class call sites unchanged.
  private rowToEntity(row: EntityRow): CodeEntity { return mapRowToEntity(this.db, row, this); }
  private rowsToEntities(rows: EntityRow[]): CodeEntity[] { return mapRowsToEntities(this.db, rows); }
  private rowToWarning(row: WarningRow) { return mapRowToWarning(row); }
  private rowToEvent(row: EventRow) { return mapRowToEvent(row); }
}

// 싱글톤
let storeInstance: SqliteRegistryStore | null = null;
let storeInstancePath: string | null = null;

export function getRegistryStore(dbPath?: string): SqliteRegistryStore {
  const requestedPath = resolve(dbPath ?? DEFAULT_DB_PATH);
  if (!storeInstance) {
    storeInstance = new SqliteRegistryStore(requestedPath);
    storeInstancePath = requestedPath;
  } else if (storeInstancePath !== requestedPath) {
    throw new Error(`Registry store already opened for ${storeInstancePath}; close it before opening ${requestedPath}`);
  }
  return storeInstance;
}

export function closeRegistryStore(): void {
  if (storeInstance) {
    storeInstance.close();
    storeInstance = null;
    storeInstancePath = null;
  }
}
