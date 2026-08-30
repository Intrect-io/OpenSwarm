// ============================================
// OpenSwarm - Coordination monitoring API
// ============================================
//
// Read surfaces for the orchestration view plus the operator's way into an
// exchange. Mutations here are gated by web.ts's `isAuthorizedMutation` check,
// which runs before this module is reached — see web.ts, where every `/api/`
// mutation is rejected ahead of route delegation.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getCoordinationStore } from './coordinationStore.js';
import { queryTrace, traceSize } from './coordinationTrace.js';
import { consultationTelemetry } from './consultationTelemetry.js';

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseLimit(raw: string | null, fallback: number, max: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

export async function tryHandleCoordinationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  requestUrl: URL,
  readBody?: (req: IncomingMessage) => Promise<string>,
): Promise<boolean> {
  if (req.method === 'GET' && url === '/api/coordination') {
    const repository = requestUrl.searchParams.get('repository') || undefined;
    const afterRaw = Number.parseInt(requestUrl.searchParams.get('afterSeq') ?? '0', 10);
    const afterSeq = Number.isSafeInteger(afterRaw) && afterRaw > 0 ? afterRaw : 0;
    const store = getCoordinationStore();
    const snapshot = store.snapshot(repository);
    writeJson(res, 200, {
      events: snapshot.events.filter((event) => event.seq > afterSeq),
      pending: snapshot.pending,
      lastSeq: snapshot.events.at(-1)?.seq ?? 0,
      traceSize: traceSize(),
      consultation: consultationTelemetry(snapshot.events),
    });
    return true;
  }

  // The permanent trace. The board is a ring buffer, so a conversation older
  // than its window is only readable here.
  if (req.method === 'GET' && url === '/api/coordination/history') {
    const params = requestUrl.searchParams;
    const events = queryTrace({
      repository: params.get('repository') || undefined,
      taskId: params.get('taskId') || undefined,
      taskLabel: params.get('taskLabel') || undefined,
      correlationId: params.get('correlationId') || undefined,
      actor: params.get('actor') || undefined,
      limit: parseLimit(params.get('limit'), 200, 1_000),
    });
    writeJson(res, 200, {
      events,
      traceSize: traceSize(),
      consultation: consultationTelemetry(events),
    });
    return true;
  }

  // Operator attachment upload. Deliberately not routed through `readBody`:
  // that caps a JSON body at 1 MiB and holds it as a string, which is both too
  // small for a real file and the wrong shape for one. The raw stream goes to
  // disk with its own cap enforced as bytes arrive (AGT-4031).
  if (req.method === 'POST' && url === '/api/coordination/attachment') {
    const taskId = requestUrl.searchParams.get('taskId') ?? '';
    if (!taskId) {
      writeJson(res, 400, { error: 'taskId is required so the file lands with the task it belongs to' });
      return true;
    }
    const { storeAttachment } = await import('./attachmentStore.js');
    try {
      const stored = await storeAttachment(req, {
        taskId,
        filename: requestUrl.searchParams.get('filename') ?? undefined,
      });
      writeJson(res, 201, {
        id: stored.id,
        filename: stored.filename,
        bytes: stored.bytes,
        // The agent opens this directly with the file tools it already has —
        // no new tool contract, and the operator sees where it landed.
        path: stored.path,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /exceeds/.test(message) ? 413
        : /storage is full|ENOSPC/.test(message) ? 507
          : 400;
      writeJson(res, status, { error: message });
    }
    return true;
  }


  // Operator interjection. Two shapes, deliberately one endpoint: replying to a
  // blocking question must unblock the agent that asked, while speaking into
  // any other exchange is an ordinary board message the addressee picks up on
  // its next `coordination_read`.
  if (req.method === 'POST' && url === '/api/coordination/message') {
    if (!readBody) {
      writeJson(res, 500, { error: 'Body reader unavailable' });
      return true;
    }
    let body: { correlationId?: unknown; text?: unknown; repository?: unknown; taskId?: unknown; recipient?: unknown };
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch {
      writeJson(res, 400, { error: 'Request body is not valid JSON' });
      return true;
    }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      writeJson(res, 400, { error: 'text must be a non-empty string' });
      return true;
    }
    const correlationId = typeof body.correlationId === 'string' ? body.correlationId : undefined;
    const store = getCoordinationStore();

    // Prefer answering over chatting. The client names the exchange it believes
    // is open, but it only sees a window over the board's ring buffer — so when
    // that lookup misses, fall back to the question that recipient is parked on,
    // which only the server can see (AGT-4030).
    const recipientHint = typeof body.recipient === 'string' && body.recipient ? body.recipient : undefined;
    const scopeHint = {
      ...(typeof body.repository === 'string' && body.repository ? { repository: body.repository } : {}),
      ...(typeof body.taskId === 'string' && body.taskId ? { taskId: body.taskId } : {}),
    };
    const resolvedQuestion = (correlationId ? store.findQuestion(correlationId) : undefined)
      ?? (recipientHint ? store.findOpenQuestionFor(recipientHint, scopeHint) : undefined);

    {
      const question = resolvedQuestion;
      if (question) {
        const { answerHumanQuestion } = await import('./humanQuestions.js');
        const answered = await answerHumanQuestion(question.correlationId, text, 'operator-dashboard');
        if (!answered.accepted) {
          writeJson(res, 409, { error: answered.reason ?? 'Question is no longer answerable' });
          return true;
        }
        writeJson(res, 202, { delivered: true, mode: 'answer', event: answered.event });
        return true;
      }
    }

    // Free-standing note. Address it to the agent the operator is replying to
    // so `store.consume` actually hands it over; without a recipient the
    // message would sit on the board unread.
    const thread = correlationId
      ? store.list({ limit: 500 }).filter((event) => event.correlationId === correlationId)
      : [];
    const last = thread.at(-1);
    const recipient = typeof body.recipient === 'string' && body.recipient
      ? body.recipient
      : last?.actor;
    const repository = typeof body.repository === 'string' && body.repository
      ? body.repository
      : last?.repository;
    const taskId = typeof body.taskId === 'string' && body.taskId ? body.taskId : last?.taskId;
    if (!repository || !taskId || !recipient) {
      writeJson(res, 400, {
        error: 'Cannot address the message: pass repository, taskId and recipient, or a correlationId from an existing exchange',
      });
      return true;
    }

    const event = await store.publish({
      repository,
      taskId,
      taskLabel: last?.taskLabel,
      actor: 'operator-dashboard',
      actorName: 'Operator',
      actorRole: 'human',
      recipient,
      recipientName: last?.actorName,
      recipientRole: last?.actorRole,
      kind: 'advice-response',
      status: 'completed',
      correlationId,
      summary: text.length > 160 ? `${text.slice(0, 157)}...` : text,
      detail: text,
    });
    writeJson(res, 202, { delivered: true, mode: 'note', event });
    return true;
  }

  return false;
}
