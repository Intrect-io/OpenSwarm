import { createHash, randomUUID } from 'node:crypto';
import { channelDatabase } from './channelSchema.js';
import { requireChannel, type ChannelDelivery } from './channelStore.js';
import { createCoordinationThread, getCoordinationThread, postCoordinationThreadMessage } from './coordinationThreads.js';
import type { CoordinationEvent } from './coordinationStore.js';
import { broadcastEvent } from '../core/eventHub.js';
import { recordTraceEventRequired, toEvent } from './coordinationTrace.js';
import type { ProjectSession } from './projectModel.js';

interface DeliveryRow {
  id: string; repo_key: string; thread_id: string; message_id: string;
  task_id: string | null; recipient: string | null; correlation_id: string | null;
  status: ChannelDelivery['status']; run_id: string | null; error: string | null;
  created_at: number; fingerprint: string;
}
function delivery(r: DeliveryRow): ChannelDelivery {
  return { id: r.id, repoKey: r.repo_key, threadId: r.thread_id, messageId: r.message_id,
    taskId: r.task_id ?? undefined, recipient: r.recipient ?? undefined, correlationId: r.correlation_id ?? undefined,
    status: r.status, runId: r.run_id ?? undefined, error: r.error ?? undefined, createdAt: r.created_at };
}
export function getChannelDelivery(id: string): ChannelDelivery {
  const r = channelDatabase().prepare('SELECT * FROM coordination_channel_deliveries WHERE id=?').get(id) as DeliveryRow | undefined;
  if (!r) throw new Error('Delivery not found');
  return delivery(r);
}

export interface SendChannelMessage {
  repoKey: string; body: string; idempotencyKey: string; threadId?: string;
  taskId?: string; recipient?: string; correlationId?: string;
}

