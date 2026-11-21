// Created: 2026-11-22
// Purpose: pin the MaintenanceHost contract — state is per runner and runner methods are read at call time
// Dependencies: runnerMaintenance, autonomousRunner
// Test Status: passing

import { describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { setTaskSource } from './runnerExecution.js';
import { createMaintenanceState, maybeRunBacklogGrooming, syslogSkipSummary, type MaintenanceHost } from './runnerMaintenance.js';

function fakeHost(): MaintenanceHost {
  return {
    maintenance: createMaintenanceState(),
    config: { allowedProjects: [] },
    scheduler: { isTaskQueued: () => false, isTaskRunning: () => false },
    durableRuns: { getRun: () => null, recordPullRequestState: () => false },
    syslog: () => {},
    resolveProjectPath: async () => null,
    resolveRegistryProjectId: (projectPath) => projectPath,
    groupTasksForGrooming: async () => new Map(),
    completeParentIfChildrenMerged: async () => {},
  };
}

describe('MaintenanceHost contract (AGT-4867)', () => {
  it('keeps the skip summary on the host state and logs through the current syslog', () => {
    const host = fakeHost();
    const first = vi.fn();
    host.syslog = first;
    syslogSkipSummary(host, new Map([['ProjA', 2]]), new Map());
    expect(first).toHaveBeenCalledTimes(1);
    expect(host.maintenance.lastSkipSummary).toContain('ProjA (2)');

    const second = vi.fn();
    host.syslog = second;
    syslogSkipSummary(host, new Map([['ProjA', 2]]), new Map());
    expect(second).not.toHaveBeenCalled();
    syslogSkipSummary(host, new Map([['ProjA', 3]]), new Map());
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('groups grooming tasks through the host at call time and leaves the cadence unset without a planner run', async () => {
    setTaskSource({ kind: 'local' } as unknown as Parameters<typeof setTaskSource>[0]);
    const host = fakeHost();
    host.config = { allowedProjects: [], backlogGrooming: { enabled: true } };
    const lines: string[] = [];
    host.syslog = (line) => { lines.push(line); };
    const group = vi.fn(async () => new Map<string, TaskItem[]>());
    host.groupTasksForGrooming = group;
    const tasks = [{
      id: 'A', issueId: 'A', issueIdentifier: 'A', source: 'linear', title: 'A', priority: 2, createdAt: 0, linearState: 'Todo',
    } as TaskItem];
    expect(await maybeRunBacklogGrooming(host, tasks)).toBe(tasks);
    expect(group).toHaveBeenCalledWith(tasks);
    expect(lines).toEqual(['⚠ Backlog grooming skipped: no mapped project paths']);
    expect(host.maintenance.lastBacklogGroomingAt).toBe(0);
  });
});

describe('the runner builds its maintenance host late-bound (AGT-4867)', () => {
  it('honours a reassigned syslog and keeps state per runner instance', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'openswarm-maintenance-host-'));
    for (const [key, file] of [
      ['OPENSWARM_TASK_STATE_FILE', 'task-state.json'], ['OPENSWARM_RUNNER_TASK_STATE_FILE', 'runner-state.json'],
      ['OPENSWARM_RUNNER_REJECTION_STATE_FILE', 'rejections.json'], ['OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', 'history.json'],
      ['OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', 'decomposition.json'],
    ] as const) vi.stubEnv(key, join(root, file));
    try {
      const { AutonomousRunner } = await import('./autonomousRunner.js');
      type Internal = {
        syslog(line: string): void;
        syslogSkipSummary(unmapped: Map<string, number>, disabled: Map<string, number>): void;
      };
      const make = () => new AutonomousRunner({
        linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
        autoExecute: true, dryRun: true, automationLedgerMode: 'off',
      }) as unknown as Internal;
      const a = make();
      const b = make();

      const seenA: string[] = [];
      a.syslog = (line) => { seenA.push(`first:${line}`); };
      a.syslogSkipSummary(new Map([['ProjA', 1]]), new Map());
      a.syslog = (line) => { seenA.push(line); };
      a.syslogSkipSummary(new Map([['ProjA', 2]]), new Map());
      expect(seenA).toHaveLength(2);
      expect(seenA[0]).toMatch(/^first:/);
      expect(seenA[1]).toContain('ProjA (2)');

      // A second runner has its own lastSkipSummary, so the same summary still logs there.
      const seenB: string[] = [];
      b.syslog = (line) => { seenB.push(line); };
      b.syslogSkipSummary(new Map([['ProjA', 2]]), new Map());
      expect(seenB).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
