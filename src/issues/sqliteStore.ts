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
  getIssueByIdentifier(identifier: string): Issue | null;
  updateIssue(id: string, patch: Partial<CreateIssueInput>): Issue | null;
  deleteIssue(id: string): boolean;
  listIssues(filter?: IssueFilter): { issues: Issue[]; total: number };

  // 상태 전이
  changeStatus(id: string, status: IssueStatus, actor?: string): Issue | null;

  // 이벤트 로그
  addEvent(issueId: string, type: IssueEventType, data?: EventData): IssueEvent;
  getEvents(issueId: string, limit?: number): IssueEvent[];

  // 라벨 관리
  ensureLabel(name: string): Label;
  ensureLabelId(name: string): string | null;
  getLabelByName(name: string): Label | null;
  listLabels(): Label[];

  // 마일스톤
  ensureMilestone(name: string): Milestone;
  listMilestones(): Milestone[];

  // 통계
  getStats(): IssueStats;

  // Linear 동기화 (동시성 안전)
  upsertIssueByLinearId(linearId: string, input: CreateIssueInput): Issue;
}

export interface CreateIssueInput {
  id?: string;
  projectId: string;
  title: string;
  description?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  source?: IssueSource;
  assignee?: string;
  milestone?: string;
  estimateMinutes?: number;
  complexity?: string;
  parentId?: string;
  linearId?: string;
  linearIdentifier?: string;
  linearUrl?: string;
  labels?: string[];
  dependencies?: string[];
  relevantFiles?: string[];
  acceptanceCriteria?: string[];
}

export interface EventData {
  [key: string]: unknown;
}

export interface IssueStats {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
}

function restrictDatabasePermissions(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows or permission-denied — best effort
  }
}

export class SqliteIssueStore implements IIssueStore {
  private db: Database.Database;
  private insertIssue: Database.Statement;
  private insertLabel: Database.Statement;
  private insertDep: Database.Statement;
  private insertFile: Database.Statement;
  private insertCriteria: Database.Statement;
  private insertEvent: Database.Statement;
  private upsertIssueStmt: Database.Statement | null = null;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = resolve(dbPath, '..');
    mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    restrictDatabasePermissions(dbPath);

    // WAL mode with busy timeout — concurrent readers do not block writers
    // and writers retry instead of failing immediately. The connection is never
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

    // Pre-compile statements
    this.insertIssue = this.db.prepare(`
      INSERT INTO issues (id, project_id, title, description, status, priority, source,
        assignee, milestone, estimate_minutes, complexity, parent_id,
        linear_id, linear_identifier, linear_url, created_at, updated_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertLabel = this.db.prepare(
      'INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)'
    );
    this.insertDep = this.db.prepare(
      'INSERT OR IGNORE INTO issue_dependencies (issue_id, depends_on_id) VALUES (?, ?)'
    );
    this.insertFile = this.db.prepare(
      'INSERT OR IGNORE INTO issue_relevant_files (issue_id, file_path) VALUES (?, ?)'
    );
    this.insertCriteria = this.db.prepare(
      'INSERT INTO issue_acceptance_criteria (issue_id, criterion, sort_order) VALUES (?, ?, ?)'
    );
    this.insertEvent = this.db.prepare(`
      INSERT INTO issue_events (id, issue_id, type, new_value, actor, created_at)
      VALUES (?, ?, 'created', ?, 'system', ?)
    `);
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
        linear_id TEXT UNIQUE,
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

      CREATE TABLE IF NOT EXISTS issue_events (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        type TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        actor TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS labels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        due_date TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
      CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
      CREATE INDEX IF NOT EXISTS idx_issues_linear ON issues(linear_id);
      CREATE INDEX IF NOT EXISTS idx_issues_updated ON issues(updated_at);
      CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events(issue_id);
      CREATE INDEX IF NOT EXISTS idx_issue_events_created ON issue_events(created_at);
    `);

