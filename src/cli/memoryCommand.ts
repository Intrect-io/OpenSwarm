// ============================================
// OpenSwarm - `openswarm memory status|compact`
// ============================================
//
// `status` is intentionally read-only: it opens LanceDB directly instead of
// going through memoryCore.initDatabase(), because initDatabase may migrate the
// table. `compact` is the explicit mutating path.

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { connect } from '@lancedb/lancedb';
import { compactMemoryTable } from '../memory/compaction.js';
import { reembedMemoryTable } from '../memory/reembed.js';
import { PERMANENT_EXPIRY } from '../memory/memoryCore.js';
import { isTransientReviewRejectionMemory } from '../memory/memoryFilters.js';
import { c, status as statusIcon } from '../support/colors.js';
import { getDaemonStatus } from './daemon.js';

const LEGACY_COLUMNS = ['revisionCount', 'decay', 'stability', 'contradicts', 'supports'] as const;

/** Bound each status page so a large table is streamed, not loaded wholesale. */
export const MEMORY_STATUS_PAGE_SIZE = 10_000;

export interface MemoryStatus {
  memoryDir: string;
  sqliteMirror: {
    path: string;
    exists: boolean;
    modifiedAt?: string;
  };
  table: string | null;
  exists: boolean;
  rows: number;
  schemaFields: string[];
  legacyColumns: string[];
  legacyRows: number;
  transientReviewRejections: number;
  expiredRows: number;
  lowImportanceRows: number;
  avgImportance: number;
}

export interface MemoryCommandOptions {
  json?: boolean;
  force?: boolean;
}

export interface MemoryCommandDeps {
  inspect?: (dir?: string) => Promise<MemoryStatus>;
  compact?: () => Promise<{
    before: number;
    after: number;
    removed: number;
    deduplicated: number;
  }>;
  reembed?: () => Promise<{
    total: number;
    reembedded: number;
    empty: number;
    signature: string;
  }>;
  daemonRunning?: () => boolean;
}

export function memoryDir(): string {
  return resolve(homedir(), '.openswarm/memory');
}

function sqliteMirrorInfo(dir: string): MemoryStatus['sqliteMirror'] {
  const path = resolve(dir, 'cognitive_memory.sqlite');
  if (!existsSync(path)) return { path, exists: false };
  const stat = statSync(path);
  return { path, exists: true, modifiedAt: stat.mtime.toISOString() };
}

