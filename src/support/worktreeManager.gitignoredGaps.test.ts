// AGT-4041 (#855 review): linkSharedPaths computes the gitignored paths a new
// worktree cannot see once, and records them for the daemon worker and reviewer
// prompts, keyed by the worktree path. Real git, no mocks.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktree } from './worktreeManager.js';
import { clearWorktreeGitignoredGaps, worktreeGitignoredGaps } from './worktreeMissingPaths.js';

describe('createWorktree records the gitignored source paths the worktree cannot see', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'openswarm-wt-gaps-')));
    repo = join(root, 'repo');
    const originBare = join(root, 'origin.git');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    writeFileSync(join(repo, '.gitignore'), 'docs/CGF_data/\n');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'README.md'), 'tracked\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', originBare]);
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });
    mkdirSync(join(repo, 'docs', 'CGF_data'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'CGF_data', 'f.pdf'), 'x');
  });

  afterEach(() => {
    clearWorktreeGitignoredGaps();
    rmSync(root, { recursive: true, force: true });
  });

  it('keys the missing list by the worktree path and does not list parked worktrees', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = await createWorktree(repo, 'GAP-1', 'swarm/GAP-1-gaps');
      expect(worktreeGitignoredGaps(first.worktreePath)).toMatchObject({ missing: ['docs/CGF_data'], unreadable: [] });
      // The first worktree now sits inside the repository; the second must not report it as data.
      const second = await createWorktree(repo, 'GAP-2', 'swarm/GAP-2-gaps');
      expect(worktreeGitignoredGaps(second.worktreePath)?.missing).toEqual(['docs/CGF_data']);
      // Same repository, same list: warned once.
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('gitignored path(s)'))).toHaveLength(1);
    } finally { warn.mockRestore(); }
  }, 60_000);
});