/** 수신자 확인은 HTTP 경계에서 수행한다. 이 함수는 저장과 큐 등록을 원자적으로 묶는다. */
export function sendChannelMessage(input: SendChannelMessage): ChannelDelivery {
  requireChannel(input.repoKey);
  if (!input.body?.trim() || input.body.length > 4_000) throw new Error('Message must contain 1–4000 characters');
  if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 160) throw new Error('Invalid idempotency key');
  if (Boolean(input.taskId) !== Boolean(input.recipient)) throw new Error('Task and recipient must be provided together');
  const db = channelDatabase();
  const fingerprint = createHash('sha256').update(JSON.stringify([
    input.body, input.threadId ?? null, input.taskId ?? null, input.recipient ?? null, input.correlationId ?? null,
  ])).digest('hex');
  const result = db.transaction(() => {
    const previous = db.prepare(`SELECT * FROM coordination_channel_deliveries WHERE repo_key=? AND idempotency_key=?`)
      .get(input.repoKey, input.idempotencyKey) as DeliveryRow | undefined;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Idempotency key conflict');
      return delivery(previous);
    }
    requireChannel(input.repoKey, true);
    let threadId = input.threadId;
    const source = { repository: input.repoKey, actor: 'operator-dashboard', actorName: 'Operator', actorRole: 'human', taskId: 'operator' };
    let messageId: string;
    if (threadId) {
      const detail = getCoordinationThread({ repository: input.repoKey, threadId, messageLimit: 1 });
      if (input.taskId && !detail.thread.relatedTaskIds.includes(input.taskId)) throw new Error('Thread task scope conflict');
      messageId = postCoordinationThreadMessage({ ...source, threadId, body: input.body, idempotencyKey: input.idempotencyKey }).id;
    } else {
      const thread = createCoordinationThread({ ...source, subject: input.body.trim().slice(0, 200), body: input.body,
        relatedTaskIds: input.taskId ? [input.taskId] : [], idempotencyKey: input.idempotencyKey });
      threadId = thread.id;
      messageId = getCoordinationThread({ repository: input.repoKey, threadId, messageLimit: 1 }).messages.items[0].id;
    }
    const now = Date.now();
    const id = randomUUID();
    db.prepare(`INSERT INTO coordination_channel_deliveries
      (id,repo_key,thread_id,message_id,task_id,recipient,correlation_id,idempotency_key,fingerprint,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(id, input.repoKey, threadId, messageId,
      input.taskId ?? null, input.recipient ?? null, input.correlationId ?? null, input.idempotencyKey, fingerprint, now, now);
    if (input.correlationId) {
      const questions = (db.prepare(`SELECT t.* FROM coordination_trace t LEFT JOIN coordination_channel_aliases a
        ON a.repository=t.repository WHERE COALESCE(t.repo_key,a.repo_key)=? AND COALESCE(t.source_task_id,t.task_id)=? AND t.correlation_id=?
        AND t.id=(SELECT MAX(t2.id) FROM coordination_trace t2 LEFT JOIN coordination_channel_aliases a2
          ON a2.repository=t2.repository WHERE t2.correlation_id=t.correlation_id
          AND COALESCE(t2.repo_key,a2.repo_key)=COALESCE(t.repo_key,a.repo_key))
        AND t.kind='human-question' AND t.status IN ('waiting','open','running')`).all(input.repoKey, input.taskId, input.correlationId) as Array<Parameters<typeof toEvent>[0]>).map(toEvent);
      const exact = questions.find((q) => q.correlationId === input.correlationId && q.actor === input.recipient);
      if (!exact) throw new Error('Question scope conflict or already answered');
      for (const question of questions) {
        recordTraceEventRequired(db, { id: `channel-answer:${id}:${question.correlationId}`, seq: 0, timestamp: Math.max(now, question.timestamp + 1),
          repository: question.repository, repoKey: input.repoKey, taskId: question.taskId, taskLabel: question.taskLabel,
          sourceTaskId: 'operator', targetTaskId: input.taskId, actor: 'operator-dashboard', actorName: 'Operator',
          actorRole: 'human', recipient: question.actor, kind: 'human-answer', status: 'completed',
          correlationId: question.correlationId, summary: 'Operator answered', detail: channelMessageBody(getChannelDelivery(id)),
          metadata: { answerSetId: input.correlationId, channelMessageId: messageId, deliveryId: id }, fingerprint });
      }
    }
    return getChannelDelivery(id);
  }).immediate();
  broadcastEvent({ type: 'coordination:channel', data: { repoKey: input.repoKey } });
  return result;
}

export function findChannelDeliveryByKey(repoKey: string, key: string): ChannelDelivery | undefined {
  const row = channelDatabase().prepare(`SELECT * FROM coordination_channel_deliveries WHERE repo_key=? AND idempotency_key=?`)
    .get(repoKey, key) as DeliveryRow | undefined;
  return row ? delivery(row) : undefined;
}

export function pendingCoordinatorMessages(repoKey: string): ChannelDelivery[] {
  return (channelDatabase().prepare(`SELECT * FROM coordination_channel_deliveries
    WHERE repo_key=? AND recipient IS NULL AND status='queued' ORDER BY created_at,id LIMIT 50`).all(repoKey) as DeliveryRow[]).map(delivery);
}
export function processingCoordinatorProjects(): string[] {
  return (channelDatabase().prepare(`SELECT DISTINCT repo_key FROM coordination_channel_deliveries
    WHERE recipient IS NULL AND status='processing'`).all() as Array<{ repo_key: string }>).map((r) => r.repo_key);
}
export function channelMessageBody(item: ChannelDelivery): string {
  return (channelDatabase().prepare('SELECT body FROM coordination_thread_messages WHERE message_id=?')
    .get(item.messageId) as { body: string }).body;
}
export function claimChannelDelivery(id: string): string | undefined {
  const db = channelDatabase();
  const result = db.transaction(() => {
    const runId = randomUUID();
    const now = Date.now();
    const update = db.prepare(`UPDATE coordination_channel_deliveries SET status='processing',run_id=?,updated_at=?,error=NULL
      WHERE id=? AND status='queued'`).run(runId, now, id);
    if (!update.changes) return undefined;
    db.prepare(`INSERT INTO coordination_channel_runs(id,delivery_id,status,owner_pid,started_at) VALUES (?,?,'running',?,?)`)
      .run(runId, id, process.pid, now);
    return runId;
  }).immediate();
  if (result) broadcastEvent({ type: 'coordination:channel-status', data: { repoKey: getChannelDelivery(id).repoKey } });
  return result;
}

export function finishChannelDelivery(id: string, runId: string, status: 'failed' | 'interrupted' | 'queued', error?: string): void {
  const db = channelDatabase();
  db.transaction(() => {
    const now = Date.now();
    db.prepare(`UPDATE coordination_channel_runs SET status=?,error=?,finished_at=? WHERE id=? AND status='running'`)
      .run(status === 'queued' ? 'skipped' : status, error ?? null, now, runId);
    db.prepare(`UPDATE coordination_channel_deliveries SET status=?,error=?,updated_at=? WHERE id=? AND run_id=? AND status='processing'`)
      .run(status, error ?? null, now, id, runId);
  }).immediate();
  broadcastEvent({ type: 'coordination:channel-status', data: { repoKey: getChannelDelivery(id).repoKey } });
}

export function respondToChannelDelivery(id: string, runId: string, actor: string, output: string): void {
  const db = channelDatabase();
  db.transaction(() => {
    const item = getChannelDelivery(id);
    if (item.status !== 'processing' || item.runId !== runId) throw new Error('Delivery ownership conflict');
    if (!output.trim()) throw new Error('Coordinator returned no response');
    // 긴 결과는 Threads의 메시지 한도에 맞춰 나누되 전체 결과를 보존한다.
    let responseId: string | undefined;
    for (let offset = 0; offset < output.length; offset += 4_000) {
      responseId = postCoordinationThreadMessage({ repository: item.repoKey, threadId: item.threadId,
        actor, actorName: actor, actorRole: 'orchestrator', taskId: 'orchestrator:sweep',
        body: output.slice(offset, offset + 4_000), idempotencyKey: `channel-response:${runId}:${offset}` }).id;
    }
    const now = Date.now();
    db.prepare(`UPDATE coordination_channel_runs SET status='responded',response_id=?,finished_at=? WHERE id=? AND status='running'`)
      .run(responseId, now, runId);
    db.prepare(`UPDATE coordination_channel_deliveries SET status='responded',updated_at=? WHERE id=? AND run_id=?`).run(now, id, runId);
  }).immediate();
  broadcastEvent({ type: 'coordination:channel-status', data: { repoKey: getChannelDelivery(id).repoKey } });
}

/** 프로젝트 잠금을 확보한 coordinator만 호출한다. 실행 결과가 없으면 자동 재실행하지 않는다. */
export function recoverCoordinatorDeliveries(repoKey: string): void {
  const db = channelDatabase();
  const rows = db.prepare(`SELECT d.id,d.run_id,r.status FROM coordination_channel_deliveries d
    LEFT JOIN coordination_channel_runs r ON r.id=d.run_id
    WHERE d.repo_key=? AND d.recipient IS NULL AND d.status='processing'`).all(repoKey) as Array<{id: string; run_id: string; status: string | null}>;
  for (const r of rows) {
    if (r.status === 'responded') db.prepare(`UPDATE coordination_channel_deliveries SET status='responded' WHERE id=?`).run(r.id);
    else finishChannelDelivery(r.id, r.run_id, 'interrupted', 'Coordinator stopped without a durable response. Retry explicitly.');
  }
}

export function retryChannelDelivery(repoKey: string, id: string): ChannelDelivery {
  requireChannel(repoKey, true);
  const db = channelDatabase();
  const update = db.prepare(`UPDATE coordination_channel_deliveries SET status='queued',run_id=NULL,error=NULL,updated_at=?
    WHERE id=? AND repo_key=? AND status IN ('failed','interrupted')`).run(Date.now(), id, repoKey);
  if (!update.changes) throw new Error('Delivery retry conflict');
  return getChannelDelivery(id);
}

/** 보드 밖에서도 정확한 프로젝트·작업·주소로 영속 메시지를 가져온다. */
export function consumeChannelTaskInbox(repoKey: string, taskId: string, actor: string): CoordinationEvent[] {
  const db = channelDatabase();
  return db.transaction(() => {
    const rows = db.prepare(`SELECT * FROM coordination_channel_deliveries WHERE repo_key=? AND task_id=?
      AND recipient=? AND status='queued' ORDER BY created_at,id LIMIT 50`).all(repoKey, taskId, actor) as DeliveryRow[];
    return rows.flatMap((row) => {
      const runId = claimChannelDelivery(row.id);
      if (!runId) return [];
      const item = delivery(row);
      return [{ id: row.id, seq: 0, timestamp: row.created_at, repository: requireChannel(repoKey).repository, repoKey,
        taskId: 'operator', sourceTaskId: 'operator', targetTaskId: taskId, actor: 'operator-dashboard', actorName: 'Operator',
        actorRole: 'human', recipient: actor, kind: 'thread-update' as const, status: 'open' as const,
        correlationId: `channel:${row.id}`, summary: channelMessageBody(item), fingerprint: row.fingerprint,
        metadata: { threadId: row.thread_id, deliveryId: row.id, action: 'created' } }];
    });
  }).immediate();
}

export function interruptEndedTaskDeliveries(sessions: readonly ProjectSession[]): void {
  const db = channelDatabase();
  const rows = db.prepare(`SELECT * FROM coordination_channel_deliveries WHERE recipient IS NOT NULL
    AND status IN ('queued','processing')`).all() as DeliveryRow[];
  for (const row of rows) {
    if (row.correlation_id && row.status === 'queued') continue;
    const active = sessions.find((s) => s.repoKey === row.repo_key && s.taskId === row.task_id);
    const role = db.prepare(`SELECT actor_role FROM coordination_trace WHERE repo_key=?
      AND COALESCE(source_task_id,task_id)=? AND actor=? ORDER BY id DESC LIMIT 1`)
      .get(row.repo_key, row.task_id, row.recipient) as { actor_role: string | null } | undefined;
    const run = row.run_id ? db.prepare(`SELECT started_at FROM coordination_channel_runs WHERE id=?`)
      .get(row.run_id) as { started_at: number } | undefined : undefined;
    if (active && (!active.stage || active.stage === role?.actor_role)
      && (!run || !active.startedAt || active.startedAt <= run.started_at)) continue;
    if (row.run_id) finishChannelDelivery(row.id, row.run_id, 'interrupted', 'Recipient is no longer running');
    else db.prepare(`UPDATE coordination_channel_deliveries SET status='interrupted',error='Recipient is no longer running',updated_at=?
      WHERE id=? AND status='queued'`).run(Date.now(), row.id);
  }
}
