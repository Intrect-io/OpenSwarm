// AGT-3470 — changed-file discovery must cover staged-but-uncommitted edits and
// parse git's NUL-delimited output verbatim (paths may contain newlines).
//
// Kept out of gitInfo.test.ts because that file mocks node:child_process for the
// churn unit tests, which would make these real-git cases unrunnable.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRecentlyChangedFiles } from './gitInfo.js';

const execFileAsync = promisify(execFile);
let tmp: string;

async function git(...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: tmp });
}

async function writeProjectFile(path: string, content: string): Promise<void> {
  const fullPath = join(tmp, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

describe('git changed-file discovery limits', () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'openswarm-git-discovery-'));
    await git('init', '-q');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('discovers a staged-but-uncommitted edit that git log cannot see', async () => {
    await writeProjectFile('src/committed.ts', 'export const committed = 1;\n');
    await git('add', 'src/committed.ts');
    await git('commit', '-q', '-m', 'committed');
    // Backdate so the edit is outside `log --since` — only the staged diff shows it.
    const edited = 'src/committed.ts';
    await writeFile(join(tmp, edited), 'export const committed = 2;\n', 'utf-8');
    await git('add', edited);

    const changed = await getRecentlyChangedFiles(tmp, Date.now() + 60_000);

    expect(changed).toContain(edited);
  });

  it('keeps a path with an embedded newline intact instead of splitting it', async () => {
    const embedded = 'src/line\nbreak.ts';
    await writeProjectFile(embedded, 'export const embedded = 1;\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'embedded newline');

    const changed = await getRecentlyChangedFiles(tmp, Date.now() - 60_000);

    expect(changed).toContain(embedded);
    expect(changed).not.toContain('src/line');
    expect(changed).not.toContain('break.ts');
  });

  it('preserves a path that starts with a newline rather than trimming it away', async () => {
    const leading = '\nleading.ts';
    await writeProjectFile(leading, 'export const leading = 1;\n');
    await writeProjectFile('src/other.ts', 'export const other = 1;\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'leading newline');

    const changed = await getRecentlyChangedFiles(tmp, Date.now() - 60_000);

    expect(changed).toContain(leading);
    expect(changed).not.toContain('leading.ts');
  });
});
