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

  // 라벨
  createLabel(name: string, color?: string): Label;
  getLabel(id: string): Label | null;
  listLabels(): Label[];
  addLabelToIssue(issueId: string, labelId: string): void;
  removeLabelFromIssue(issueId: string, labelId: string): void;

  // 마일스톤
  createMilestone(name: string, dueDate?: string): Milestone;
  getMilestone(id: string): Milestone | null;
  listMilestones(): Milestone[];

  // 통계
  getStats(): IssueStats;
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
  labels?: string[];
  dependencies?: string[];
  relevantFiles?: string[];
}

export interface EventData {
  [key: string]: unknown;
}

export interface IssueStats {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
}

// ============================================
// SqliteIssueStore Implementation
// ============================================

export class SqliteIssueStore implements IIssueStore {
  private db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
    enableWalWithRetry(this.db);
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;

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
      -- create multiple local mappings for one Linear issue. The (linear_id, source)
      -- composite index prevents duplicate mappings even when two sync workers race
      -- on the same Linear issue from different sources.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_linear_id
        ON issues(linear_id) WHERE linear_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_linear_source
        ON issues(linear_id, source) WHERE linear_id IS NOT NULL;
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
        event_data TEXT,
        actor TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_issues_project_id
        ON issues(project_id);

      CREATE INDEX IF NOT EXISTS idx_issues_status
        ON issues(status);

      CREATE INDEX IF NOT EXISTS idx_issues_priority
        ON issues(priority);

      CREATE INDEX IF NOT EXISTS idx_issues_created_at
        ON issues(created_at);

      CREATE INDEX IF NOT EXISTS idx_issues_updated_at
        ON issues(updated_at);

      CREATE INDEX IF NOT EXISTS idx_issues_assignee
        ON issues(assignee);

      CREATE INDEX IF NOT EXISTS idx_issues_parent_id
        ON issues(parent_id);

      CREATE INDEX IF NOT EXISTS idx_issues_linear_identifier
        ON issues(linear_identifier);

      CREATE INDEX IF NOT EXISTS idx_issues_linear_id
        ON issues(linear_id);

      -- FTS5 full-text search index
      CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
        id UNINDEXED,
        title,
        description,
        content=issues,
        content_rowid=rowid
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

