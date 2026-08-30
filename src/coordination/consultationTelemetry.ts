import type { CoordinationEvent } from './coordinationStore.js';

export interface ValidAdviceExchange {
  request: CoordinationEvent;
  response: CoordinationEvent;
}

function sourceTask(event: CoordinationEvent): string {
  return event.sourceTaskId ?? event.taskId;
}

function targetTask(event: CoordinationEvent): string {
  return event.targetTaskId ?? event.taskId;
}

function repositoryIdentity(event: CoordinationEvent): string {
  return event.repoKey ?? event.repository;
}

function isAdviceRequest(event: CoordinationEvent): boolean {
  return event.kind === 'advice-request'
    && event.status === 'open'
    && event.metadata?.consultation === true
    && event.metadata?.consultationPhase === 'request'
    && typeof event.recipient === 'string'
    && event.recipient.length > 0
    && event.actor !== event.recipient;
}

function matchesAdviceResponse(request: CoordinationEvent, response: CoordinationEvent): boolean {
  const requestThread = typeof request.metadata?.threadId === 'string' ? request.metadata.threadId : undefined;
  const responseThread = typeof response.metadata?.threadId === 'string' ? response.metadata.threadId : undefined;
  return response.kind === 'advice-response'
    && response.status === 'completed'
    && response.correlationId === request.correlationId
    && response.seq > request.seq
    && response.metadata?.consultation === true
    && response.metadata?.consultationPhase === 'response'
    && repositoryIdentity(response) === repositoryIdentity(request)
    && response.actor === request.recipient
    && sourceTask(response) === targetTask(request)
    && response.recipient === request.actor
    && targetTask(response) === sourceTask(request)
    && requestThread === responseThread;
}

/** Return only a response that reverses the original trusted routing envelope. */
export function validAdviceExchange(
  events: readonly CoordinationEvent[],
  correlationId: string,
): ValidAdviceExchange | undefined {
  const ordered = events
    .filter((event) => event.correlationId === correlationId)
    .slice()
    .sort((left, right) => left.seq - right.seq);
  const requests = ordered.filter(isAdviceRequest);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const response = ordered[index];
    if (response.kind !== 'advice-response') continue;
    for (let requestIndex = requests.length - 1; requestIndex >= 0; requestIndex -= 1) {
      const request = requests[requestIndex];
      if (matchesAdviceResponse(request, response)) return { request, response };
    }
  }
  return undefined;
}

/** Board-derived activation evidence; no model self-report is counted. */
export interface ConsultationTelemetry {
  requests: number;
  responses: number;
  acknowledgedResponses: number;
  threadLinkedRequests: number;
  crossTaskRequests: number;
  crossRoleRequests: number;
}

export function consultationTelemetry(events: readonly CoordinationEvent[]): ConsultationTelemetry {
  const telemetry: ConsultationTelemetry = {
    requests: 0,
    responses: 0,
    acknowledgedResponses: 0,
    threadLinkedRequests: 0,
    crossTaskRequests: 0,
    crossRoleRequests: 0,
  };
  const requests = new Map<string, CoordinationEvent>();

  for (const event of events) {
    if (isAdviceRequest(event) && !requests.has(event.correlationId)) requests.set(event.correlationId, event);
  }

  telemetry.requests = requests.size;
  for (const request of requests.values()) {
    if (typeof request.metadata?.threadId === 'string') telemetry.threadLinkedRequests += 1;
    if (sourceTask(request) !== targetTask(request)) telemetry.crossTaskRequests += 1;
    if (request.actorRole && request.recipientRole && request.actorRole !== request.recipientRole) {
      telemetry.crossRoleRequests += 1;
    }
    const exchange = validAdviceExchange(events, request.correlationId);
    if (!exchange) continue;
    telemetry.responses += 1;
    const requestThread = typeof request.metadata?.threadId === 'string' ? request.metadata.threadId : undefined;
    const acknowledged = events.some((event) =>
      event.kind === 'thread-update'
      && event.metadata?.acknowledgesCorrelationId === request.correlationId
      && event.actor === request.actor
      && sourceTask(event) === sourceTask(request)
      && (!requestThread || event.metadata?.threadId === requestThread));
    if (acknowledged) telemetry.acknowledgedResponses += 1;
  }
  return telemetry;
}
