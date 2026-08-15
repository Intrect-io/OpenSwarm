// ============================================
// OpenSwarm - writes that used to clobber or leak
// ============================================
//
// Two write paths destroyed or exposed data without reporting anything: the
// prompt handed to every CLI adapter, and the "Add File" patch operation.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnCli } from './base.js';
import { applyV4APatch } from './applyPatch.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

type Seen = { path: string; mode: number; dirMode: number; content: string };

describe('spawnCli prompt file', () => {

  /**
   * An adapter that records where the prompt was placed and what its mode was,
   * observed from inside buildCommand — i.e. while the file is live, which is
   * the only point it exists.
   */
  function inspectingAdapter(seen: Array<Seen>) {
    return {
      name: 'inspector',
      capabilities: { supportsStreaming: false },
      buildCommand: ({ prompt }: { prompt: string }) => {
        // Recorded here, not after spawnCli returns: the directory is removed
        // on the way out, so this is the only moment it can be observed.
        const promptFd = openSync(prompt, 'r');
        try {
          seen.push({
            path: prompt,
            mode: fstatSync(promptFd).mode & 0o777,
            dirMode: statSync(dirname(prompt)).mode & 0o777,
            content: readFileSync(promptFd, 'utf-8'),
          });
        } finally {
          closeSync(promptFd);
        }
        return { command: 'true', args: [] };
      },
    } as never;
  }

  it('gives each concurrent call its own prompt', async () => {
    const seen: Seen[] = [];
    const adapter = inspectingAdapter(seen);

    // Same millisecond is what the old Date.now() name could not survive.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        spawnCli(adapter, { prompt: `task-${i}`, cwd: process.cwd() } as never),
      ),
    );

    expect(seen).toHaveLength(8);
    expect(new Set(seen.map((s) => s.path)).size).toBe(8);
    // Each call must see its own text, not a neighbour's.
    expect(new Set(seen.map((s) => s.content)).size).toBe(8);
  }, 30_000);

  it('keeps the prompt unreadable by other local users', async () => {
    const seen: Seen[] = [];
    await spawnCli(inspectingAdapter(seen), { prompt: 'sensitive task', cwd: process.cwd() } as never);

    expect(seen[0].mode & 0o077).toBe(0);
    // The containing directory must be private too, or the mode above is moot.
    expect(seen[0].dirMode & 0o077).toBe(0);
  }, 30_000);

  it('removes the prompt directory afterwards', async () => {
    const seen: Seen[] = [];
    await spawnCli(inspectingAdapter(seen), { prompt: 'x', cwd: process.cwd() } as never);

    expect(() => statSync(dirname(seen[0].path))).toThrow();
  }, 30_000);

  it('removes the prompt directory even when the run fails', async () => {
    const seen: Seen[] = [];
    const failing = {
      name: 'failing',
      capabilities: { supportsStreaming: false },
      buildCommand: ({ prompt }: { prompt: string }) => {
        seen.push({ path: prompt, mode: 0, dirMode: 0, content: '' });
        throw new Error('buildCommand blew up');
      },
    } as never;

    await expect(spawnCli(failing, { prompt: 'x', cwd: process.cwd() } as never)).rejects.toThrow();
    expect(() => statSync(dirname(seen[0].path))).toThrow();
  }, 30_000);
});

