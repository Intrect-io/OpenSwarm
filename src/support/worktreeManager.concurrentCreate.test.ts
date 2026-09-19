// Concurrent worktree creation against ONE repository.
//
// The lifecycle lock is per issue, so two issues of the same repository enter
// `git worktree add -b` together. With upstream tracking on, each call rewrites
// the shared `.git/config`, and the loser dies with
//   error: could not lock config file .git/config: File exists
// Recorded 2026-09-17 on cgf-portal as same-second pairs (AX-1530 + AX-1443,
// AX-1447 + AX-1482), each costing the issue one attempt. Real git, no mocks —
// the defect lives in git's own config lock.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree } from './worktreeManager.js';

const ISSUES = 8;
const ROUNDS = 3;

describe('createWorktree under same-repository concurrency', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'openswarm-wt-concurrent-')));
    repo = join(root, 'repo');
    const originBare = join(root, 'origin.git');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'app.py'), 'base\n');
    execFileSync('git', ['-C', repo, 'add', '-A']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', originBare]);
    execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates every worktree when many issues start in the same instant', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const results = await Promise.allSettled(
        Array.from({ length: ISSUES }, (_, i) =>
          createWorktree(repo, `RACE-${round}-${i}`, `swarm/RACE-${round}-${i}-concurrent`)),
      );
      const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => String(r.reason?.message ?? r.reason));
      expect(failures).toEqual([]);
    }
  }, 120_000);

  it('leaves a fresh branch without an upstream, so nothing is written to the shared config', async () => {
    const info = await createWorktree(repo, 'RACE-U', 'swarm/RACE-U-no-upstream');
    const config = execFileSync('git', ['-C', repo, 'config', '--local', '--list'], { encoding: 'utf8' });
    expect(config).not.toContain('branch.swarm/race-u-no-upstream.');
    expect(config).not.toContain(`branch.${info.branchName}.`);
  });
});
