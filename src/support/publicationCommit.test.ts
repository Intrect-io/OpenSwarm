import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitStagedForPublication } from './publicationCommit.js';

// AX-1797's parked work was never published: the repository's pre-commit (ruff,
// SIM114) rejected the worker's last edits and they stayed in the worktree (AGT-4677).

const roots: string[] = [];

/** A repository whose pre-commit hook rejects every commit, with one staged change. */
function repoWithRejectingHook(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osw-publication-commit-'));
  roots.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    stdio: 'pipe',
  }).toString();
  git('init', '-q', '-b', 'main');
  // The code under test runs a plain `git commit`, so the identity has to live in the repository;
  // a CI runner has no global one ("Author identity unknown", PR 818's first run).
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  // The hook is the repository's own gate; git must be pointed at it explicitly so the
  // test does not depend on the global hooksPath of the machine it runs on.
  const hook = join(dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho "SIM114 Combine if branches using logical or operator" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  git('config', 'core.hooksPath', join(dir, '.git', 'hooks'));
  writeFileSync(join(dir, 'f.txt'), 'edit\n');
  git('add', 'f.txt');
  return dir;
}

const headSubject = (dir: string): string =>
  execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s'], { stdio: 'pipe' }).toString().trim();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('commitStagedForPublication', () => {
  it('commits a draft even though the repository hook rejects the edits', async () => {
    const dir = repoWithRejectingHook();
    await commitStagedForPublication(dir, 'feat(AX-1797): parked work', { draft: true });
    expect(headSubject(dir)).toBe('feat(AX-1797): parked work');
  });

  it('keeps the hook for a reviewed publication: the repository gate still applies', async () => {
    const dir = repoWithRejectingHook();
    await expect(commitStagedForPublication(dir, 'feat(AX-1797): approved work', { draft: false }))
      .rejects.toThrow(/Command failed/);
    // Nothing was committed, the edit is still staged.
    const staged = execFileSync('git', ['-C', dir, 'diff', '--cached', '--name-only'], { stdio: 'pipe' }).toString().trim();
    expect(staged).toBe('f.txt');
  });

  it('treats a missing draft option as a reviewed publication', async () => {
    const dir = repoWithRejectingHook();
    await expect(commitStagedForPublication(dir, 'feat(AX-1797): default')).rejects.toThrow(/Command failed/);
  });
});
