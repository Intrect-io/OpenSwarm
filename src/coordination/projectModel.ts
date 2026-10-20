import type { CoordinationEvent } from './coordinationStore.js';
import type { Channel } from './channelStore.js';

export const RECENT_PARTICIPANT_WINDOW = 30 * 60_000;
export interface ProjectSession {
  repoKey: string; taskId: string; title: string; status: string; stage?: string; startedAt?: number;
  blockedReason?: string;
}
export interface OperatorNeed {
  id: string; repoKey: string; taskId: string; taskLabel?: string; question?: string;
  correlationId?: string; actor?: string; kind: 'question' | 'parked';
}
export interface ProjectTask {
  repoKey: string; taskId: string; title: string; status: string; stage?: string;
  blockedReason?: string;
  participants: Array<{ id: string; address: string; name: string; role?: string; recent: boolean; canReceive: boolean }>;
  needs: OperatorNeed[];
}
export interface ProjectSummary extends Channel {
  runningTasks: number | null; recentParticipants: number | null; needsYou: number | null;
}
export interface ProjectSnapshot {
  projects: ProjectSummary[]; needs: OperatorNeed[]; tasks: ProjectTask[];
  totals: { runningTasks: number | null; recentParticipants: number | null; needsYou: number | null; questions: number; parked: number };
  partial: boolean; unavailable: string[]; generatedAt: number;
  scope: { participantsSince: number; source: string };
}

/** 이름이나 task ID만으로 전역 참가자를 합치지 않는다. */
export function participantId(repoKey: string, taskId: string, actor: string): string {
  return JSON.stringify([repoKey, taskId, actor]);
}

export function buildProjectSnapshot(input: {
  channels: Channel[]; sessions: ProjectSession[]; events: CoordinationEvent[];
  parked?: OperatorNeed[]; knownTasks?: ProjectSession[];
  unavailable?: string[]; now?: number;
}): ProjectSnapshot {
  const now = input.now ?? Date.now();
  const unavailable = [...new Set(input.unavailable ?? [])];
  const tasks = new Map<string, ProjectTask>();
  const latest = new Map<string, CoordinationEvent>();
  const allParticipants = new Map<string, Map<string, { id: string; address: string; name: string; role?: string; lastSeen: number }>>();
  const ensureTask = (repoKey: string, taskId: string, title?: string): ProjectTask => {
    const key = JSON.stringify([repoKey, taskId]);
    let task = tasks.get(key);
    if (!task) {
      task = { repoKey, taskId, title: title ?? taskId, status: 'recorded', participants: [], needs: [] };
      tasks.set(key, task);
    }
    return task;
  };
  for (const e of input.events) {
    if (!e.repoKey) continue;
    const taskId = e.sourceTaskId === 'operator' ? e.targetTaskId ?? e.taskId : e.sourceTaskId ?? e.taskId;
    if (taskId !== 'operator') ensureTask(e.repoKey, taskId, e.sourceTaskLabel ?? e.taskLabel);
    const key = JSON.stringify([e.repoKey, e.correlationId]);
    const previous = latest.get(key);
    if (!previous || e.timestamp > previous.timestamp || (e.timestamp === previous.timestamp && e.seq > previous.seq)) latest.set(key, e);
    if (e.actorRole !== 'human' && e.actorRole !== 'daemon') {
      const id = participantId(e.repoKey, taskId, e.actor);
      const members = allParticipants.get(e.repoKey) ?? new Map();
      const previousMember = members.get(id);
      if (!previousMember || previousMember.lastSeen < e.timestamp) members.set(id, {
        id, address: e.actor, name: e.actorName ?? e.actor, role: e.actorRole, lastSeen: e.timestamp,
      });
      allParticipants.set(e.repoKey, members);
    }
  }
  for (const session of [...(input.knownTasks ?? []), ...input.sessions]) {
    Object.assign(ensureTask(session.repoKey, session.taskId, session.title), session);
  }
  const needs: OperatorNeed[] = [...latest.values()]
    .filter((e) => e.kind === 'human-question' && ['open', 'waiting', 'running'].includes(e.status))
    .map((e) => ({ id: e.id, repoKey: e.repoKey!, taskId: e.sourceTaskId ?? e.taskId,
      taskLabel: e.sourceTaskLabel ?? e.taskLabel, question: e.detail ?? e.summary,
      correlationId: e.correlationId, actor: e.actor, kind: 'question' }));
  for (const parked of input.parked ?? []) {
    const question = needs.find((n) => n.repoKey === parked.repoKey
      && (n.taskId === parked.taskId || n.taskLabel === parked.taskId || (parked.taskLabel && parked.taskLabel === n.taskLabel)));
    if (!question) needs.push(parked);
  }
  for (const need of needs) ensureTask(need.repoKey, need.taskId, need.taskLabel).needs.push(need);
  for (const task of tasks.values()) {
    task.participants = [...(allParticipants.get(task.repoKey)?.values() ?? [])]
      .filter((p) => p.id === participantId(task.repoKey, task.taskId, p.address))
      .map((p) => ({ id: p.id, address: p.address, name: p.name, role: p.role,
        recent: p.lastSeen >= now - RECENT_PARTICIPANT_WINDOW,
        canReceive: task.status === 'running' && task.stage === p.role }));
  }
  const projects = input.channels.map((channel) => ({ ...channel,
    runningTasks: unavailable.includes('sessions') ? null : input.sessions.filter((s) => s.repoKey === channel.repoKey && s.status === 'running').length,
    recentParticipants: unavailable.includes('activity') ? null : [...(allParticipants.get(channel.repoKey)?.values() ?? [])].filter((p) => p.lastSeen >= now - RECENT_PARTICIPANT_WINDOW).length,
    needsYou: unavailable.includes('questions') || unavailable.includes('ledger') ? null : needs.filter((n) => n.repoKey === channel.repoKey).length,
  }));
  const sum = (key: 'runningTasks' | 'recentParticipants' | 'needsYou'): number | null =>
    projects.some((p) => p[key] === null) ? null : projects.reduce((n, p) => n + (p[key] ?? 0), 0);
  return { projects, needs, tasks: [...tasks.values()], totals: {
    runningTasks: sum('runningTasks'), recentParticipants: sum('recentParticipants'), needsYou: sum('needsYou'),
    questions: needs.filter((n) => n.kind === 'question').length, parked: needs.filter((n) => n.kind === 'parked').length,
  }, partial: unavailable.length > 0, unavailable, generatedAt: now,
  scope: { participantsSince: now - RECENT_PARTICIPANT_WINDOW, source: 'sessions + durable coordination + run ledger' } };
}
