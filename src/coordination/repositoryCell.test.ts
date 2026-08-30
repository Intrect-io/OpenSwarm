import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoordinationEvent } from './coordinationStore.js';
import { coordinationPeers, repositoryCell, resetRepositoryCellCacheForTests } from './repositoryCell.js';

let root = '';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function event(over: Partial<CoordinationEvent> = {}): CoordinationEvent {
  const seq = over.seq ?? 1;
  return {
    id: `event-${seq}`,
    seq,
    timestamp: over.timestamp ?? 1_000,
    repository: '/repo',
    repoKey: 'git:shared',
    taskId: 'task-a',
    actor: 'worker-a',
    actorName: 'Worker A',
    actorRole: 'worker',
    kind: 'delegation-request',
    status: 'running',
    correlationId: `correlation-${seq}`,
    summary: 'running',
    fingerprint: `fingerprint-${seq}`,
    ...over,
  };
}

afterEach(() => {
  resetRepositoryCellCacheForTests();
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('repositoryCell', () => {
  it('gives a main checkout and its real sibling worktree one repository key', () => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-cell-'));
    const main = join(root, 'main');
    const sibling = join(root, 'sibling');
    mkdirSync(main);
    git(main, 'init');
    git(main, 'config', 'user.email', 'test@example.invalid');
    git(main, 'config', 'user.name', 'OpenSwarm test');
    writeFileSync(join(main, 'README.md'), 'cell\n');
    git(main, 'add', 'README.md');
    git(main, 'commit', '-m', 'seed');
    git(main, 'worktree', 'add', '-b', 'sibling', sibling);

    const primary = repositoryCell(main);
    const linked = repositoryCell(sibling);
    expect(linked.repoKey).toBe(primary.repoKey);
    expect(linked.repositoryPath).toBe(primary.repositoryPath);

    const other = join(root, 'other');
    mkdirSync(other);
    git(other, 'init');
    expect(repositoryCell(other).repoKey).not.toBe(primary.repoKey);
  });

  it('uses a stable path cell when Git metadata is unavailable', () => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-path-cell-'));
    const first = repositoryCell(root);
    resetRepositoryCellCacheForTests();
    expect(repositoryCell(root)).toMatchObject({ repoKey: first.repoKey, repositoryPath: first.repositoryPath });
    expect(first.repoKey).toMatch(/^path:/);
  });
});

describe('coordinationPeers', () => {
  const now = 10_000;
  const reviewerQuery = {
    repoKey: 'git:shared',
    now,
    roles: ['reviewer'],
    taskIds: ['task-a'],
  };

  it('does not make a future reviewer present until that reviewer publishes its own running event', () => {
    const workerStart = event({
      seq: 1,
      timestamp: now - 300,
      recipient: 'reviewer-a',
      recipientName: 'Reviewer A',
      recipientRole: 'reviewer',
      targetTaskId: 'task-a',
    });
    expect(coordinationPeers([workerStart], reviewerQuery)).toEqual([]);

    const reviewerStart = event({
      seq: 2,
      timestamp: now - 200,
      correlationId: 'reviewer-attempt-1',
      actor: 'reviewer-a',
      actorName: 'Reviewer A',
      actorRole: 'reviewer',
      recipient: 'worker-a',
      recipientName: 'Worker A',
      recipientRole: 'worker',
    });
    expect(coordinationPeers([workerStart, reviewerStart], reviewerQuery)).toEqual([
      expect.objectContaining({ address: 'reviewer-a', name: 'Reviewer A', role: 'reviewer', taskId: 'task-a' }),
    ]);

    const reviewerDone = event({
      seq: 3,
      timestamp: now - 100,
      correlationId: 'reviewer-attempt-1',
      actor: 'reviewer-a',
      actorName: 'Reviewer A',
      actorRole: 'reviewer',
      kind: 'delegation-result',
      status: 'completed',
    });
    expect(coordinationPeers([workerStart, reviewerStart, reviewerDone], reviewerQuery)).toEqual([]);
  });

  it.each([
    ['worker', 'delegation-request', 'delegation-result'],
    ['orchestrator', 'mcp-audit', 'mcp-audit'],
    ['review-agent', 'review-run', 'review-run'],
  ] as const)('removes %s presence on its terminal lifecycle event', (role, startKind, endKind) => {
    const actor = `${role}-actor`;
    const taskId = `${role}-task`;
    const started = event({
      seq: 10,
      timestamp: now - 200,
      correlationId: 'lifecycle-attempt-1',
      actor,
      actorRole: role,
      taskId,
      kind: startKind,
      status: 'running',
    });
    const ended = event({
      seq: 11,
      timestamp: now - 100,
      correlationId: 'lifecycle-attempt-1',
      actor,
      actorRole: role,
      taskId,
      kind: endKind,
      status: 'completed',
    });

    expect(coordinationPeers([started], { repoKey: 'git:shared', now })).toHaveLength(1);
    // Newest seq wins even if a caller supplies the slice out of order.
    expect(coordinationPeers([ended, started], { repoKey: 'git:shared', now })).toEqual([]);
  });

  it('removes only the terminal actor/task presence when one address appears on two tasks', () => {
    const taskA = event({
      seq: 20,
      timestamp: now - 300,
      correlationId: 'task-a-attempt-1',
      actor: 'shared-actor',
      taskId: 'task-a',
    });
    const taskB = event({ seq: 21, timestamp: now - 200, actor: 'shared-actor', taskId: 'task-b' });
    const taskADone = event({
      seq: 22,
      timestamp: now - 100,
      correlationId: 'task-a-attempt-1',
      actor: 'shared-actor',
      taskId: 'task-a',
      kind: 'delegation-result',
      status: 'failed',
    });

    expect(coordinationPeers([taskA, taskB, taskADone], { repoKey: 'git:shared', now }))
      .toEqual([expect.objectContaining({ address: 'shared-actor', taskId: 'task-b' })]);
  });

  it('keeps a retry present when an earlier attempt terminates later', () => {
    const attempt1Start = event({
      seq: 30,
      timestamp: now - 400,
      correlationId: 'attempt-1',
      actor: 'retry-worker',
      taskId: 'task-retry',
    });
    const attempt2Start = event({
      seq: 31,
      timestamp: now - 300,
      correlationId: 'attempt-2',
      actor: 'retry-worker',
      taskId: 'task-retry',
    });
    const attempt1Done = event({
      seq: 32,
      timestamp: now - 200,
      correlationId: 'attempt-1',
      actor: 'retry-worker',
      taskId: 'task-retry',
      kind: 'delegation-result',
      status: 'completed',
    });

    expect(coordinationPeers(
      // Deliberately replayed out of order: seq, not array order, decides
      // each correlation's latest lifecycle state.
      [attempt1Done, attempt2Start, attempt1Start],
      { repoKey: 'git:shared', now },
    )).toEqual([
      expect.objectContaining({
        address: 'retry-worker',
        taskId: 'task-retry',
        lastSeen: attempt2Start.timestamp,
      }),
    ]);

    const attempt2Done = event({
      seq: 33,
      timestamp: now - 100,
      correlationId: 'attempt-2',
      actor: 'retry-worker',
      taskId: 'task-retry',
      kind: 'delegation-result',
      status: 'completed',
    });
    expect(coordinationPeers(
      [attempt2Done, attempt1Done, attempt2Start, attempt1Start],
      { repoKey: 'git:shared', now },
    )).toEqual([]);
  });
});
