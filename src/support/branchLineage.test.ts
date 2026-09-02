import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareAttemptBranch, resolveAttemptBranchName } from './branchLineage.js';

// vela cgf-portal 2026-09-02: AX-863's PR #179 merged on 08-30, the card came
// back to In Progress, and 44 attempts pushed the merged branch name again.
describe('resolveAttemptBranchName', () => {
  const base = 'swarm/AX-863-a2-4';

  it('keeps the base name when no pull request exists or the existing one is open', async () => {
    await expect(resolveAttemptBranchName('/repo', base, async () => null))
      .resolves.toEqual({ branchName: base, consumedPullRequests: [] });
    await expect(resolveAttemptBranchName('/repo', base, async () => ({ url: 'u/1', state: 'OPEN' })))
      .resolves.toEqual({ branchName: base, consumedPullRequests: [] });
  });

  it('moves past every merged or closed pull request to the first free name', async () => {
    const seen = new Map<string, { url: string; state: string }>([
      [base, { url: 'https://github.com/o/r/pull/179', state: 'MERGED' }],
      [`${base}-r2`, { url: 'https://github.com/o/r/pull/190', state: 'CLOSED' }],
    ]);
    const lookup = vi.fn(async (_repo: string, name: string) => seen.get(name) ?? null);
    await expect(resolveAttemptBranchName('/repo', base, lookup)).resolves.toEqual({
      branchName: `${base}-r3`,
      consumedPullRequests: ['https://github.com/o/r/pull/179', 'https://github.com/o/r/pull/190'],
    });
    expect(lookup.mock.calls.map((c) => c[1])).toEqual([base, `${base}-r2`, `${base}-r3`]);
  });

  it('fails open on a GitHub error, keeping the name it could not check', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(resolveAttemptBranchName('/repo', base, async () => { throw new Error('gh: 502'); }))
      .resolves.toEqual({ branchName: base, consumedPullRequests: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gh: 502'));
    warn.mockRestore();
  });
});

describe('prepareAttemptBranch', () => {
  let root = '';
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('retires the preserved worktree only when the name was consumed', async () => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-lineage-'));
    const stale = join(root, 'worktree', 'issue-1');
    mkdirSync(stale, { recursive: true });
    const retire = vi.fn(async () => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(prepareAttemptBranch(root, 'issue-1', 'swarm/X-1-t', {
      lookup: async () => null, retire,
    })).resolves.toBe('swarm/X-1-t');
    expect(retire).not.toHaveBeenCalled();

    await expect(prepareAttemptBranch(root, 'issue-1', 'swarm/X-1-t', {
      lookup: async (_r, name) => (name === 'swarm/X-1-t' ? { url: 'u/9', state: 'MERGED' } : null), retire,
    })).resolves.toBe('swarm/X-1-t-r2');
    expect(retire).toHaveBeenCalledWith(stale);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('consumed by u/9'));
    log.mockRestore();
  });
});