    // FTS5 full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
        title, description, content='issues', content_rowid='rowid',
        tokenize='unicode61'
      );

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

    const transaction = this.db.transaction(() => {
      this.insertIssue.run(
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
        if (labelId) this.insertLabel.run(id, labelId);
      }
      for (const depId of input.dependencies ?? []) {
        this.insertDep.run(id, depId);
      }
      for (const filePath of input.relevantFiles ?? []) {
        this.insertFile.run(id, filePath);
      }
      for (let i = 0; i < (input.acceptanceCriteria ?? []).length; i++) {
        this.insertCriteria.run(id, input.acceptanceCriteria![i], i);
      }
      this.insertEvent.run(nanoid(12), id, input.source ?? 'local', now);
    });

    try {
      transaction();
    } catch (err: any) {
      // If the UNIQUE constraint on linear_id fires, another concurrent
      // writer already inserted this Linear issue.  Fall through to the
      // upsert path so the caller gets a deterministic result.
      if (input.linearId && err?.message?.includes('UNIQUE constraint failed')) {
        return this.upsertIssueByLinearId(input.linearId, input);
      }
      throw err;
    }

    return this.getIssue(id)!;
  }

  /**
   * upsertIssueByLinearId — atomic INSERT OR REPLACE keyed on linear_id.
   * Safe for concurrent sync workers: the UNIQUE constraint serialises
   * the race, and the transaction ensures labels/events are consistent
   * with the winning row.
   */
  upsertIssueByLinearId(linearId: string, input: CreateIssueInput): Issue {
    // Check for existing row inside the same transaction
    const existing = this.getIssueByLinearId(linearId);
    if (existing) {
      // Update in place
      this.updateIssue(existing.id, input);
      return this.getIssue(existing.id)!;
    }

    // No existing row — create with a fresh id, retrying on id collision
    const id = input.id ?? nanoid(12);
    const now = new Date().toISOString();

    const transaction = this.db.transaction(() => {
      this.insertIssue.run(
        id, input.projectId, input.title, input.description ?? '',
        input.status ?? 'backlog', input.priority ?? 'medium', input.source ?? 'local',
        input.assignee ?? null, input.milestone ?? null,
        input.estimateMinutes ?? null, input.complexity ?? null,
        input.parentId ?? null,
        linearId, input.linearIdentifier ?? null, input.linearUrl ?? null,
        now, now, input.status === 'done' || input.status === 'cancelled' ? now : null,
      );

      for (const label of input.labels ?? []) {
        const labelId = this.ensureLabelId(label);
        if (labelId) this.insertLabel.run(id, labelId);
      }
      for (const depId of input.dependencies ?? []) {
        this.insertDep.run(id, depId);
      }
      for (const filePath of input.relevantFiles ?? []) {
        this.insertFile.run(id, filePath);
      }
      for (let i = 0; i < (input.acceptanceCriteria ?? []).length; i++) {
        this.insertCriteria.run(id, input.acceptanceCriteria![i], i);
      }
      this.insertEvent.run(nanoid(12), id, input.source ?? 'linear', now);
    });

    try {
      transaction();
    } catch (err: any) {
      // Another concurrent writer inserted the same linear_id between our
      // getIssueByLinearId check and the INSERT.  Fall back to update.
      if (err?.message?.includes('UNIQUE constraint failed')) {
        const winner = this.getIssueByLinearId(linearId);
        if (winner) {
          this.updateIssue(winner.id, input);
          return this.getIssue(winner.id)!;
        }
      }
      throw err;
    }

    return this.getIssue(id)!;
  }

  getIssue(id: string): Issue | null {
    const row = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as any;
    if (!row) return null;
    return this.rowToIssue(row);
  }

  getIssueByIdentifier(identifier: string): Issue | null {
    const row = this.db.prepare(`
      SELECT * FROM issues
      WHERE linear_identifier = ? COLLATE NOCASE
      LIMIT 1
    `).get(identifier) as any;
    return row ? this.rowToIssue(row) : null;
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

      if (patch.status && patch.status !== existing.status) {
        this.db.prepare('UPDATE issues SET status = ?, updated_at = ? WHERE id = ?')
          .run(patch.status, now, id);
        this.addEvent(id, 'status_change', {
          oldValue: existing.status,
          newValue: patch.status,
        });
      }

      if (patch.labels) {
        this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(id);
        for (const label of patch.labels) {
          const labelId = this.ensureLabelId(label);
          if (labelId) this.insertLabel.run(id, labelId);
        }
      }

      if (patch.dependencies) {
        this.db.prepare('DELETE FROM issue_dependencies WHERE issue_id = ?').run(id);
        for (const depId of patch.dependencies) {
          this.insertDep.run(id, depId);
        }
      }

      if (patch.relevantFiles) {
        this.db.prepare('DELETE FROM issue_relevant_files WHERE issue_id = ?').run(id);
        for (const filePath of patch.relevantFiles) {
          this.insertFile.run(id, filePath);
        }
      }

      if (patch.acceptanceCriteria) {
        this.db.prepare('DELETE FROM issue_acceptance_criteria WHERE issue_id = ?').run(id);
        for (let i = 0; i < patch.acceptanceCriteria.length; i++) {
          this.insertCriteria.run(id, patch.acceptanceCriteria[i], i);
        }
      }
    });

    transaction();
    return this.getIssue(id);
  }

  deleteIssue(id: string): boolean {
    const existing = this.getIssue(id);
    if (!existing) return false;

    this.db.transaction(() => {
      this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(id);
      this.db.prepare('DELETE FROM issue_dependencies WHERE issue_id = ?').run(id);
      this.db.prepare('DELETE FROM issue_relevant_files WHERE issue_id = ?').run(id);
      this.db.prepare('DELETE FROM issue_acceptance_criteria WHERE issue_id = ?').run(id);
      this.db.prepare('DELETE FROM issue_events WHERE issue_id = ?').run(id);
      this.db.prepare('DELETE FROM issues WHERE id = ?').run(id);
    })();

    return true;
  }

  listIssues(filter?: IssueFilter): { issues: Issue[]; total: number } {
    const conditions: string[] = [];
    const params: any[] = [];

    // Status filter
    if (filter?.status) {
      conditions.push('i.status = ?');
      params.push(filter.status);
    }

    // Priority filter
    if (filter?.priority) {
      conditions.push('i.priority = ?');
      params.push(filter.priority);
    }

    // Source filter
    if (filter?.source) {
      conditions.push('i.source = ?');
      params.push(filter.source);
    }

    // Assignee filter
    if (filter?.assignee) {
      conditions.push('i.assignee = ?');
      params.push(filter.assignee);
    }

    // Milestone filter
    if (filter?.milestone) {
      conditions.push('i.milestone = ?');
      params.push(filter.milestone);
    }

    // Project filter
    if (filter?.projectId) {
      conditions.push('i.project_id = ?');
      params.push(filter.projectId);
    }

    // Parent filter
    if (filter?.parentId) {
      conditions.push('i.parent_id = ?');
      params.push(filter.parentId);
    }

    // Labels filter
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

    // Count
    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM issues i ${ftsJoin} ${where}`).get(...params) as any;
    const total = countRow?.cnt ?? 0;

    // Sort
    const sortField = filter?.sort ?? 'updated_at';
    const sortOrder = filter?.order === 'asc' ? 'ASC' : 'DESC';
    const allowedSorts = ['created_at', 'updated_at', 'title', 'status', 'priority'];
    const safeSort = allowedSorts.includes(sortField) ? sortField : 'updated_at';

    // Pagination
    const limit = normalizeLimit(filter?.limit, 50, 200);
    const offset = normalizeOffset(filter?.offset);

    const rows = this.db.prepare(`
      SELECT i.* FROM issues i ${ftsJoin} ${where}
      ORDER BY i.${safeSort} ${sortOrder}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as any[];

    return {
      issues: rows.map(r => this.rowToIssue(r)),
      total,
    };
  }

  // ============ 상태 전이 ============

  changeStatus(id: string, status: IssueStatus, actor?: string): Issue | null {
    const issue = this.getIssue(id);
    if (!issue) return null;

    const now = new Date().toISOString();
    const closedAt = (status === 'done' || status === 'cancelled') ? now : null;

    this.db.transaction(() => {
      this.db.prepare('UPDATE issues SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?')
        .run(status, now, closedAt, id);
      this.addEvent(id, 'status_change', {
        oldValue: issue.status,
        newValue: status,
        actor: actor ?? 'system',
      });
    })();

    return this.getIssue(id);
  }

  // ============ 이벤트 로그 ============

  addEvent(issueId: string, type: IssueEventType, data?: EventData): IssueEvent {
    const id = nanoid(12);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO issue_events (id, issue_id, type, old_value, new_value, actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, issueId, type,
      data?.oldValue as string ?? null,
      data?.newValue as string ?? null,
      data?.actor as string ?? 'system',
      now,
    );

    return {
      id, issueId, type,
      oldValue: data?.oldValue as string,
      newValue: data?.newValue as string,
      actor: data?.actor as string ?? 'system',
      createdAt: now,
    };
  }

  getEvents(issueId: string, limit: number = 50): IssueEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM issue_events
      WHERE issue_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(issueId, limit) as any[];

    return rows.map(r => ({
      id: r.id,
      issueId: r.issue_id,
      type: r.type as IssueEventType,
      oldValue: r.old_value,
      newValue: r.new_value,
      actor: r.actor,
      createdAt: r.created_at,
    }));
  }

  // ============ 라벨 관리 ============

  ensureLabel(name: string): Label {
    const existing = this.getLabelByName(name);
    if (existing) return existing;

    const id = nanoid(8);
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO labels (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now);
    return { id, name, createdAt: now };
  }

  ensureLabelId(name: string): string | null {
    try {
      const label = this.ensureLabel(name);
      return label.id;
    } catch {
      return null;
    }
  }

  getLabelByName(name: string): Label | null {
    const row = this.db.prepare('SELECT * FROM labels WHERE name = ?').get(name) as any;
    if (!row) return null;
    return { id: row.id, name: row.name, color: row.color, createdAt: row.created_at };
  }

  listLabels(): Label[] {
    const rows = this.db.prepare('SELECT * FROM labels ORDER BY name').all() as any[];
    return rows.map(r => ({ id: r.id, name: r.name, color: r.color, createdAt: r.created_at }));
  }

  // ============ 마일스톤 ============

  ensureMilestone(name: string): Milestone {
    const existing = this.db.prepare('SELECT * FROM milestones WHERE name = ?').get(name) as any;
    if (existing) {
      return { id: existing.id, name: existing.name, description: existing.description, dueDate: existing.due_date, createdAt: existing.created_at };
    }

    const id = nanoid(8);
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO milestones (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now);
    return { id, name, createdAt: now };
  }

  listMilestones(): Milestone[] {
    const rows = this.db.prepare('SELECT * FROM milestones ORDER BY name').all() as any[];
    return rows.map(r => ({
      id: r.id, name: r.name, description: r.description, dueDate: r.due_date, createdAt: r.created_at,
    }));
  }

  // ============ 통계 ============

  getStats(): IssueStats {
    const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM issues').get() as any).cnt;
    const byStatusRows = this.db.prepare('SELECT status, COUNT(*) as cnt FROM issues GROUP BY status').all() as any[];
    const byPriorityRows = this.db.prepare('SELECT priority, COUNT(*) as cnt FROM issues GROUP BY priority').all() as any[];

    const byStatus: Record<string, number> = {};
    const byPriority: Record<string, number> = {};

    for (const row of byStatusRows) byStatus[row.status] = row.cnt;
    for (const row of byPriorityRows) byPriority[row.priority] = row.cnt;

    return { total, byStatus, byPriority };
  }

  // ============ 내부 헬퍼 ============

  private rowToIssue(row: any): Issue {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description ?? '',
      status: row.status as IssueStatus,
      priority: row.priority as IssuePriority,
      source: row.source as IssueSource,
      assignee: row.assignee ?? undefined,
      milestone: row.milestone ?? undefined,
      estimateMinutes: row.estimate_minutes ?? undefined,
      complexity: row.complexity ?? undefined,
      parentId: row.parent_id ?? undefined,
      linearId: row.linear_id ?? undefined,
      linearIdentifier: row.linear_identifier ?? undefined,
      linearUrl: row.linear_url ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at ?? undefined,
      labels: this.getIssueLabels(row.id),
      dependencies: this.getIssueDependencies(row.id),
      relevantFiles: this.getIssueRelevantFiles(row.id),
      acceptanceCriteria: this.getIssueAcceptanceCriteria(row.id),
    };
  }

  private getIssueLabels(issueId: string): string[] {
    const rows = this.db.prepare(`
      SELECT l.name FROM issue_labels il
      JOIN labels l ON l.id = il.label_id
      WHERE il.issue_id = ?
      ORDER BY l.name
    `).all(issueId) as any[];
    return rows.map(r => r.name);
  }

  private getIssueDependencies(issueId: string): string[] {
    const rows = this.db.prepare(
      'SELECT depends_on_id FROM issue_dependencies WHERE issue_id = ?'
    ).all(issueId) as any[];
    return rows.map(r => r.depends_on_id);
  }

  private getIssueRelevantFiles(issueId: string): string[] {
    const rows = this.db.prepare(
      'SELECT file_path FROM issue_relevant_files WHERE issue_id = ?'
    ).all(issueId) as any[];
    return rows.map(r => r.file_path);
  }

  private getIssueAcceptanceCriteria(issueId: string): string[] {
    const rows = this.db.prepare(
      'SELECT criterion FROM issue_acceptance_criteria WHERE issue_id = ? ORDER BY sort_order'
    ).all(issueId) as any[];
    return rows.map(r => r.criterion);
  }
}

// ============ FTS 헬퍼 ============

function toFtsQuery(search: string): string | null {
  if (!search || search.trim().length === 0) return null;

  // Escape special FTS5 characters and build prefix query
  const sanitized = search.replace(/['"]/g, '').replace(/[^\w가-힣\s]/g, ' ').trim();
  if (!sanitized) return null;

  // Build prefix query: each word becomes a prefix match
  const terms = sanitized.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;

  return terms.map(t => `"${t}"*`).join(' ');
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

// ============ 싱글톤 ============

let storeInstance: SqliteIssueStore | null = null;

export function getIssueStore(dbPath?: string): SqliteIssueStore {
  if (!storeInstance) {
    storeInstance = new SqliteIssueStore(dbPath);
  }
  return storeInstance;
}

export function closeIssueStore(): void {
  if (storeInstance) {
    try {
      storeInstance['db'].close();
    } catch {
      // already closed
    }
    storeInstance = null;
  }
}