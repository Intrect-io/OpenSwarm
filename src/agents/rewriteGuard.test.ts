import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acknowledgedRewrites, findRewrites, inspectRewrites } from './rewriteGuard.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

const lines = (n: number, prefix = 'field') => Array.from({ length: n }, (_, i) => `${prefix}_${i} = ${i}`).join('\n') + '\n';

describe('findRewrites (AGT-4406)', () => {
  it('flags a file that lost more than 30% of its lines and leaves targeted edits alone', () => {
    const counts = new Map([['config.py', 95], ['small.py', 10], ['touched.py', 200]]);
    const found = findRewrites([
      { file: 'config.py', added: 255, deleted: 290, isNew: false, whitespaceOnly: false },
      { file: 'touched.py', added: 12, deleted: 9, isNew: false, whitespaceOnly: false },
      { file: 'small.py', added: 20, deleted: 10, isNew: false, whitespaceOnly: false },
      { file: 'new.py', added: 0, deleted: 0, isNew: true, whitespaceOnly: false },
      { file: 'fmt.py', added: 80, deleted: 80, isNew: false, whitespaceOnly: true },
    ], counts);
    expect(found.map((f) => f.file)).toEqual(['config.py']);
    expect(found[0].ratio).toBeGreaterThan(1);
  });

  it('reads per-file acknowledgements from the worker summary, exact path only', () => {
    const ack = acknowledgedRewrites('Rewrote the parser as asked. REWRITE: src/parser.py and REWRITE: ./docs/spec.md');
    expect(ack).toEqual(new Set(['src/parser.py', 'docs/spec.md']));
    expect(acknowledgedRewrites('REWRITE everything')).toEqual(new Set());
  });
});

describe('inspectRewrites against a real worktree', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'openswarm-rewrite-'));
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'config.py'), lines(40));
    writeFileSync(join(repo, 'notes.md'), '# notes\n\nkeep me\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('blocks a whole-file rewrite the worker did not acknowledge, and passes it once acknowledged', async () => {
    writeFileSync(join(repo, 'config.py'), lines(28, 'other'));
    const silent = await inspectRewrites(repo, 'Added the three fields.');
    expect(silent.unacknowledged.map((f) => f.file)).toEqual(['config.py']);
    expect(silent.acknowledged).toEqual([]);

    const declared = await inspectRewrites(repo, 'Rebuilt the schema. REWRITE: config.py');
    expect(declared.unacknowledged).toEqual([]);
    expect(declared.acknowledged.map((f) => f.file)).toEqual(['config.py']);
  });

  it('does not flag a targeted edit', async () => {
    const edited = lines(40).replace('field_3 = 3', 'field_3 = 33\nfield_3b = 34');
    writeFileSync(join(repo, 'config.py'), edited);
    const outcome = await inspectRewrites(repo, 'changed field_3');
    expect(outcome.unacknowledged).toEqual([]);
  });

  it('restores the trailing newline a modified file lost, and only then', async () => {
    writeFileSync(join(repo, 'notes.md'), '# notes\n\nkeep me\nadded');
    writeFileSync(join(repo, 'fresh.txt'), 'no newline is fine for a new file');
    const outcome = await inspectRewrites(repo, '');
    expect(outcome.newlineRestored).toEqual(['notes.md']);
    expect(readFileSync(join(repo, 'notes.md'), 'utf8')).toBe('# notes\n\nkeep me\nadded\n');
    expect(readFileSync(join(repo, 'fresh.txt'), 'utf8')).toBe('no newline is fine for a new file');
  });
});
