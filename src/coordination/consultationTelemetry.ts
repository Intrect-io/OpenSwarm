import type { CoordinationEvent } from './coordinationStore.js';

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
  const responses = new Set<string>();
  const acknowledgments = new Set<string>();

  for (const event of events) {
    if (event.kind === 'advice-response') {
      telemetry.responses += 1;
      responses.add(event.correlationId);
    }
    if (event.kind === 'thread-update' && typeof event.metadata?.acknowledgesCorrelationId === 'string') {
      acknowledgments.add(event.metadata.acknowledgesCorrelationId);
    }
    if (event.kind !== 'advice-request') continue;
    telemetry.requests += 1;
    if (typeof event.metadata?.threadId === 'string') telemetry.threadLinkedRequests += 1;
    if ((event.sourceTaskId ?? event.taskId) !== (event.targetTaskId ?? event.taskId)) {
      telemetry.crossTaskRequests += 1;
    }
    if (event.actorRole && event.recipientRole && event.actorRole !== event.recipientRole) {
      telemetry.crossRoleRequests += 1;
    }
  }

  telemetry.acknowledgedResponses = [...acknowledgments].filter((correlationId) => responses.has(correlationId)).length;
  return telemetry;
}
