import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AutonomousRunner } from '../automation/autonomousRunner.js';
import { broadcastEvent } from '../core/eventHub.js';
import { queryProjectSnapshot, queryTaskRelations } from './projectQueries.js';
import { participantId, type ProjectSnapshot } from './projectModel.js';
import { listChannelEntries, markChannelRead, pageLimit, requireChannel, type Page } from './channelStore.js';
import { findChannelDeliveryByKey, getChannelDelivery, retryChannelDelivery, sendChannelMessage } from './channelQueue.js';
import { channelDatabase } from './channelSchema.js';
import { toEvent } from './coordinationTrace.js';
import { getCoordinationStore } from './coordinationStore.js';
import { HttpError } from '../support/httpBody.js';

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
export function projectPage<T>(items: T[], key: (item: T) => string, scope: string, params: URLSearchParams): Page<T> {
  const rawLimit = params.get('limit');
  const limit = pageLimit(rawLimit === null ? undefined : Number(rawLimit));
  const sorted = [...items].sort((a, b) => key(a).localeCompare(key(b), 'en'));
  let last = '';
  let ceiling = sorted.length ? key(sorted.at(-1)!) : '';
  const cursor = params.get('cursor');
  if (cursor) {
    try {
      const p = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (!Array.isArray(p) || p.length !== 3 || p[0] !== scope || typeof p[1] !== 'string' || typeof p[2] !== 'string') throw new Error();
      [, last, ceiling] = p;
    } catch { throw new Error('Invalid cursor'); }
  }
  const remaining = sorted.filter((item) => key(item).localeCompare(last, 'en') > 0 && key(item).localeCompare(ceiling, 'en') <= 0);
  const page = remaining.slice(0, limit);
  return { items: page,
    ...(remaining.length > limit ? { nextCursor: Buffer.from(JSON.stringify([scope, key(page.at(-1)!), ceiling])).toString('base64url') } : {}),
    scope: { limit, source: scope }, partial: false, unavailable: [] };
}

