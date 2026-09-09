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
  getEvents(issueId: string, limit?: number, offset?: number): IssueEvent[];

  // 통계
  getStats(): IssueStats;

  // 레이블
  createLabel(name: string, color?: string): Label;
  getLabel(id: string): Label | null;
  listLabels(): Label[];
  addLabelToIssue(issueId: string, labelId: string): void;
  removeLabelFromIssue(issueId: string, labelId: string): void;

  // 마일스톤
  createMilestone(name: string, dueDate?: string): Milestone;
  getMilestone(id: string): Milestone | null;
  listMilestones(): Milestone[];
  setIssueMilestone(issueId: string, milestoneId: string | null): void;

  // 의존성
  addDependency(issueId: string, dependsOnId: string): void;
  removeDependency(issueId: string, dependsOnId: string): void;
  getDependencies(issueId: string): Issue[];

  // 관련 파일
  addRelevantFile(issueId: string, filePath: string): void;
  removeRelevantFile(issueId: string, filePath: string): void;
  getRelevantFiles(issueId: string): string[];

  // DB 관리
  close(): void;
  vacuum(): void;
}

export interface CreateIssueInput {
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
}

export interface EventData {
  [key: string]: unknown;
}

export interface IssueStats {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  bySource: Record<string, number>;
}

export class SqliteIssueStore implements IIssueStore {
  private db: Database.Database;
  private ready: Promise<void>;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = resolve(dbPath, '..');
    mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    // NOTE: better-sqlite3 is synchronous, but we keep the async wrapper for
    // future async backends. The connection is opened in the constructor and
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

      -- Enforce unique Linear-to-local mappings: concurrent inbound sync cannot
      -- create multiple local mappings for one Linear issue.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_linear_id
        ON issues(linear_id) WHERE linear_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_linear_identifier
        ON issues(linear_identifier) WHERE linear_identifier IS NOT NULL;

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

