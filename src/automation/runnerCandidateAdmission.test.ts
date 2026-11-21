// Created: 2026-11-22
// Purpose: pin the CandidateAdmissionHost contract — state and runner methods are read at call time
// Dependencies: runnerCandidateAdmission
// Test Status: passing

import { describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { resolveRunnableCandidates, type CandidateAdmissionHost } from './runnerCandidateAdmission.js';

const task = (id: string): TaskItem => ({
  id, issueId: id, issueIdentifier: id, source: 'linear', title: id, priority: 2, createdAt: 0,
  linearState: 'Todo', linearProject: { id: 'project', name: 'Repo' },
});

function fakeHost(): CandidateAdmissionHost & { stopping: boolean } {
  return {
    stopping: false,
    config: {},
    scheduler: {
      isTaskQueued: () => false, isTaskRunning: () => false, isProjectBusy: () => false, getRunningTasks: () => [],
    },
    unresolvableIssueIds: new Set<string>(),
    projectPathCache: new Map<string, string>(),
    preAdmissionScopeCache: new Map(),
    unknownScopeDebt: new Set<string>(),
    syslog: () => {},
    resolveProjectPath: async () => '/repo',
    shouldFilterByEnabled: () => false,
    isProjectEnabled: () => true,
    holdDeclinedBeforeClaim: async (group) => group,
    getExecCtx: () => { throw new Error('not drafted here'); },
  } as unknown as CandidateAdmissionHost & { stopping: boolean };
}

describe('CandidateAdmissionHost contract (AGT-4867)', () => {
  it('reads `stopping` on every candidate, not once', async () => {
    const host = fakeHost();
    host.resolveProjectPath = vi.fn(async () => { host.stopping = true; return '/repo'; });
    const out = await resolveRunnableCandidates(host, [{ task: task('A') }, { task: task('B') }]);
    expect(out.map(c => c.task.id)).toEqual(['A']);
    expect(host.projectPathCache.get('Repo')).toBe('/repo');
  });

  it('records an unresolvable project on the host state', async () => {
    const host = fakeHost();
    host.resolveProjectPath = async () => null;
    expect(await resolveRunnableCandidates(host, [{ task: task('A') }])).toEqual([]);
    expect(host.unresolvableIssueIds.has('A')).toBe(true);
  });
});

describe('the runner builds its host late-bound (AGT-4867)', () => {
  it('honours a runner member reassigned after the host was first built', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'openswarm-admission-host-'));
    for (const [key, file] of [
      ['OPENSWARM_TASK_STATE_FILE', 'task-state.json'], ['OPENSWARM_RUNNER_TASK_STATE_FILE', 'runner-state.json'],
      ['OPENSWARM_RUNNER_REJECTION_STATE_FILE', 'rejections.json'], ['OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', 'history.json'],
      ['OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', 'decomposition.json'],
    ] as const) vi.stubEnv(key, join(root, file));
    try {
      const { AutonomousRunner } = await import('./autonomousRunner.js');
      const runner = new AutonomousRunner({
        linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
        autoExecute: true, dryRun: true, automationLedgerMode: 'off',
      });
      const internal = runner as unknown as {
        resolveProjectPath(t: TaskItem): Promise<string | null>;
        resolveRunnableCandidates(d: Array<{ task: TaskItem }>): Promise<Array<{ task: TaskItem; projectPath: string }>>;
        answerArrivedFor(id: string): boolean;
        readmitAnsweredRun(id: string): boolean;
        projectSelectionTouched: boolean;
        enabledProjects: Set<string>;
      };
      // Independent of any project selection saved on this machine.
      internal.projectSelectionTouched = false;
      internal.enabledProjects = new Set();
      internal.resolveProjectPath = async () => '/first';
      expect((await internal.resolveRunnableCandidates([{ task: task('A') }]))[0]?.projectPath).toBe('/first');
      internal.resolveProjectPath = async () => '/second';
      expect((await internal.resolveRunnableCandidates([{ task: task('B') }]))[0]?.projectPath).toBe('/second');

      // Same for the task-filter host: readmitAnsweredRun reaches answerArrivedFor through the runner.
      // Stubbed from the start so no real coordination store is opened.
      const seen: string[] = [];
      internal.answerArrivedFor = (id) => { seen.push(`first:${id}`); return false; };
      expect(internal.readmitAnsweredRun('X')).toBe(false);
      internal.answerArrivedFor = (id) => { seen.push(id); return false; };
      expect(internal.readmitAnsweredRun('Y')).toBe(false);
      expect(seen).toEqual(['first:X', 'Y']);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
