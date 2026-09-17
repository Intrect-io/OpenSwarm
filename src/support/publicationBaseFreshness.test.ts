import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FRESH_BASE, baseFreshnessSection, parseConflictedPaths, probeBaseFreshness } from './publicationBaseFreshness.js';

describe('parseConflictedPaths', () => {
  it('drops the tree id line and deduplicates paths', () => {
    expect(parseConflictedPaths('abc123\n\nsrc/a.py\nsrc/a.py\nsrc/b.py\n')).toEqual(['src/a.py', 'src/b.py']);
    expect(parseConflictedPaths('abc123\n')).toEqual([]);
  });
});

describe('baseFreshnessSection (AGT-4189)', () => {
  it('is silent for an up-to-date branch', () => {
    expect(baseFreshnessSection(FRESH_BASE, 'main')).toBeNull();
  });

  it('notes a stale base without alarm', () => {
    const section = baseFreshnessSection({ behindBy: 112, conflictFiles: [] }, 'main')!;
    expect(section).toContain('## Base freshness');
    expect(section).toContain('112 commit(s) behind `main`');
    expect(section).not.toContain('Conflicts');
  });

  it('names the conflicting files and explains the green-checks trap', () => {
    const section = baseFreshnessSection({ behindBy: 3, conflictFiles: ['apps/a.py', 'docs/x.md'] }, 'main')!;
    expect(section).toContain('⚠ **Conflicts with `main`** in: `apps/a.py`, `docs/x.md`');
    expect(section).toContain('runs no `pull_request` workflows');
    expect(section).toContain('Opened as a draft');
  });
});

describe('probeBaseFreshness against a real repository', () => {
  let root: string;
  let repo: string;
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-base-freshness-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' });
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is fresh when the branch is at or ahead of the base', async () => {
    writeFileSync(join(repo, 'c.txt'), 'c\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feature');
    await expect(probeBaseFreshness(repo, 'main')).resolves.toEqual(FRESH_BASE);
  });

  it('counts commits behind and reports a clean merge', async () => {
    writeFileSync(join(repo, 'c.txt'), 'c\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feature');
    git('checkout', '-q', 'main');
    writeFileSync(join(repo, 'b.txt'), 'b2\n');
    git('commit', '-q', '-am', 'main moves');
    writeFileSync(join(repo, 'b.txt'), 'b3\n');
    git('commit', '-q', '-am', 'main moves again');
    git('checkout', '-q', 'feature');
    await expect(probeBaseFreshness(repo, 'main')).resolves.toEqual({ behindBy: 2, conflictFiles: [] });
  });

  it('names the files that conflict with the base', async () => {
    writeFileSync(join(repo, 'a.txt'), 'feature side\n');
    git('commit', '-q', '-am', 'feature edits a');
    git('checkout', '-q', 'main');
    writeFileSync(join(repo, 'a.txt'), 'main side\n');
    git('commit', '-q', '-am', 'main edits a');
    git('checkout', '-q', 'feature');
    await expect(probeBaseFreshness(repo, 'main')).resolves.toEqual({ behindBy: 1, conflictFiles: ['a.txt'] });
    // The probe left the worktree and index untouched.
    expect(git('status', '--porcelain')).toBe('');
  });

  it('falls back to fresh when the base ref cannot be read', async () => {
    await expect(probeBaseFreshness(repo, 'no-such-ref')).resolves.toEqual(FRESH_BASE);
  });
});