function escapeLanceId(id: string): string {
  return id.replace(/'/g, "''");
}

type MemoryStatusPageQuery = {
  where: (predicate: string) => MemoryStatusPageQuery;
  limit: (n: number) => { toArray: () => Promise<unknown[]> };
  orderBy?: (spec: Array<{ column: string; ascending?: boolean }>) => MemoryStatusPageQuery;
};

/** Prefer ascending `id` order so `id > cursor` pages do not skip/dup rows. */
function orderMemoryStatusQuery(query: MemoryStatusPageQuery): MemoryStatusPageQuery {
  if (typeof query.orderBy !== 'function') return query;
  return query.orderBy([{ column: 'id', ascending: true }]);
}

/**
 * Stream memory rows page-by-page via an `id` cursor (not OFFSET).
 * Each page is bounded to MEMORY_STATUS_PAGE_SIZE.
 */
export async function* iterateMemoryStatusPages(
  table: { query: () => MemoryStatusPageQuery },
  pageSize = MEMORY_STATUS_PAGE_SIZE,
): AsyncGenerator<Array<Record<string, unknown>>> {
  let cursor: string | undefined;
  for (;;) {
    const base = orderMemoryStatusQuery(table.query());
    const limited = cursor === undefined
      ? base.limit(pageSize)
      : orderMemoryStatusQuery(base.where(`id > '${escapeLanceId(cursor)}'`)).limit(pageSize);
    const page = await limited.toArray() as Array<Record<string, unknown>>;
    if (page.length === 0) return;

    // Defensive: keep page order stable even when the store omits orderBy.
    page.sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
    yield page;

    const lastId = String(page[page.length - 1]?.id ?? '');
    if (!lastId || lastId === cursor || page.length < pageSize) return;
    cursor = lastId;
  }
}

export async function inspectMemoryStatus(dir = memoryDir()): Promise<MemoryStatus> {
  const sqliteMirror = sqliteMirrorInfo(dir);
  if (!existsSync(dir)) {
    return {
      memoryDir: dir,
      sqliteMirror,
      table: null,
      exists: false,
      rows: 0,
      schemaFields: [],
      legacyColumns: [],
      legacyRows: 0,
      transientReviewRejections: 0,
      expiredRows: 0,
      lowImportanceRows: 0,
      avgImportance: 0,
    };
  }

  const db = await connect(dir);
  const tableNames = await db.tableNames();
  const tableName = tableNames.includes('cognitive_memory')
    ? 'cognitive_memory'
    : tableNames.find(name => name.includes('memory')) ?? null;

  if (!tableName) {
    return {
      memoryDir: dir,
      sqliteMirror,
      table: null,
      exists: true,
      rows: 0,
      schemaFields: [],
      legacyColumns: [],
      legacyRows: 0,
      transientReviewRejections: 0,
      expiredRows: 0,
      lowImportanceRows: 0,
      avgImportance: 0,
    };
  }

  const table = await db.openTable(tableName);
  const schemaFields = (await table.schema()).fields.map(field => field.name);
  const legacyColumns = schemaFields.filter(field => (LEGACY_COLUMNS as readonly string[]).includes(field));

  let totalRows = 0;
  let legacyRows = 0;
  let transientReviewRejections = 0;
  let expiredRows = 0;
  let lowImportanceRows = 0;
  let totalImportance = 0;
  const now = Date.now();

  for await (const page of iterateMemoryStatusPages(table)) {
    totalRows += page.length;
    for (const row of page) {
      if (LEGACY_COLUMNS.some(column => column in row)) legacyRows++;
      if (isTransientReviewRejectionMemory(row)) transientReviewRejections++;
      const expiresAt = Number(row.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt < PERMANENT_EXPIRY && expiresAt < now) expiredRows++;
      const importance = Number(row.importance);
      if (Number.isFinite(importance)) {
        totalImportance += importance;
        if (importance < 0.1) lowImportanceRows++;
      }
    }
  }

  return {
    memoryDir: dir,
    sqliteMirror,
    table: tableName,
    exists: true,
    rows: totalRows,
    schemaFields,
    legacyColumns,
    legacyRows,
    transientReviewRejections,
    expiredRows,
    lowImportanceRows,
    avgImportance: totalRows > 0 ? totalImportance / totalRows : 0,
  };
}

export function formatMemoryStatus(s: MemoryStatus): string {
  const lines: string[] = [
    statusIcon.line(s.exists ? 'ok' : 'info', 'memory'),
    `  path:   ${s.memoryDir}`,
    `  table:  ${s.table ?? 'none'}`,
    `  rows:   ${s.rows}`,
    `  avg importance: ${s.avgImportance.toFixed(2)}`,
  ];
  lines.push(`  legacy schema: ${s.legacyColumns.length ? c.yellow(s.legacyColumns.join(', ')) : c.green('none')}`);
  lines.push(`  legacy rows:   ${s.legacyRows}`);
  lines.push(`  noisy reviewer failures: ${s.transientReviewRejections}`);
  lines.push(`  expired rows:  ${s.expiredRows}`);
  lines.push(`  low importance rows: ${s.lowImportanceRows}`);
  lines.push(`  SQLite mirror: ${s.sqliteMirror.exists ? `${s.sqliteMirror.path} (${s.sqliteMirror.modifiedAt})` : 'missing'}`);
  if (s.legacyColumns.length || s.transientReviewRejections || s.expiredRows || s.lowImportanceRows) {
    lines.push('');
    lines.push(c.yellow('  ⚠ maintenance recommended — run `openswarm memory compact`'));
  }
  return lines.join('\n');
}

export async function runMemoryCommand(
  action: string,
  opts: MemoryCommandOptions = {},
  deps: MemoryCommandDeps = {},
): Promise<string> {
  const inspect = deps.inspect ?? inspectMemoryStatus;
  const compact = deps.compact ?? compactMemoryTable;
  const reembed = deps.reembed ?? reembedMemoryTable;
  const daemonRunning = deps.daemonRunning ?? (() => getDaemonStatus().running);

  switch (action) {
    case 'status': {
      const status = await inspect();
      if (opts.json) return JSON.stringify(status, null, 2);
      return formatMemoryStatus(status);
    }
    case 'compact': {
      if (!opts.force && daemonRunning()) {
        throw new Error('OpenSwarm daemon is running. Stop it first or pass --force to compact memory anyway.');
      }
      const before = await inspect();
      const result = await compact();
      const after = await inspect();
      if (opts.json) {
        return JSON.stringify({ ...result, beforeStatus: before, afterStatus: after }, null, 2);
      }
      return [
        statusIcon.ok('Memory compacted'),
        `  rows: ${before.rows} -> ${after.rows}`,
        `  legacy schema: ${after.legacyColumns.length ? after.legacyColumns.join(', ') : 'none'}`,
        `  noisy reviewer failures: ${before.transientReviewRejections} -> ${after.transientReviewRejections}`,
        `  removed: ${result.removed}, deduplicated: ${result.deduplicated}`,
      ].join('\n');
    }
    case 'reembed': {
      if (!opts.force && daemonRunning()) {
        throw new Error('OpenSwarm daemon is running. Stop it first or pass --force to re-embed memory anyway.');
      }
      const result = await reembed();
      if (opts.json) return JSON.stringify(result, null, 2);
      return [
        statusIcon.ok('Memory re-embedded'),
        `  records:   ${result.total} (${result.reembedded} encoded, ${result.empty} empty)`,
        `  signature: ${result.signature}`,
      ].join('\n');
    }
    default:
      throw new Error(`Unknown memory action "${action}" (use status|compact|reembed)`);
  }
}
