import { describe, expect, it, vi } from 'vitest';
import { runDrainParksCommand } from './drainParksCommand.js';
import type { RunRecord } from '../automation/runLedger.js';

function parked(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    issueId: 'AX-1', source: 'linear', identifier: 'AX-1', title: 'Parked work',
    projectPath: '/repo', state: 'NEEDS_HUMAN', stateVersion: 4, attemptNo: 2,
    leaseEpoch: 0, branchName: 'swarm/AX-1', discoveredAt: 1, updatedAt: 2,
    ...overrides,
  };
}

function deps(run: RunRecord, attached = true) {
  const ledger = {
    listRuns: vi.fn(() => [run]),
    attachParkedPublication: vi.fn(() => attached),
    recordParkedPublicationSkip: vi.fn(() => true),
    close: vi.fn(),
  };
  const git = vi.fn(async (_path: string, ...args: string[]) => {
    if (args[0] === 'rev-list') return '2\n';
    if (args[0] === 'rev-parse') return 'deadbeef\n';
    return '';
  });
  return { ledger, git, resolveBase: vi.fn(async () => ({ remote: 'origin', branch: 'main', ref: 'origin/main' })) };
}

describe('runDrainParksCommand', () => {
  it('creates a draft only for a committed unowned park and attaches it to the same row', async () => {
    const d = deps(parked());
    const gh = vi.fn(async (_path: string, ...args: string[]) => args[1] === 'list'
      ? '' : 'https://github.com/org/repo/pull/12\n');

    const result = await runDrainParksCommand({ path: '/repo' }, { ...d, createLedger: () => d.ledger, gh });

    expect(result).toEqual({
      attached: [{ issueId: 'AX-1', branchName: 'swarm/AX-1', prUrl: 'https://github.com/org/repo/pull/12' }],
      skipped: [], failed: [],
    });
    expect(gh).toHaveBeenCalledWith('/repo', 'pr', 'create', '--head', 'swarm/AX-1', '--base', 'main', '--title', 'Parked work', '--body', expect.stringContaining('Closes AX-1'), '--draft');
    expect(d.ledger.attachParkedPublication).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'AX-1', stateVersion: 4 }), {
      prUrl: 'https://github.com/org/repo/pull/12', headSha: 'deadbeef',
    });
    expect(d.ledger.close).toHaveBeenCalledOnce();
  });

  it('reuses an existing PR and does not create another one', async () => {
    const d = deps(parked());
    const gh = vi.fn(async () => 'https://github.com/org/repo/pull/10\n');

    const result = await runDrainParksCommand({ path: '/repo' }, { ...d, createLedger: () => d.ledger, gh });

    expect(result.attached).toHaveLength(1);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(gh.mock.calls[0].slice(1, 3)).toEqual(['pr', 'list']);
  });

  it('records a no-commit park as skipped without calling GitHub', async () => {
    const d = deps(parked());
    d.git.mockImplementation(async (_path: string, ...args: string[]) => args[0] === 'rev-list' ? '0\n' : '');
    const gh = vi.fn();

    const result = await runDrainParksCommand({ path: '/repo' }, { ...d, createLedger: () => d.ledger, gh });

    expect(result.skipped).toEqual([{ issueId: 'AX-1', branchName: 'swarm/AX-1', reason: 'no commits ahead of base' }]);
    expect(d.ledger.recordParkedPublicationSkip).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'AX-1' }), 'no commits ahead of base');
    expect(gh).not.toHaveBeenCalled();
  });

  it('does not call GitHub or mutate the ledger in dry-run mode', async () => {
    const d = deps(parked());
    const gh = vi.fn();

    const result = await runDrainParksCommand({ path: '/repo', dryRun: true }, { ...d, createLedger: () => d.ledger, gh });

    expect(result.attached[0]?.prUrl).toBe('would-create-draft-for:swarm/AX-1');
    expect(gh).not.toHaveBeenCalled();
    expect(d.ledger.attachParkedPublication).not.toHaveBeenCalled();
  });

  it('reports a CAS refusal instead of claiming the PR reached the ledger', async () => {
    const d = deps(parked(), false);
    const gh = vi.fn(async () => 'https://github.com/org/repo/pull/10\n');

    const result = await runDrainParksCommand({ path: '/repo' }, { ...d, createLedger: () => d.ledger, gh });

    expect(result.failed).toEqual([{ issueId: 'AX-1', branchName: 'swarm/AX-1', reason: 'park changed while attaching its PR' }]);
    expect(result.attached).toEqual([]);
  });
});
