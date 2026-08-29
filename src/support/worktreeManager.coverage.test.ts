// Additional coverage for src/support/worktreeManager.ts.
//
// This file follows the exact conventions of worktreeManager.test.ts: real git
// operations against tmp-dir fixture repos (no fs/child_process mocking), a
// fake `gh` binary placed on PATH for GitHub-API-shaped calls, and cleanup of
// the tmp root in afterEach. It targets branches the companion file does not
// reach: pure-function edges, retry/resume error paths, the file-overlap
// report's real gh+git integration, and defensive fs-permission fallbacks.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBranchName,
  commitAndCreatePR,
  createWorktree,
  inspectWorktreeRecovery,
  preserveWorktree,
  pruneWorktrees,
  removePreservedWorktreeAt,
  resolveBaseRef,
  resolveSharedPaths,
} from './worktreeManager.js';

// registerOwnedPR persists to a REAL file under the user's home directory
// (~/.openswarm/pr-ownership.json) — its target path is resolved once at
// module-load time via node:os homedir(), so overriding process.env.HOME at
// test time has no effect on it. Mock it at the module boundary so exercising
// the "real github.com PR URL" branch in commitAndCreatePR can never write to
// the actual user's machine state, matching this file's real-git-ops-only
// convention for everything BUT this one unrelated side-effecting module.
vi.mock('../automation/prOwnership.js', () => ({
  registerOwnedPR: vi.fn().mockResolvedValue(undefined),
}));
import { registerOwnedPR } from '../automation/prOwnership.js';

describe('buildBranchName (pure)', () => {
  it('slugifies the title and joins it to the issue identifier', () => {
    expect(buildBranchName('INT-512', 'Add LLM tool interface')).toBe('swarm/INT-512-add-llm-tool-interface');
  });

  it('collapses non-alphanumeric runs into single dashes and strips leading/trailing dashes', () => {
    expect(buildBranchName('INT-1', '  Fix: (bug) #42!! ')).toBe('swarm/INT-1-fix-bug-42');
  });

  it('truncates the slug to 40 characters', () => {
    const longTitle = 'a'.repeat(80);
    const name = buildBranchName('INT-2', longTitle);
    const slug = name.replace('swarm/INT-2-', '');
    expect(slug.length).toBe(40);
    expect(slug).toBe('a'.repeat(40));
  });

  it('produces just the identifier with a trailing dash-stripped empty slug for an all-symbol title', () => {
    expect(buildBranchName('INT-3', '!!!')).toBe('swarm/INT-3-');
  });
});

describe('resolveWorktreePath escape check', () => {
  it('accepts a literal "..." issueId because it remains inside the worktree root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-escape-falsepos-'));
    const repo = join(root, 'repo');
    const originBare = join(root, 'origin.git');
    mkdirSync(repo, { recursive: true });
    try {
      execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
      execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
      execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
      writeFileSync(join(repo, 'app.py'), 'base\n');
      execFileSync('git', ['-C', repo, 'add', '-A']);
      execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'pipe' });
      execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', originBare]);
      execFileSync('git', ['-C', repo, 'push', 'origin', 'main'], { stdio: 'pipe' });

      const info = await createWorktree(repo, '...', 'swarm/dots-test');
      expect(info.worktreePath).toBe(resolve(repo, 'worktree', '...'));
      expect(existsSync(join(info.worktreePath, 'app.py'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveSharedPaths dedup (INT-2415)', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-shared-dedup-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('de-duplicates repeated entries in sandbox.sharedPaths', () => {
    mkdirSync(join(repo, 'db'), { recursive: true });
    const result = resolveSharedPaths(repo, { sandbox: { sharedPaths: ['db', 'db', 'db'] } });
    expect(result).toEqual(['db']);
  });
});

describe('resolveBaseRef on a directory with no git remote at all', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-baseref-noremote-'));
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to remote "origin" and branch "main" when `git remote` itself fails (not a repo)', async () => {
    // No `git init` at all — `git -C dir remote` fails outright, and the
    // main/master rev-parse --verify probes fail too. Exercises the last-resort
    // default at the bottom of resolveBaseRef (INT-2545).
    const notARepo = join(root, 'not-a-repo');
    mkdirSync(notARepo, { recursive: true });
    expect(await resolveBaseRef(notARepo)).toEqual({ remote: 'origin', branch: 'main', ref: 'origin/main' });
  });
});

