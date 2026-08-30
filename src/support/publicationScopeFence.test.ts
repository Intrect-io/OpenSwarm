import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitAndCreatePRWithHead, type WorktreeInfo } from './worktreeManager.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

describe('pre-publication write-scope fence', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function repository(branchName: string): { repo: string; origin: string; info: WorktreeInfo } {
    root = mkdtempSync(join(tmpdir(), 'openswarm-publish-scope-'));
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '--bare', '-q', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test User');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/allowed.ts'), 'allowed\n');
    writeFileSync(join(repo, 'src/outside.ts'), 'outside\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'initial');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-u', 'origin', 'main');
    git(repo, 'checkout', '-qb', branchName);
    return {
      repo,
      origin,
      info: { worktreePath: repo, originalPath: repo, branchName, issueId: 'AGT-SCOPE' },
    };
  }

  function remoteBranch(origin: string, branchName: string): string {
    return execFileSync('git', ['ls-remote', '--heads', origin, branchName], { encoding: 'utf8' }).trim();
  }

  it('blocks a fresh out-of-scope worker edit before push or PR creation', async () => {
    const branchName = 'swarm/AGT-SCOPE-fresh';
    const { repo, origin, info } = repository(branchName);
    writeFileSync(join(repo, 'src/outside.ts'), 'worker edit\n');

    await expect(commitAndCreatePRWithHead(
      info, 'Scoped task', 'AGT-SCOPE', '', { fileScope: ['src/allowed.ts'] },
    )).rejects.toThrow(/publication-scope.*src\/outside\.ts/);

    expect(remoteBranch(origin, branchName)).toBe('');
  });

  it('blocks an out-of-scope commit inherited from a preserved task branch', async () => {
    const branchName = 'swarm/AGT-SCOPE-preserved';
    const { repo, origin, info } = repository(branchName);
    writeFileSync(join(repo, 'src/outside.ts'), 'preserved edit\n');
    git(repo, 'add', 'src/outside.ts');
    git(repo, 'commit', '-qm', 'wip: preserve prior task work');

    await expect(commitAndCreatePRWithHead(
      info, 'Scoped resume', 'AGT-SCOPE', '',
      { committedOnly: true, fileScope: ['src/allowed.ts'] },
    )).rejects.toThrow(/publication-scope.*src\/outside\.ts/);

    expect(remoteBranch(origin, branchName)).toBe('');
  });
});
