import { describe, it, expect } from 'vitest';
import {
  projectsToTable,
  pipelineToTable,
  stuckToTable,
  issuesToTable,
} from './monitorRows.js';

describe('monitorRows (EPIC INT-1813 S6)', () => {
  it('projectsToTable maps enabled flag and run/queue counts', () => {
    const t = projectsToTable([
      {
        name: 'A',
        linearProject: 'Linear A',
        path: '/Users/u/dev/A',
        enabled: true,
        running: [{ id: '1', title: 'active worker task' }],
        queued: [],
        pending: [{ id: '2', title: 'todo', issueIdentifier: 'INT-2', linearState: 'Todo' }],
        git: { branch: 'main', hasChanges: true, uncommittedFiles: 2, ahead: 1 },
      },
      { name: 'B', path: '/b', enabled: false },
    ]);
    expect(t.columns).toEqual(['', 'PROJECT', 'PATH', 'GIT/WT', 'LINEAR', 'RUN', 'QUEUE', 'PEND', 'LAST']);
    expect(t.rows[0]).toEqual(['●', 'A', '…/dev/A', 'main +2 ↑1', 'Linear A', '1', '0', '1', 'run active worker task']);
    expect(t.rows[1]).toEqual(['○', 'B', '/b', '', '', '0', '0', '0', '']);
  });

  it('pipelineToTable joins task:started titles to stage rows, newest first', () => {
    const t = pipelineToTable([
      { type: 'task:started', data: { taskId: 't1', issueIdentifier: 'INT-9' } },
      { type: 'pipeline:stage', data: { taskId: 't1', stage: 'worker', status: 'start', model: 'gpt-5.2-codex', repository: 'OpenSwarm' } },
      { type: 'pipeline:stage', data: { taskId: 't1', stage: 'reviewer', status: 'complete', durationMs: 5000, decision: 'approve', summary: 'review accepted the changes' } },
    ]);
    expect(t.rows[0][0]).toBe('INT-9');
    expect(t.rows[0][2]).toBe('reviewer'); // newest first
    expect(t.rows[0][4]).toBe('● complete/approve');
    expect(t.rows[0][5]).toBe('5s');
    expect(t.rows[0][6]).toBe('review accepted the cha…');
    expect(t.rows[1][2]).toBe('worker');
    expect(t.rows[1][3]).toBe('5.2-codex'); // model shortened
    expect(t.rows[1][6]).toBe('');
  });

  it('stuckToTable tags stuck vs failed and truncates long text', () => {
    const t = stuckToTable(
      [{ identifier: 'INT-1', title: 'short', reason: 'no retry', priority: 1, project: { name: 'OpenSwarm' }, stuckDays: 8 }],
      [{
        identifier: 'INT-2',
        title: 'x'.repeat(60),
        reason: 'boom',
        priority: 3,
        labels: ['failed'],
        comments: [{ body: 'worker failed after repeated timeout', createdAt: '2026-01-02T00:00:00.000Z' }],
      }],
    );
    expect(t.rows[0]).toEqual(['stuck', 'INT-1', 'short', 'urgent', 'OpenSwarm', 'no retry', '8d stale']);
    expect(t.rows[1][0]).toBe('failed');
    expect(t.rows[1][2].endsWith('…')).toBe(true);
    expect(t.rows[1][6]).toBe('worker failed after rep…');
  });

  it('issuesToTable maps title/status/priority', () => {
    const t = issuesToTable([{ id: '1', title: 'fix it', status: 'open', priority: 2 }]);
    expect(t.rows[0]).toEqual(['fix it', 'open', 'high']);
  });

  it('issuesToTable maps GraphQL enum priorities', () => {
    const t = issuesToTable([
      { id: '1', title: 'urgent issue', status: 'open', priority: 'urgent' },
      { id: '2', title: 'medium issue', status: 'open', priority: 'medium' },
      { id: '3', title: 'none issue', status: 'open', priority: 'none' },
    ]);
    expect(t.rows.map((r) => r[2])).toEqual(['urgent', 'med', 'none']);
  });
});

describe('workScopeCaption (AGT-3188)', () => {
  it('says which issues the daemon may pick, or that the daemon did not say', async () => {
    const { workScopeCaption } = await import('./monitorRows.js');
    expect(workScopeCaption({ milestone: 'S4' })).toBe('Work scope: milestone "S4" only');
    expect(workScopeCaption({ milestone: null })).toBe('Work scope: all issues in the allowed projects');
    expect(workScopeCaption(undefined)).toBe('Work scope: unknown');
  });
});
