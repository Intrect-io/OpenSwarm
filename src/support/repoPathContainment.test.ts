// ============================================
// OpenSwarm - !dev repo path containment
// ============================================
//
// The repo name in `!dev <repo> "<task>"` comes from a Discord message, and the
// path it resolves to becomes the cwd of a
// `claude --permission-mode bypassPermissions` process. The relative branch
// joined the name onto ~/dev without filtering, so `../.ssh` resolved to
// ~/.ssh and `..` to the home directory — a repo name alone chose where an
// unsandboxed agent would run.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;

/** Load dev.ts with HOME pointed at a temp tree containing ~/dev. */
async function loadDev() {
  vi.resetModules();
  const mockOs = async (importOriginal: () => Promise<typeof import('node:os')>) => {
    const actual = await importOriginal();
    return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
  };
  vi.doMock('node:os', mockOs);
  vi.doMock('os', mockOs);
  return await import('./dev.js');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'openswarm-home-'));
  mkdirSync(join(home, 'dev', 'RealRepo'), { recursive: true });
  mkdirSync(join(home, 'dev', 'nested', 'inner'), { recursive: true });
  // Things that must stay unreachable through a repo name.
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_rsa'), 'secret\n');
  mkdirSync(join(home, 'elsewhere'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.doUnmock('node:os');
  vi.doUnmock('os');
  vi.restoreAllMocks();
});

describe('resolveRepoPath', () => {
  it('resolves a repository inside ~/dev', async () => {
    const { resolveRepoPath } = await loadDev();
    expect(resolveRepoPath('RealRepo')).toBe(join(home, 'dev', 'RealRepo'));
  });

  it('resolves a nested path inside ~/dev', async () => {
    const { resolveRepoPath } = await loadDev();
    expect(resolveRepoPath('nested/inner')).toBe(join(home, 'dev', 'nested', 'inner'));
  });

  // The defect. Each of these existed and was returned, so the agent ran there.
  it.each([
    ['a parent escape', '../.ssh'],
    ['the home directory', '..'],
    ['a deeper escape', '../../'],
    ['an escape after a real segment', 'RealRepo/../../.ssh'],
    ['an escape to a sibling of dev', '../elsewhere'],
  ])('refuses %s', async (_label, repo) => {
    const { resolveRepoPath } = await loadDev();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveRepoPath(repo)).toBeNull();
  });

  // A lexical check alone would pass this: the path string stays under ~/dev
  // while the directory it names does not.
  it('refuses a symlink inside ~/dev that points outside it', async () => {
    symlinkSync(join(home, '.ssh'), join(home, 'dev', 'looks-normal'));
    const { resolveRepoPath } = await loadDev();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveRepoPath('looks-normal')).toBeNull();
  });

  it('says why it refused', async () => {
    const { resolveRepoPath } = await loadDev();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    resolveRepoPath('../.ssh');

    expect(String(warn.mock.calls[0]?.[0])).toMatch(/outside ~\/dev/);
  });

  it('returns null for a name that does not exist', async () => {
    const { resolveRepoPath } = await loadDev();
    expect(resolveRepoPath('NoSuchRepo')).toBeNull();
  });

  // An explicitly absolute path is a separate, deliberate branch — the
  // containment rule is about a bare name being joined onto ~/dev.
  it('still allows an explicit absolute path', async () => {
    const { resolveRepoPath } = await loadDev();
    expect(resolveRepoPath(join(home, 'elsewhere'))).toBe(join(home, 'elsewhere'));
  });
});
