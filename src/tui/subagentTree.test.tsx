import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { SubagentTree } from './components/SubagentTree.js';
import { buildSubagentTree } from './subagentTree.js';
import { displayWidth } from '../cli/reviewProgress.js';
import type { StageEntry } from './pipelineEvents.js';

describe('SubagentTree component (EPIC INT-1813 S7)', () => {
  it('renders an empty state', () => {
    expect(render(<SubagentTree repositories={[]} />).lastFrame()).toContain('no active agents');
  });

  it('renders repository, worktree and role nodes', () => {
    const stages: StageEntry[] = [
      {
        taskId: 'INT-2367-x',
        stage: 'worker',
        status: 'complete',
        model: 'gpt-5.2-codex',
        repository: 'OpenSwarm',
        worktree: 'INT-2367',
        branch: 'swarm/INT-2367-pipeline-tree',
        issueIdentifier: 'INT-2367',
        title: 'Pipeline tab tree',
      },
      { taskId: 'INT-2367-x', stage: 'reviewer', status: 'start', repository: 'OpenSwarm', worktree: 'INT-2367' },
    ];
    const f = render(<SubagentTree repositories={buildSubagentTree(stages)} />).lastFrame()!;
    expect(f).toContain('Agents by repository');
    expect(f).toContain('OpenSwarm');
    expect(f).toContain('INT-2367');
    expect(f).toContain('swarm/INT-2367-pipeline-tree');
    expect(f).toContain('Worker');
    expect(f).toContain('Reviewer');
  });

  it('renders compact running activity and real rate-limit reset data', () => {
    const stages: StageEntry[] = [
      {
        taskId: 'INT-2368-x',
        stage: 'worker',
        status: 'start',
        repository: 'OpenSwarm',
        issueIdentifier: 'INT-2368',
        activity: 'tool: apply_patch',
        model: 'codex',
      },
      {
        taskId: 'INT-2368-x',
        stage: 'reviewer',
        status: 'fail',
        repository: 'OpenSwarm',
        issueIdentifier: 'INT-2368',
        activity: 'rate-limited',
        rateLimitResetsAt: 1770000000000,
      },
    ];

    const f = render(<SubagentTree repositories={buildSubagentTree(stages)} />).lastFrame()!;
    expect(f).toContain('tool: apply_patch');
    expect(f).toContain('rate-limited');
    expect(f).toContain('reset 2026-');
  });

  it('honors zero display limits', () => {
    const stages: StageEntry[] = [
      { taskId: 'INT-1940-x', stage: 'worker', status: 'complete', model: 'gpt-5.2-codex' },
    ];

    expect(render(<SubagentTree repositories={buildSubagentTree(stages)} max={0} />).lastFrame()).toContain('no active agents');

    const f = render(<SubagentTree repositories={buildSubagentTree(stages)} maxRoles={0} />).lastFrame()!;
    expect(f).toContain('INT-1940');
    expect(f).not.toContain('(gpt-5.2-codex)');
  });

  it('strips terminal control sequences from labels before rendering', () => {
    const stages: StageEntry[] = [
      {
        taskId: '\x1b]52;c;AAAA\x07INT-1940-x',
        stage: 'worker\x1b[31m',
        status: 'complete',
        model: 'gpt\x1b]0;bad\x07',
      },
    ];

    const f = render(<SubagentTree repositories={buildSubagentTree(stages)} />).lastFrame()!;
    expect(f).toContain('INT-1940');
    expect(f).toContain('Worker');
    expect(f).toContain('gpt');
    expect(f).not.toContain('\x1b');
    expect(f).not.toContain('AAAA');
    expect(f).not.toContain('bad');
  });

  // Every tree node is one row. The old caps were code units, so a newline- or
  // over-long stage/title still wrapped its row into several and grew the tree
  // past the frame. (AGT-3458)
  it('keeps a pathological stage name on one row', () => {
    const stages: StageEntry[] = [
      {
        taskId: 't1',
        stage: `${'x'.repeat(400)}\n${'line\n'.repeat(300)}`,
        status: 'start',
        repository: 'OpenSwarm',
        title: `${'y'.repeat(400)}\n${'title\n'.repeat(200)}`,
        model: `${'m'.repeat(400)}`,
        activity: `${'a'.repeat(400)}\n${'act\n'.repeat(200)}`,
      },
    ];

    const f = render(<SubagentTree repositories={buildSubagentTree(stages)} />).lastFrame()!;
    const rows = f.split('\n');
    // heading + repository + worktree + role — each node exactly one row.
    expect(rows.length).toBe(4);
    expect(Math.max(...rows.map(displayWidth))).toBeLessThanOrEqual(100);
    expect(f).toContain('xxxx');
  });

  it('leaves a normal tree unchanged', () => {
    const stages: StageEntry[] = [
      {
        taskId: 'INT-2367-x',
        stage: 'worker',
        status: 'complete',
        model: 'gpt-5.2-codex',
        repository: 'OpenSwarm',
        worktree: 'INT-2367',
        branch: 'swarm/INT-2367-pipeline-tree',
        issueIdentifier: 'INT-2367',
        title: 'Pipeline tab tree',
      },
    ];

    const f = render(<SubagentTree repositories={buildSubagentTree(stages)} />).lastFrame()!;
    expect(f).toContain('OpenSwarm');
    expect(f).toContain('INT-2367');
    expect(f).toContain('swarm/INT-2367-pipeline-tree');
    expect(f).toContain('Pipeline tab tree');
  });
});
