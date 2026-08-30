// ============================================
// OpenSwarm - Tracker-backed coordination board
// ============================================

import type { ITaskSource } from '../automation/taskSource.js';
import type { CoordinationEvent } from './coordinationStore.js';

const MARKER = '<!-- openswarm-coordination:';

export function formatCoordinationComment(event: CoordinationEvent): string {
  const body = {
    version: 1,
    id: event.id,
    seq: event.seq,
    repository: event.repository,
    repoKey: event.repoKey,
    taskId: event.taskId,
    taskLabel: event.taskLabel,
    sourceTaskId: event.sourceTaskId,
    sourceTaskLabel: event.sourceTaskLabel,
    targetTaskId: event.targetTaskId,
    targetTaskLabel: event.targetTaskLabel,
    actor: event.actor,
    // Call signs travel with the message: a board comment restored on another
    // host would otherwise show routing addresses where the operator expects
    // the name the agent is known by.
    actorName: event.actorName,
    actorRole: event.actorRole,
    recipient: event.recipient,
    recipientName: event.recipientName,
    recipientRole: event.recipientRole,
    kind: event.kind,
    status: event.status,
    correlationId: event.correlationId,
    summary: event.summary,
    detail: event.detail,
    metadata: event.metadata,
    fingerprint: event.fingerprint,
    timestamp: event.timestamp,
  };
  return [
    `## Agent board — ${event.kind}`,
    '',
    `**${event.actorName ?? event.actor} → ${event.recipientName ?? event.recipient ?? 'all'}** · ${event.status}`,
    '',
    event.summary,
    ...(event.detail ? ['', event.detail] : []),
    '',
    `${MARKER}${Buffer.from(JSON.stringify(body)).toString('base64url')} -->`,
  ].join('\n');
}

export function parseCoordinationComment(body: string): CoordinationEvent | null {
  const start = body.lastIndexOf(MARKER);
  if (start < 0) return null;
  const end = body.indexOf(' -->', start);
  if (end < 0) return null;
  try {
    const encoded = body.slice(start + MARKER.length, end).trim();
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CoordinationEvent & { version?: number };
    if (parsed.version !== 1 || typeof parsed.id !== 'string' || typeof parsed.fingerprint !== 'string') return null;
    const { version: _version, ...event } = parsed;
    return event;
  } catch { // cxt-ignore: error_swallow,exception_hiding — a non-board comment is not an error, just not ours
    return null;
  }
}

export class TrackerCoordinationBoard {
  constructor(private readonly source: ITaskSource, private readonly boardIssueId: string) {}

  async publish(event: CoordinationEvent): Promise<void> {
    await this.source.addComment(this.boardIssueId, formatCoordinationComment(event), `coordination:${event.fingerprint}`);
  }

  async read(): Promise<CoordinationEvent[]> {
    if (!this.source.getExecutionComments) return [];
    const comments = await this.source.getExecutionComments(this.boardIssueId);
    return comments.flatMap((comment) => {
      const event = parseCoordinationComment(comment.body);
      return event ? [event] : [];
    }).sort((a, b) => a.seq - b.seq);
  }
}
