import type Database from 'better-sqlite3';
import { getTraceDb } from './coordinationTrace.js';
import { migrateCoordinationThreads } from './coordinationThreads.js';

const migrated = new WeakSet<Database.Database>();

/** 채널은 원본 ID만 투영한다. 기록용 trace의 성공 여부에 전달을 맡기지 않는다. */
export function channelDatabase(): Database.Database {
  const db = getTraceDb();
  if (!db) throw new Error('Channel store unavailable');
  if (migrated.has(db)) return db;
  migrateCoordinationThreads(db);
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coordination_channels (
        repo_key TEXT PRIMARY KEY, repository TEXT NOT NULL, name TEXT NOT NULL,
        configured INTEGER NOT NULL DEFAULT 0, read_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS coordination_channel_aliases (
        repository TEXT PRIMARY KEY, repo_key TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS coordination_channel_entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, repo_key TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('trace','message')),
        source_id TEXT NOT NULL, thread_id TEXT, task_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(source_kind, source_id)
      );
      CREATE INDEX IF NOT EXISTS channel_entries_scope
        ON coordination_channel_entries(repo_key, seq);
      CREATE INDEX IF NOT EXISTS channel_entries_task
        ON coordination_channel_entries(repo_key, task_id, seq);
      CREATE TABLE IF NOT EXISTS coordination_channel_deliveries (
        id TEXT PRIMARY KEY, repo_key TEXT NOT NULL, thread_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE, task_id TEXT, recipient TEXT,
        correlation_id TEXT, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','processing','responded','failed','interrupted')),
        run_id TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(repo_key, idempotency_key),
        FOREIGN KEY(thread_id) REFERENCES coordination_threads(thread_id),
        FOREIGN KEY(message_id) REFERENCES coordination_thread_messages(message_id)
      );
      CREATE INDEX IF NOT EXISTS channel_deliveries_queue
        ON coordination_channel_deliveries(repo_key, status, created_at);
      CREATE TABLE IF NOT EXISTS coordination_channel_runs (
        id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','responded','failed','interrupted','skipped')),
        owner_pid INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
        response_id TEXT, error TEXT,
        FOREIGN KEY(delivery_id) REFERENCES coordination_channel_deliveries(id)
      );
      DROP TRIGGER IF EXISTS channel_project_trace;
      CREATE TRIGGER channel_project_trace AFTER INSERT ON coordination_trace
      WHEN NEW.kind != 'thread-update' AND json_extract(COALESCE(NEW.metadata_json,'{}'),'$.channelMessageId') IS NULL
      BEGIN
        INSERT OR IGNORE INTO coordination_channel_entries
          (repo_key, source_kind, source_id, task_id, created_at)
        SELECT COALESCE(k.repo_key, NEW.repo_key, a.repo_key), 'trace', NEW.event_id,
          COALESCE(NEW.source_task_id, NEW.task_id), NEW.timestamp
        FROM (SELECT 1) LEFT JOIN coordination_channel_aliases a ON a.repository = NEW.repository
        LEFT JOIN coordination_channel_aliases k ON k.repository=NEW.repo_key
        WHERE COALESCE(k.repo_key, NEW.repo_key, a.repo_key) IS NOT NULL;
      END;
      DROP TRIGGER IF EXISTS channel_project_message;
      CREATE TRIGGER channel_project_message AFTER INSERT ON coordination_thread_messages
      BEGIN
        INSERT OR IGNORE INTO coordination_channel_entries
          (repo_key, source_kind, source_id, thread_id, task_id, created_at)
        SELECT COALESCE(a.repo_key,t.repository), 'message', NEW.message_id, NEW.thread_id, NEW.task_id, NEW.created_at
        FROM coordination_threads t LEFT JOIN coordination_channel_aliases a ON a.repository=t.repository
        WHERE t.thread_id = NEW.thread_id;
        UPDATE coordination_channel_deliveries SET status = 'responded', updated_at = NEW.created_at
        WHERE id = NEW.reply_to_delivery_id AND thread_id = NEW.thread_id AND status = 'processing'
          AND recipient = NEW.actor AND task_id = NEW.task_id;
        UPDATE coordination_channel_runs SET status = 'responded', response_id = NEW.message_id,
          finished_at = NEW.created_at
        WHERE status = 'running' AND id IN (SELECT run_id FROM coordination_channel_deliveries
          WHERE id = NEW.reply_to_delivery_id AND thread_id = NEW.thread_id AND recipient = NEW.actor AND task_id = NEW.task_id);
      END;
    `);
  }).immediate();
  migrated.add(db);
  return db;
}

/** 이관은 원본을 복제하지 않는다. 고유 인덱스로 재접속/중복 publish를 흡수한다. */
export function backfillChannelEntries(db: Database.Database): void {
  db.exec(`
    UPDATE coordination_channel_entries AS e SET repo_key=COALESCE(k.repo_key,t.repo_key,a.repo_key)
    FROM coordination_trace t LEFT JOIN coordination_channel_aliases a ON a.repository=t.repository
      LEFT JOIN coordination_channel_aliases k ON k.repository=t.repo_key
    WHERE e.source_kind='trace' AND e.source_id=t.event_id AND COALESCE(k.repo_key,t.repo_key,a.repo_key) IS NOT NULL
      AND e.repo_key!=COALESCE(k.repo_key,t.repo_key,a.repo_key);
    UPDATE coordination_channel_entries AS e SET repo_key=COALESCE(a.repo_key,t.repository)
    FROM coordination_thread_messages m JOIN coordination_threads t ON t.thread_id=m.thread_id
      LEFT JOIN coordination_channel_aliases a ON a.repository=t.repository
    WHERE e.source_kind='message' AND e.source_id=m.message_id AND e.repo_key!=COALESCE(a.repo_key,t.repository);
    INSERT OR IGNORE INTO coordination_channel_entries
      (repo_key, source_kind, source_id, thread_id, task_id, created_at)
    SELECT repo_key,source_kind,source_id,thread_id,task_id,created_at FROM (
      SELECT COALESCE(a.repo_key,t.repository) repo_key, 'message' source_kind, m.message_id source_id,
        m.thread_id, m.task_id, m.created_at, m.seq original_order
      FROM coordination_thread_messages m JOIN coordination_threads t ON t.thread_id=m.thread_id
      LEFT JOIN coordination_channel_aliases a ON a.repository=t.repository
      UNION ALL
      SELECT COALESCE(k.repo_key,t.repo_key,a.repo_key), 'trace', t.event_id, NULL,
        COALESCE(t.source_task_id,t.task_id), t.timestamp, t.id
      FROM coordination_trace t LEFT JOIN coordination_channel_aliases a ON a.repository=t.repository
      LEFT JOIN coordination_channel_aliases k ON k.repository=t.repo_key
      WHERE t.kind!='thread-update' AND json_extract(COALESCE(t.metadata_json,'{}'),'$.channelMessageId') IS NULL
        AND COALESCE(k.repo_key,t.repo_key,a.repo_key) IS NOT NULL
    ) ORDER BY created_at,source_kind,original_order;
  `);
}
