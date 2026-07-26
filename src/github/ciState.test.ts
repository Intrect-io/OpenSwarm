// ============================================
// OpenSwarm - CI state persistence tests
// ============================================
//
// ci-state.json holds each repo's health timeline (brokenSince, lastReminder).
// Two independent callers write it — core/service.ts checkGitHubCI and
// automation/ciWorker.ts — with no lock between them, and loadCIState's
// fallback is an empty state. That combination is what makes the write's
// atomicity load-bearing: a reader that catches a half-written file silently
// resets every repo's history instead of reporting a problem.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let home: string;

/**
 * Load a fresh copy of github.js with homedir() pointed at a temp directory.
 * CI_STATE_PATH is computed at module load, so the mock has to be in place
 * before the import — hence resetModules + dynamic import per test.
 */
async function loadModule() {
  vi.resetModules();
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
  });
  return await import('./github.js');
}

const ciStatePath = () => resolve(home, '.openswarm', 'ci-state.json');

describe('CI state persistence', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'openswarm-cistate-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    vi.doUnmock('node:os');
    vi.restoreAllMocks();
  });

  it('round-trips state through save and load', async () => {
    const { saveCIState, loadCIState } = await loadModule();
    await saveCIState({
      repos: { 'owner/repo': { status: 'broken', brokenSince: '2026-07-01T00:00:00.000Z' } },
      updatedAt: 'ignored',
    } as never);

    const loaded = await loadCIState();
    expect(loaded.repos['owner/repo']).toMatchObject({ brokenSince: '2026-07-01T00:00:00.000Z' });
  });

  it('creates the .openswarm directory when it does not exist yet', async () => {
    const { saveCIState } = await loadModule();
    await saveCIState({ repos: {}, updatedAt: '' } as never);
    expect(statSync(ciStatePath()).isFile()).toBe(true);
  });

  // The observable difference between an in-place rewrite and write-temp+rename:
  // truncating in place keeps the inode, renaming installs a new one. A reader
  // holding the old inode therefore never sees a partially written file.
  it('replaces ci-state.json atomically rather than rewriting it in place', async () => {
    const { saveCIState } = await loadModule();
    await saveCIState({ repos: {}, updatedAt: '' } as never);
    const inodeBefore = statSync(ciStatePath()).ino;

    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`owner/repo-${i}`, { status: 'broken', brokenSince: '2026-07-01T00:00:00.000Z' }]),
    );
    await saveCIState({ repos: many, updatedAt: '' } as never);

    expect(statSync(ciStatePath()).ino).not.toBe(inodeBefore);
    expect(JSON.parse(readFileSync(ciStatePath(), 'utf-8')).repos['owner/repo-39']).toBeDefined();
  });

  it('returns empty state and stays quiet when the file has never been written', async () => {
    const { loadCIState } = await loadModule();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(loadCIState()).resolves.toMatchObject({ repos: {} });
    expect(warn).not.toHaveBeenCalled();
  });

  // A corrupt file and a missing file both end up as "empty state", but only one
  // of them means real history was just thrown away. Collapsing them into one
  // silent catch is how a wiped health timeline goes unnoticed.
  it('warns when the state file exists but cannot be parsed', async () => {
    const { loadCIState } = await loadModule();
    await mkdir(resolve(home, '.openswarm'), { recursive: true });
    writeFileSync(ciStatePath(), '{ "repos": { "owner/repo": ');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(loadCIState()).resolves.toMatchObject({ repos: {} });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/corrupt/i);
  });
});