describe('linkSharedPaths edge cases (INT-2415)', () => {
  let root: string;
  let repo: string;

  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-link-edge-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    try { git(repo, 'worktree', 'remove', '--force', join(repo, 'worktree', 'INT-1')); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to auto-detect (does not crash) when openswarm.json is malformed JSON', async () => {
    const originBare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', originBare);
    git(repo, 'push', 'origin', 'main');

    // Malformed config file at the repo root (openswarm.json unreadable).
    writeFileSync(join(repo, 'openswarm.json'), '{ this is not valid json');
    // Auto-detect candidate present, so it should still get linked despite the
    // config error (loadRepoMetadata throws, caught, meta stays null).
    mkdirSync(join(repo, 'node_modules', 'leftpad'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'leftpad', 'index.js'), 'module.exports = 1;\n');

    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-test');

    const wtNodeModules = join(info.worktreePath, 'node_modules');
    expect(lstatSync(wtNodeModules).isSymbolicLink()).toBe(true);
    expect(existsSync(join(wtNodeModules, 'leftpad', 'index.js'))).toBe(true);
  });

  it('does not clobber a tracked directory that shares a name with a configured shared path', async () => {
    const originBare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    // 'src' is a TRACKED directory — it will be checked out for real into the
    // fresh worktree by `git worktree add`.
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', originBare);
    git(repo, 'push', 'origin', 'main');

    // Opt 'src' into sandbox.sharedPaths — a misconfiguration, since it's
    // already a tracked dir, not a gitignored dependency.
    writeFileSync(join(repo, 'openswarm.json'), JSON.stringify({ schemaVersion: 1, sandbox: { sharedPaths: ['src'] } }));

    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-test');

    const wtSrc = join(info.worktreePath, 'src');
    // Real checked-out directory, never replaced by a symlink to the original.
    expect(lstatSync(wtSrc).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(wtSrc, 'index.ts'), 'utf8')).toBe('export const x = 1;\n');
  });
});

