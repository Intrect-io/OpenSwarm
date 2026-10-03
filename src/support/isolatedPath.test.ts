import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyIsolatedPath } from './isolatedPath.js';

describe('copyIsolatedPath symlink cycles (AGT-4666)', () => {
  let root = '';

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function fixture(): Promise<{ source: string; sandbox: string; target: string }> {
    root = await mkdtemp(join(tmpdir(), 'openswarm-isolated-cycle-'));
    const source = join(root, 'live', 'node_modules');
    const sandbox = join(root, 'sandbox');
    await mkdir(join(source, 'pkg'), { recursive: true });
    await writeFile(join(source, 'pkg', 'index.js'), 'module.exports = 1;\n');
    await mkdir(join(sandbox, '.git'), { recursive: true });
    return { source, sandbox, target: join(sandbox, 'apps', 'node_modules') };
  }

  // cgf-portal's shared node_modules held `node_modules -> node_modules`. Every
  // sandbox copy dereferenced it, found the same link in the copy, and went on
  // until the path was too long, copying the tree at each level: nine abandoned
  // sandboxes held about 73 GB.
  it('copies a dependency tree that contains a link to itself, once', async () => {
    const { source, sandbox, target } = await fixture();
    await symlink(source, join(source, 'node_modules'));

    await copyIsolatedPath(source, target, sandbox, 'apps/node_modules');

    expect(await readFile(join(target, 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    // The cyclic link is neutralized, not copied in as a second tree.
    const entries = (await readdir(target)).sort();
    expect(entries).toEqual(['node_modules', 'pkg']);
    expect((await lstat(join(target, 'node_modules'))).isSymbolicLink()).toBe(true);
    expect(await readdir(join(target, 'pkg'))).toEqual(['index.js']);
  }, 30_000);

  it('does not let the neutralized link point back at the live tree', async () => {
    const { source, sandbox, target } = await fixture();
    await symlink(source, join(source, 'node_modules'));

    await copyIsolatedPath(source, target, sandbox, 'apps/node_modules');

    const linkTarget = await readlink(join(target, 'node_modules'));
    expect(linkTarget.startsWith('/Users/') || linkTarget.includes(source)).toBe(false);
  }, 30_000);

  it('still dereferences a link to a sibling tree outside the copied one', async () => {
    const { source, sandbox, target } = await fixture();
    const sibling = join(root, 'live', 'shared-lib');
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, 'lib.js'), 'lib\n');
    await symlink(sibling, join(source, 'shared-lib'));

    await copyIsolatedPath(source, target, sandbox, 'apps/node_modules');

    expect((await lstat(join(target, 'shared-lib'))).isDirectory()).toBe(true);
    expect(await readFile(join(target, 'shared-lib', 'lib.js'), 'utf8')).toBe('lib\n');
  }, 30_000);
});
