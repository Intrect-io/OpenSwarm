// ============================================
// OpenSwarm - Coordination monitoring API
// ============================================

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getCoordinationStore } from './coordinationStore.js';

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function tryHandleCoordinationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  requestUrl: URL,
): boolean {
  if (req.method !== 'GET' || url !== '/api/coordination') return false;
  const repository = requestUrl.searchParams.get('repository') || undefined;
  const afterRaw = Number.parseInt(requestUrl.searchParams.get('afterSeq') ?? '0', 10);
  const afterSeq = Number.isSafeInteger(afterRaw) && afterRaw > 0 ? afterRaw : 0;
  const store = getCoordinationStore();
  const snapshot = store.snapshot(repository);
  writeJson(res, 200, {
    events: snapshot.events.filter((event) => event.seq > afterSeq),
    pending: snapshot.pending,
    lastSeq: snapshot.events.at(-1)?.seq ?? 0,
  });
  return true;
}