describe('createWorktree retry/resume error paths', () => {
  let root: string;
  let repo: string;
  let originBare: string;

  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-retry-'));
    repo = join(root, 'repo');
    originBare = join(root, 'origin.git');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'app.py'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', originBare);
    git(repo, 'push', 'origin', 'main');
  });

  afterEach(() => {
    try { git(repo, 'worktree', 'remove', '--force', join(repo, 'worktree', 'INT-1')); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('retains an unproven stray directory instead of deleting possible crash output', async () => {
    // Simulate a leftover directory that was never registered via `git worktree
    // add` (e.g. a half-finished manual cleanup). `git worktree remove` fails
    // against it ("is not a working tree"), which must fall back to a direct
    // rmSync instead of aborting worktree creation.
    const worktreePath = resolve(repo, 'worktree', 'INT-1');
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, 'stray.txt'), 'leftover');

    await expect(createWorktree(repo, 'INT-1', 'swarm/INT-1-test'))
      .rejects.toThrow(/requires reconciliation/i);
    expect(readFileSync(join(worktreePath, 'stray.txt'), 'utf8')).toBe('leftover');
  });

  // AGT-4053: this container assigns the daemon the same pid every restart,
  // so a marker from a dead prior generation makes processAppearsAlive hit
  // the *current* process's own pid and read "alive" forever. Age must be
  // able to reclassify it as orphaned even while the pid probe insists the
  // marker's owner is alive.
  it('reclassifies a very old active marker as orphaned even when its pid still appears alive (AGT-4053)', async () => {
    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-pid-reuse');
    const markerPath = join(
      repo, '.git', 'openswarm', 'active-worktrees', 'INT-1', `${info.activeMarkerToken}.json`,
    );
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    // ownerPid stays process.pid (genuinely alive right now) — simulating a
    // container that reused this same pid for a new, unrelated daemon.
    marker.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(markerPath, JSON.stringify(marker));

    await expect(inspectWorktreeRecovery(repo, 'INT-1', info.worktreePath)).resolves.toMatchObject({
      state: 'orphaned',
    });
  });

  it('honors OPENSWARM_ACTIVE_MARKER_ABANDON_MS for deployments with unusually long stage timeouts (AGT-4053)', async () => {
    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-abandon-override');
    const markerPath = join(
      repo, '.git', 'openswarm', 'active-worktrees', 'INT-1', `${info.activeMarkerToken}.json`,
    );
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    marker.createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h old — well under the 24h default
    writeFileSync(markerPath, JSON.stringify(marker));

    const prev = process.env.OPENSWARM_ACTIVE_MARKER_ABANDON_MS;
    process.env.OPENSWARM_ACTIVE_MARKER_ABANDON_MS = String(60 * 60 * 1000); // 1h override
    try {
      await expect(inspectWorktreeRecovery(repo, 'INT-1', info.worktreePath)).resolves.toMatchObject({
        state: 'orphaned',
      });
    } finally {
      if (prev === undefined) delete process.env.OPENSWARM_ACTIVE_MARKER_ABANDON_MS;
      else process.env.OPENSWARM_ACTIVE_MARKER_ABANDON_MS = prev;
    }
  });

  // The regression this fix must not introduce: `openswarm attach`, a manual
  // `openswarm run` and a second daemon are all "not this process", so a
  // differing owner id cannot be read as proof of death. Doing so would put
  // two owners on one worktree. (Caught by the commit-gate review.)
  it('respects a marker from another live OpenSwarm process even though its owner id differs (AGT-4067)', async () => {
    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-sibling-process');
    const markerPath = join(
      repo, '.git', 'openswarm', 'active-worktrees', 'INT-1', `${info.activeMarkerToken}.json`,
    );
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    // A different process that is genuinely running: our own parent. Its id
    // differs from ours and its marker predates nothing — it must be kept.
    marker.ownerInstanceId = 'sibling-process-00000000-0000-4000-8000-000000000000';
    marker.ownerPid = process.ppid;
    marker.createdAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    writeFileSync(markerPath, JSON.stringify(marker));

    await expect(inspectWorktreeRecovery(repo, 'INT-1', info.worktreePath)).resolves.toMatchObject({
      state: 'active_owner',
      marker: { ownerPid: process.ppid },
    });
  });

  // The live incident this was written for: the markers already on disk were
  // written before `ownerInstanceId` existed, so the boot comparison cannot
  // reach them. A pid is unique among live processes, which is proof enough —
  // a marker carrying our own pid that predates our start belongs to a process
  // that has since exited, whatever the pid table now says.
  it('abandons a marker that carries our pid but predates this process (AGT-4067)', async () => {
    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-legacy-prior-boot');
    const markerPath = join(
      repo, '.git', 'openswarm', 'active-worktrees', 'INT-1', `${info.activeMarkerToken}.json`,
    );
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    delete marker.ownerInstanceId; // written before the field existed
    expect(marker.ownerPid).toBe(process.pid);
    // Comfortably inside the 24h abandon window, so age alone still says live.
    marker.createdAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    writeFileSync(markerPath, JSON.stringify(marker));

    await expect(inspectWorktreeRecovery(repo, 'INT-1', info.worktreePath)).resolves.toMatchObject({
      state: 'orphaned',
    });
  });

  it('keeps a marker from this boot for the full window so a live stage cannot lose its worktree (AGT-4067)', async () => {
    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-this-boot');
    const markerPath = join(
      repo, '.git', 'openswarm', 'active-worktrees', 'INT-1', `${info.activeMarkerToken}.json`,
    );
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(marker.ownerInstanceId).toBeTruthy();
    // An hour in — long enough that shortening the abandon window (the unsafe
    // workaround this replaces) would expire it, but this boot wrote it, so a
    // long-running worker stage must keep its worktree.
    marker.createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(markerPath, JSON.stringify(marker));

    await expect(inspectWorktreeRecovery(repo, 'INT-1', info.worktreePath)).resolves.toMatchObject({
      state: 'active_owner',
      marker: { ownerInstanceId: marker.ownerInstanceId },
    });
  });

  it('falls back to the pid + age test for a legacy marker with no boot recorded (AGT-4067)', async () => {
    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-legacy-marker');
    const markerPath = join(
      repo, '.git', 'openswarm', 'active-worktrees', 'INT-1', `${info.activeMarkerToken}.json`,
    );
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    delete marker.ownerInstanceId; // written before this field existed
    writeFileSync(markerPath, JSON.stringify(marker));

    await expect(inspectWorktreeRecovery(repo, 'INT-1', info.worktreePath)).resolves.toMatchObject({
      state: 'active_owner',
    });
  });

  it('distinguishes a live owner, a dead owner, and a safely preserved worktree', async () => {
    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-recovery');
    await expect(inspectWorktreeRecovery(repo, 'INT-1', info.worktreePath)).resolves.toMatchObject({
      state: 'active_owner',
      marker: { ownerPid: process.pid },
    });

    expect(info.activeMarkerToken).toBeTruthy();
    const markerPath = join(
      repo,
      '.git',
      'openswarm',
      'active-worktrees',
      'INT-1',
      `${info.activeMarkerToken}.json`,
    );
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    marker.ownerPid = 2_147_483_647;
    writeFileSync(markerPath, JSON.stringify(marker));
    await expect(inspectWorktreeRecovery(repo, 'INT-1', info.worktreePath)).resolves.toMatchObject({ state: 'orphaned' });

    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');
    expect(await preserveWorktree(info, 'retryable failure')).toBe(true);
    await expect(inspectWorktreeRecovery(repo, 'INT-1', info.worktreePath)).resolves.toMatchObject({ state: 'preserved' });

    const resumed = await createWorktree(repo, 'INT-1', 'swarm/INT-1-recovery');
    expect(resumed.resumedTaskFiles).toEqual(['app.py']);
  });

  it('restores preserved WIP files when only the task branch remains', async () => {
    const branch = 'swarm/INT-1-branch-only';
    const info = await createWorktree(repo, 'INT-1', branch);
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\nbranch-only\n');
    expect(await preserveWorktree(info, 'retryable failure')).toBe(true);
    git(repo, 'worktree', 'remove', '--force', info.worktreePath);

    const resumed = await createWorktree(repo, 'INT-1', branch);

    expect(resumed.resumedTaskFiles).toEqual(['app.py']);
  });

  it('clears only its own active marker when a newer owner token exists', async () => {
    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-token-fence');
    expect(info.activeMarkerToken).toBeTruthy();
    const markerDir = join(repo, '.git', 'openswarm', 'active-worktrees', 'INT-1');
    const oldMarkerPath = join(markerDir, `${info.activeMarkerToken}.json`);
    const newToken = 'new-owner-token';
    const newMarkerPath = join(markerDir, `${newToken}.json`);
    writeFileSync(newMarkerPath, JSON.stringify({
      issueId: 'INT-1',
      branchName: info.branchName,
      worktreePath: info.worktreePath,
      originalPath: repo,
      ownerPid: process.pid,
      ownerToken: newToken,
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    }));
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');

    expect(await preserveWorktree(info, 'old owner settling')).toBe(true);

    expect(existsSync(oldMarkerPath)).toBe(false);
    expect(existsSync(newMarkerPath)).toBe(true);
    await expect(inspectWorktreeRecovery(repo, 'INT-1', info.worktreePath)).resolves.toMatchObject({
      state: 'active_owner',
      marker: { ownerToken: newToken },
    });
  });

  it('deletes a pre-existing branch of the same name on retry (no preserve marker)', async () => {
    const first = await createWorktree(repo, 'INT-1', 'swarm/dup-test');
    // Simulate an abnormal worktree-only removal (branch survives), e.g. an
    // external `git worktree remove` without going through removeWorktree().
    git(repo, 'worktree', 'remove', '--force', first.worktreePath);
    expect(git(repo, 'branch', '--list', 'swarm/dup-test').toString()).toContain('swarm/dup-test');

    const second = await createWorktree(repo, 'INT-1', 'swarm/dup-test');
    expect(existsSync(second.worktreePath)).toBe(true);
    expect(
      execFileSync('git', ['-C', second.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(),
    ).toBe('swarm/dup-test');
  });

  it('quarantines a preserved resume candidate whose .git linkage is broken', async () => {
    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');
    expect(await preserveWorktree(info, 'test failure')).toBe(true);

    // Corrupt the preserved tree's own .git pointer — `git status` and
    // `git rev-parse` both fail from inside it (caught, valid=false and
    // branch=''), so createWorktree correctly refuses to resume it and logs
    // "Preserved worktree invalid ... recreating".
    //
    writeFileSync(join(info.worktreePath, '.git'), 'gitdir: /nonexistent/broken\n');

    await expect(createWorktree(repo, 'INT-1', 'swarm/INT-1-test'))
      .rejects.toThrow(/requires reconciliation/i);
    expect(existsSync(join(info.worktreePath, '.openswarm-preserved'))).toBe(true);
    expect(readFileSync(join(info.worktreePath, 'app.py'), 'utf8')).toBe('base\npartial\n');
  });

  it('still creates the worktree from a cached remote-tracking ref when `git fetch` fails (remote unreachable)', async () => {
    // The remote becomes unreachable AFTER the initial push (network outage
    // analog). The already-fetched/pushed local origin/main ref is still
    // usable, so createWorktree must not hard-fail just because fetch failed.
    rmSync(originBare, { recursive: true, force: true });

    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-test');
    expect(existsSync(info.worktreePath)).toBe(true);
    expect(existsSync(join(info.worktreePath, 'app.py'))).toBe(true);
  });

  it('self-heals a fresh checkout of an LFS-tracked repo (git lfs pull succeeds)', async () => {
    execFileSync('git', ['lfs', 'install', '--local'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['lfs', 'track', '*.bin'], { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'asset.bin'), Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'add lfs asset');
    git(repo, 'config', 'lfs.allowincompletepush', 'true'); // known-gotcha default on this machine
    git(repo, 'push', 'origin', 'main');

    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-test');

    // Real binary content on disk, not a raw LFS pointer ("version https://git-lfs...").
    const content = readFileSync(join(info.worktreePath, 'asset.bin'));
    expect(content.length).toBe(256);
    expect(content.subarray(0, 4)).toEqual(Buffer.from([0, 1, 2, 3]));
  });
});

describe('preserveWorktree — worktree directory already gone when git status fails', () => {
  let root: string;
  let repo: string;

  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-preserve-gone-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    const originBare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'app.py'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', originBare);
    git(repo, 'push', 'origin', 'main');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns false without throwing when the worktree path no longer exists at all', async () => {
    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-test');
    // Directory removed out from under us (e.g. an external cleanup), so `git
    // status` fails with ENOENT (cwd missing) AND existsSync also reports gone.
    rmSync(info.worktreePath, { recursive: true, force: true });

    expect(await preserveWorktree(info, 'external removal')).toBe(false);
  });
});

