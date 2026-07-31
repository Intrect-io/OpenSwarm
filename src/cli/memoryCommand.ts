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
import { EMBEDDING_DIM, PERMANENT_EXPIRY } from '../memory/memoryCore.js';
import { isTransientReviewRejectionMemory } from '../memory/memoryFilters.js';
import { c, status as statusIcon } from '../support/colors.js';
import { getDaemonStatus } from './daemon.js';

const LEGACY_COLUMNS = ['revisionCount', 'decay', 'stability', 'contradicts', 'supports'] as const;

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
  inspect?: () => Promise<MemoryStatus>;
  compact?: () => Promise<{ before: number; after: number; removed: number; deduplicated: number }>;
  reembed?: () => Promise<{ total: number; reembedded: number; empty: number; signature: string }>;
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
  const rows = await table.search(Array.from({ length: EMBEDDING_DIM }, () => 0)).limit(100_000).toArray();
  const now = Date.now();

  let legacyRows = 0;
  let transientReviewRejections = 0;
  let expiredRows = 0;
  let lowImportanceRows = 0;
  let totalImportance = 0;

  for (const row of rows as Array<Record<string, unknown>>) {
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

  return {
    memoryDir: dir,
    sqliteMirror,
    table: tableName,
    exists: true,
    rows: rows.length,
    schemaFields,
    legacyColumns,
    legacyRows,
    transientReviewRejections,
    expiredRows,
    lowImportanceRows,
    avgImportance: rows.length > 0 ? totalImportance / rows.length : 0,
  };
}

export function formatMemoryStatus(s: MemoryStatus): string {
  const lines: string[] = [];
  lines.push(`${statusIcon.info('Memory')} ${c.bold(s.memoryDir)}`);
  lines.push(`  LanceDB: ${s.exists ? c.green('present') : c.yellow('missing')}`);
  lines.push(`  table:   ${s.table ?? 'none'}`);
  lines.push(`  rows:    ${s.rows}`);
  lines.push(`  avg importance: ${s.avgImportance.toFixed(2)}`);
  lines.push(`  legacy schema: ${s.legacyColumns.length ? c.yellow(s.legacyColumns.join(', ')) : c.green('none')}`);
  lines.push(`  legacy rows:   ${s.legacyRows}`);
  lines.push(`  noisy reviewer failures: ${s.transientReviewRejections}`);
  lines.push(`  expired rows:  ${s.expiredRows}`);
  lines.push(`  low importance rows: ${s.lowImportanceRows}`);
  lines.push(`  SQLite mirror: ${s.sqliteMirror.exists ? `${s.sqliteMirror.path} (${s.sqliteMirror.modifiedAt})` : 'missing'}`);
  if (s.legacyColumns.length || s.transientReviewRejections || s.expiredRows || s.lowImportanceRows) {
    lines.push('');
    lines.push(`  ${c.yellow('cleanup available:')} openswarm memory compact`);
  }
  return lines.join('\n');
}

export async function runMemoryCommand(
  action: string,
  opts: MemoryCommandOptions = {},
  deps: MemoryCommandDeps = {},
): Promise<string> {
  const inspect = deps.inspect ?? (() => inspectMemoryStatus());
  const compact = deps.compact ?? (() => compactMemoryTable());
  const reembed = deps.reembed ?? (() => reembedMemoryTable());
  const daemonRunning = deps.daemonRunning ?? (() => getDaemonStatus().running);

  switch (action) {
    case 'status': {
      const s = await inspect();
      return opts.json ? JSON.stringify(s, null, 2) : formatMemoryStatus(s);
    }
    case 'compact': {
      if (!opts.force && daemonRunning()) {
        throw new Error('OpenSwarm daemon is running. Stop it first or pass --force to compact memory anyway.');
      }
      const before = await inspect();
      const result = await compact();
      const after = await inspect();
      const payload = { before, compaction: result, after };
      if (opts.json) return JSON.stringify(payload, null, 2);
      return [
        statusIcon.ok('Memory compacted'),
        `  rows: ${result.before} -> ${result.after} (${result.removed} removed, ${result.deduplicated} deduplicated)`,
        `  legacy schema: ${after.legacyColumns.length ? after.legacyColumns.join(', ') : 'none'}`,
        `  noisy reviewer failures: ${before.transientReviewRejections} -> ${after.transientReviewRejections}`,
      ].join('\n');
    }
    case 'reembed': {
      // Rewrites every vector, so a daemon writing concurrently would race the
      // table swap — same guard as compact.
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
