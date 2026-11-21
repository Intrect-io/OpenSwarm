// Created: 2026-11-22
// Purpose: The strict head sandbox neutralizes a self-linked node_modules instead of expanding it (AGT-4666, AGT-4785).
// Dependencies: vitest, git, ./runner.js (fake sandboxExecutorSessionFactory, no real companion)
// Test Status: passing

import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runVerify } from './runner.js';

let root: string;
let repo: string;

function gitIn(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function duKb(path: string): number {
  return Number(execFileSync('du', ['-sk', path], { encoding: 'utf8' }).split('\t')[0]);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'openswarm-verify-footprint-')));
  repo = join(root, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  gitIn('config', 'user.email', 'test@example.com');
  gitIn('config', 'user.name', 'Test');
  await writeFile(join(repo, '.gitignore'), 'pkg/\n');
  await writeFile(join(repo, 'README.md'), 'base\n');
  gitIn('add', '-A');
  gitIn('commit', '-q', '-m', 'base');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('strict head sandbox disk footprint (AGT-4666)', () => {
  it('a verify sandbox with a self-linked node_modules stays bounded on disk', async () => {
    // cgf-portal's shape: an ignored dependency dir whose node_modules links to itself by absolute path.
    const pkg = join(repo, 'pkg');
    const nodeModules = join(pkg, 'node_modules');
    await mkdir(join(nodeModules, 'dep'), { recursive: true });
    await writeFile(join(pkg, 'index.js'), 'module.exports = 0;\n');
    await writeFile(join(nodeModules, 'dep', 'index.js'), `${'x'.repeat(64 * 1024)}\n`);
    await symlink(nodeModules, join(nodeModules, 'node_modules'));
    const sourceKb = duKb(pkg);

    const seen: Array<{ isLink: boolean; target: string; entries: string[]; pkgKb: number; index: string; dotGitIsFile: boolean }> = [];
    const factory = vi.fn(async (workspace: string) => {
      if (workspace.includes('.openswarm-verify-head-')) {
        const link = join(workspace, 'pkg', 'node_modules', 'node_modules');
        seen.push({
          isLink: (await lstat(link)).isSymbolicLink(),
          target: await readlink(link),
          entries: (await readdir(join(workspace, 'pkg', 'node_modules'))).sort(),
          pkgKb: duKb(join(workspace, 'pkg')),
          index: await readFile(join(workspace, 'pkg', 'node_modules', 'dep', 'index.js'), 'utf8'),
          dotGitIsFile: (await lstat(join(workspace, '.git'))).isFile(),
        });
      }
      return {
        execute: vi.fn(async () => ({
          output: 'ok', exitCode: 0, signal: null, timedOut: false, truncated: false, outputLimitExceeded: false,
        })),
      };
    });

    const [evidence] = await runVerify({
      projectPath: repo,
      commands: [{ name: 'fixture', run: 'true', kind: 'test', timeoutMs: 2_000, cwd: 'pkg' }],
      baseRef: 'HEAD',
      sandboxExecutorSessionFactory: factory,
      sandboxScratchRoot: root,
    });

    expect(evidence.headStatus, evidence.rawOutputTail).toBe('pass');
    expect(seen).toHaveLength(1);
    const [head] = seen;
    expect(head.dotGitIsFile).toBe(true); // the strict worktree path, not the full-copy fallback
    expect(head.isLink).toBe(true);
    expect(head.target.includes(repo)).toBe(false);
    expect(head.entries).toEqual(['dep', 'node_modules']);
    expect(head.index).toBe(`${'x'.repeat(64 * 1024)}\n`);
    // Copied once: a followed link would at least double it.
    expect(head.pkgKb).toBeLessThan(sourceKb * 1.5);
    expect((await readdir(root)).filter((name) => name.startsWith('.openswarm-verify-'))).toEqual([]);
  }, 60_000);
});