function scopedSnapshot(paths: readonly string[], runner: AutonomousRunner | undefined): ProjectSnapshot {
  return queryProjectSnapshot(paths, runner);
}
function string(body: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = body[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Invalid ${key}`);
  return v;
}

/** web.ts가 인증·Origin·본문 크기 제한을 적용한 후에만 위임한다. */
export async function tryHandleProjectRoutes(
  req: IncomingMessage, res: ServerResponse, path: string, url: URL,
  runner: AutonomousRunner | undefined, paths: readonly string[], readBody: (req: IncomingMessage) => Promise<string>,
): Promise<boolean> {
  if (!/^\/api\/coordination\/(?:projects|channels|needs-you)(?:\/|$)/.test(path)) return false;
  try {
    const snapshot = scopedSnapshot(paths, runner);
    if (req.method === 'GET' && path === '/api/coordination/projects') {
      json(res, 200, { ...projectPage(snapshot.projects.map((p) => ({ ...p,
        coordinatorAvailable: runner?.isProjectCoordinatorAvailable(p.repoKey) ?? false })), (p) => p.repoKey, 'projects', url.searchParams),
        totals: snapshot.totals, partial: snapshot.partial, unavailable: snapshot.unavailable,
        activityScope: snapshot.scope, generatedAt: snapshot.generatedAt });
      return true;
    }
    if (req.method === 'GET' && path === '/api/coordination/needs-you') {
      const repoKey = url.searchParams.get('repoKey');
      json(res, 200, { ...projectPage(snapshot.needs.filter((n) => !repoKey || n.repoKey === repoKey),
        (n) => `${n.repoKey}:${n.id}`, `needs:${repoKey ?? '*'}`, url.searchParams),
        total: snapshot.totals.needsYou, partial: snapshot.partial, unavailable: snapshot.unavailable });
      return true;
    }
    const taskMatch = /^\/api\/coordination\/projects\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(path);
    if (taskMatch && req.method === 'GET') {
      const repoKey = decodeURIComponent(taskMatch[1]);
      requireChannel(repoKey);
      const tasks = snapshot.tasks.filter((t) => t.repoKey === repoKey);
      if (!taskMatch[2]) {
        json(res, 200, { ...projectPage(tasks, (t) => t.taskId, `tasks:${repoKey}`, url.searchParams),
          partial: snapshot.partial, unavailable: snapshot.unavailable });
        return true;
      }
      const taskId = decodeURIComponent(taskMatch[2]);
      const task = tasks.find((t) => t.taskId === taskId);
      if (!task) throw new Error('Task not found');
      const { nodes, edges } = queryTaskRelations(repoKey, taskId);
      const selected = url.searchParams.get('node');
      const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
      const selectedNode = nodes.find((n) => n.id === selected);
      const visible = [...(selectedNode ? [selectedNode] : []), ...ordered.filter((n) => n.id !== selectedNode?.id)].slice(0, 20);
      const ids = new Set(visible.map((n) => n.id));
      const visibleEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target)).slice(0, 40);
      const query = (url.searchParams.get('search') ?? '').toLocaleLowerCase();
      const matching = new Set(nodes.filter((n) => `${n.name} ${n.address}`.toLocaleLowerCase().includes(query)).map((n) => n.id));
      const names = new Map(nodes.map((n) => [n.id, `${n.name} (${n.address})`]));
      const relationships = edges.filter((e) => matching.has(e.source) || matching.has(e.target))
        .map((e) => ({ ...e, sourceLabel: names.get(e.source), targetLabel: names.get(e.target) }));
      if (url.searchParams.get('part') === 'connections') {
        json(res, 200, projectPage(relationships, (e) => `${e.source}:${e.target}`,
          `relationships:${repoKey}:${taskId}:${query}`, url.searchParams));
        return true;
      }
      json(res, 200, { task, graph: { nodes: visible, edges: visibleEdges,
        omittedNodes: nodes.length - visible.length, omittedEdges: edges.length - visibleEdges.length },
        participants: projectPage(nodes.filter((n) => `${n.name} ${n.address}`.toLocaleLowerCase().includes(query)),
          (n) => n.id, `participants:${repoKey}:${taskId}:${query}`, url.searchParams),
        relationships: projectPage(relationships,
          (e) => `${e.source}:${e.target}`, `relationships:${repoKey}:${taskId}:${query}`, new URLSearchParams({ limit: '50' })),
        relationTotals: { participants: nodes.length, connections: edges.length },
        partial: snapshot.partial, unavailable: snapshot.unavailable });
      return true;
    }
    const match = /^\/api\/coordination\/channels\/([^/]+)\/(entries|messages|read|deliveries\/([^/]+)\/retry)$/.exec(path);
    if (!match) { json(res, 404, { error: 'Channel endpoint not found' }); return true; }
    const repoKey = decodeURIComponent(match[1]);
    requireChannel(repoKey);
    if (match[2] === 'entries' && req.method === 'GET') {
      const params = url.searchParams;
      json(res, 200, listChannelEntries(repoKey, { cursor: params.get('cursor') ?? undefined,
        limit: params.has('limit') ? Number(params.get('limit')) : undefined,
        threadId: params.get('threadId') ?? undefined, taskId: params.get('taskId') ?? undefined,
        correlationId: params.get('correlationId') ?? undefined }));
      return true;
    }
    if (match[2] === 'read' && req.method === 'GET') {
      const channel = requireChannel(repoKey);
      json(res, 200, { readSeq: channel.readSeq, unread: channel.unread, latestSeq: channel.latestSeq });
      return true;
    }
    if (req.method !== 'POST' || match[2] === 'entries') { json(res, 405, { error: 'Method not allowed' }); return true; }
    const raw: unknown = JSON.parse(await readBody(req));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid request body');
    const body = raw as Record<string, unknown>;
    if (match[2] === 'read') {
      const readSeq = markChannelRead(repoKey, body.throughSeq as number);
      const channel = requireChannel(repoKey);
      json(res, 200, { readSeq, unread: channel.unread, latestSeq: channel.latestSeq });
      return true;
    }
    if (match[3]) {
      const previous = getChannelDelivery(decodeURIComponent(match[3]));
      if (previous.repoKey !== repoKey) throw new Error('Delivery scope conflict');
      if (previous.taskId && !snapshot.tasks.some((t) => t.repoKey === repoKey && t.taskId === previous.taskId
        && t.status === 'running' && t.participants.some((p) => p.address === previous.recipient && p.canReceive))) throw new Error('Recipient is no longer running');
      const result = retryChannelDelivery(repoKey, previous.id);
      broadcastEvent({ type: 'coordination:channel', data: { repoKey } });
      json(res, 202, { delivery: result });
      return true;
    }
    const taskId = string(body, 'taskId');
    const recipient = string(body, 'recipient');
    const correlationId = string(body, 'correlationId');
    const idempotencyKey = string(body, 'idempotencyKey', true)!;
    if (!findChannelDeliveryByKey(repoKey, idempotencyKey) && taskId && recipient) {
      const need = correlationId ? snapshot.needs.find((n) => n.repoKey === repoKey && n.taskId === taskId
        && n.correlationId === correlationId && n.actor === recipient) : undefined;
      const running = snapshot.tasks.find((t) => t.repoKey === repoKey && t.taskId === taskId && t.status === 'running');
      if (!need && (!running || !running.participants.some((p) => p.id === participantId(repoKey, taskId, recipient) && p.canReceive))) {
        throw new Error('Recipient is no longer running or task scope conflicts');
      }
      if (correlationId && !need) throw new Error('Question scope conflict');
    }
    const result = sendChannelMessage({ repoKey, body: string(body, 'body', true)!, idempotencyKey,
      taskId, recipient, correlationId, threadId: string(body, 'threadId') });
    // 원자 커밋된 답변은 기존 재개 정책이 읽는다. 보드는 알림이며 실패해도 접수 상태를 바꾸지 않는다.
    if (correlationId) {
      const rows = channelDatabase().prepare(`SELECT * FROM coordination_trace WHERE event_id LIKE ?`).all(`channel-answer:${result.id}:%`) as Array<Parameters<typeof toEvent>[0]>;
      for (const row of rows) {
        const e = toEvent(row);
        try { await getCoordinationStore().publish(e); }
        catch (error) { console.warn('[Channels] Answer notification pending:', error instanceof Error ? error.message : String(error)); }
      }
    }
    json(res, 202, { delivery: result, coordinatorAvailable: runner?.isProjectCoordinatorAvailable(repoKey) ?? false });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Channel request failed';
    const status = error instanceof HttpError ? error.statusCode : /not found/i.test(message) ? 404 : /unavailable|SQLITE|database/i.test(message) ? 503
      : /conflict|read-only|no longer running|already answered/i.test(message) ? 409 : 400;
    json(res, status, { error: status === 503 ? 'Project data unavailable. Retry when the store recovers.' : message });
    return true;
  }
}
