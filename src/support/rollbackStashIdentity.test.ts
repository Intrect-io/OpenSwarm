// Audit 2026-07-26 (src/support) — `stash@{N}` is a POSITION, not an identity.
// Every `git stash push` inserts at 0 and shifts existing entries down, but the
// checkpoint captured its index at creation time and reused that literal string
// at pop time. Anything that stashed in between made it point at the wrong
// entry — and the `stash` rollback strategy pushes one ITSELF immediately before
// popping, so it reliably restored the `rollback-preserve-*` stash it had just
// created and left the checkpoint's stash orphaned. The user's preserved work
// came back as somebody else's changes.
//
// These tests drive the real rollback path against a real git repo, with the
// checkpoint store redirected to a temp HOME so they never touch ~/.openswarm.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => process.env.OSW_TEST_HOME ?? actual.homedir() };
});

let sandbox: string;
let repo: string;
let previousHome: string | undefined;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

/** Fresh module instance — CHECKPOINT_DIR is resolved once at import time. */
async function loadRollback() {
  vi.resetModules();
  return await import('./rollback.js');
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'osw-rollback-'));
  previousHome = process.env.OSW_TEST_HOME;
  process.env.OSW_TEST_HOME = join(sandbox, 'home');
  repo = join(sandbox, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  await writeFile(join(repo, 'tracked.txt'), 'committed\n', 'utf8');
  git('add', '-A');
  git('commit', '-m', 'base');
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.OSW_TEST_HOME;
  else process.env.OSW_TEST_HOME = previousHome;
  await rm(sandbox, { recursive: true, force: true });
});

describe('checkpoint stash identity', () => {
  it('restores the checkpoint stash after another stash shifted its index', async () => {
    const { createCheckpoint, rollbackToCheckpoint } = await loadRollback();

    await writeFile(join(repo, 'tracked.txt'), 'CHECKPOINT WORK\n', 'utf8');
    const checkpoint = await createCheckpoint('exec-1', repo);
    expect(checkpoint.stashId).toBeDefined();

    // Something else stashes afterwards — the checkpoint's entry is now one
    // position further down, so the index captured above is stale.
    await writeFile(join(repo, 'tracked.txt'), 'SOMEONE ELSE\n', 'utf8');
    execFileSync('git', ['-C', repo, 'stash', 'push', '-m', 'unrelated', '--include-untracked'], { stdio: 'pipe' });

    const result = await rollbackToCheckpoint(checkpoint.id, 'reset_hard');

    expect(result.success).toBe(true);
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('CHECKPOINT WORK\n');
  });

  it("the stash strategy does not restore the stash it just created itself", async () => {
    // The sharpest form: this strategy pushes `rollback-preserve-*` and then
    // pops. With a stored index of stash@{0} it popped its own fresh stash.
    const { createCheckpoint, rollbackToCheckpoint } = await loadRollback();

    await writeFile(join(repo, 'tracked.txt'), 'CHECKPOINT WORK\n', 'utf8');
    const checkpoint = await createCheckpoint('exec-2', repo);

    await writeFile(join(repo, 'tracked.txt'), 'UNCOMMITTED AT ROLLBACK TIME\n', 'utf8');
    const result = await rollbackToCheckpoint(checkpoint.id, 'stash');

    expect(result.success).toBe(true);
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('CHECKPOINT WORK\n');
  });

  it('reports failure instead of popping an arbitrary stash when the checkpoint stash is gone', async () => {
    // Failing loudly beats silently restoring whatever happens to sit at that
    // index — that is the data-corruption shape this whole fix is about.
    const { createCheckpoint, rollbackToCheckpoint } = await loadRollback();

    await writeFile(join(repo, 'tracked.txt'), 'CHECKPOINT WORK\n', 'utf8');
    const checkpoint = await createCheckpoint('exec-3', repo);

    execFileSync('git', ['-C', repo, 'stash', 'drop'], { stdio: 'pipe' });
    await writeFile(join(repo, 'decoy.txt'), 'decoy\n', 'utf8');
    execFileSync('git', ['-C', repo, 'stash', 'push', '-m', 'decoy', '--include-untracked'], { stdio: 'pipe' });

    const result = await rollbackToCheckpoint(checkpoint.id, 'reset_hard');

    expect(result.success).toBe(false);
    expect(result.action).toBe('stash_pop');
    // The decoy must still be stashed — nothing of it leaked into the worktree.
    expect(git('stash', 'list')).toContain('decoy');
  });

  it('leaves a checkpoint with no stash untouched', async () => {
    const { createCheckpoint, rollbackToCheckpoint } = await loadRollback();

    const checkpoint = await createCheckpoint('exec-4', repo); // clean tree
    expect(checkpoint.stashId).toBeUndefined();

    const result = await rollbackToCheckpoint(checkpoint.id, 'reset_hard');

    expect(result.success).toBe(true);
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('committed\n');
  });
});

describe('test harness', () => {
  it('redirects the checkpoint store away from the real home', () => {
    expect(homedir()).toBe(process.env.OSW_TEST_HOME);
    expect(homedir()).toContain('osw-rollback-');
  });
});
