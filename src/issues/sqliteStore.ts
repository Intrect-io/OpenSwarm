// ============================================
// OpenSwarm - SQLite Issue Store
// Created: 2026-04-03
// Purpose: better-sqlite3 기반 이슈 저장소
// Dependencies: better-sqlite3, nanoid
// ============================================

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { chmodSync, mkdirSync } from 'node:fs';
import { DEFAULT_BUSY_TIMEOUT_MS, enableWalWithRetry } from '../support/sqliteWal.js';
import type {
  Issue, IssueFilter, IssueEvent, IssueEventType,
  Label, Milestone, IssueStatus, IssuePriority, IssueSource,
} from './schema.js';

const DEFAULT_DB_PATH = resolve(homedir(), '.openswarm', 'issues.db');

// SQLite 스토어 인터페이스 (향후 다른 백엔드 교체 가능)
export interface IIssueStore {
  // 이슈 CRUD
  createIssue(input: CreateIssueInput): Issue;
  getIssue(id: string): Issue | null;
  updateIssue(id: string, patch: Partial<CreateIssueInput>): Issue | null;
  deleteIssue(id: string): boolean;
  listIssues(filter?: IssueFilter): { issues: Issue[]; total: number };

  // 상태 전이
  changeStatus(id: string, status: IssueStatus, actor?: string): Issue | null;

  // 이벤트 로그
  addEvent(issueId: string, type: IssueEventType, data?: EventData): IssueEvent;
  getEvents(issueId: string, limit?: number): IssueEvent[];
  getRecentEvents(limit?: number): IssueEvent[];

  // 라벨
  createLabel(name: string, color?: string, description?: string): Label;
  listLabels(): Label[];
  deleteLabel(id: string): boolean;

  // 마일스톤
  createMilestone(name: string, description?: string, dueDate?: string): Milestone;
  listMilestones(): Milestone[];

  // 메모리 연동
  linkMemory(issueId: string, memoryId: string): void;
  getLinkedMemories(issueId: string): string[];

  // 통계
  getStats(projectId?: string): IssueStats;

  // 종료
  close(): void;
}

export interface CreateIssueInput {
  /** Caller-provided stable ID for idempotent local issue creation. */
  id?: string;
  projectId: string;
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  source?: IssueSource;
  labels?: string[];
  assignee?: string;
  milestone?: string;
  relevantFiles?: string[];
  acceptanceCriteria?: string[];
  estimateMinutes?: number;
  complexity?: 'simple' | 'moderate' | 'complex' | 'very_complex';
  dependencies?: string[];
  parentId?: string;
  linearId?: string;
  linearIdentifier?: string;
  linearUrl?: string;
}

export interface EventData {
  oldValue?: string;
  newValue?: string;
  content?: string;
  memoryId?: string;
  actor?: string;
  /** Stable key for an idempotent event insert. */
  idempotencyKey?: string;
}

export interface IssueStats {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  byProject: Record<string, number>;
  recentlyCreated: number;  // 최근 7일
  recentlyClosed: number;   // 최근 7일
}

/**
 * Owner-only permissions on the database and any WAL sidecars already present.
 *
 * Best-effort: a store on a filesystem without POSIX modes, or one owned by
 * another account, must not stop the CLI from opening it.
 */
function restrictDatabasePermissions(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(file, 0o600);
    } catch {
      // Sidecars may not exist yet, and a non-POSIX filesystem has no modes.
    }
  }
}

