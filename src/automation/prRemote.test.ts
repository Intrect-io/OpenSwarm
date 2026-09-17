import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prRemote } from './prRemote.js';

describe('prRemote (AGT-3374)', () => {
  const roots: string[] = [];
  function repoWithRemotes(...names: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-pr-remote-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'pipe' });
    for (const name of names) execFileSync('git', ['-C', root, 'remote', 'add', name, `https://example.test/${name}.git`], { stdio: 'pipe' });
    return root;
  }
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it('uses the only remote even when it is not called origin (vega-agent names it unohee)', async () => {
    await expect(prRemote(repoWithRemotes('unohee'))).resolves.toBe('unohee');
  });

  it('prefers origin when several remotes exist', async () => {
    await expect(prRemote(repoWithRemotes('unohee', 'origin'))).resolves.toBe('origin');
  });

  it('falls back to origin when there is no remote at all', async () => {
    await expect(prRemote(repoWithRemotes())).resolves.toBe('origin');
  });
});
