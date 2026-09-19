import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitAndCreatePR, createWorktree } from './worktreeManager.js';
import { regressedAgainstFreshBase } from './publicationRegressionProbe.js';

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

// AGT-4465, cgf-portal AX-1584/PR#586: a sibling PR changed a function's
// signature on `main` while this branch's own new test still called it with
// the OLD signature. The branch never touched the function's file, so the
// merge is textually clean — `probeBaseFreshness` alone waves it through as
// merely "behind" — but the merged result is broken, exactly what GitHub's
// own `refs/pull/N/merge` CI trigger would have caught.
it('opens a draft when the merged result breaks even though the base merges cleanly', async () => {
  setUpRepo();
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node lib.test.js' } }, null, 2),
  );
  writeFileSync(join(repo, 'lib.js'), 'function build(rows) {\n  return rows.length;\n}\nmodule.exports = { build };\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'add lib + package.json');
  git(repo, 'push', 'origin', 'main');

  const info = await createWorktree(repo, 'INT-4', 'swarm/INT-4-test');
  // The branch's own new test — correct against the base it was written
  // against, and never touches lib.js itself.
  writeFileSync(
    join(info.worktreePath, 'lib.test.js'),
    "const { build } = require('./lib.js');\nconst assert = require('assert');\nassert.strictEqual(build([1, 2, 3]), 3);\nconsole.log('pass');\n",
  );

  // A sibling merges to main: build() now requires a second argument. Same
  // file, different lines than anything the branch touched — no conflict.
  writeFileSync(
    join(repo, 'lib.js'),
    "function build(rows, opts) {\n  if (!opts) throw new Error('opts required');\n  return rows.length;\n}\nmodule.exports = { build };\n",
  );
  git(repo, 'commit', '-am', 'sibling: build() now requires opts');
  git(repo, 'push', 'origin', 'main');

  const ghLog = fakeGh(`case "$*" in
*"pr list --head"*) echo "";;
*"in:body"*) echo "[]";;
*"pr list --state open"*) echo "[]";;
*"pr create"*) echo "https://example.test/pull/2000";;
esac`);

  const prevPath = process.env.PATH;
  process.env.PATH = `${join(root, 'bin')}:${prevPath}`;
  try {
    await commitAndCreatePR(info, 'Add lib test', 'INT-4', 'desc', {
      verify: { enabled: true, blockOnNewFailures: true, maxCommands: 4 },
    });
  } finally {
    process.env.PATH = prevPath;
  }

  const calls = readFileSync(ghLog, 'utf8');
  expect(calls).toMatch(/pr create[\s\S]*--draft/);

  // The revalidation probe must never leave the worktree mid-merge, and must
  // never touch the branch it already pushed.
  expect(git(info.worktreePath, 'status', '--porcelain').toString().trim()).toBe('');
  expect(git(info.worktreePath, 'log', '-1', '--pretty=%s').toString().trim()).toContain('Add lib test');

  git(repo, 'worktree', 'remove', '--force', info.worktreePath);
});