describe('applyPatch "add" operation', () => {

  const addPatch = (file: string, body: string) =>
    `*** Begin Patch\n*** Add File: ${file}\n${body.split('\n').map((l) => `+${l}`).join('\n')}\n*** End Patch`;

  it('creates a new file', async () => {
    const repo = tempRoot('openswarm-patch-');
    const result = await applyV4APatch(addPatch('new.ts', 'export const a = 1;'), repo, (f) => join(repo, f));

    expect(result.errors).toEqual([]);
    expect(readFileSync(join(repo, 'new.ts'), 'utf-8')).toContain('export const a = 1;');
  });

  // The defect: an add op naming an existing file replaced it outright, with
  // no error and nothing recorded as an update.
  it('refuses to overwrite an existing file', async () => {
    const repo = tempRoot('openswarm-patch-');
    writeFileSync(join(repo, 'existing.ts'), 'export const important = "keep me";\n');

    const result = await applyV4APatch(addPatch('existing.ts', 'export const replacement = 1;'), repo, (f) => join(repo, f));

    expect(result.errors.join('\n')).toMatch(/existing\.ts/);
    expect(readFileSync(join(repo, 'existing.ts'), 'utf-8')).toContain('keep me');
    expect(result.changed).toEqual([]);
  });

  it('says what to do instead', async () => {
    const repo = tempRoot('openswarm-patch-');
    writeFileSync(join(repo, 'existing.ts'), 'x\n');

    const result = await applyV4APatch(addPatch('existing.ts', 'y'), repo, (f) => join(repo, f));

    expect(result.errors.join('\n')).toMatch(/update op/);
  });

  // The refusal runs rollback, and rollback removes paths it recorded as
  // absent. A snapshot that could not read the file must not be mistaken for
  // one that found nothing — otherwise refusing to overwrite a protected file
  // deletes it, which is worse than the overwrite being prevented.
  it('does not delete a file it could not read while refusing to add it', async () => {
    const repo = tempRoot('openswarm-patch-');
    const target = join(repo, 'locked.ts');
    writeFileSync(target, 'export const secret = 1;\n');
    chmodSync(target, 0o000);

    try {
      const result = await applyV4APatch(addPatch('locked.ts', 'export const clobber = 1;'), repo, (f) => join(repo, f));

      expect(result.errors.length).toBeGreaterThan(0);
      // The file must still be there. Its contents are unchanged too, but the
      // point of the assertion is that it exists at all.
      expect(existsSync(target)).toBe(true);
      chmodSync(target, 0o600);
      expect(readFileSync(target, 'utf-8')).toContain('secret');
    } finally {
      chmodSync(target, 0o600);
    }
  });

  // A dangling symlink exists as a path but cannot be read through.
  it('does not delete a dangling symlink while refusing to add over it', async () => {
    const repo = tempRoot('openswarm-patch-');
    const link = join(repo, 'link.ts');
    symlinkSync(join(repo, 'nowhere.ts'), link);

    const result = await applyV4APatch(addPatch('link.ts', 'export const clobber = 1;'), repo, (f) => join(repo, f));

    expect(result.errors.length).toBeGreaterThan(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('refuses to update through a pre-existing symlink', async () => {
    const repo = tempRoot('openswarm-patch-');
    const outside = tempRoot('openswarm-outside-');
    const target = join(outside, 'protected.ts');
    const link = join(repo, 'link.ts');
    writeFileSync(target, 'export const protectedValue = true;\n');
    symlinkSync(target, link);

    const patch = [
      '*** Begin Patch',
      '*** Update File: link.ts',
      '@@',
      '-export const protectedValue = true;',
      '+export const protectedValue = false;',
      '*** End Patch',
    ].join('\n');
    const result = await applyV4APatch(patch, repo, (f) => join(repo, f));

    expect(result.changed).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/symbolic link/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toContain('protectedValue = true');
  });

  it('rejects an intermediate symlink swapped in after preflight', async () => {
    const repo = tempRoot('openswarm-patch-');
    const outside = tempRoot('openswarm-outside-');
    const nested = join(repo, 'nested');
    const target = join(outside, 'protected.ts');
    mkdirSync(nested);
    writeFileSync(join(nested, 'protected.ts'), 'export const value = true;\n');
    writeFileSync(target, 'export const value = true;\n');
    let resolves = 0;
    const resolveWithSwap = (file: string) => {
      resolves++;
      if (file === 'nested/protected.ts' && resolves === 2) {
        renameSync(nested, join(repo, 'nested-before-swap'));
        symlinkSync(outside, nested);
      }
      return join(repo, file);
    };
    const patch = [
      '*** Begin Patch',
      '*** Update File: nested/protected.ts',
      '@@',
      '-export const value = true;',
      '+export const value = false;',
      '*** End Patch',
    ].join('\n');

    const result = await applyV4APatch(patch, repo, resolveWithSwap);

    expect(result.changed).toEqual([]);
    expect(result.errors.join('\n')).toMatch(/symbolic link/);
    expect(readFileSync(target, 'utf-8')).toContain('value = true');
  });

  it('restores a deleted regular file when a later operation fails', async () => {
    const repo = tempRoot('openswarm-patch-');
    const removed = join(repo, 'removed.ts');
    const invalid = join(repo, 'invalid.ts');
    writeFileSync(removed, 'export const keep = true;\n');
    writeFileSync(invalid, 'export const current = true;\n');

    const patch = [
      '*** Begin Patch',
      '*** Delete File: removed.ts',
      '*** Update File: invalid.ts',
      '@@',
      '-export const missing = true;',
      '+export const changed = true;',
      '*** End Patch',
    ].join('\n');
    const result = await applyV4APatch(patch, repo, (f) => join(repo, f));

    expect(result.changed).toEqual([]);
    expect(readFileSync(removed, 'utf-8')).toContain('keep = true');
    expect(readFileSync(invalid, 'utf-8')).toContain('current = true');
  });

  // The snapshot is taken up front, so a path that appears afterwards was
  // written by someone else. Rollback must not remove it just because it was
  // absent when the patch started — that is data loss reported as a clean
  // refusal. Encoded deterministically: resolvePath creates the file on the
  // second call for a path, which is exactly the window between the snapshot
  // pass and the apply loop.
  it('does not delete a file that appeared after the snapshot', async () => {
    const repo = tempRoot('openswarm-patch-');
    const target = join(repo, 'raced.ts');
    const calls = new Map<string, number>();
    const resolveWithRace = (f: string) => {
      const abs = join(repo, f);
      const n = (calls.get(f) ?? 0) + 1;
      calls.set(f, n);
      if (f === 'raced.ts' && n === 2) writeFileSync(target, 'written by someone else\n');
      return abs;
    };

    const result = await applyV4APatch(addPatch('raced.ts', 'export const mine = 1;'), repo, resolveWithRace);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toContain('someone else');
  });

  const movePatch = (from: string, to: string, oldLine: string, newLine: string) =>
    `*** Begin Patch\n*** Update File: ${from}\n*** Move to: ${to}\n@@\n-${oldLine}\n+${newLine}\n*** End Patch`;

  // Move had the same clobbering problem as add, and a worse consequence: a
  // destination whose contents could not be snapshotted is skipped by rollback,
  // so the overwrite survived while the result said nothing had been applied.
  it('refuses to move onto an existing file', async () => {
    const repo = tempRoot('openswarm-patch-');
    writeFileSync(join(repo, 'src.ts'), 'v = 1\n');
    writeFileSync(join(repo, 'dest.ts'), 'do not lose me\n');

    const result = await applyV4APatch(movePatch('src.ts', 'dest.ts', 'v = 1', 'v = 2'), repo, (f) => join(repo, f));

    expect(result.errors.join('\n')).toMatch(/dest\.ts/);
    expect(readFileSync(join(repo, 'dest.ts'), 'utf-8')).toContain('do not lose me');
    // The source must survive the refusal too.
    expect(readFileSync(join(repo, 'src.ts'), 'utf-8')).toContain('v = 1');
  });

  // Write-only, not mode 000: with 000 the OS refuses the write anyway, so the
  // test would pass with or without the guard. 0o200 is the case that actually
  // discriminates — the old code could overwrite it, and rollback skips paths
  // it could not snapshot, so the overwrite survived a reported-clean failure.
  it('refuses to move onto a file it cannot read', async () => {
    const repo = tempRoot('openswarm-patch-');
    writeFileSync(join(repo, 'src.ts'), 'v = 1\n');
    const dest = join(repo, 'dest.ts');
    writeFileSync(dest, 'protected\n');
    chmodSync(dest, 0o200);

    try {
      const result = await applyV4APatch(movePatch('src.ts', 'dest.ts', 'v = 1', 'v = 2'), repo, (f) => join(repo, f));

      expect(result.errors.length).toBeGreaterThan(0);
      expect(existsSync(dest)).toBe(true);
      chmodSync(dest, 0o600);
      expect(readFileSync(dest, 'utf-8')).toContain('protected');
    } finally {
      chmodSync(dest, 0o600);
    }
  });

  // A rejected add must not leave earlier operations of the same patch applied.
  it('rolls back the rest of the patch', async () => {
    const repo = tempRoot('openswarm-patch-');
    writeFileSync(join(repo, 'existing.ts'), 'keep\n');

    const patch = [
      '*** Begin Patch',
      '*** Add File: first.ts',
      '+export const first = 1;',
      `*** Add File: existing.ts`,
      '+export const clobber = 1;',
      '*** End Patch',
    ].join('\n');

    const result = await applyV4APatch(patch, repo, (f) => join(repo, f));

    expect(result.errors.length).toBeGreaterThan(0);
    expect(readFileSync(join(repo, 'existing.ts'), 'utf-8')).toContain('keep');
    expect(readdirSync(repo)).not.toContain('first.ts');
  });
});
