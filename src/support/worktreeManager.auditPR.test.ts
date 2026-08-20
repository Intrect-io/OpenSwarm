// Coverage for the isolated audit worktree path of `review --max --fix` (INT-2905):
// createWorktree's base-ref override and commitAndCreateAuditPR.
//
// Same conventions as worktreeManager.test.ts: real git against tmp-dir fixture
// repos, a fake `gh` binary on PATH, tmp root removed in afterEach.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitAndCreateAuditPR, createWorktree } from './worktreeManager.js';

let root: string;
let repo: string;
let originBare: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString();

function fakeGh(script: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const ghLog = join(root, 'gh-args.log');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n${script}\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  return ghLog;
}

async function withFakeGh<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PATH;
  process.env.PATH = `${join(root, 'bin')}:${prev}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = prev;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openswarm-audit-pr-'));
  repo = join(root, 'repo');
  originBare = join(root, 'origin.git');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', originBare);
  git(repo, 'push', 'origin', 'main');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createWorktree base-ref override (INT-2905)', () => {
  it('forks the given commit instead of the remote default branch', async () => {
    // A local-only feature commit: origin/main does NOT contain feature.ts.
    git(repo, 'checkout', '-b', 'feat/wip');
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const feature = true;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'wip feature');
    const headSha = git(repo, 'rev-parse', 'HEAD').trim();

    const info = await createWorktree(repo, 'audit-1', 'swarm/audit-1', headSha);

    expect(existsSync(join(info.worktreePath, 'src', 'feature.ts'))).toBe(true);
    expect(git(info.worktreePath, 'rev-parse', 'HEAD').trim()).toBe(headSha);
  });

  it('does not need a remote at all when the base ref is given', async () => {
    git(repo, 'remote', 'remove', 'origin');
    const headSha = git(repo, 'rev-parse', 'HEAD').trim();

    const info = await createWorktree(repo, 'audit-2', 'swarm/audit-2', headSha);

    expect(git(info.worktreePath, 'rev-parse', 'HEAD').trim()).toBe(headSha);
  });
});

describe('commitAndCreateAuditPR (INT-2905)', () => {
  async function makeAuditWorktree(forkFrom = 'main') {
    if (forkFrom !== 'main') {
      git(repo, 'checkout', '-b', forkFrom);
      writeFileSync(join(repo, 'src', 'wip.ts'), 'export const wip = 1;\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-m', 'branch work');
    }
    const baseSha = git(repo, 'rev-parse', 'HEAD').trim();
    const info = await createWorktree(repo, 'audit-x', 'swarm/audit-x', baseSha);
    return { info, baseSha, forkedFromBranch: forkFrom };
  }

  it('commits the fixes, pushes, and opens the PR against the branch it forked from', async () => {
    const audit = await makeAuditWorktree('feat/in-flight');
    git(repo, 'push', 'origin', 'feat/in-flight'); // the fork point exists on the remote
    writeFileSync(join(audit.info.worktreePath, 'src', 'index.ts'), 'export const x = 2;\n');

    const ghLog = fakeGh(`case "$*" in
  *"pr list --head"*) echo "";;
  *"pr create"*) echo "https://example.test/pull/42";;
esac`);

    const url = await withFakeGh(() =>
      commitAndCreateAuditPR(audit.info, {
        title: 'fix(audit): x',
        body: 'body',
        commitMessage: 'fix(audit): apply findings',
        forkedFromBranch: audit.forkedFromBranch,
        baseSha: audit.baseSha,
      }),
    );

    expect(url).toBe('https://example.test/pull/42');
    expect(readFileSync(ghLog, 'utf8')).toContain('--base feat/in-flight');
    // The fix landed as a commit on the audit branch, pushed to the remote.
    expect(git(audit.info.worktreePath, 'log', '-1', '--pretty=%s').trim()).toBe('fix(audit): apply findings');
    expect(git(repo, 'ls-remote', '--heads', 'origin', 'swarm/audit-x')).toContain('swarm/audit-x');
  });

  it('falls back to the default branch when the fork point is not on the remote', async () => {
    const audit = await makeAuditWorktree('feat/local-only'); // never pushed
    writeFileSync(join(audit.info.worktreePath, 'src', 'index.ts'), 'export const x = 3;\n');

    const ghLog = fakeGh(`case "$*" in
  *"pr list --head"*) echo "";;
  *"pr create"*) echo "https://example.test/pull/43";;
esac`);

    await withFakeGh(() =>
      commitAndCreateAuditPR(audit.info, {
        title: 't',
        body: 'b',
        commitMessage: 'fix(audit): apply findings',
        forkedFromBranch: audit.forkedFromBranch,
        baseSha: audit.baseSha,
      }),
    );

    expect(readFileSync(ghLog, 'utf8')).toContain('--base main');
  });

  it('returns null without pushing when the audit changed nothing', async () => {
    const audit = await makeAuditWorktree();

    const ghLog = fakeGh('echo "";');

    const url = await withFakeGh(() =>
      commitAndCreateAuditPR(audit.info, {
        title: 't',
        body: 'b',
        commitMessage: 'fix(audit): apply findings',
        forkedFromBranch: audit.forkedFromBranch,
        baseSha: audit.baseSha,
      }),
    );

    expect(url).toBeNull();
    expect(existsSync(ghLog)).toBe(false); // gh never invoked
    expect(git(repo, 'ls-remote', '--heads', 'origin', 'swarm/audit-x').trim()).toBe('');
  });

  it('reuses an already-open PR for the audit branch instead of creating a second one', async () => {
    const audit = await makeAuditWorktree();
    writeFileSync(join(audit.info.worktreePath, 'src', 'index.ts'), 'export const x = 4;\n');

    const ghLog = fakeGh(`case "$*" in
  *"pr list --head"*) echo "https://example.test/pull/7";;
  *"pr create"*) echo "https://example.test/pull/SHOULD-NOT-HAPPEN";;
esac`);

    const url = await withFakeGh(() =>
      commitAndCreateAuditPR(audit.info, {
        title: 't',
        body: 'b',
        commitMessage: 'fix(audit): apply findings',
        forkedFromBranch: audit.forkedFromBranch,
        baseSha: audit.baseSha,
      }),
    );

    expect(url).toBe('https://example.test/pull/7');
    expect(readFileSync(ghLog, 'utf8')).not.toContain('pr create');
  });
});