  // ============================================
  // Issue CRUD
  // ============================================

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
      input.assignee ?? null, input.milestone ?? null,
      input.estimateMinutes ?? null, input.complexity ?? null,
      input.parentId ?? null, input.linearId ?? null,
      input.linearIdentifier ?? null, input.linearUrl ?? null,
      now, now
    );

    // Attach labels
    if (input.labels) {
      for (const labelId of input.labels) {
        this.db.prepare('INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)').run(id, labelId);
      }
    }

    // Attach dependencies
    if (input.dependencies) {
      for (const depId of input.dependencies) {
        this.db.prepare('INSERT OR IGNORE INTO issue_dependencies (issue_id, depends_on_id) VALUES (?, ?)').run(id, depId);
      }
    }

    // Attach relevant files
    if (input.relevantFiles) {
      for (const filePath of input.relevantFiles) {
        this.db.prepare('INSERT OR IGNORE INTO issue_relevant_files (issue_id, file_path) VALUES (?, ?)').run(id, filePath);
      }
    }

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

    const now = new Date().toISOString();
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (patch.title !== undefined) { fields.push('title = ?'); values.push(patch.title); }
    if (patch.description !== undefined) { fields.push('description = ?'); values.push(patch.description); }
    if (patch.status !== undefined) { fields.push('status = ?'); values.push(patch.status); }
    if (patch.priority !== undefined) { fields.push('priority = ?'); values.push(patch.priority); }
    if (patch.source !== undefined) { fields.push('source = ?'); values.push(patch.source); }
    if (patch.assignee !== undefined) { fields.push('assignee = ?'); values.push(patch.assignee); }
    if (patch.milestone !== undefined) { fields.push('milestone = ?'); values.push(patch.milestone); }
    if (patch.estimateMinutes !== undefined) { fields.push('estimate_minutes = ?'); values.push(patch.estimateMinutes); }
    if (patch.complexity !== undefined) { fields.push('complexity = ?'); values.push(patch.complexity); }
    if (patch.parentId !== undefined) { fields.push('parent_id = ?'); values.push(patch.parentId); }
    if (patch.linearId !== undefined) { fields.push('linear_id = ?'); values.push(patch.linearId); }
    if (patch.linearIdentifier !== undefined) { fields.push('linear_identifier = ?'); values.push(patch.linearIdentifier); }
    if (patch.linearUrl !== undefined) { fields.push('linear_url = ?'); values.push(patch.linearUrl); }

    values.push(id);
    this.db.prepare(`UPDATE issues SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    // Update labels if provided
    if (patch.labels) {
      this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ?').run(id);
      for (const labelId of patch.labels) {
        this.db.prepare('INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)').run(id, labelId);
      }
    }

    // Update dependencies if provided
    if (patch.dependencies) {
      this.db.prepare('DELETE FROM issue_dependencies WHERE issue_id = ?').run(id);
      for (const depId of patch.dependencies) {
        this.db.prepare('INSERT OR IGNORE INTO issue_dependencies (issue_id, depends_on_id) VALUES (?, ?)').run(id, depId);
      }
    }

    // Update relevant files if provided
    if (patch.relevantFiles) {
      this.db.prepare('DELETE FROM issue_relevant_files WHERE issue_id = ?').run(id);
      for (const filePath of patch.relevantFiles) {
        this.db.prepare('INSERT OR IGNORE INTO issue_relevant_files (issue_id, file_path) VALUES (?, ?)').run(id, filePath);
      }
    }

    return this.getIssue(id);
  }

  deleteIssue(id: string): boolean {
    const result = this.db.prepare('DELETE FROM issues WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listIssues(filter?: IssueFilter): { issues: Issue[]; total: number } {
    let whereClause = '';
    const params: unknown[] = [];

    if (filter) {
      const conditions: string[] = [];

      if (filter.projectId) {
        conditions.push('project_id = ?');
        params.push(filter.projectId);
      }
      if (filter.status) {
        conditions.push('status = ?');
        params.push(filter.status);
      }
      if (filter.priority) {
        conditions.push('priority = ?');
        params.push(filter.priority);
      }
      if (filter.source) {
        conditions.push('source = ?');
        params.push(filter.source);
      }
      if (filter.assignee) {
        conditions.push('assignee = ?');
        params.push(filter.assignee);
      }
      if (filter.search) {
        // Use FTS5 for full-text search
        const ftsQuery = toFtsQuery(filter.search);
        if (ftsQuery) {
          conditions.push(`id IN (SELECT id FROM issues_fts WHERE issues_fts MATCH ?)`);
          params.push(ftsQuery);
        } else {
          conditions.push('(title LIKE ? OR description LIKE ?)');
          params.push(`%${filter.search}%`, `%${filter.search}%`);
        }
      }
      if (filter.parentId) {
        conditions.push('parent_id = ?');
        params.push(filter.parentId);
      }
      if (filter.linearId) {
        conditions.push('linear_id = ?');
        params.push(filter.linearId);
      }
      if (filter.ids && filter.ids.length > 0) {
        conditions.push(`id IN (${filter.ids.map(() => '?').join(',')})`);
        params.push(...filter.ids);
      }

      if (conditions.length > 0) {
        whereClause = 'WHERE ' + conditions.join(' AND ');
      }
    }

    const countRow = this.db.prepare(`SELECT COUNT(*) as count FROM issues ${whereClause}`).get(...params) as { count: number };
    const total = countRow.count;

    const limit = normalizeLimit(filter?.limit, 50, 200);
    const offset = normalizeOffset(filter?.offset);
    const orderBy = filter?.sortBy ? `ORDER BY ${filter.sortBy} ${filter.sortOrder === 'desc' ? 'DESC' : 'ASC'}` : 'ORDER BY created_at DESC';

    const rows = this.db.prepare(`SELECT * FROM issues ${whereClause} ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset) as Record<string, unknown>[];

    return {
      issues: rows.map(r => this.rowToIssue(r)),
      total,
    };
  }

  // ============================================
  // Status Transitions
  // ============================================

  changeStatus(id: string, status: IssueStatus, actor?: string): Issue | null {
    const issue = this.getIssue(id);
    if (!issue) return null;

    const now = new Date().toISOString();
    this.db.prepare('UPDATE issues SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);

    // Log event
    this.addEvent(id, 'status_change', { from: issue.status, to: status, actor });

    // Set closed_at if closing
    if (status === 'done' || status === 'cancelled') {
      this.db.prepare('UPDATE issues SET closed_at = ? WHERE id = ?').run(now, id);
    }

    return this.getIssue(id);
  }

  // ============================================
  // Event Log
  // ============================================

  addEvent(issueId: string, type: IssueEventType, data?: EventData): IssueEvent {
    const id = nanoid();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO issue_events (id, issue_id, event_type, event_data, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id, issueId, type, data ? JSON.stringify(data) : null, now
    );
    return { id, issueId, type, data, createdAt: now };
  }

  getEvents(issueId: string, limit = 50, offset = 0): IssueEvent[] {
    const rows = this.db.prepare('SELECT * FROM issue_events WHERE issue_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(issueId, limit, offset) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      issueId: r.issue_id as string,
      type: r.event_type as IssueEventType,
      data: r.event_data ? JSON.parse(r.event_data as string) as EventData : undefined,
      createdAt: r.created_at as string,
    }));
  }

  // ============================================
  // Labels
  // ============================================

  createLabel(name: string, color?: string): Label {
    const id = nanoid();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)').run(id, name, color ?? '#808080', now);
    return { id, name, color: color ?? '#808080', createdAt: now };
  }

  getLabel(id: string): Label | null {
    const row = this.db.prepare('SELECT * FROM labels WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return { id: row.id as string, name: row.name as string, color: row.color as string, createdAt: row.created_at as string };
  }

  listLabels(): Label[] {
    return (this.db.prepare('SELECT * FROM labels ORDER BY name').all() as Record<string, unknown>[]).map(r => ({
      id: r.id as string,
      name: r.name as string,
      color: r.color as string,
      createdAt: r.created_at as string,
    }));
  }

  addLabelToIssue(issueId: string, labelId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)').run(issueId, labelId);
  }

  removeLabelFromIssue(issueId: string, labelId: string): void {
    this.db.prepare('DELETE FROM issue_labels WHERE issue_id = ? AND label_id = ?').run(issueId, labelId);
  }

  // ============================================
  // Milestones
  // ============================================

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
      id: r.id as string,
      name: r.name as string,
      dueDate: r.due_date as string | undefined,
      createdAt: r.created_at as string,
    }));
  }

  // ============================================
  // Stats
  // ============================================

  getStats(): IssueStats {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM issues').get() as { count: number }).count;
    const byStatus: Record<string, number> = {};
    const statusRows = this.db.prepare('SELECT status, COUNT(*) as count FROM issues GROUP BY status').all() as { status: string; count: number }[];
    for (const row of statusRows) {
      byStatus[row.status] = row.count;
    }
    const byPriority: Record<string, number> = {};
    const priorityRows = this.db.prepare('SELECT priority, COUNT(*) as count FROM issues GROUP BY priority').all() as { priority: string; count: number }[];
    for (const row of priorityRows) {
      byPriority[row.priority] = row.count;
    }
    return { total, byStatus, byPriority };
  }

  // ============================================
  // Helpers
  // ============================================

  private rowToIssue(row: Record<string, unknown>): Issue {
    // Fetch labels
    const labels = (this.db.prepare('SELECT l.* FROM labels l JOIN issue_labels il ON l.id = il.label_id WHERE il.issue_id = ?').all(row.id as string) as Record<string, unknown>[]).map(r => ({
      id: r.id as string,
      name: r.name as string,
      color: r.color as string,
      createdAt: r.created_at as string,
    }));

    // Fetch dependencies
    const dependencies = (this.db.prepare('SELECT depends_on_id FROM issue_dependencies WHERE issue_id = ?').all(row.id as string) as { depends_on_id: string }[]).map(r => r.depends_on_id);

    // Fetch relevant files
    const relevantFiles = (this.db.prepare('SELECT file_path FROM issue_relevant_files WHERE issue_id = ?').all(row.id as string) as { file_path: string }[]).map(r => r.file_path);

    return {
      id: row.id as string,
      projectId: row.project_id as string,
      title: row.title as string,
      description: row.description as string,
      status: row.status as IssueStatus,
      priority: row.priority as IssuePriority,
      source: row.source as IssueSource,
      assignee: row.assignee as string | undefined,
      milestone: row.milestone as string | undefined,
      estimateMinutes: row.estimate_minutes as number | undefined,
      complexity: row.complexity as string | undefined,
      parentId: row.parent_id as string | undefined,
      linearId: row.linear_id as string | undefined,
      linearIdentifier: row.linear_identifier as string | undefined,
      linearUrl: row.linear_url as string | undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      closedAt: row.closed_at as string | undefined,
      labels,
      dependencies,
      relevantFiles,
    };
  }
}

// ============================================
// Utility Functions
// ============================================

function toFtsQuery(search: string): string | null {
  // Escape special FTS5 characters and create a prefix query
  const sanitized = search.replace(/['"*^$()~`{}[\]\\]/g, '').trim();
  if (!sanitized) return null;
  // Wrap each word as a prefix query for better matching
  return sanitized.split(/\s+/).map(w => `"${w}"*`).join(' ');
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  if (value < 1) return 1;
  if (value > maximum) return maximum;
  return Math.floor(value);
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || value === null) return 0;
  if (value < 0) return 0;
  return Math.floor(value);
}

// ============================================
// Singleton
// ============================================

let instance: SqliteIssueStore | null = null;

export function getIssueStore(dbPath?: string): SqliteIssueStore {
  if (!instance) {
    instance = new SqliteIssueStore(dbPath);
  }
  return instance;
}

export function closeIssueStore(): void {
  if (instance) {
    instance = null;
  }
}