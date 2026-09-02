import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertBranchWithinWriteScope } from './publicationScopeFence.js';
import { commitAndCreatePRWithHead, type WorktreeInfo } from './worktreeManager.js';
import { purgeTrackedEphemeralArtifacts } from './worktreeEphemeralOps.js';

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

  it('ignores generated OpenSwarm repository snapshots in a preserved branch', async () => {
    const branchName = 'swarm/AGT-SCOPE-bookkeeping';
    const { repo } = repository(branchName);
    mkdirSync(join(repo, '.openswarm'));
    writeFileSync(join(repo, '.openswarm', 'repo-snapshot.json'), '{}\n');
    writeFileSync(join(repo, '.openswarm', 'repo.graphql'), 'type Query { ok: Boolean }\n');
    git(repo, 'add', '.openswarm');
    git(repo, 'commit', '-qm', 'chore: generated repository context');

    await expect(assertBranchWithinWriteScope(
      repo, 'origin/main', ['src/allowed.ts'],
    )).resolves.toBeUndefined();
  });

  it('ignores pytest per-run artifacts but not source test files', async () => {
    const branchName = 'swarm/AGT-SCOPE-pytest-temp';
    const { repo } = repository(branchName);
    mkdirSync(join(repo, 'pytest-of-openswarm', 'pytest-1'), { recursive: true });
    writeFileSync(join(repo, 'pytest-of-openswarm', 'pytest-1', 'run-marker'), 'generated\n');
    git(repo, 'add', 'pytest-of-openswarm');
    git(repo, 'commit', '-qm', 'test: generated pytest worktree output');

    await expect(assertBranchWithinWriteScope(
      repo, 'origin/main', ['src/allowed.ts'],
    )).resolves.toBeUndefined();

    writeFileSync(join(repo, 'src/outside.ts'), 'still source\n');
    git(repo, 'add', 'src/outside.ts');
    git(repo, 'commit', '-qm', 'test: out of scope source');
    await expect(assertBranchWithinWriteScope(
      repo, 'origin/main', ['src/allowed.ts'],
    )).rejects.toThrow(/publication-scope.*src\/outside\.ts/);
  });

  it('ignores the worktree-local virtual-environment link', async () => {
    const branchName = 'swarm/AGT-SCOPE-venv';
    const { repo } = repository(branchName);
    writeFileSync(join(repo, '.venv'), '/private/var/tmp/venv-link\n');
    git(repo, 'add', '.venv');
    git(repo, 'commit', '-qm', 'test: generated virtual environment pointer');

    await expect(assertBranchWithinWriteScope(
      repo, 'origin/main', ['src/allowed.ts'],
    )).resolves.toBeUndefined();
  });

  it('ignores quarantined pytest output', async () => {
    const branchName = 'swarm/AGT-SCOPE-pytest-quarantine';
    const { repo } = repository(branchName);
    mkdirSync(join(repo, '.openswarm-trash', 'AGT-SCOPE-pytest-1', 'pytest-1'), { recursive: true });
    writeFileSync(join(repo, '.openswarm-trash', 'AGT-SCOPE-pytest-1', 'pytest-1', 'run-marker'), 'generated\n');
    git(repo, 'add', '.openswarm-trash');
    git(repo, 'commit', '-qm', 'test: quarantined generated pytest output');

    await expect(assertBranchWithinWriteScope(
      repo, 'origin/main', ['src/allowed.ts'],
    )).resolves.toBeUndefined();
  });

  it('ignores and removes legacy verify quarantine and heartbeat locks before publication', async () => {
    const branchName = 'swarm/AGT-SCOPE-verify-quarantine';
    const { repo, origin } = repository(branchName);
    mkdirSync(join(repo, '.openswarm-trash', 'AGT-SCOPE-verify-1', 'pytest-1'), { recursive: true });
    mkdirSync(join(repo, '.vega'), { recursive: true });
    writeFileSync(join(repo, '.openswarm-trash', 'AGT-SCOPE-verify-1', 'pytest-1', 'run-marker'), 'generated\n');
    writeFileSync(join(repo, '.vega', 'google_heartbeat_sync.lock'), 'runtime\n');
    writeFileSync(join(repo, 'src', 'allowed.ts'), 'task source\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'wip: includes legacy runtime output');

    await purgeTrackedEphemeralArtifacts(repo);

    const changed = git(repo, 'diff', '--name-only', 'origin/main...HEAD').trim().split('\n').filter(Boolean);
    expect(changed).toEqual(['src/allowed.ts']);
    expect(remoteBranch(origin, branchName)).toBe('');
  });
});
