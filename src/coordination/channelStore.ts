import { basename, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expandPath } from '../core/config.js';
import { repositoryCell, type RepositoryCell } from './repositoryCell.js';
import { backfillChannelEntries, channelDatabase } from './channelSchema.js';

export interface Channel {
  repoKey: string; repository: string; name: string; configured: boolean;
  readSeq: number; latestSeq: number; unread: number;
}
export interface Page<T> {
  items: T[]; nextCursor?: string;
  scope: { repoKey?: string; limit: number; throughSeq?: number; source: string };
  partial: boolean; unavailable: string[];
}
export interface ChannelEntry {
  seq: number; repoKey: string; sourceKind: 'trace' | 'message'; sourceId: string;
  threadId?: string; taskId: string; taskLabel?: string; actor: string; actorName?: string;
  actorRole?: string; body: string; detail?: string; kind: string; status: string;
  correlationId?: string; createdAt: number; delivery?: ChannelDelivery;
}
export interface ChannelDelivery {
  id: string; repoKey: string; threadId: string; messageId: string;
  taskId?: string; recipient?: string; correlationId?: string;
  status: 'queued' | 'processing' | 'responded' | 'failed' | 'interrupted';
  runId?: string; error?: string; createdAt: number;
}
interface EntryRow {
  seq: number; source_kind: ChannelEntry['sourceKind']; source_id: string; thread_id: string | null;
  task_id: string; created_at: number; m_actor: string | null; m_name: string | null; m_role: string | null;
  m_body: string | null; m_label: string | null; t_actor: string | null; t_name: string | null; t_role: string | null;
  summary: string | null; detail: string | null; kind: string | null; status: string | null;
  correlation_id: string | null; t_label: string | null; delivery_id: string | null;
  delivery_status: ChannelDelivery['status'] | null; delivery_task: string | null; recipient: string | null;
  run_id: string | null; error: string | null;
}

let configuration: { db: unknown; signature: string | undefined; traceId: number; threadRowId: number } | undefined;

