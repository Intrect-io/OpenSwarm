import type { AutonomousRunner } from '../automation/autonomousRunner.js';
import { getStageBuffer } from '../core/eventHub.js';
import { taskEventKey } from '../orchestration/decisionEngine.js';
import { repositoryCell } from './repositoryCell.js';
import type { ProjectSession } from './projectModel.js';

/** Uses the current scheduler session and actual stage start/complete records, not recent utterances. */
export function runningProjectSessions(runner: Pick<AutonomousRunner, 'getRunningTasks'>): ProjectSession[] {
  const stages = getStageBuffer().filter((e) => e.type === 'pipeline:stage');
  return runner.getRunningTasks().map((r) => {
    const repoKey = repositoryCell(r.projectPath).repoKey;
    const last = [...stages].reverse().find((e) => e.data.taskId === taskEventKey(r.task)
      && (e.data.projectPath || e.data.repository)
      && repositoryCell(e.data.projectPath ?? e.data.repository!).repoKey === repoKey);
    return { repoKey, taskId: taskEventKey(r.task), title: r.task.title, status: 'running', startedAt: r.startedAt,
      stage: last ? last.data.status === 'start' ? last.data.stage : 'between stages' : r.stage };
  });
}
