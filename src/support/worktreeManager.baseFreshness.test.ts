import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitAndCreatePR, createWorktree } from './worktreeManager.js';

describe('publication base freshness (AGT-4189)', () => {
  let root: string;
  let repo: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  function setUpRepo(): void {
    const originBare = join(root, 'origin.git');
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
  }

  function fakeGh(script: string): string {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh-args.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n${script}\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    return ghLog;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-base-fresh-pr-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

// AGT-4189: a branch that no longer merges into main gets no CI from GitHub
// while the default CodeQL checks still turn green. Publish it as a draft
// that names the conflicting files instead of a ready PR that looks checked.
it('opens a draft naming the conflicting files when main moved under the branch', async () => {
  setUpRepo();
  const info = await createWorktree(repo, 'INT-3', 'swarm/INT-3-test');
  writeFileSync(join(info.worktreePath, 'src', 'index.ts'), 'export const x = 3; // branch\n');
  // main advances on the same line after the worktree branched.
  writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 99; // main\n');
  git(repo, 'commit', '-am', 'main moves');
  git(repo, 'push', 'origin', 'main');

  const ghLog = fakeGh(`case "$*" in
*"pr list --head"*) echo "";;
*"in:body"*) echo "[]";;
*"pr list --state open"*) echo "[]";;
*"pr create"*) echo "https://example.test/pull/1000";;
esac`);

  const prevPath = process.env.PATH;
  process.env.PATH = `${join(root, 'bin')}:${prevPath}`;
  try {
    await commitAndCreatePR(info, 'Conflicting change', 'INT-3', 'desc');
  } finally {
    process.env.PATH = prevPath;
  }

  const calls = readFileSync(ghLog, 'utf8');
  // The body is multi-line, so the flag lands after it in the logged argv.
  expect(calls).toMatch(/pr create[\s\S]*--draft/);
  expect(calls).toContain('## Base freshness');
  expect(calls).toContain('1 commit(s) behind `main`');
  expect(calls).toContain('Conflicts with `main`** in: `src/index.ts`');
  expect(calls).not.toContain('pr ready');

  git(repo, 'worktree', 'remove', '--force', info.worktreePath);
});
});