      CREATE TABLE IF NOT EXISTS labels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT DEFAULT '#808080',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        due_date TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issue_events (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT,
        data TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_issue_events_issue_id
        ON issue_events(issue_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_issues_status
        ON issues(status);

      CREATE INDEX IF NOT EXISTS idx_issues_project_id
        ON issues(project_id);

      CREATE INDEX IF NOT EXISTS idx_issues_updated_at
        ON issues(updated_at);

      CREATE INDEX IF NOT EXISTS idx_issues_linear_identifier
        ON issues(linear_identifier);

      CREATE INDEX IF NOT EXISTS idx_issues_linear_id
        ON issues(linear_id);

      -- FTS5 full-text search index
      CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
        id UNINDEXED,
        title,
        description,
        content='issues',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS index in sync
      CREATE TRIGGER IF NOT EXISTS issues_ai AFTER INSERT ON issues BEGIN
        INSERT INTO issues_fts(rowid, id, title, description)
        VALUES (new.rowid, new.id, new.title, new.description);
      END;

      CREATE TRIGGER IF NOT EXISTS issues_ad AFTER DELETE ON issues BEGIN
        INSERT INTO issues_fts(issues_fts, rowid, id, title, description)
        VALUES ('delete', old.rowid, old.id, old.title, old.description);
      END;

      CREATE TRIGGER IF NOT EXISTS issues_au AFTER UPDATE ON issues BEGIN
        INSERT INTO issues_fts(issues_fts, rowid, id, title, description)
        VALUES ('delete', old.rowid, old.id, old.title, old.description);
        INSERT INTO issues_fts(rowid, id, title, description)
        VALUES (new.rowid, new.id, new.title, new.description);
      END;
    `);
  }

  // ==================== Issue CRUD ====================

  createIssue(input: CreateIssueInput): Issue {
    const id = nanoid();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO issues (id, project_id, title, description, status, priority, source,
        assignee, milestone, estimate_minutes, complexity, parent_id,
        linear_id, linear_identifier, linear_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id, input.projectId, input.title, input.description ?? '',
      input.status ?? 'backlog', input.priority ?? 'medium', input.source ?? 'local',
      input.assignee ?? null, input.milestone ?? null, input.estimateMinutes ?? null,
      input.complexity ?? null, input.parentId ?? null,
      input.linearId ?? null, input.linearIdentifier ?? null, input.linearUrl ?? null,
      now, now
    );

    return this.getIssue(id)!;
  }

  getIssue(id: string): Issue | null {
    const row = this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToIssue(row);
  }

  getIssueByIdentifier(identifier: string): Issue | null {
    const row = this.db.prepare('SELECT * FROM issues WHERE linear_identifier = ?').get(identifier) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToIssue(row);
  }

  updateIssue(id: string, patch: Partial<CreateIssueInput>): Issue | null {
    const existing = this.getIssue(id);
    if (!existing) return null;

    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(patch)) {
      const col = this.toColumnName(key);
      if (col) {
        fields.push(`${col} = ?`);
        values.push(value ?? null);
      }
    }

    if (fields.length === 0) return existing;

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE issues SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getIssue(id);
  }

  deleteIssue(id: string): boolean {
    const result = this.db.prepare('DELETE FROM issues WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listIssues(filter?: IssueFilter): { issues: Issue[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.status) {
      conditions.push('i.status = ?');
      params.push(filter.status);
    }

    if (filter?.priority) {
      conditions.push('i.priority = ?');
      params.push(filter.priority);
    }

    if (filter?.source) {
      conditions.push('i.source = ?');
      params.push(filter.source);
    }

    if (filter?.projectId) {
      conditions.push('i.project_id = ?');
      params.push(filter.projectId);
    }

    if (filter?.assignee) {
      conditions.push('i.assignee = ?');
      params.push(filter.assignee);
    }

    if (filter?.milestone) {
      conditions.push('i.milestone = ?');
      params.push(filter.milestone);
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

    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM issues i ${ftsJoin} ${where}`).get(...params) as { cnt: number };
    const total = countRow.cnt;

    const limit = normalizeLimit(filter?.limit, 50, 200);
    const offset = normalizeOffset(filter?.offset);

    const rows = this.db.prepare(
      `SELECT i.* FROM issues i ${ftsJoin} ${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Record<string, unknown>[];

    return {
      issues: rows.map(r => this.rowToIssue(r)),
      total,
    };
  }

  // ==================== Status Transitions ====================

  changeStatus(id: string, status: IssueStatus, actor?: string): Issue | null {
    const issue = this.getIssue(id);
    if (!issue) return null;

    const now = new Date().toISOString();
    this.db.prepare('UPDATE issues SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?').run(
      status, now, status === 'done' || status === 'cancelled' ? now : null, id
    );

    this.addEvent(id, 'status_change', { from: issue.status, to: status, actor });
    return this.getIssue(id);
  }

  // ==================== Events ====================

  addEvent(issueId: string, type: IssueEventType, data?: EventData): IssueEvent {
    const id = nanoid();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO issue_events (id, issue_id, event_type, data, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, issueId, type, JSON.stringify(data ?? {}), now);
    return { id, issueId, type, data: data ?? {}, createdAt: now };
  }

  getEvents(issueId: string, limit = 50, offset = 0): IssueEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM issue_events WHERE issue_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(issueId, limit, offset) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      issueId: r.issue_id as string,
      type: r.event_type as IssueEventType,
      data: JSON.parse((r.data as string) || '{}'),
      createdAt: r.created_at as string,
    }));
  }

  // ==================== Stats ====================

  getStats(): IssueStats {
    const total = (this.db.prepare('SELECT COUNT(*) as cnt FROM issues').get() as { cnt: number }).cnt;
    const byStatus: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    for (const row of this.db.prepare('SELECT status, COUNT(*) as cnt FROM issues GROUP BY status').all() as Record<string, unknown>[]) {
      byStatus[row.status as string] = row.cnt as number;
    }
    for (const row of this.db.prepare('SELECT priority, COUNT(*) as cnt FROM issues GROUP BY priority').all() as Record<string, unknown>[]) {
      byPriority[row.priority as string] = row.cnt as number;
    }
    for (const row of this.db.prepare('SELECT source, COUNT(*) as cnt FROM issues GROUP BY source').all() as Record<string, unknown>[]) {
      bySource[row.source as string] = row.cnt as number;
    }

    return { total, byStatus, byPriority, bySource };
  }

  // ==================== Labels ====================

  createLabel(name: string, color = '#808080'): Label {
    const id = nanoid();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)').run(id, name, color, now);
    return { id, name, color, createdAt: now };
  }

  getLabel(id: string): Label | null {
    const row = this.db.prepare('SELECT * FROM labels WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: row.id as string, name: row.name as string, color: row.color as string, createdAt: row.created_at as string };
  }

  listLabels(): Label[] {
    return (this.db.prepare('SELECT * FROM labels ORDER BY name').all() as Record<string, unknown>[]).map(r => ({
      id: r.id as string, name: r.name as string, color: r.color as string, createdAt: r.created_at as string,
    }));
  }

  addLabelToIssue(issueId: string, labelId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)').run(issueId, labelId);
  }

  removeLabelFromIssue(issueId: string, labelId: string): void {
    this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ? AND label_id = ?').run(issueId, labelId);
  }

  // ==================== Milestones ====================

  createMilestone(name: string, dueDate?: string): Milestone {
    const id = nanoid();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO milestones (id, name, due_date, created_at) VALUES (?, ?, ?, ?)').run(id, name, dueDate ?? null, now);
    return { id, name, dueDate, createdAt: now };
  }

  getMilestone(id: string): Milestone | null {
    const row = this.db.prepare('SELECT * FROM milestones WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: row.id as string, name: row.name as string, dueDate: row.due_date as string | undefined, createdAt: row.created_at as string };
  }

  listMilestones(): Milestone[] {
    return (this.db.prepare('SELECT * FROM milestones ORDER BY name').all() as Record<string, unknown>[]).map(r => ({
      id: r.id as string, name: r.name as string, dueDate: r.due_date as string | undefined, createdAt: r.created_at as string,
    }));
  }

  setIssueMilestone(issueId: string, milestoneId: string | null): void {
    this.db.prepare('UPDATE issues SET milestone = ?, updated_at = ? WHERE id = ?').run(milestoneId, new Date().toISOString(), issueId);
  }

  // ==================== Dependencies ====================

  addDependency(issueId: string, dependsOnId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO issue_dependencies (issue_id, depends_on_id) VALUES (?, ?)').run(issueId, dependsOnId);
  }

  removeDependency(issueId: string, dependsOnId: string): void {
    this.db.prepare('DELETE FROM issue_dependencies WHERE issue_id = ? AND depends_on_id = ?').run(issueId, dependsOnId);
  }

  getDependencies(issueId: string): Issue[] {
    const rows = this.db.prepare(`
      SELECT i.* FROM issues i
      JOIN issue_dependencies d ON d.depends_on_id = i.id
      WHERE d.issue_id = ?
    `).all(issueId) as Record<string, unknown>[];
    return rows.map(r => this.rowToIssue(r));
  }

  // ==================== Relevant Files ====================

  addRelevantFile(issueId: string, filePath: string): void {
    this.db.prepare('INSERT OR IGNORE INTO issue_relevant_files (issue_id, file_path) VALUES (?, ?)').run(issueId, filePath);
  }

  removeRelevantFile(issueId: string, filePath: string): void {
    this.db.prepare('DELETE FROM issue_relevant_files WHERE issue_id = ? AND file_path = ?').run(issueId, filePath);
  }

  getRelevantFiles(issueId: string): string[] {
    const rows = this.db.prepare('SELECT file_path FROM issue_relevant_files WHERE issue_id = ?').all(issueId) as Record<string, unknown>[];
    return rows.map(r => r.file_path as string);
  }

  // ==================== DB Management ====================

  close(): void {
    this.db.close();
  }

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  // ==================== Helpers ====================

  private rowToIssue(row: Record<string, unknown>): Issue {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      title: row.title as string,
      description: (row.description as string) ?? '',
      status: row.status as IssueStatus,
      priority: row.priority as IssuePriority,
      source: row.source as IssueSource,
      assignee: (row.assignee as string) ?? undefined,
      milestone: (row.milestone as string) ?? undefined,
      estimateMinutes: (row.estimate_minutes as number) ?? undefined,
      complexity: (row.complexity as string) ?? undefined,
      parentId: (row.parent_id as string) ?? undefined,
      linearId: (row.linear_id as string) ?? undefined,
      linearIdentifier: (row.linear_identifier as string) ?? undefined,
      linearUrl: (row.linear_url as string) ?? undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      closedAt: (row.closed_at as string) ?? undefined,
    };
  }

  private toColumnName(key: string): string | null {
    const map: Record<string, string> = {
      projectId: 'project_id',
      title: 'title',
      description: 'description',
      status: 'status',
      priority: 'priority',
      source: 'source',
      assignee: 'assignee',
      milestone: 'milestone',
      estimateMinutes: 'estimate_minutes',
      complexity: 'complexity',
      parentId: 'parent_id',
      linearId: 'linear_id',
      linearIdentifier: 'linear_identifier',
      linearUrl: 'linear_url',
    };
    return map[key] ?? null;
  }
}

// ==================== Module-level singleton ====================

let storeInstance: SqliteIssueStore | null = null;

export function getIssueStore(dbPath?: string): SqliteIssueStore {
  if (!storeInstance) {
    storeInstance = new SqliteIssueStore(dbPath);
  }
  return storeInstance;
}

export function closeIssueStore(): void {
  if (storeInstance) {
    storeInstance.close();
    storeInstance = null;
  }
}

// ==================== Utility Functions ====================

function toFtsQuery(search: string): string | null {
  // Escape special FTS5 characters and build a prefix query
  const sanitized = search.replace(/['"*^$()~`{}[\]\\]/g, '').trim();
  if (!sanitized) return null;
  // Wrap each word as a prefix term for partial matching
  const terms = sanitized.split(/\s+/).filter(Boolean).map(t => `"${t}"*`);
  return terms.join(' ');
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), maximum);
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || value === null) return 0;
  return Math.max(0, Math.floor(value));
}