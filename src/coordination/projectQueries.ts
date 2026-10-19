import type { AutonomousRunner } from '../automation/autonomousRunner.js';
import { getCoordinationStore } from './coordinationStore.js';
import { toEvent } from './coordinationTrace.js';
import { channelDatabase } from './channelSchema.js';
import { syncChannels } from './channelStore.js';
import { repositoryCell, repositoryKey } from './repositoryCell.js';
import { buildProjectSnapshot, type OperatorNeed, type ProjectSession, type ProjectSnapshot } from './projectModel.js';
import { taskEventKey } from '../orchestration/decisionEngine.js';
import { runningProjectSessions } from './projectRuntime.js';

export type ProjectRunner = Pick<AutonomousRunner, 'getAllowedProjects' | 'getRunningTasks' | 'getQueuedTasks' | 'getStats'>;

/** 집계는 페이지 크기와 라이브 보드 상한으로 잘리지 않는다. */
export function queryProjectSnapshot(paths: readonly string[], runner?: ProjectRunner): ProjectSnapshot {
  const channels = syncChannels(paths);
  const db = channelDatabase();
  const unavailable: string[] = [];
  let events: ReturnType<typeof toEvent>[] = [];
  const sessions: ProjectSession[] = [];
  const knownTasks: ProjectSession[] = [];
  const parked: OperatorNeed[] = [];
  try {
    events = (db.prepare(`SELECT t.* FROM coordination_trace t WHERE t.id IN (
      SELECT MAX(id) FROM coordination_trace GROUP BY COALESCE(repo_key,repository),COALESCE(source_task_id,task_id),actor
    ) OR t.id IN (
      SELECT id FROM (SELECT t.*, ROW_NUMBER() OVER (
        PARTITION BY COALESCE(repo_key,repository),correlation_id ORDER BY id DESC) rn
        FROM coordination_trace t)
      WHERE rn=1 AND correlation_id IN (SELECT correlation_id FROM coordination_trace WHERE kind='human-question')
    )`).all() as Array<Parameters<typeof toEvent>[0]>).map(toEvent);
  } catch { unavailable.push('activity', 'questions'); }
  try {
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const e of getCoordinationStore().snapshot().events) byId.set(e.id, e);
    events = [...byId.values()].map((e) => ({ ...e, repoKey: repositoryKey(e.repoKey, e.repository) }));
  } catch { unavailable.push('live board'); }
  if (runner) {
    try {
      sessions.push(...runningProjectSessions(runner));
      for (const q of runner.getQueuedTasks()) sessions.push({ repoKey: repositoryCell(q.projectPath).repoKey,
        taskId: taskEventKey(q.task), title: q.task.title, status: 'queued' });
    } catch { unavailable.push('sessions'); }
  } else unavailable.push('sessions');
  try {
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='automation_runs'`).get()) {
      const runs = db.prepare(`SELECT issue_id,identifier,title,project_path,state,last_error_message FROM automation_runs`).all() as Array<{
        issue_id: string; identifier: string | null; title: string | null; project_path: string; state: string; last_error_message: string | null;
      }>;
      for (const r of runs) {
        const repoKey = repositoryCell(r.project_path).repoKey;
        knownTasks.push({ repoKey, taskId: r.issue_id, title: r.title ?? r.identifier ?? r.issue_id, status: r.state, blockedReason: r.last_error_message ?? undefined });
        if (r.state === 'NEEDS_HUMAN') parked.push({ id: `park:${r.issue_id}`, repoKey, taskId: r.issue_id,
          taskLabel: r.identifier ?? undefined, question: r.last_error_message ?? undefined, kind: 'parked' });
      }
    }
  } catch { unavailable.push('ledger'); }
  for (const t of db.prepare(`SELECT DISTINCT t.repository,tt.task_id FROM coordination_threads t
    JOIN coordination_thread_tasks tt ON tt.thread_id=t.thread_id WHERE tt.task_id!='operator'`).all() as Array<{repository: string; task_id: string}>) {
    if (!knownTasks.some((k) => k.repoKey === t.repository && k.taskId === t.task_id)) knownTasks.push({
      repoKey: t.repository, taskId: t.task_id, title: t.task_id, status: 'recorded',
    });
  }
  return buildProjectSnapshot({ channels, sessions, knownTasks, events, parked, unavailable });
}

/** 전체 관계 목록은 원본을 서버에서 집계한다. 표시용 그래프 상한과 무관하다. */
export function queryTaskRelations(repoKey: string, taskId: string): { nodes: Array<{
  id: string; address: string; name: string; role?: string;
}>; edges: Array<{ source: string; target: string; count: number }> } {
  const db = channelDatabase();
  const rows = db.prepare(`SELECT t.* FROM coordination_trace t LEFT JOIN coordination_channel_aliases a
    ON a.repository=t.repository WHERE COALESCE(t.repo_key,a.repo_key)=?
    AND (COALESCE(t.source_task_id,t.task_id)=? OR t.target_task_id=?) ORDER BY t.id`)
    .all(repoKey, taskId, taskId) as Array<Parameters<typeof toEvent>[0]>;
  const nodes = new Map<string, {id: string; address: string; name: string; role?: string}>();
  const edges = new Map<string, {source: string; target: string; count: number}>();
  for (const e of rows.map(toEvent)) {
    const source = JSON.stringify([repoKey, e.sourceTaskId ?? e.taskId, e.actor]);
    nodes.set(source, { id: source, address: e.actor, name: e.actorName ?? e.actor, role: e.actorRole });
    // 명시적인 수신 작업이 없으면 다른 프로젝트/작업 관계를 추측하지 않는다.
    if (!e.recipient || !e.targetTaskId) continue;
    const target = JSON.stringify([repoKey, e.targetTaskId, e.recipient]);
    nodes.set(target, { id: target, address: e.recipient, name: e.recipientName ?? e.recipient, role: e.recipientRole });
    const key = JSON.stringify([source, target]);
    const previous = edges.get(key);
    edges.set(key, { source, target, count: (previous?.count ?? 0) + 1 });
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
