// ============================================
// OpenSwarm - Durable thread notification outbox
// ============================================

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getTraceDb } from './coordinationTrace.js';
import { t } from '../locale/index.js';
import {
  getCoordinationStore,
  type PublishCoordinationEvent,
} from './coordinationStore.js';

export type ThreadMutationAction = 'created' | 'replied' | 'resolved';

export interface ThreadOutboxParticipant {
  actor: string;
  actorName?: string;
  actorRole?: string;
  taskId: string;
  taskLabel?: string;
}

export interface EnqueueThreadMutationInput {
  mutationId: string;
  repository: string;
  repoKey: string;
  threadId: string;
  subject: string;
  action: ThreadMutationAction;
  body?: string;
  acknowledgesCorrelationId?: string;
  source: ThreadOutboxParticipant;
  targets: ThreadOutboxParticipant[];
  now?: number;
}

interface OutboxRow {
  delivery_id: string;
  mutation_id: string;
  repository: string;
  repo_key: string;
  thread_id: string;
  subject: string;
  action: ThreadMutationAction;
  body: string | null;
  acknowledges_correlation_id: string | null;
  source_actor: string;
  source_actor_name: string | null;
  source_actor_role: string | null;
  source_task_id: string;
  source_task_label: string | null;
  target_actor: string | null;
  target_actor_name: string | null;
  target_actor_role: string | null;
  target_task_id: string;
  target_task_label: string | null;
  attempts: number;
}

export interface ThreadOutboxDrainResult {
  delivered: number;
  pending: number;
  warnings: string[];
}

export function migrateCoordinationThreadOutbox(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coordination_thread_outbox (
      delivery_id TEXT PRIMARY KEY,
      mutation_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      repo_key TEXT NOT NULL,
      thread_id TEXT NOT NULL REFERENCES coordination_threads(thread_id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('created', 'replied', 'resolved')),
      body TEXT,
      acknowledges_correlation_id TEXT,
      source_actor TEXT NOT NULL,
      source_actor_name TEXT,
      source_actor_role TEXT,
      source_task_id TEXT NOT NULL,
      source_task_label TEXT,
      target_actor TEXT,
      target_actor_name TEXT,
      target_actor_role TEXT,
      target_task_id TEXT NOT NULL,
      target_task_label TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS coordination_thread_outbox_target
      ON coordination_thread_outbox(mutation_id, target_task_id, COALESCE(target_actor, ''));
    CREATE INDEX IF NOT EXISTS coordination_thread_outbox_pending
      ON coordination_thread_outbox(status, created_at, delivery_id);
  `);
}

function deliveryId(input: EnqueueThreadMutationInput, target?: ThreadOutboxParticipant): string {
  return createHash('sha256').update(JSON.stringify({
    mutationId: input.mutationId,
    targetActor: target?.actor ?? null,
    targetTaskId: target?.taskId ?? input.source.taskId,
  })).digest('hex');
}

/** Called inside the same SQLite transaction that commits the thread mutation. */
export function enqueueCoordinationThreadMutation(
  db: Database.Database,
  input: EnqueueThreadMutationInput,
): void {
  migrateCoordinationThreadOutbox(db);
  const targets: Array<ThreadOutboxParticipant | undefined> = input.targets.length > 0
    ? input.targets
    : [undefined];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO coordination_thread_outbox(
      delivery_id, mutation_id, repository, repo_key, thread_id, subject, action, body,
      acknowledges_correlation_id, source_actor, source_actor_name, source_actor_role,
      source_task_id, source_task_label, target_actor, target_actor_name, target_actor_role,
      target_task_id, target_task_label, status, attempts, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
  `);
  for (const target of targets) {
    insert.run(
      deliveryId(input, target), input.mutationId, input.repository, input.repoKey,
      input.threadId, input.subject, input.action, input.body ?? null,
      input.acknowledgesCorrelationId ?? null,
      input.source.actor, input.source.actorName ?? null, input.source.actorRole ?? null,
      input.source.taskId, input.source.taskLabel ?? null,
      target?.actor ?? null, target?.actorName ?? null, target?.actorRole ?? null,
      target?.taskId ?? input.source.taskId, target?.taskLabel ?? input.source.taskLabel ?? null,
      input.now ?? Date.now(),
    );
  }
}

