import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { getRecentlyChangedFiles } from './gitInfo.js';

describe('getRecentlyChangedFiles', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('includes newly created untracked source files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'osw-gitinfo-'));
    execFileSync('git', ['init'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    writeFileSync(join(dir, 'tracked.ts'), 'export const a = 1;\n');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: dir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });

    writeFileSync(join(dir, 'src-foo.ts'), 'export const b = 2;\n');

    const changed = await getRecentlyChangedFiles(dir, Date.now() - 60_000);
    expect(changed).toContain('src-foo.ts');
  });
});
