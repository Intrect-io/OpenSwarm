// Created: 2026-11-22
// Purpose: A failed head-worktree rollback keeps its sandbox root instead of deleting it under live Git metadata (AGT-4785).
// Dependencies: vitest, git, ./headSandbox.js
// Test Status: passing

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeadWorktreeRollbackError, addStrictHeadWorktree, releaseHeadSandbox, strandedHeadWorktree } from './headSandbox.js';

let root: string;
let repo: string;
let locked: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'openswarm-head-rollback-')));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'base']);
});

afterEach(async () => {
  if (locked && existsSync(locked)) await chmod(locked, 0o700);
  await rm(root, { recursive: true, force: true });
});

describe('head worktree rollback (AGT-4785)', () => {
  // A read-only directory blocks the rollback's rm; uid 0 ignores the mode.
  it.skipIf(process.getuid?.() === 0)('reports a failed rollback with its path and the release preserves the root', async () => {
    const sandboxRoot = join(root, '.openswarm-verify-head-x');
    const project = join(sandboxRoot, 'worktree');
    locked = join(project, 'locked');
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, 'file'), 'x\n');
    await chmod(locked, 0o500);
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    // `worktree add` refuses the non-empty path, then the rollback cannot remove it.
    const error = await addStrictHeadWorktree(repo, project, head, [root]).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(HeadWorktreeRollbackError);
    expect(strandedHeadWorktree(error)).toBe(project);
    expect(strandedHeadWorktree(new Error('other'))).toBeUndefined();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await releaseHeadSandbox(repo, sandboxRoot, strandedHeadWorktree(error));
      expect(warn.mock.calls.some((call) => String(call[0]).includes(`Preserving ${sandboxRoot}`))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(existsSync(sandboxRoot)).toBe(true);
  });
});
