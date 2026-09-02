import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareAttemptBranch, resolveAttemptBranchName, retireConsumedWorktree } from './branchLineage.js';

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
    expect(retire).toHaveBeenCalledWith(root, 'issue-1', stale);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('consumed by u/9'));
    log.mockRestore();
  });

  // vela AX-863 attempt 45: the ownership-aware removal kept the tree because a
  // 2026-08-28 marker named a pid that is alive again in this container, and
  // createWorktree threw "requires reconciliation". The lease already fences
  // every other executor, so the retirement must not consult markers at all.
  it('retires the tree and every marker under the issue regardless of who wrote them', async () => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-lineage-git-'));
    const repo = join(root, 'repo');
    const g = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'T');
    writeFileSync(join(repo, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-qm', 'init');
    const stale = join(repo, 'worktree', 'issue-9');
    g('worktree', 'add', '-q', '-b', 'swarm/X-9-t', stale);
    writeFileSync(join(stale, 'wip.txt'), 'wip\n');
    const markers = join(repo, '.git', 'openswarm', 'active-worktrees', 'issue-9');
    mkdirSync(markers, { recursive: true });
    writeFileSync(join(markers, 'legacy.json'), JSON.stringify({ ownerPid: 1, branchName: 'swarm/X-9-t' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await retireConsumedWorktree(repo, 'issue-9', stale);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(markers)).toBe(false);
    expect(g('worktree', 'list')).not.toContain('issue-9');
    // The consumed branch itself is left for the record.
    expect(g('branch', '--list', 'swarm/X-9-t').trim()).toContain('swarm/X-9-t');
    log.mockRestore();
  });
});