function pendingCount(db: Database.Database, mutationId?: string): number {
  const row = mutationId
    ? db.prepare(`SELECT COUNT(*) AS count FROM coordination_thread_outbox WHERE status = 'pending' AND mutation_id = ?`)
      .get(mutationId)
    : db.prepare(`SELECT COUNT(*) AS count FROM coordination_thread_outbox WHERE status = 'pending'`).get();
  return (row as { count: number }).count;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(bearer\s+\S+|(?:sk|ghp|xox[baprs])_?[-A-Za-z0-9_]{8,})/gi, '[redacted]')
    .slice(0, 500);
}

/**
 * Deliver pending subscriber copies. Stable event IDs plus CoordinationStore's
 * fingerprint dedup make a crash after board publish but before outbox ack safe.
 */
export async function drainCoordinationThreadOutbox(options: {
  mutationId?: string;
  limit?: number;
  deliver?: (event: PublishCoordinationEvent) => Promise<unknown>;
} = {}): Promise<ThreadOutboxDrainResult> {
  const db = getTraceDb();
  if (!db) return { delivered: 0, pending: 0, warnings: ['Coordination thread store is unavailable'] };
  migrateCoordinationThreadOutbox(db);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 1_000);
  const rows = (options.mutationId
    ? db.prepare(`
        SELECT * FROM coordination_thread_outbox
        WHERE status = 'pending' AND mutation_id = ?
        ORDER BY created_at, delivery_id LIMIT ?
      `).all(options.mutationId, limit)
    : db.prepare(`
        SELECT * FROM coordination_thread_outbox
        WHERE status = 'pending' ORDER BY created_at, delivery_id LIMIT ?
      `).all(limit)) as OutboxRow[];
  const deliver = options.deliver ?? ((event: PublishCoordinationEvent) => getCoordinationStore().publish(event));
  const warnings: string[] = [];
  let delivered = 0;
  for (const row of rows) {
    const metadata: NonNullable<PublishCoordinationEvent['metadata']> = {
      threadId: row.thread_id,
      action: row.action,
      mutationId: row.mutation_id,
      ...(row.acknowledges_correlation_id
        ? { acknowledgesCorrelationId: row.acknowledges_correlation_id }
        : {}),
    };
    try {
      await deliver({
        id: row.delivery_id,
        repository: row.repository,
        repoKey: row.repo_key,
        taskId: row.source_task_id,
        taskLabel: row.source_task_label ?? undefined,
        sourceTaskId: row.source_task_id,
        sourceTaskLabel: row.source_task_label ?? undefined,
        targetTaskId: row.target_task_id,
        targetTaskLabel: row.target_task_label ?? undefined,
        actor: row.source_actor,
        actorName: row.source_actor_name ?? undefined,
        actorRole: row.source_actor_role ?? undefined,
        recipient: row.target_actor ?? undefined,
        recipientName: row.target_actor_name ?? undefined,
        recipientRole: row.target_actor_role ?? undefined,
        kind: 'thread-update',
        status: row.action === 'created' ? 'open' : 'completed',
        correlationId: `thread:${row.thread_id}`,
        summary: t(`coordination.threadAction.${row.action}`, { subject: row.subject }),
        detail: row.body ?? undefined,
        metadata,
      });
      db.prepare(`
        UPDATE coordination_thread_outbox
        SET status = 'delivered', delivered_at = ?, attempts = attempts + 1, last_error = NULL
        WHERE delivery_id = ? AND status = 'pending'
      `).run(Date.now(), row.delivery_id);
      delivered += 1;
    } catch (error) {
      const message = cleanError(error);
      db.prepare(`
        UPDATE coordination_thread_outbox SET attempts = attempts + 1, last_error = ?
        WHERE delivery_id = ? AND status = 'pending'
      `).run(message, row.delivery_id);
      warnings.push(`${row.delivery_id.slice(0, 12)}: ${message}`);
    }
  }
  return { delivered, pending: pendingCount(db, options.mutationId), warnings };
}
