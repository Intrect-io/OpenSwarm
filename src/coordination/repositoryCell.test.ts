import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repositoryCell, resetRepositoryCellCacheForTests } from './repositoryCell.js';

let root = '';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

afterEach(() => {
  resetRepositoryCellCacheForTests();
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('repositoryCell', () => {
  it('gives a main checkout and its real sibling worktree one repository key', () => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-cell-'));
    const main = join(root, 'main');
    const sibling = join(root, 'sibling');
    mkdirSync(main);
    git(main, 'init');
    git(main, 'config', 'user.email', 'test@example.invalid');
    git(main, 'config', 'user.name', 'OpenSwarm test');
    writeFileSync(join(main, 'README.md'), 'cell\n');
    git(main, 'add', 'README.md');
    git(main, 'commit', '-m', 'seed');
    git(main, 'worktree', 'add', '-b', 'sibling', sibling);

    const primary = repositoryCell(main);
    const linked = repositoryCell(sibling);
    expect(linked.repoKey).toBe(primary.repoKey);
    expect(linked.repositoryPath).toBe(primary.repositoryPath);

    const other = join(root, 'other');
    mkdirSync(other);
    git(other, 'init');
    expect(repositoryCell(other).repoKey).not.toBe(primary.repoKey);
  });

  it('uses a stable path cell when Git metadata is unavailable', () => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-path-cell-'));
    const first = repositoryCell(root);
    resetRepositoryCellCacheForTests();
    expect(repositoryCell(root)).toMatchObject({ repoKey: first.repoKey, repositoryPath: first.repositoryPath });
    expect(first.repoKey).toMatch(/^path:/);
  });
});
