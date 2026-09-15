import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshotWorkingTree, restoreWorkingTree, withRestoredWorkingTree } from './reviewWorktreeGuard.js';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-review-guard-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'calc.js'), 'let total = 0;\n');
  git(root, ['add', 'calc.js']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

describe('reviewWorktreeGuard (AGT-4291)', () => {
  it('restores the operator dirty state and discards reviewer edits', async () => {
    const root = initRepo();
    try {
      writeFileSync(join(root, 'calc.js'), 'let total = 1; // operator\n');
      writeFileSync(join(root, 'notes.txt'), 'operator note\n');

      await withRestoredWorkingTree(root, async () => {
        writeFileSync(join(root, 'calc.js'), 'let total = 99; // reviewer\n');
        writeFileSync(join(root, 'reviewer-only.js'), 'oops\n');
      });

      expect(readFileSync(join(root, 'calc.js'), 'utf8')).toBe('let total = 1; // operator\n');
      expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('operator note\n');
      expect(() => readFileSync(join(root, 'reviewer-only.js'))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('snapshot/restore round-trips a clean tree', () => {
    const root = initRepo();
    try {
      const tree = snapshotWorkingTree(root);
      writeFileSync(join(root, 'calc.js'), 'mutated\n');
      restoreWorkingTree(root, tree);
      expect(readFileSync(join(root, 'calc.js'), 'utf8')).toBe('let total = 0;\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