// Review finding, 2026-09-19: the merge attempt inside regressedAgainstFreshBase
// is not side-effect-free on failure the way a bad ref would be — a genuine
// conflict still writes conflict markers, stages a partial merge, and sets
// MERGE_HEAD. This can happen even after probeBaseFreshness confirmed a clean
// merge-tree, if a concurrent task's fetch/push moves the base again in
// between. Exercises the function directly (bypassing probeBaseFreshness's
// gate) with a base that WILL conflict, and asserts full restoration anyway.
it('restores the worktree even when the merge attempt itself conflicts', async () => {
  setUpRepo();
  writeFileSync(join(repo, 'conflict.txt'), 'line1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'add conflict.txt');
  git(repo, 'push', 'origin', 'main');

  const info = await createWorktree(repo, 'INT-5', 'swarm/INT-5-test');
  writeFileSync(join(info.worktreePath, 'conflict.txt'), 'line1-branch\n');
  git(info.worktreePath, 'add', '-A');
  git(info.worktreePath, 'commit', '-m', 'branch edits conflict.txt');
  const headSha = git(info.worktreePath, 'rev-parse', 'HEAD').toString().trim();

  // Same line, different content on main — a real conflict, not merely a
  // moved base.
  writeFileSync(join(repo, 'conflict.txt'), 'line1-main\n');
  git(repo, 'commit', '-am', 'sibling edits the same line');
  git(repo, 'push', 'origin', 'main');
  git(info.worktreePath, 'fetch', 'origin', 'main');

  const regressed = await regressedAgainstFreshBase(
    info.worktreePath,
    'origin/main',
    headSha,
    { enabled: true, blockOnNewFailures: true, maxCommands: 4 },
  );

  expect(regressed).toBe(false); // fails open — a probe failure is not a verified regression
  expect(git(info.worktreePath, 'status', '--porcelain').toString().trim()).toBe('');
  expect(() => git(info.worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow();
  expect(git(info.worktreePath, 'rev-parse', 'HEAD').toString().trim()).toBe(headSha);

  git(repo, 'worktree', 'remove', '--force', info.worktreePath);
});

// Review finding, 2026-09-19 (second pass): `regressed` was originally computed
// only for the fresh-create draft decision. The two paths that instead REUSE an
// already-open PR — the early `existing` return, and the create-race fallback —
// never consulted it, so exactly the flow this fix exists for (a run parked on
// a branch, main moves under it, the run later gets approved and republishes,
// finding the PR its own earlier parked publish already opened as a draft)
// could still promote a regressed PR to ready.
it('does not promote an existing draft PR to ready when the merged result regresses', async () => {
  setUpRepo();
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node lib.test.js' } }, null, 2),
  );
  writeFileSync(join(repo, 'lib.js'), 'function build(rows) {\n  return rows.length;\n}\nmodule.exports = { build };\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'add lib + package.json');
  git(repo, 'push', 'origin', 'main');

  const info = await createWorktree(repo, 'INT-6', 'swarm/INT-6-test');
  // The branch's own new test — correct against the base it was written
  // against, and never touches lib.js itself.
  writeFileSync(
    join(info.worktreePath, 'lib.test.js'),
    "const { build } = require('./lib.js');\nconst assert = require('assert');\nassert.strictEqual(build([1, 2, 3]), 3);\nconsole.log('pass');\n",
  );

  // A sibling merges to main while this branch sits parked: build() now
  // requires a second argument. Same file, different lines — no textual
  // conflict.
  writeFileSync(
    join(repo, 'lib.js'),
    "function build(rows, opts) {\n  if (!opts) throw new Error('opts required');\n  return rows.length;\n}\nmodule.exports = { build };\n",
  );
  git(repo, 'commit', '-am', 'sibling: build() now requires opts');
  git(repo, 'push', 'origin', 'main');

  // This branch already has an open, draft PR — as it would if an earlier
  // parked publish opened one and the approved caller is only now
  // republishing to promote it.
  const ghLog = fakeGh(`case "$*" in
*"pr list --head"*) echo "https://example.test/pull/3000";;
*"isDraft"*) echo "true";;
*"pr ready"*) echo "must not be called on a regressed PR" >&2; exit 1;;
esac`);

  const prevPath = process.env.PATH;
  process.env.PATH = `${join(root, 'bin')}:${prevPath}`;
  let url: string;
  try {
    url = await commitAndCreatePR(info, 'Add lib test', 'INT-6', 'desc', {
      verify: { enabled: true, blockOnNewFailures: true, maxCommands: 4 },
    });
  } finally {
    process.env.PATH = prevPath;
  }

  // The existing (draft) PR is returned as-is — never promoted, never
  // recreated.
  expect(url).toBe('https://example.test/pull/3000');
  const calls = readFileSync(ghLog, 'utf8');
  expect(calls).not.toContain('pr ready');

  // The revalidation probe must still leave the worktree clean and on the
  // branch it already pushed.
  expect(git(info.worktreePath, 'status', '--porcelain').toString().trim()).toBe('');

  git(repo, 'worktree', 'remove', '--force', info.worktreePath);
});
});