function physicalAliasKey(cell: RepositoryCell, known?: string): string {
  if (!known || known === cell.repoKey || cell.repoKey.startsWith('git:')) return cell.repoKey;
  // The path: fallback also covers delete/access failures. Only paths confirmed as non-Git get their existing alias corrected.
  const probe = spawnSync('git', ['-C', cell.worktreePath, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
    env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return probe.status === 128 && probe.stderr?.startsWith('fatal: not a git repository (or any ')
    ? cell.repoKey : known;
}

function registerHistoricalChannel(db: ReturnType<typeof channelDatabase>, repository: string, explicitKey?: string): boolean {
  const path = expandPath(repository);
  const cell = isAbsolute(path) ? repositoryCell(path) : undefined;
  const known = db.prepare('SELECT repo_key FROM coordination_channel_aliases WHERE repository=?').get(repository) as { repo_key: string } | undefined;
  const explicit = explicitKey ? db.prepare('SELECT repo_key FROM coordination_channel_aliases WHERE repository=?').get(explicitKey) as { repo_key: string } | undefined : undefined;
  const explicitCell = explicitKey && isAbsolute(expandPath(explicitKey)) ? repositoryCell(expandPath(explicitKey)) : undefined;
  // An opaque event key does not change ownership of a path alias. Git common paths are confirmed against the real cell.
  const physicalKey = cell ? physicalAliasKey(cell, known?.repo_key) : repository;
  const explicitPathKey = explicitCell ? physicalAliasKey(explicitCell, explicit?.repo_key) : undefined;
  const key = explicitPathKey ?? explicitKey ?? physicalKey;
  let changed = false;
  const aliases: Array<[string, string]> = [repository, ...(cell ? [path, cell.worktreePath, cell.repositoryPath] : [])].map((alias) => [alias, physicalKey]);
  if (explicitCell) aliases.push(...[explicitKey!, explicitCell.worktreePath, explicitCell.repositoryPath].map((alias): [string, string] => [alias, explicitPathKey!]));
  for (const [alias, aliasKey] of aliases) {
    if (db.prepare(`INSERT INTO coordination_channel_aliases VALUES (?,?) ON CONFLICT(repository)
      DO UPDATE SET repo_key=excluded.repo_key WHERE repo_key!=excluded.repo_key`).run(alias, aliasKey).changes) changed = true;
  }
  if (db.prepare('INSERT OR IGNORE INTO coordination_channels(repo_key,repository,name) VALUES (?,?,?)')
    .run(key, cell?.repositoryPath ?? '', cell ? basename(cell.repositoryPath) : `Archived ${key.slice(-8)}`).changes) changed = true;
  return changed;
}

/** Threads calls without a configured path also prepare the record migration but keep the configured state. */
export function syncChannelState(paths?: readonly string[]): void {
  const db = channelDatabase();
  const previous = configuration?.db === db ? configuration : undefined;
  const configuredPaths = paths ?? [];
  const signature = paths === undefined ? previous?.signature : JSON.stringify([...new Set(configuredPaths)].sort());
  const configurationChanged = paths !== undefined && (!previous || previous.signature !== signature);
  const traceId = (db.prepare('SELECT COALESCE(MAX(id),0) position FROM coordination_trace').get() as { position: number }).position;
  const threadRowId = (db.prepare('SELECT COALESCE(MAX(rowid),0) position FROM coordination_threads').get() as { position: number }).position;
  if (!previous || configurationChanged || traceId !== previous.traceId || threadRowId !== previous.threadRowId) {
    db.transaction(() => {
      const oldKeys = new Set((db.prepare('SELECT repo_key FROM coordination_channels').all() as Array<{ repo_key: string }>).map((r) => r.repo_key));
      const cells = configurationChanged ? configuredPaths.map((path) => repositoryCell(expandPath(path))) : [];
      let aliasesChanged = configurationChanged;
      for (const [index, cell] of cells.entries()) {
        for (const alias of [expandPath(configuredPaths[index]), cell.worktreePath, cell.repositoryPath]) {
          const known = db.prepare('SELECT repo_key FROM coordination_channel_aliases WHERE repository=?').get(alias) as { repo_key: string } | undefined;
          db.prepare(`INSERT INTO coordination_channel_aliases VALUES (?,?) ON CONFLICT(repository)
            DO UPDATE SET repo_key=excluded.repo_key WHERE repo_key!=excluded.repo_key`)
            .run(alias, physicalAliasKey(cell, known?.repo_key));
        }
      }
      // Check only the paths of new records. A sibling created while running is grouped into the same channel without a restart.
      const historical = db.prepare(`SELECT DISTINCT repository, repo_key FROM coordination_trace WHERE id>? AND id<=?`)
        .all(previous?.traceId ?? 0, traceId) as Array<{ repository: string; repo_key: string | null }>;
      for (const row of historical) {
        if (registerHistoricalChannel(db, row.repository, row.repo_key ?? undefined)) aliasesChanged = true;
      }
      const oldThreads = db.prepare(`SELECT DISTINCT repository FROM coordination_threads WHERE rowid>? AND rowid<=?`)
        .all(previous?.threadRowId ?? 0, threadRowId) as Array<{ repository: string }>;
      for (const { repository } of oldThreads) {
        if (registerHistoricalChannel(db, repository)) aliasesChanged = true;
      }
      if (configurationChanged) db.prepare('UPDATE coordination_channels SET configured = 0').run();
      for (const cell of cells) {
        db.prepare(`INSERT INTO coordination_channels(repo_key,repository,name,configured) VALUES (?,?,?,1)
          ON CONFLICT(repo_key) DO UPDATE SET repository=excluded.repository,name=excluded.name,configured=1`)
          .run(cell.repoKey, cell.repositoryPath, basename(cell.repositoryPath));
      }
      if (!aliasesChanged) return;
      backfillChannelEntries(db);
      // Merge the read position of path channels that were wrongly split, while keeping the original and the projection seq.
      db.exec(`UPDATE coordination_channels SET read_seq=MAX(read_seq,COALESCE((
        SELECT MAX(old.read_seq) FROM coordination_channels old JOIN coordination_channel_aliases a
          ON a.repository=old.repo_key WHERE a.repo_key=coordination_channels.repo_key),0))`);
      // Only a newly migrated channel gets a baseline. A restart does not change the read position.
      const baseline = db.prepare(`UPDATE coordination_channels SET read_seq=COALESCE(
        (SELECT MAX(seq) FROM coordination_channel_entries WHERE repo_key=?),0) WHERE repo_key=?`);
      for (const row of db.prepare('SELECT repo_key FROM coordination_channels').all() as Array<{ repo_key: string }>) {
        if (!oldKeys.has(row.repo_key)) baseline.run(row.repo_key, row.repo_key);
      }
    }).immediate();
    configuration = { db, signature, traceId, threadRowId };
  }
}

/** Run targets are registered from server config only. A client-supplied path is not accepted. */
export function syncChannels(paths: readonly string[]): Channel[] {
  syncChannelState(paths);
  return readChannels();
}

export function readChannels(): Channel[] {
  return (channelDatabase().prepare(`SELECT c.*,
    COALESCE((SELECT MAX(seq) FROM coordination_channel_entries e WHERE e.repo_key=c.repo_key),0) latest_seq,
    (SELECT COUNT(*) FROM coordination_channel_entries e LEFT JOIN coordination_thread_messages m
      ON e.source_kind='message' AND e.source_id=m.message_id
      WHERE e.repo_key=c.repo_key AND e.seq>c.read_seq AND COALESCE(m.actor_role,'')!='human') unread
    FROM coordination_channels c WHERE NOT EXISTS(SELECT 1 FROM coordination_channel_aliases a
      WHERE a.repository=c.repo_key AND a.repo_key!=c.repo_key)
    ORDER BY c.name COLLATE NOCASE, c.repo_key`).all() as Array<{
      repo_key: string; repository: string; name: string; configured: number;
      read_seq: number; latest_seq: number; unread: number;
    }>).map((r) => ({ repoKey: r.repo_key, repository: r.repository, name: r.name,
      configured: r.configured === 1, readSeq: r.read_seq, latestSeq: r.latest_seq, unread: r.unread }));
}

export function requireChannel(repoKey: string, writable = false): Channel {
  const channel = readChannels().find((c) => c.repoKey === repoKey);
  if (!channel) throw new Error('Channel not found');
  if (writable && !channel.configured) throw new Error('Archived channel is read-only');
  return channel;
}

export function pageLimit(value?: number): number {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('Invalid limit');
  return Math.min(value ?? 50, 200);
}

export function encodeCursor(scope: string, position: number, through: number): string {
  return Buffer.from(JSON.stringify([scope, position, through])).toString('base64url');
}
export function decodeCursor(cursor: string | undefined, scope: string, through: number): [number, number] {
  if (!cursor) return [through + 1, through];
  try {
    const p = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (!Array.isArray(p) || p.length !== 3 || p[0] !== scope || !Number.isSafeInteger(p[1]) || p[1] < 0
      || !Number.isSafeInteger(p[2]) || p[2] < 0 || p[1] > p[2] + 1) throw new Error('shape');
    return [p[1], p[2]];
  } catch { throw new Error('Invalid cursor'); }
}

export function markChannelRead(repoKey: string, throughSeq: number): number {
  const c = requireChannel(repoKey);
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || throughSeq > c.latestSeq) throw new Error('Invalid read cursor');
  const row = channelDatabase().prepare(`UPDATE coordination_channels SET read_seq=MAX(read_seq,?)
    WHERE repo_key=? RETURNING read_seq`).get(throughSeq, repoKey) as { read_seq: number };
  return row.read_seq;
}

export function listChannelEntries(repoKey: string, options: {
  cursor?: string; limit?: number; threadId?: string; taskId?: string; correlationId?: string;
} = {}): Page<ChannelEntry> {
  const c = requireChannel(repoKey);
  const db = channelDatabase();
  const limit = pageLimit(options.limit);
  const scope = JSON.stringify([repoKey, options.threadId ?? '', options.taskId ?? '', options.correlationId ?? '']);
  const [before, through] = decodeCursor(options.cursor, scope, c.latestSeq);
  const rows = db.prepare(`SELECT e.*, m.actor m_actor, m.actor_name m_name, m.actor_role m_role,
    m.body m_body, m.task_label m_label, t.actor t_actor, t.actor_name t_name, t.actor_role t_role,
    t.summary, t.detail, t.kind, t.status, t.correlation_id, t.task_label t_label,
    d.id delivery_id, d.status delivery_status, d.task_id delivery_task, d.recipient, d.run_id, d.error
    FROM coordination_channel_entries e
    LEFT JOIN coordination_thread_messages m ON e.source_kind='message' AND e.source_id=m.message_id
    LEFT JOIN coordination_trace t ON e.source_kind='trace' AND e.source_id=t.event_id
    LEFT JOIN coordination_channel_deliveries d ON d.message_id=e.source_id AND e.source_kind='message'
    WHERE e.repo_key=? AND e.seq<? AND e.seq<=?
      AND (? IS NULL OR e.thread_id=?)
      AND (? IS NULL OR e.task_id=? OR d.task_id=? OR EXISTS(SELECT 1 FROM coordination_thread_tasks tt
        WHERE tt.thread_id=e.thread_id AND tt.task_id=?))
      AND (? IS NULL OR t.correlation_id=? OR d.correlation_id=?)
    ORDER BY e.seq DESC LIMIT ?`).all(repoKey, before, through,
    options.threadId ?? null, options.threadId ?? null,
    options.taskId ?? null, options.taskId ?? null, options.taskId ?? null, options.taskId ?? null,
    options.correlationId ?? null, options.correlationId ?? null, options.correlationId ?? null, limit + 1) as EntryRow[];
  const items: ChannelEntry[] = rows.slice(0, limit).map((r) => ({
    seq: r.seq, repoKey, sourceKind: r.source_kind, sourceId: r.source_id, threadId: r.thread_id ?? undefined,
    taskId: r.delivery_task ?? r.task_id, taskLabel: r.m_label ?? r.t_label ?? undefined,
    actor: r.m_actor ?? r.t_actor ?? 'unknown', actorName: r.m_name ?? r.t_name ?? undefined,
    actorRole: r.m_role ?? r.t_role ?? undefined, body: r.m_body ?? r.summary ?? '', detail: r.detail ?? undefined,
    kind: r.kind ?? 'discussion', status: r.delivery_status ?? r.status ?? 'recorded',
    correlationId: r.correlation_id ?? undefined, createdAt: r.created_at,
    ...(r.delivery_id && r.thread_id && r.delivery_status ? { delivery: { id: r.delivery_id, repoKey, threadId: r.thread_id, messageId: r.source_id,
      taskId: r.delivery_task ?? undefined, recipient: r.recipient ?? undefined, status: r.delivery_status,
      runId: r.run_id ?? undefined, error: r.error ?? undefined, createdAt: r.created_at } } : {}),
  }));
  return { items, ...(rows.length > limit ? { nextCursor: encodeCursor(scope, items.at(-1)!.seq, through) } : {}),
    scope: { repoKey, limit, throughSeq: through, source: 'durable channel projection' }, partial: false, unavailable: [] };
}
