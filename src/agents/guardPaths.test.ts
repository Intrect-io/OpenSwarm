import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { containedProjectPath, lexicallyContainedPath, partitionChangedPaths } from './guardPaths.js';

describe('guard path containment (AGT-3441)', () => {
  let root: string;
  let project: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-guardpaths-'));
    project = join(root, 'project');
    outside = join(root, 'outside');
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(outside, 'secret.ts'), 'export const secret = 1;\n');
    symlinkSync(outside, join(project, 'linked-dir'));
    symlinkSync(join(outside, 'secret.ts'), join(project, 'src', 'linked-file.ts'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts project-relative paths, including absolute ones inside the project and new files', () => {
    expect(containedProjectPath(project, 'src/a.ts')).toBe('src/a.ts');
    expect(containedProjectPath(project, './src/a.ts')).toBe('src/a.ts');
    expect(containedProjectPath(project, join(project, 'src', 'a.ts'))).toBe('src/a.ts');
    expect(containedProjectPath(project, 'src/new/deep/file.ts')).toBe('src/new/deep/file.ts');
  });

  it('rejects traversal, absolute outside paths, empty and NUL paths lexically', () => {
    for (const bad of ['../outside/secret.ts', 'src/../../outside/secret.ts', join(outside, 'secret.ts'), '', '.', 'src/a.ts\0x', '..']) {
      expect(lexicallyContainedPath(project, bad)).toBeNull();
      expect(containedProjectPath(project, bad)).toBeNull();
    }
  });

  it('rejects paths that leave the project through a symlinked directory or file', () => {
    expect(lexicallyContainedPath(project, 'linked-dir/secret.ts')).toBe('linked-dir/secret.ts');
    expect(containedProjectPath(project, 'linked-dir/secret.ts')).toBeNull();
    expect(containedProjectPath(project, 'linked-dir/not-yet.ts')).toBeNull();
    expect(containedProjectPath(project, 'src/linked-file.ts')).toBeNull();
  });

  it('partitions a changed-file list', () => {
    expect(partitionChangedPaths(project, ['src/a.ts', '../x.ts', 'linked-dir/secret.ts'])).toEqual({
      contained: ['src/a.ts'],
      escaped: ['../x.ts', 'linked-dir/secret.ts'],
    });
  });
});
