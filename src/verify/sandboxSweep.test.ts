import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STALE_SANDBOX_AGE_MS, sweepStaleVerifySandboxes } from './sandboxSweep.js';

let root: string;
const NOW = Date.UTC(2026, 10, 15, 12);

async function sandbox(name: string, ageMs: number): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, 'worktree', '.git'), { recursive: true });
  await writeFile(join(path, 'worktree', '.git', 'pack'), 'x');
  const at = new Date(NOW - ageMs);
  await utimes(path, at, at);
  return path;
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'osw-sandbox-sweep-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('sweepStaleVerifySandboxes', () => {
  it('removes stale head and base sandboxes and keeps fresh ones', async () => {
    const staleHead = await sandbox('.openswarm-verify-head-cSMUrc', DEFAULT_STALE_SANDBOX_AGE_MS + 1);
    const staleBase = await sandbox('.openswarm-verify-base-3zSAeP', 2 * DEFAULT_STALE_SANDBOX_AGE_MS);
    const fresh = await sandbox('.openswarm-verify-head-UY8fMU', 60_000);

    const result = await sweepStaleVerifySandboxes({ root, now: NOW });

    expect(result.removed.sort()).toEqual([staleBase, staleHead].sort());
    expect(result.keptFresh).toBe(1);
    expect(result.failed).toEqual([]);
    expect(existsSync(staleHead)).toBe(false);
    expect(existsSync(staleBase)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('leaves anything that is not a verify sandbox alone', async () => {
    const other = await sandbox('openswarm-verify-trust-abc', DEFAULT_STALE_SANDBOX_AGE_MS * 3);
    const lookalike = await sandbox('.openswarm-verify-head-abc.keep', DEFAULT_STALE_SANDBOX_AGE_MS * 3);
    const result = await sweepStaleVerifySandboxes({ root, now: NOW });
    expect(result.removed).toEqual([]);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(lookalike)).toBe(true);
  });

  it('does not follow a symlink that matches the pattern', async () => {
    const target = await mkdtemp(join(tmpdir(), 'osw-sandbox-sweep-target-'));
    try {
      await writeFile(join(target, 'keep'), 'x');
      await symlink(target, join(root, '.openswarm-verify-head-link01'));
      const result = await sweepStaleVerifySandboxes({ root, now: NOW + DEFAULT_STALE_SANDBOX_AGE_MS * 10 });
      expect(result.removed).toEqual([]);
      expect(existsSync(join(target, 'keep'))).toBe(true);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it('returns an empty result for a missing root', async () => {
    const result = await sweepStaleVerifySandboxes({ root: join(root, 'missing'), now: NOW });
    expect(result).toEqual({ removed: [], keptFresh: 0, failed: [] });
  });
});