export class SqliteIssueStore implements IIssueStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;
    // 0700/0600 rather than the process umask. This store holds issue titles,
    // descriptions and task history for every tracked repository; on a shared
    // machine the default 0644 leaves all of it readable by any local account.
    //
    // Tightening the main file is enough for the -wal and -shm sidecars too:
    // SQLite creates them with the database's own mode, verified on disk. The
    // test asserts the property rather than this mechanism, so it still holds if
    // that ever stops being true.
    mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    restrictDatabasePermissions(path);

    // WAL for concurrency. Install the wait policy first and retry the
    // conversion: the CLI, the daemon and the dashboard all open this store, so
    // a single unguarded attempt turns a concurrent open into a hard crash in
    // this constructor. See support/sqliteWal.ts.
    //
    // Setup can now fail where it previously could not, so the handle has to be
    // closed on the way out — this store is a module singleton, and a leaked
    // connection would keep its own locks alive for the life of the process.
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
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT DEFAULT 'backlog',
        priority TEXT DEFAULT 'medium',
        source TEXT DEFAULT 'local',
        assignee TEXT,
        milestone TEXT,
        estimate_minutes INTEGER,
        complexity TEXT,
        parent_id TEXT,
        linear_id TEXT,
        linear_identifier TEXT,
        linear_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        FOREIGN KEY (parent_id) REFERENCES issues(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS issue_labels (
        issue_id TEXT NOT NULL,
        label_id TEXT NOT NULL,
        PRIMARY KEY (issue_id, label_id),
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
        FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS issue_dependencies (
        issue_id TEXT NOT NULL,
        depends_on_id TEXT NOT NULL,
        PRIMARY KEY (issue_id, depends_on_id),
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
        FOREIGN KEY (depends_on_id) REFERENCES issues(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS issue_relevant_files (
        issue_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        PRIMARY KEY (issue_id, file_path),
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS issue_acceptance_criteria (
        issue_id TEXT NOT NULL,
        criterion TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS issue_memory_links (
        issue_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        PRIMARY KEY (issue_id, memory_id),
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS issue_events (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        type TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        content TEXT,
        memory_id TEXT,
        actor TEXT DEFAULT 'system',
        created_at TEXT NOT NULL,
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS labels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT DEFAULT '#6B7280',
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        due_date TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT NOT NULL
      );

      -- FTS5 전문검색 인덱스
      CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
        title, description, content=issues, content_rowid=rowid
      );

      -- 인덱스
      CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
      CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
      CREATE INDEX IF NOT EXISTS idx_issues_priority ON issues(priority);
      CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id);
      CREATE INDEX IF NOT EXISTS idx_issues_linear ON issues(linear_id);
      CREATE INDEX IF NOT EXISTS idx_events_issue ON issue_events(issue_id);
      CREATE INDEX IF NOT EXISTS idx_events_created ON issue_events(created_at);

      -- FTS 트리거 (자동 동기화)
      CREATE TRIGGER IF NOT EXISTS issues_ai AFTER INSERT ON issues BEGIN
        INSERT INTO issues_fts(rowid, title, description)
        VALUES (new.rowid, new.title, new.description);
      END;
      CREATE TRIGGER IF NOT EXISTS issues_ad AFTER DELETE ON issues BEGIN
        INSERT INTO issues_fts(issues_fts, rowid, title, description)
        VALUES ('delete', old.rowid, old.title, old.description);
      END;
      CREATE TRIGGER IF NOT EXISTS issues_au AFTER UPDATE ON issues BEGIN
        INSERT INTO issues_fts(issues_fts, rowid, title, description)
        VALUES ('delete', old.rowid, old.title, old.description);
        INSERT INTO issues_fts(rowid, title, description)
        VALUES (new.rowid, new.title, new.description);
      END;

    `);
    const ftsMigration = this.db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get('issues_fts_v1');
    if (!ftsMigration) {
      this.db.transaction(() => {
        this.db.prepare("INSERT INTO issues_fts(issues_fts) VALUES('rebuild')").run();
        this.db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
          .run('issues_fts_v1', new Date().toISOString());
      })();
    }
  }

  // ============ 이슈 CRUD ============

  createIssue(input: CreateIssueInput): Issue {
    const id = input.id ?? nanoid(12);
    const now = new Date().toISOString();

    const insertIssue = this.db.prepare(`
      INSERT INTO issues (id, project_id, title, description, status, priority, source,
        assignee, milestone, estimate_minutes, complexity, parent_id,
        linear_id, linear_identifier, linear_url, created_at, updated_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertLabel = this.db.prepare(
      'INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)'
    );
    const insertDep = this.db.prepare(
      'INSERT OR IGNORE INTO issue_dependencies (issue_id, depends_on_id) VALUES (?, ?)'
    );
    const insertFile = this.db.prepare(
      'INSERT OR IGNORE INTO issue_relevant_files (issue_id, file_path) VALUES (?, ?)'
    );
    const insertCriteria = this.db.prepare(
      'INSERT INTO issue_acceptance_criteria (issue_id, criterion, sort_order) VALUES (?, ?, ?)'
    );
    const insertEvent = this.db.prepare(`
      INSERT INTO issue_events (id, issue_id, type, new_value, actor, created_at)
      VALUES (?, ?, 'created', ?, 'system', ?)
    `);
    // 부모 이슈의 child 목록은 쿼리 시 동적 조회

    const transaction = this.db.transaction(() => {
      insertIssue.run(
        id, input.projectId, input.title, input.description ?? '',
        input.status ?? 'backlog', input.priority ?? 'medium', input.source ?? 'local',
        input.assignee ?? null, input.milestone ?? null,
        input.estimateMinutes ?? null, input.complexity ?? null,
        input.parentId ?? null,
        input.linearId ?? null, input.linearIdentifier ?? null, input.linearUrl ?? null,
        now, now, input.status === 'done' || input.status === 'cancelled' ? now : null,
      );

      for (const label of input.labels ?? []) {
        const labelId = this.ensureLabelId(label);
        if (labelId) insertLabel.run(id, labelId);
      }
      for (const depId of input.dependencies ?? []) {
        insertDep.run(id, depId);
      }
      for (const filePath of input.relevantFiles ?? []) {
        insertFile.run(id, filePath);
      }
      for (let i = 0; i < (input.acceptanceCriteria ?? []).length; i++) {
        insertCriteria.run(id, input.acceptanceCriteria![i], i);
      }

      insertEvent.run(nanoid(12), id, input.title, now);
    });

    transaction();
    return this.getIssue(id)!;
  }

  getIssue(id: string): Issue | null {
    const row = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.rowToIssue(row);
  }

  getIssueByLinearId(linearId: string): Issue | null {
    const row = this.db.prepare('SELECT * FROM issues WHERE linear_id = ?').get(linearId) as any;
    if (!row) return null;
    return this.rowToIssue(row);
  }

  updateIssue(id: string, patch: Partial<CreateIssueInput>): Issue | null {
    const existing = this.getIssue(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: any[] = [];

    const fieldMap: Record<string, string> = {
      projectId: 'project_id', title: 'title', description: 'description',
      priority: 'priority', source: 'source',
      assignee: 'assignee', milestone: 'milestone',
      estimateMinutes: 'estimate_minutes', complexity: 'complexity',
      parentId: 'parent_id', linearId: 'linear_id',
      linearIdentifier: 'linear_identifier', linearUrl: 'linear_url',
    };

    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in patch) {
        fields.push(`${col} = ?`);
        values.push((patch as any)[key] ?? null);
      }
    }

    if (fields.length === 0 && patch.status === undefined && !patch.labels && !patch.dependencies
      && !patch.relevantFiles && !patch.acceptanceCriteria) {
      return existing;
    }

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const transaction = this.db.transaction(() => {
      if (fields.length > 1) {
        this.db.prepare(`UPDATE issues SET ${fields.join(', ')} WHERE id = ?`).run(...values);
      }

      if (patch.labels !== undefined) {
        this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(id);
        const ins = this.db.prepare('INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)');
        for (const label of patch.labels) {
          const labelId = this.ensureLabelId(label);
          if (labelId) ins.run(id, labelId);
        }
      }

      if (patch.dependencies !== undefined) {
        this.db.prepare('DELETE FROM issue_dependencies WHERE issue_id = ?').run(id);
        const ins = this.db.prepare('INSERT OR IGNORE INTO issue_dependencies (issue_id, depends_on_id) VALUES (?, ?)');
        for (const depId of patch.dependencies) ins.run(id, depId);
      }

      if (patch.relevantFiles !== undefined) {
        this.db.prepare('DELETE FROM issue_relevant_files WHERE issue_id = ?').run(id);
        const ins = this.db.prepare('INSERT OR IGNORE INTO issue_relevant_files (issue_id, file_path) VALUES (?, ?)');
        for (const fp of patch.relevantFiles) ins.run(id, fp);
      }

      if (patch.acceptanceCriteria !== undefined) {
        this.db.prepare('DELETE FROM issue_acceptance_criteria WHERE issue_id = ?').run(id);
        const ins = this.db.prepare('INSERT INTO issue_acceptance_criteria (issue_id, criterion, sort_order) VALUES (?, ?, ?)');
        for (let i = 0; i < patch.acceptanceCriteria.length; i++) {
          ins.run(id, patch.acceptanceCriteria[i], i);
        }
      }

      if (patch.status !== undefined) {
        this.applyStatusChange(id, existing.status, patch.status, 'system');
      }
    });

    transaction();
    return this.getIssue(id);
  }

  deleteIssue(id: string): boolean {
    const result = this.db.prepare('DELETE FROM issues WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listIssues(filter?: IssueFilter): { issues: Issue[]; total: number } {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filter?.projectId) {
      conditions.push('i.project_id = ?');
      params.push(filter.projectId);
    }
    if (filter?.status && filter.status.length > 0) {
      conditions.push(`i.status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }
    if (filter?.priority && filter.priority.length > 0) {
      conditions.push(`i.priority IN (${filter.priority.map(() => '?').join(',')})`);
      params.push(...filter.priority);
    }
    if (filter?.assignee) {
      conditions.push('i.assignee = ?');
      params.push(filter.assignee);
    }
    if (filter?.source) {
      conditions.push('i.source = ?');
      params.push(filter.source);
    }
    if (filter?.parentId) {
      conditions.push('i.parent_id = ?');
      params.push(filter.parentId);
    }
    if (filter?.labels && filter.labels.length > 0) {
      conditions.push(`i.id IN (
        SELECT il.issue_id FROM issue_labels il
        JOIN labels l ON l.id = il.label_id
        WHERE il.label_id IN (${filter.labels.map(() => '?').join(',')})
          OR l.name IN (${filter.labels.map(() => '?').join(',')})
      )`);
      params.push(...filter.labels, ...filter.labels);
    }

    // FTS 전문검색
    let ftsJoin = '';
    const ftsQuery = filter?.search ? toFtsQuery(filter.search) : null;
    if (ftsQuery) {
      ftsJoin = 'INNER JOIN issues_fts ON issues_fts.rowid = i.rowid';
      conditions.push('issues_fts MATCH ?');
      params.push(ftsQuery);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = normalizeLimit(filter?.limit, 50, 500);
    const offset = normalizeOffset(filter?.offset);

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM issues i ${ftsJoin} ${where}`
    ).get(...params) as any;
    const total = countRow.cnt;

    const rows = this.db.prepare(`
      SELECT i.* FROM issues i ${ftsJoin} ${where}
      ORDER BY
        CASE i.priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END,
        i.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];

    return {
      issues: rows.map((r) => this.rowToIssue(r)),
      total,
    };
  }

  // ============ 상태 전이 ============

  changeStatus(id: string, status: IssueStatus, actor?: string): Issue | null {
    const existing = this.getIssue(id);
    if (!existing) return null;

    this.applyStatusChange(id, existing.status, status, actor ?? 'system');
    return this.getIssue(id);
  }

  private applyStatusChange(id: string, oldStatus: IssueStatus, status: IssueStatus, actor: string): void {
    const now = new Date().toISOString();
    const closedAt = (status === 'done' || status === 'cancelled') ? now : null;

    this.db.prepare(`
      UPDATE issues SET status = ?, updated_at = ?, closed_at = ?
      WHERE id = ?
    `).run(status, now, closedAt, id);

    if (status !== oldStatus) {
      this.addEvent(id, 'status_changed', {
        oldValue: oldStatus,
        newValue: status,
        actor,
      });
    }
  }

  // ============ 이벤트 로그 ============

  addEvent(issueId: string, type: IssueEventType, data?: EventData): IssueEvent {
    const id = data?.idempotencyKey
      ? `os-${createHash('sha256').update(`issue-event:${data.idempotencyKey}`).digest('hex').slice(0, 24)}`
      : nanoid(12);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT OR IGNORE INTO issue_events (id, issue_id, type, old_value, new_value, content, memory_id, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, issueId, type,
      data?.oldValue ?? null, data?.newValue ?? null,
      data?.content ?? null, data?.memoryId ?? null,
      data?.actor ?? 'system', now,
    );

    const existing = this.db.prepare('SELECT * FROM issue_events WHERE id = ?').get(id) as any;
    if (
      existing.issue_id !== issueId
      || existing.type !== type
      || (existing.old_value ?? undefined) !== data?.oldValue
      || (existing.new_value ?? undefined) !== data?.newValue
      || (existing.content ?? undefined) !== data?.content
      || (existing.memory_id ?? undefined) !== data?.memoryId
      || existing.actor !== (data?.actor ?? 'system')
    ) {
      throw new Error(`Issue event idempotency key collision: ${data?.idempotencyKey}`);
    }
    return {
      id,
      issueId: existing.issue_id,
      type: existing.type,
      oldValue: existing.old_value ?? undefined,
      newValue: existing.new_value ?? undefined,
      content: existing.content ?? undefined,
      memoryId: existing.memory_id ?? undefined,
      actor: existing.actor,
      createdAt: existing.created_at,
    };
  }

  getEvents(issueId: string, limit = 50): IssueEvent[] {
    // rowid DESC is the tiebreaker: created_at is ms-precision TEXT, so events
    // written in the same millisecond (e.g. createIssue's 'created' + an
    // immediate addEvent) would otherwise order non-deterministically. rowid is
    // monotonic with insertion order, so the newest event always sorts first.
    return (this.db.prepare(
      'SELECT * FROM issue_events WHERE issue_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?'
    ).all(issueId, normalizeLimit(limit, 50, 500)) as any[]).map(this.rowToEvent);
  }

  getRecentEvents(limit = 20): IssueEvent[] {
    // rowid DESC tiebreaker for same-millisecond created_at — see getEvents.
    return (this.db.prepare(
      'SELECT * FROM issue_events ORDER BY created_at DESC, rowid DESC LIMIT ?'
    ).all(normalizeLimit(limit, 20, 500)) as any[]).map(this.rowToEvent);
  }

  // ============ 라벨 ============

  createLabel(name: string, color = '#6B7280', description?: string): Label {
    const existing = this.db.prepare('SELECT * FROM labels WHERE name = ? LIMIT 1').get(name) as any;
    if (existing) {
      return {
        id: existing.id,
        name: existing.name,
        color: existing.color,
        description: existing.description ?? undefined,
      };
    }

    const id = nanoid(8);
    this.db.prepare(
      'INSERT INTO labels (id, name, color, description) VALUES (?, ?, ?, ?)'
    ).run(id, name, color, description ?? null);
    return { id, name, color, description };
  }

  listLabels(): Label[] {
    return (this.db.prepare('SELECT * FROM labels ORDER BY name').all() as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      description: r.description ?? undefined,
    }));
  }

  deleteLabel(id: string): boolean {
    return this.db.prepare('DELETE FROM labels WHERE id = ?').run(id).changes > 0;
  }

  // ============ 마일스톤 ============

  createMilestone(name: string, description?: string, dueDate?: string): Milestone {
    const id = nanoid(8);
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO milestones (id, name, description, due_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, name, description ?? null, dueDate ?? null, 'active', now);
    return { id, name, description, dueDate, status: 'active', createdAt: now };
  }

  listMilestones(): Milestone[] {
    return (this.db.prepare('SELECT * FROM milestones ORDER BY due_date').all() as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? undefined,
      dueDate: r.due_date ?? undefined,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  // ============ 메모리 연동 ============

  linkMemory(issueId: string, memoryId: string): void {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      'INSERT OR IGNORE INTO issue_memory_links (issue_id, memory_id, linked_at) VALUES (?, ?, ?)'
    ).run(issueId, memoryId, now);
    if (result.changes > 0) this.addEvent(issueId, 'memory_linked', { memoryId });
  }

  getLinkedMemories(issueId: string): string[] {
    return (this.db.prepare(
      'SELECT memory_id FROM issue_memory_links WHERE issue_id = ? ORDER BY linked_at'
    ).all(issueId) as any[]).map((r) => r.memory_id);
  }

  // ============ 통계 ============

  getStats(projectId?: string): IssueStats {
    const where = projectId ? 'WHERE project_id = ?' : '';
    const params = projectId ? [projectId] : [];

    const total = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM issues ${where}`
    ).get(...params) as any).cnt;

    const byStatus: Record<string, number> = {};
    (this.db.prepare(
      `SELECT status, COUNT(*) as cnt FROM issues ${where} GROUP BY status`
    ).all(...params) as any[]).forEach((r) => { byStatus[r.status] = r.cnt; });

    const byPriority: Record<string, number> = {};
    (this.db.prepare(
      `SELECT priority, COUNT(*) as cnt FROM issues ${where} GROUP BY priority`
    ).all(...params) as any[]).forEach((r) => { byPriority[r.priority] = r.cnt; });

    // Scoped like every other field here. Without the filter this counted
    // across all projects while total/byStatus/byPriority counted one, so a
    // per-project stats view showed a breakdown whose numbers did not add up to
    // its own total.
    const byProject: Record<string, number> = {};
    (this.db.prepare(
      `SELECT project_id, COUNT(*) as cnt FROM issues ${where} GROUP BY project_id`
    ).all(...params) as any[]).forEach((r) => { byProject[r.project_id] = r.cnt; });

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const recentlyCreated = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM issues ${where ? where + ' AND' : 'WHERE'} created_at > ?`
    ).get(...params, sevenDaysAgo) as any).cnt;

    const recentlyClosed = (this.db.prepare(
      `SELECT COUNT(*) as cnt FROM issues ${where ? where + ' AND' : 'WHERE'} closed_at > ?`
    ).get(...params, sevenDaysAgo) as any).cnt;

    return { total, byStatus, byPriority, byProject, recentlyCreated, recentlyClosed };
  }

  // ============ 유틸 ============

  close(): void {
    this.db.close();
  }

  private rowToIssue(row: any): Issue {
    const id = row.id;

    const labels = (this.db.prepare(
      `SELECT COALESCE(l.name, il.label_id) as label
       FROM issue_labels il
       LEFT JOIN labels l ON l.id = il.label_id
       WHERE il.issue_id = ?`
    ).all(id) as any[]).map((r) => r.label);

    const dependencies = (this.db.prepare(
      'SELECT depends_on_id FROM issue_dependencies WHERE issue_id = ?'
    ).all(id) as any[]).map((r) => r.depends_on_id);

    const relevantFiles = (this.db.prepare(
      'SELECT file_path FROM issue_relevant_files WHERE issue_id = ?'
    ).all(id) as any[]).map((r) => r.file_path);

    const acceptanceCriteria = (this.db.prepare(
      'SELECT criterion FROM issue_acceptance_criteria WHERE issue_id = ? ORDER BY sort_order'
    ).all(id) as any[]).map((r) => r.criterion);

    const memoryIds = (this.db.prepare(
      'SELECT memory_id FROM issue_memory_links WHERE issue_id = ?'
    ).all(id) as any[]).map((r) => r.memory_id);

    const childIds = (this.db.prepare(
      'SELECT id FROM issues WHERE parent_id = ?'
    ).all(id) as any[]).map((r) => r.id);

    return {
      id,
      projectId: row.project_id,
      title: row.title,
      description: row.description ?? '',
      status: row.status,
      priority: row.priority,
      source: row.source,
      labels,
      assignee: row.assignee ?? undefined,
      milestone: row.milestone ?? undefined,
      relevantFiles,
      acceptanceCriteria,
      estimateMinutes: row.estimate_minutes ?? undefined,
      complexity: row.complexity ?? undefined,
      dependencies,
      parentId: row.parent_id ?? undefined,
      childIds,
      linearId: row.linear_id ?? undefined,
      linearIdentifier: row.linear_identifier ?? undefined,
      linearUrl: row.linear_url ?? undefined,
      memoryIds,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at ?? undefined,
    };
  }

  private rowToEvent(row: any): IssueEvent {
    return {
      id: row.id,
      issueId: row.issue_id,
      type: row.type,
      oldValue: row.old_value ?? undefined,
      newValue: row.new_value ?? undefined,
      content: row.content ?? undefined,
      memoryId: row.memory_id ?? undefined,
      actor: row.actor,
      createdAt: row.created_at,
    };
  }

  private ensureLabelId(label: string): string | null {
    const name = label.trim();
    if (!name) return null;

    const existing = this.db.prepare(
      'SELECT id FROM labels WHERE id = ? OR name = ? LIMIT 1'
    ).get(name, name) as { id: string } | undefined;
    if (existing) return existing.id;

    this.db.prepare(
      'INSERT INTO labels (id, name, color, description) VALUES (?, ?, ?, ?)'
    ).run(name, name, '#6B7280', null);
    return name;
  }
}

function toFtsQuery(search: string): string | null {
  const rawTokens: Array<{ type: 'term' | 'operator'; value: string }> = [];
  let i = 0;

  while (i < search.length) {
    while (/\s/.test(search[i] ?? '')) i++;
    if (i >= search.length) break;

    if (search[i] === '"') {
      i++;
      let phrase = '';
      while (i < search.length) {
        if (search[i] === '"' && search[i + 1] === '"') {
          phrase += '"';
          i += 2;
          continue;
        }
        if (search[i] === '"') {
          i++;
          break;
        }
        phrase += search[i];
        i++;
      }
      const value = phrase.trim();
      if (value) rawTokens.push({ type: 'term', value });
      continue;
    }

    const start = i;
    while (i < search.length && !/\s/.test(search[i])) i++;
    const value = search.slice(start, i).trim();
    if (!value) continue;

    const upper = value.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
      rawTokens.push({ type: 'operator', value: upper });
    } else {
      rawTokens.push({ type: 'term', value });
    }
  }

  const tokens: string[] = [];
  let expectTerm = true;
  for (const token of rawTokens) {
    if (token.type === 'operator') {
      if (expectTerm) continue;
      tokens.push(token.value);
      expectTerm = true;
      continue;
    }

    tokens.push(`"${token.value.replace(/"/g, '""')}"`);
    expectTerm = false;
  }

  while (tokens.length > 0 && ['AND', 'OR', 'NOT'].includes(tokens[tokens.length - 1])) tokens.pop();
  return tokens.length > 0 ? tokens.join(' ') : null;
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value!)));
}

function normalizeOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value!));
}

// 싱글톤 인스턴스
let storeInstance: SqliteIssueStore | null = null;
let storeInstancePath: string | null = null;

export function getIssueStore(dbPath?: string): SqliteIssueStore {
  const requestedPath = resolve(dbPath ?? DEFAULT_DB_PATH);
  if (!storeInstance) {
    storeInstance = new SqliteIssueStore(requestedPath);
    storeInstancePath = requestedPath;
  } else if (storeInstancePath !== requestedPath) {
    throw new Error(`Issue store already initialized at ${storeInstancePath}; requested ${requestedPath}`);
  }
  return storeInstance;
}

export function closeIssueStore(): void {
  if (storeInstance) {
    storeInstance.close();
    storeInstance = null;
    storeInstancePath = null;
  }
}
