// AGT-3470 — changed-file discovery must cover untracked/staged paths and parse
// git's NUL-delimited output verbatim (paths may contain newlines).

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeGraph } from './graph.js';
import { enrichWithGitInfo, getRecentlyChangedFiles } from './gitInfo.js';

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

describe('git changed-file discovery', () => {
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'openswarm-gitinfo-'));
    await git('init', '-q');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('includes staged source files that are not yet committed', async () => {
    await writeProjectFile('src/committed.ts', 'export const committed = 1;\n');
    await git('add', 'src/committed.ts');
    await git('commit', '-q', '-m', 'committed');

    await writeProjectFile('src/staged.ts', 'export const staged = 1;\n');
    await git('add', 'src/staged.ts');

    const changed = await getRecentlyChangedFiles(tmp, Date.now() - 60_000);

    expect(changed).toContain('src/committed.ts');
    expect(changed).toContain('src/staged.ts');
  });

  it('keeps paths containing newlines intact instead of splitting them', async () => {
    const embedded = 'src/line\nbreak.ts';
    await writeProjectFile(embedded, 'export const embedded = 1;\n');
    await writeProjectFile('src/normal.ts', 'export const normal = 1;\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'newline path');

    const changed = await getRecentlyChangedFiles(tmp, Date.now() - 60_000);

    expect(changed).toContain(embedded);
    expect(changed).not.toContain('src/line');
    expect(changed).not.toContain('break.ts');
  });

  it('preserves a path that starts with a newline rather than reading it as a commit separator', async () => {
    const leading = '\nleading.ts';
    await writeProjectFile(leading, 'export const leading = 1;\n');
    await writeProjectFile('src/other.ts', 'export const other = 1;\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'leading newline path');

    const graph = new KnowledgeGraph('test-project', tmp);
    graph.addNode({ id: leading, type: 'module', name: 'leading.ts', path: leading });

    await enrichWithGitInfo(graph, tmp);

    expect(await getRecentlyChangedFiles(tmp, Date.now() - 60_000)).toContain(leading);
    expect(graph.getNode(leading)?.gitInfo?.commitCount30d).toBe(1);
  });

  it('treats a purely numeric filename as a path, not a commit timestamp', async () => {
    await writeProjectFile('20240101', 'export const generated = 1;\n');
    await writeProjectFile('src/other.ts', 'export const other = 1;\n');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'numeric path');

    const graph = new KnowledgeGraph('test-project', tmp);
    graph.addNode({ id: '20240101', type: 'module', name: '20240101', path: '20240101' });
    graph.addNode({ id: 'src/other.ts', type: 'module', name: 'other.ts', path: 'src/other.ts' });

    await enrichWithGitInfo(graph, tmp);

    expect(graph.getNode('src/other.ts')?.gitInfo?.commitCount30d).toBe(1);
    expect(graph.getNode('20240101')?.gitInfo?.commitCount30d).toBe(1);
    expect(graph.getNode('20240101')?.gitInfo?.lastCommitDate).toBeGreaterThan(0);
  });
});