describe('removePreservedWorktreeAt — foreign/stray worktree path', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-removepreserved-stray-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to a direct rmSync when `git worktree remove` fails (path never registered as a worktree)', async () => {
    const strayPath = resolve(repo, 'worktree', 'FAKE-1');
    mkdirSync(strayPath, { recursive: true });
    writeFileSync(join(strayPath, 'x.txt'), 'x');

    await removePreservedWorktreeAt(strayPath);

    expect(existsSync(strayPath)).toBe(false);
  });
});

describe('pruneWorktrees (INT-1810 R4 / INT-2503 / INT-2506)', () => {
  let root: string;
  let repo: string;
  let originBare: string;

  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  beforeEach(() => {
    // realpathSync: `pruneWorktrees` string-prefix-matches `git worktree list
    // --porcelain` output (which git reports with symlinks resolved) against
    // `${repoPath}/worktree/`. On macOS, tmpdir() lives under a symlinked
    // /var -> /private/var, so an unresolved repoPath would never match any
    // of git's reported worktree paths and nothing would ever be identified
    // as prunable. Canonicalize up front so the two sides agree, exactly as
    // a caller would if it resolved its configured repo path once at startup.
    const rawRoot = mkdtempSync(join(tmpdir(), 'openswarm-prune-'));
    root = realpathSync(rawRoot);
    repo = join(root, 'repo');
    originBare = join(root, 'origin.git');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'app.py'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', originBare);
    git(repo, 'push', 'origin', 'main');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('only sweeps a proven orphan, keeps active/unproven/fresh preserved, and sweeps expired preserved', async () => {
    const orphan = await createWorktree(repo, 'INT-1', 'swarm/INT-1-orphan');
    const active = await createWorktree(repo, 'INT-2', 'swarm/INT-2-active');
    const freshPreserved = await createWorktree(repo, 'INT-3', 'swarm/INT-3-fresh');
    const expiredPreserved = await createWorktree(repo, 'INT-4', 'swarm/INT-4-expired');

    writeFileSync(join(freshPreserved.worktreePath, 'app.py'), 'base\nfresh-wip\n');
    await preserveWorktree(freshPreserved, 'test failure');
    writeFileSync(join(expiredPreserved.worktreePath, 'app.py'), 'base\nexpired-wip\n');
    await preserveWorktree(expiredPreserved, 'test failure');
    // Backdate the expired one's marker past PRESERVE_MAX_AGE_MS (7 days).
    const expiredMarkerPath = join(expiredPreserved.worktreePath, '.openswarm-preserved');
    const marker = JSON.parse(readFileSync(expiredMarkerPath, 'utf8'));
    marker.at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(expiredMarkerPath, JSON.stringify(marker));

    // Durable proof and the active-owner marker are sampled at different times.
    // Make INT-1 a genuinely dead owner, while INT-2 deliberately appears in
    // the stale proven set with a live owner to exercise the deletion TOCTOU.
    const orphanActiveMarker = join(
      repo, '.git', 'openswarm', 'active-worktrees', 'INT-1', `${orphan.activeMarkerToken}.json`,
    );
    const orphanMarker = JSON.parse(readFileSync(orphanActiveMarker, 'utf8'));
    orphanMarker.ownerPid = 2_147_483_647;
    writeFileSync(orphanActiveMarker, JSON.stringify(orphanMarker));

    await pruneWorktrees(repo, new Set(), new Set([orphan.worktreePath, active.worktreePath]));

    expect(existsSync(orphan.worktreePath)).toBe(false); // swept — orphan, not active, not preserved
    expect(existsSync(active.worktreePath)).toBe(true); // kept — live marker defeats stale proven-orphan snapshot
    expect(existsSync(freshPreserved.worktreePath)).toBe(true); // kept — preserved and still fresh
    expect(existsSync(expiredPreserved.worktreePath)).toBe(false); // swept — preserved but expired

    // The expired tree's partial work was committed to its branch before removal (INT-2506).
    const show = execFileSync('git', ['-C', repo, 'show', 'swarm/INT-4-expired:app.py'], { encoding: 'utf8' });
    expect(show).toBe('base\nexpired-wip\n');
  });

  // AGT-4053: a container-reused pid makes processAppearsAlive report true
  // forever for a marker from a dead prior generation. A proven orphan must
  // still sweep once its marker is old enough, even though its pid probe
  // alone can never disprove the (unrelated, container-reused) live pid.
  it('sweeps a proven orphan whose stale marker still has a live-looking pid, once old enough (AGT-4053)', async () => {
    const orphan = await createWorktree(repo, 'INT-6', 'swarm/INT-6-pid-reuse');
    const markerPath = join(
      repo, '.git', 'openswarm', 'active-worktrees', 'INT-6', `${orphan.activeMarkerToken}.json`,
    );
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    marker.createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(markerPath, JSON.stringify(marker));

    await pruneWorktrees(repo, new Set(), new Set([orphan.worktreePath]));

    expect(existsSync(orphan.worktreePath)).toBe(false);
  });

  it('sweeps a proven orphan whose marker predates this process, well inside the age window (AGT-4067)', async () => {
    const orphan = await createWorktree(repo, 'INT-7', 'swarm/INT-7-prior-boot');
    const markerPath = join(
      repo, '.git', 'openswarm', 'active-worktrees', 'INT-7', `${orphan.activeMarkerToken}.json`,
    );
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    delete marker.ownerInstanceId; // as a crashed pre-AGT-4067 boot left it
    marker.createdAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    writeFileSync(markerPath, JSON.stringify(marker));

    await pruneWorktrees(repo, new Set(), new Set([orphan.worktreePath]));

    expect(existsSync(orphan.worktreePath)).toBe(false);
  });

  it('does not throw when the repo path is not a git repository at all (both internal sweeps fail cleanly)', async () => {
    const notARepo = join(root, 'not-a-repo');
    mkdirSync(notARepo, { recursive: true });
    await expect(pruneWorktrees(notARepo)).resolves.toBeUndefined();
  });

  it('retains an unreadable/malformed preserve marker for reconciliation', async () => {
    const info = await createWorktree(repo, 'INT-5', 'swarm/INT-5-malformed');
    // Bypass preserveWorktree entirely — drop a marker file that isn't valid JSON.
    writeFileSync(join(info.worktreePath, '.openswarm-preserved'), '{ not json');

    await pruneWorktrees(repo);

    expect(existsSync(info.worktreePath)).toBe(true);
  });

  it('logs a warning but does not throw when the orphan sweep itself fails (broken worktree .git linkage)', async () => {
    const info = await createWorktree(repo, 'INT-6', 'swarm/INT-6-broken-sweep');
    // No preserve marker — this is a plain orphan candidate. Break its .git
    // pointer so `git worktree remove --force` fails validation during the
    // sweep (same mechanism as the createWorktree retry tests above).
    writeFileSync(join(info.worktreePath, '.git'), 'gitdir: /nonexistent/broken\n');

    await expect(pruneWorktrees(repo)).resolves.toBeUndefined();
    // The sweep's `.catch` only warns — it does not fall back to rmSync, so
    // the broken worktree directory is left in place rather than silently lost.
    expect(existsSync(info.worktreePath)).toBe(true);
  });
});

describe('collectActiveScopes / buildFileOverlapSection real gh+git integration (INT-2392 / INT-2421)', () => {
  let root: string;
  let repo: string;
  let originBare: string;

  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  function fakeGh(script: string): string {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh-args.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n${script}\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    return ghLog;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-overlap-integration-'));
    repo = join(root, 'repo');
    originBare = join(root, 'origin.git');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', originBare);
    git(repo, 'push', 'origin', 'main');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('surfaces overlap from an open PR and an active swarm/* branch, tolerates a broken PR diff, and skips self/oid-less merged PRs', async () => {
    const selfBranch = 'swarm/INT-1-test';
    const info = await createWorktree(repo, 'INT-1', selfBranch);

    // Simulate a legacy preserved branch created before runtime markers were
    // excluded from WIP commits. Publication must remove this control file.
    writeFileSync(join(info.worktreePath, '.openswarm-preserved'), '{"legacy":true}\n');
    git(info.worktreePath, 'add', '.openswarm-preserved');
    git(info.worktreePath, 'commit', '-m', 'wip: legacy tracked runtime marker');

    // Another worker's swarm/* branch, pushed via a separate clone (no PR of
    // its own yet) — touches otherfile.py.
    const otherClone = join(root, 'other-clone');
    execFileSync('git', ['clone', originBare, otherClone], { stdio: 'pipe' });
    git(otherClone, 'config', 'user.email', 'test@example.com');
    git(otherClone, 'config', 'user.name', 'Test');
    git(otherClone, 'config', 'commit.gpgsign', 'false');
    git(otherClone, 'checkout', '-b', 'swarm/other-branch');
    writeFileSync(join(otherClone, 'otherfile.py'), 'shared work\n');
    git(otherClone, 'add', '-A');
    git(otherClone, 'commit', '-m', 'other worker wip');
    git(otherClone, 'push', 'origin', 'swarm/other-branch');
    git(repo, 'fetch', 'origin'); // make the remote-tracking ref visible from our repo/worktree

    // Our own branch touches BOTH shared.py (to overlap with the mocked open
    // PR #501) and otherfile.py (to overlap with the real swarm/other-branch).
    writeFileSync(join(info.worktreePath, 'shared.py'), 'our change\n');
    writeFileSync(join(info.worktreePath, 'otherfile.py'), 'our change too\n');

    const ghLog = fakeGh(`case "$*" in
  *"pr list --head"*) echo "";;
  *"in:body"*) echo "[]";;
  *"pr diff 501"*) echo "shared.py";;
  *"pr diff 502"*) exit 1;;
  *"pr list --state open"*) echo '[{"number":500,"headRefName":"${selfBranch}"},{"number":501,"headRefName":"feat/other-501"},{"number":502,"headRefName":"feat/broken-502"}]';;
  *"pr list --state merged"*) echo '[{"number":600,"headRefName":"${selfBranch}","mergeCommit":{"oid":"deadbeef"}},{"number":601,"headRefName":"feat/no-oid"}]';;
  *"pr create"*) echo "https://example.test/pull/999";;
esac`);

    const prevPath = process.env.PATH;
    process.env.PATH = `${join(root, 'bin')}:${prevPath}`;
    try {
      await commitAndCreatePR(info, 'Our change', 'INT-1', 'desc');
    } finally {
      process.env.PATH = prevPath;
    }

    expect(git(info.worktreePath, 'ls-files', '--', '.openswarm-preserved').toString().trim()).toBe('');
    expect(existsSync(join(info.worktreePath, '.openswarm-preserved'))).toBe(false);

    const calls = readFileSync(ghLog, 'utf8');
    // Overlap from the mocked open PR #501 (self PR #500 excluded, broken #502 tolerated).
    expect(calls).toContain('File overlap');
    expect(calls).toContain('PR #501 (feat/other-501)');
    expect(calls).toContain('shared.py');
    // Overlap from the real active swarm/* sibling branch.
    expect(calls).toContain('branch origin/swarm/other-branch');
    expect(calls).toContain('otherfile.py');
    // The broken PR #502 must not appear as a scope, and merged-PR staleness
    // must be silent (self-referencing #600, oid-less #601 both skipped).
    expect(calls).not.toContain('feat/broken-502');
    expect(calls).not.toContain('MERGED PR');

    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });

  it('skips the overlap report entirely when the branch has commits ahead but no changed files (empty commit)', async () => {
    const info = await createWorktree(repo, 'INT-2', 'swarm/INT-2-empty');
    // An empty commit: commitsAhead > 0, but the base...HEAD diff has no files,
    // so buildFileOverlapSection must short-circuit before ever calling gh/git
    // for other scopes.
    git(info.worktreePath, 'commit', '--allow-empty', '-m', 'empty wip commit');

    const ghLog = fakeGh(`case "$*" in
  *"pr list --head"*) echo "";;
  *"in:body"*) echo "[]";;
  *"pr list --state open"*) echo '[{"number":1,"headRefName":"feat/should-not-be-queried"}]';;
  *"pr create"*) echo "https://example.test/pull/999";;
esac`);

    const prevPath = process.env.PATH;
    process.env.PATH = `${join(root, 'bin')}:${prevPath}`;
    try {
      await commitAndCreatePR(info, 'Empty change', 'INT-2', 'desc');
    } finally {
      process.env.PATH = prevPath;
    }

    const calls = readFileSync(ghLog, 'utf8');
    expect(calls).toContain('pr create');
    // No self-diff files means collectActiveScopes must never even run —
    // the "open PR" list call it would have made never happens.
    expect(calls).not.toContain('pr list --state open');
    expect(calls).not.toContain('File overlap');

    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });
});

describe('commitAndCreatePR additional branches', () => {
  let root: string;
  let repo: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  function fakeGh(script: string): string {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh-args.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n${script}\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    return ghLog;
  }

  function setUpRepo(): string {
    const originBare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', originBare);
    git(repo, 'push', 'origin', 'main');
    return originBare;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-commitpr-extra-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('throws "no commits to create PR from" when the worktree has zero commits ahead of base', async () => {
    setUpRepo();
    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-test');
    // No changes at all — status is clean, nothing to commit, nothing ahead.
    await expect(commitAndCreatePR(info, 'title', 'INT-1', 'desc')).rejects.toThrow(/No commits to create PR from/);
    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });

  it('logs "nothing left to commit" and then throws when only an unsafe binary was staged (guard strips everything)', async () => {
    setUpRepo();
    const info = await createWorktree(repo, 'INT-2', 'swarm/INT-2-test');
    writeFileSync(join(info.worktreePath, 'dump.duckdb'), Buffer.from([1, 2, 3]));

    await expect(commitAndCreatePR(info, 'title', 'INT-2', 'desc')).rejects.toThrow(/No commits to create PR from/);
    // Untracked binary survives on disk — unstaged, not deleted, never committed.
    expect(existsSync(join(info.worktreePath, 'dump.duckdb'))).toBe(true);
    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });

  it('warns on a non-conventional commit message (empty title) but still commits and creates the PR', async () => {
    setUpRepo();
    const info = await createWorktree(repo, 'INT-3', 'swarm/INT-3-test');
    writeFileSync(join(info.worktreePath, 'src', 'index.ts'), 'export const x = 2;\n');

    const ghLog = fakeGh(`case "$*" in
  *"pr list --head"*) echo "";;
  *"in:body"*) echo "[]";;
  *"pr list --state open"*) echo "[]";;
  *"pr create"*) echo "https://example.test/pull/999";;
esac`);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prevPath = process.env.PATH;
    process.env.PATH = `${join(root, 'bin')}:${prevPath}`;
    let url: string;
    try {
      url = await commitAndCreatePR(info, '', 'INT-3', 'desc'); // empty title breaks conventional-commit format
    } finally {
      process.env.PATH = prevPath;
    }
    // Assert on the spy's recorded calls BEFORE mockRestore() — restoring
    // clears .mock.calls, which would make this assertion vacuously pass.
    expect(url).toBe('https://example.test/pull/999');
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('Commit format warning'))).toBe(true);
    warnSpy.mockRestore();

    expect(readFileSync(ghLog, 'utf8')).toContain('pr create');
    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });

  it('recovers when the "PR already exists?" gh lookup fails outright, still creating a new PR', async () => {
    setUpRepo();
    const info = await createWorktree(repo, 'INT-4', 'swarm/INT-4-test');
    writeFileSync(join(info.worktreePath, 'src', 'index.ts'), 'export const x = 2;\n');

    const ghLog = fakeGh(`case "$*" in
  *"pr list --head"*) exit 1;;
  *"in:body"*) echo "[]";;
  *"pr list --state open"*) echo "[]";;
  *"pr create"*) echo "https://example.test/pull/999";;
esac`);

    const prevPath = process.env.PATH;
    process.env.PATH = `${join(root, 'bin')}:${prevPath}`;
    try {
      const url = await commitAndCreatePR(info, 'title', 'INT-4', 'desc');
      expect(url).toBe('https://example.test/pull/999');
    } finally {
      process.env.PATH = prevPath;
    }

    expect(readFileSync(ghLog, 'utf8')).toContain('pr create');
    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });

  it('recovers a concurrent PR-create loser by re-reading the branch PR', async () => {
    setUpRepo();
    const info = await createWorktree(repo, 'INT-4-RACE', 'swarm/INT-4-race');
    writeFileSync(join(info.worktreePath, 'src', 'index.ts'), 'export const x = 2;\n');

    const lookupCount = join(root, 'lookup-count');
    const ghLog = fakeGh(`case "$*" in
  *"pr list --head"*)
    n=0; [ -f "${lookupCount}" ] && n=$(cat "${lookupCount}")
    n=$((n + 1)); printf '%s' "$n" > "${lookupCount}"
    if [ "$n" -eq 1 ]; then echo ""; else echo "https://github.com/acme/widgets/pull/77"; fi;;
  *"in:body"*) echo "[]";;
  *"pr list --state open"*) echo "[]";;
  *"pr create"*) exit 1;;
esac`);

    const prevPath = process.env.PATH;
    process.env.PATH = `${join(root, 'bin')}:${prevPath}`;
    try {
      await expect(commitAndCreatePR(info, 'title', 'INT-4-RACE', 'desc'))
        .resolves.toBe('https://github.com/acme/widgets/pull/77');
    } finally {
      process.env.PATH = prevPath;
    }

    const calls = readFileSync(ghLog, 'utf8');
    expect(calls.match(/pr list --head/g)).toHaveLength(2);
    expect(calls.match(/pr create/g)).toHaveLength(1);
    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });

  it('creates the PR normally (no draft) when the duplicate-issue-PR gh search fails outright', async () => {
    setUpRepo();
    const info = await createWorktree(repo, 'INT-5', 'swarm/INT-5-test');
    writeFileSync(join(info.worktreePath, 'src', 'index.ts'), 'export const x = 2;\n');

    const ghLog = fakeGh(`case "$*" in
  *"pr list --head"*) echo "";;
  *"in:body"*) exit 1;;
  *"pr list --state open"*) echo "[]";;
  *"pr create"*) echo "https://example.test/pull/999";;
esac`);

    const prevPath = process.env.PATH;
    process.env.PATH = `${join(root, 'bin')}:${prevPath}`;
    try {
      const url = await commitAndCreatePR(info, 'title', 'INT-5', 'desc');
      expect(url).toBe('https://example.test/pull/999');
    } finally {
      process.env.PATH = prevPath;
    }

    const calls = readFileSync(ghLog, 'utf8');
    const createCall = calls.split('\n').find((l) => l.startsWith('pr create'));
    expect(createCall).not.toContain('--draft');
    expect(calls).not.toContain('Possible duplicate work');
    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });

  it('registers PR ownership when gh returns a real github.com PR URL (registerOwnedPR module-mocked — see top-of-file note)', async () => {
    setUpRepo();
    const info = await createWorktree(repo, 'INT-6', 'swarm/INT-6-test');
    writeFileSync(join(info.worktreePath, 'src', 'index.ts'), 'export const x = 2;\n');

    fakeGh(`case "$*" in
  *"pr list --head"*) echo "";;
  *"in:body"*) echo "[]";;
  *"pr list --state open"*) echo "[]";;
  *"pr create"*) echo "https://github.com/acme/widgets/pull/42";;
esac`);

    const mockedRegister = vi.mocked(registerOwnedPR);
    mockedRegister.mockClear();
    const prevPath = process.env.PATH;
    process.env.PATH = `${join(root, 'bin')}:${prevPath}`;
    let url: string;
    try {
      url = await commitAndCreatePR(info, 'title', 'INT-6', 'desc');
    } finally {
      process.env.PATH = prevPath;
    }

    expect(url).toBe('https://github.com/acme/widgets/pull/42');
    expect(mockedRegister).toHaveBeenCalledTimes(1);
    expect(mockedRegister).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'acme/widgets', prNumber: 42, branch: 'swarm/INT-6-test', issueIdentifier: 'INT-6' }),
    );

    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });

  it('still returns the PR URL when registerOwnedPR itself rejects (best-effort, warning only)', async () => {
    setUpRepo();
    const info = await createWorktree(repo, 'INT-7', 'swarm/INT-7-test');
    writeFileSync(join(info.worktreePath, 'src', 'index.ts'), 'export const x = 2;\n');

    fakeGh(`case "$*" in
  *"pr list --head"*) echo "";;
  *"in:body"*) echo "[]";;
  *"pr list --state open"*) echo "[]";;
  *"pr create"*) echo "https://github.com/acme/widgets/pull/43";;
esac`);

    const mockedRegister = vi.mocked(registerOwnedPR);
    mockedRegister.mockRejectedValueOnce(new Error('disk full'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prevPath = process.env.PATH;
    process.env.PATH = `${join(root, 'bin')}:${prevPath}`;
    let url: string;
    try {
      url = await commitAndCreatePR(info, 'title', 'INT-7', 'desc');
    } finally {
      process.env.PATH = prevPath;
    }

    expect(url).toBe('https://github.com/acme/widgets/pull/43'); // PR creation itself must not fail
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('Failed to register PR ownership'))).toBe(true);
    warnSpy.mockRestore();

    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });
});
