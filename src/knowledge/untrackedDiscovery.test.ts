// AGT-3490 — incremental refresh must discover newly created untracked files.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRecentlyChangedFiles } from './gitInfo.js';

const execFileAsync = promisify(execFile);
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'openswarm-knowledge-'));
  await execFileAsync('git', ['init'], { cwd: tmp });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: tmp });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('incremental refresh discovery', () => {
  it('includes newly created untracked source files alongside committed history', async () => {
    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(join(tmp, 'src/committed.ts'), 'export const committed = 1;\n', 'utf-8');
    await execFileAsync('git', ['add', 'src/committed.ts'], { cwd: tmp });
    await execFileAsync('git', ['commit', '-m', 'committed'], { cwd: tmp });

    await writeFile(join(tmp, 'src/untracked.ts'), 'export const untracked = 1;\n', 'utf-8');
    const since = new Date(Date.now() - 60_000).getTime();
    const changed = await getRecentlyChangedFiles(tmp, since);

    expect(changed).toContain('src/committed.ts');
    expect(changed).toContain('src/untracked.ts');
  });

  it('returns an empty list when git discovery fails entirely', async () => {
    const changed = await getRecentlyChangedFiles(join(tmp, 'not-a-repo'), Date.now());
    expect(changed).toEqual([]);
  });
});
