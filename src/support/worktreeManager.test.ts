import { isBranchForIssue, isSwarmBranch } from './branchNaming.js';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { isProofCapableSpace, processNamespaceId } from './processLiveness.js';
import {createWorktree, preserveWorktree, removePreservedWorktreeAt, removeWorktree, resolveSharedPaths, computeFileOverlaps, formatOverlapReport, findOpenPRFileOverlaps, resolveBaseRef, commitAndCreatePR, commitAndCreatePRWithHead, type WorktreeInfo } from './worktreeManager.js';

// The fast-path proof needs a REAL pid space, which only Linux can give (boot
// id + pid-namespace inode). Elsewhere the recorded id is a machine hint, good
// for ruling a record out but never for the proof — so these cases cannot arise
// there at all. Asserted on Linux in CI.
const itWithPidSpace = isProofCapableSpace(processNamespaceId()) ? it : it.skip;


describe('open PR planned-file preflight (INT-2568)', () => {
  it('reports only open PRs that overlap the draft file scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-pr-preflight-'));
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"pr list --state open"*) echo '[{"number":16,"url":"https://example.test/16","headRefName":"audit/a","files":[{"path":"src/subtraction.rs"},{"path":"README.md"}]},{"number":18,"url":"https://example.test/18","headRefName":"audit/b","files":[{"path":"src/deess/spectral.rs"}]}]';;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous}`;
    try {
      await expect(findOpenPRFileOverlaps(root, ['./src/subtraction.rs'])).resolves.toEqual([
        expect.objectContaining({ number: 16, files: ['src/subtraction.rs'] }),
      ]);
    } finally {
      process.env.PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // AGT-4095: publishOnPark opens a draft PR for a run that parked on an
  // operator question, so from the next heartbeat the task was colliding with
  // its own branch and superseding itself forever.
  it('does not report the dispatched issue own PR, but still reports another issue', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-pr-self-'));
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"pr list --state open"*) echo '[{"number":180,"url":"https://example.test/180","headRefName":"swarm/AX-858-a3-4-sheet-lead-id","files":[{"path":"src/jobs.py"}]},{"number":179,"url":"https://example.test/179","headRefName":"swarm/AX-863-a2-4","files":[{"path":"src/jobs.py"}]}]';;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous}`;
    try {
      // Only the sibling survives — its run still holds a lease, so its PR
      // still reserves.
      await expect(findOpenPRFileOverlaps(root, ['src/jobs.py'], {
        selfIssueIdentifier: 'AX-858', activeIssueIdentifiers: ['AX-863'],
      })).resolves.toEqual([expect.objectContaining({ number: 179 })]);

      // With no ledger to ask, every swarm PR keeps reserving — omitting the
      // accessor must not empty the gate.
      await expect(findOpenPRFileOverlaps(root, ['src/jobs.py'])).resolves.toHaveLength(2);

      // AGT-4097: an empty array is an assertion, not a missing value — it says
      // nothing is held, so no swarm PR reserves.
      await expect(findOpenPRFileOverlaps(root, ['src/jobs.py'], {
        selfIssueIdentifier: 'AX-858', activeIssueIdentifiers: [],
      })).resolves.toHaveLength(0);

      // Self-exclusion (AGT-4095) still holds on its own: with AX-858 unnamed
      // but its run held, its own PR would otherwise block it.
      await expect(findOpenPRFileOverlaps(root, ['src/jobs.py'], {
        activeIssueIdentifiers: ['AX-858', 'AX-863'],
      })).resolves.toHaveLength(2);
      await expect(findOpenPRFileOverlaps(root, ['src/jobs.py'], {
        selfIssueIdentifier: 'AX-858', activeIssueIdentifiers: ['AX-858', 'AX-863'],
      })).resolves.toEqual([expect.objectContaining({ number: 179 })]);
    } finally {
      process.env.PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('isBranchForIssue', () => {
  it('matches a branch whose slug no longer matches the current title', () => {
    // Live case: the stored branch is `swarm/AX-864-a2-slack` while the current
    // title now derives `swarm/AX-864-a2-6-slack`. An equality test would miss it.
    expect(isBranchForIssue('swarm/AX-864-a2-slack', 'AX-864')).toBe(true);
    expect(isBranchForIssue('swarm/AX-864-a2-6-slack', 'AX-864')).toBe(true);
  });

  it('does not let a shorter identifier match a longer sibling', () => {
    // The trailing delimiter is the whole point: without it `AX-86` would claim
    // AX-863's branch and silently suppress a real overlap.
    expect(isBranchForIssue('swarm/AX-863-a2-4', 'AX-86')).toBe(false);
    expect(isBranchForIssue('swarm/AX-863-a2-4', 'AX-863')).toBe(true);
  });

  it('accepts a bare branch with no slug', () => {
    expect(isBranchForIssue('swarm/AX-864', 'AX-864')).toBe(true);
  });

  it('rejects foreign branches and an empty identifier', () => {
    expect(isBranchForIssue('audit/a', 'AX-864')).toBe(false);
    expect(isBranchForIssue('heewonoh/cgf-answers-20260828', 'AX-864')).toBe(false);
    expect(isBranchForIssue('swarm/AX-864-a2', '')).toBe(false);
  });
});

describe('isSwarmBranch', () => {
  // AGT-4097: this decides whether "no active worker" is knowable at all. A
  // branch the daemon did not cut has no run to consult, so it keeps reserving.
  it('recognizes the daemon own namespace and nothing else', () => {
    expect(isSwarmBranch('swarm/AX-864-a2-slack')).toBe(true);
    expect(isSwarmBranch('swarm/')).toBe(true);
    expect(isSwarmBranch('heewonoh/cgf-answers-20260828')).toBe(false);
    expect(isSwarmBranch('swarming/AX-1')).toBe(false);
    expect(isSwarmBranch('feature/swarm/AX-1')).toBe(false);
    expect(isSwarmBranch('')).toBe(false);
  });
});

describe('worktreeManager path safety', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-worktree-manager-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects issue IDs that are not a single safe path segment', async () => {
    await expect(createWorktree(repo, '../outside', 'swarm/INT-1-test')).rejects.toThrow(/Invalid worktree issueId/);
  });

  it('refuses to remove a worktree path outside the managed worktree root', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'keep');

    const info: WorktreeInfo = {
      originalPath: repo,
      worktreePath: outside,
      branchName: 'swarm/INT-1-test',
      issueId: 'INT-1',
    };

    await expect(removeWorktree(info)).rejects.toThrow(/Refusing to remove unmanaged worktree path/);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });

  it('allows fallback removal only inside the managed worktree root', async () => {
    const managedPath = resolve(repo, 'worktree', 'INT-1');
    mkdirSync(managedPath, { recursive: true });
    writeFileSync(join(managedPath, 'remove.txt'), 'remove');

    const info: WorktreeInfo = {
      originalPath: repo,
      worktreePath: managedPath,
      branchName: 'swarm/INT-1-test',
      issueId: 'INT-1',
    };

    await removeWorktree(info);
    expect(existsSync(managedPath)).toBe(false);
  });
});

describe('resolveSharedPaths (INT-2415)', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-shared-paths-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('auto-detects node_modules and verification virtualenvs that exist at the repo root', () => {
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    mkdirSync(join(repo, '.venv-verify'), { recursive: true });
    mkdirSync(join(repo, '.venv'), { recursive: true });
    // venv is absent → excluded; only existing candidates are returned.
    expect(resolveSharedPaths(repo, null).sort()).toEqual(['.venv', '.venv-verify', 'node_modules']);
  });

  it('returns [] when no auto-detect candidates exist', () => {
    expect(resolveSharedPaths(repo)).toEqual([]);
  });

  it('uses sandbox.sharedPaths verbatim (existing only) and overrides auto-detect', () => {
    mkdirSync(join(repo, 'db'), { recursive: true });
    writeFileSync(join(repo, 'db', 'prod.db'), 'x');
    mkdirSync(join(repo, 'node_modules'), { recursive: true }); // present but NOT in config
    const result = resolveSharedPaths(repo, { sandbox: { sharedPaths: ['db', 'missing-dir'] } });
    // Only existing configured paths; node_modules is dropped because config takes over.
    expect(result).toEqual(['db']);
  });

  it('falls back to auto-detect when sharedPaths is an empty array', () => {
    mkdirSync(join(repo, 'venv'), { recursive: true });
    expect(resolveSharedPaths(repo, { sandbox: { sharedPaths: [] } })).toEqual(['venv']);
  });

  it('drops absolute and parent-escaping entries', () => {
    expect(resolveSharedPaths(repo, { sandbox: { sharedPaths: ['/etc', '../secrets', ''] } })).toEqual([]);
  });
});

describe('createWorktree shared-path symlinks (INT-2415)', () => {
  let root: string;
  let repo: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-worktree-link-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    // Best-effort worktree teardown before removing the tree.
    try { git(repo, 'worktree', 'remove', '--force', join(repo, 'worktree', 'INT-1')); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('symlinks the repo node_modules into the worktree without clobbering tracked dirs', async () => {
    const originBare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');

    // A tracked source dir (checked out into the worktree from origin/main).
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', originBare);
    git(repo, 'push', 'origin', 'main');

    // Gitignored dep present only in the original working tree (untracked).
    mkdirSync(join(repo, 'node_modules', 'leftpad'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'leftpad', 'index.js'), 'module.exports = 1;\n');

    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-test');

    // node_modules is a symlink pointing at the original repo's node_modules.
    const wtNodeModules = join(info.worktreePath, 'node_modules');
    expect(lstatSync(wtNodeModules).isSymbolicLink()).toBe(true);
    expect(realpathSync(wtNodeModules)).toBe(realpathSync(join(repo, 'node_modules')));
    // The shared dep is reachable through the link.
    expect(existsSync(join(wtNodeModules, 'leftpad', 'index.js'))).toBe(true);

    // The tracked dir is a real checked-out dir, never replaced by a symlink.
    const wtSrc = join(info.worktreePath, 'src');
    expect(existsSync(join(wtSrc, 'index.ts'))).toBe(true);
    expect(lstatSync(wtSrc).isSymbolicLink()).toBe(false);
  });
});

describe('preserveWorktree → createWorktree resume roundtrip (INT-2503)', () => {
  let root: string;
  let repo: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-worktree-preserve-'));
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
    try { git(repo, 'worktree', 'remove', '--force', join(repo, 'worktree', 'INT-9')); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('preserves a dirty failed worktree and resumes it with the partial work intact', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    // Failed session left partial work: a tracked edit + a new file.
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial-impl\n');
    writeFileSync(join(info.worktreePath, 'newmod.py'), 'wip\n');

    expect(await preserveWorktree(info, 'test failure')).toBe(true);
    expect(existsSync(join(info.worktreePath, '.openswarm-preserved'))).toBe(true);

    // Retry resumes the SAME worktree — partial work intact, marker consumed.
    const resumed = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    expect(resumed.worktreePath).toBe(info.worktreePath);
    expect(readFileSync(join(resumed.worktreePath, 'app.py'), 'utf8')).toBe('base\npartial-impl\n');
    expect(existsSync(join(resumed.worktreePath, 'newmod.py'))).toBe(true);
    expect(existsSync(join(resumed.worktreePath, '.openswarm-preserved'))).toBe(false);
  });

  it('reconciles newly provisioned shared paths when a preserved worktree resumes', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial-impl\n');
    expect(await preserveWorktree(info, 'waiting for runtime input')).toBe(true);

    writeFileSync(join(repo, '.env'), 'SERVICE_URL=https://example.invalid\n');
    writeFileSync(join(repo, 'openswarm.json'), JSON.stringify({
      schemaVersion: 1,
      sandbox: { sharedPaths: ['.env'] },
    }));

    const resumed = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    const linkedEnv = join(resumed.worktreePath, '.env');
    expect(lstatSync(linkedEnv).isSymbolicLink()).toBe(true);
    expect(realpathSync(linkedEnv)).toBe(realpathSync(join(repo, '.env')));
  });

  it('INT-2729: commits the dirty work to the branch so it survives dir removal', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial-impl\n');
    writeFileSync(join(info.worktreePath, 'newmod.py'), 'wip\n');

    expect(await preserveWorktree(info, 'session did not succeed')).toBe(true);

    // The work is now a reachable commit on the swarm branch — verifiable from the
    // main repo without the worktree dir. Simulate the manual cleanup that lost
    // STO-1351 and confirm the commit (and its content) is still recoverable.
    const log = git(repo, 'log', '--format=%s', 'swarm/INT-9-test').toString();
    expect(log).toContain('wip: preserved partial work (auto, session did not succeed)');
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', info.worktreePath], { stdio: 'pipe' });
    expect(existsSync(info.worktreePath)).toBe(false);
    expect(git(repo, 'show', 'swarm/INT-9-test:newmod.py').toString()).toBe('wip\n');
    expect(git(repo, 'show', 'swarm/INT-9-test:app.py').toString()).toBe('base\npartial-impl\n');
    // The internal preserve marker is control metadata, not user work — it must NOT
    // be committed into the recovered branch (would pollute history / later PRs).
    expect(() => git(repo, 'show', 'swarm/INT-9-test:.openswarm-preserved')).toThrow();
  });

  it('removes a clean worktree instead of preserving it', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    expect(await preserveWorktree(info, 'test failure')).toBe(false);
    expect(existsSync(info.worktreePath)).toBe(false);
  });

  it('does NOT crash when the preserve-marker write fails (ENOSPC/EACCES) — reports NOT preserved (INT-2521)', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial-impl\n'); // dirty work
    // A read-only worktree dir makes the marker writeFileSync throw — exactly what a
    // full disk (ENOSPC) did in production, where an unguarded write crashed the whole
    // daemon via executePipeline. preserveWorktree must swallow it and honestly report
    // NOT preserved (false): the marker is the only thing that would protect the tree
    // from the next createWorktree()/sweep, so it must never claim a preservation it
    // can't back. It also never leaves a marker behind.
    chmodSync(info.worktreePath, 0o555);
    try {
      await expect(preserveWorktree(info, 'disk full')).resolves.toBe(false);
      expect(existsSync(join(info.worktreePath, '.openswarm-preserved'))).toBe(false); // marker never written
    } finally {
      if (existsSync(info.worktreePath)) chmodSync(info.worktreePath, 0o755); // restore for cleanup
    }
  });

  it('PRESERVES (does not delete) when git status FAILS — cannot confirm clean (INT-2521)', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\nreal-partial-work\n');
    // Break the worktree's git linkage so `git status` errors (a lock / corruption
    // analog). The old `.catch(() => '')` treated that error as "clean" and DELETED
    // the tree — losing real partial work. It must now preserve.
    writeFileSync(join(info.worktreePath, '.git'), 'gitdir: /nonexistent/broken\n');

    expect(await preserveWorktree(info, 'test failure')).toBe(true);
    expect(existsSync(info.worktreePath)).toBe(true); // tree NOT deleted
    expect(existsSync(join(info.worktreePath, '.openswarm-preserved'))).toBe(true);
    expect(readFileSync(join(info.worktreePath, 'app.py'), 'utf8')).toBe('base\nreal-partial-work\n');
  });

  it('quarantines preserved work when the requested branch does not match', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\nstale-work\n');
    await preserveWorktree(info, 'test failure');

    // Task title changed → different branch. This is not proof that the old work
    // is disposable, so recovery must stop instead of force-deleting it.
    await expect(createWorktree(repo, 'INT-9', 'swarm/INT-9-renamed'))
      .rejects.toThrow(/requires reconciliation/i);
    expect(readFileSync(join(info.worktreePath, 'app.py'), 'utf8')).toBe('base\nstale-work\n');
  });
});

describe('file-overlap report (INT-2392)', () => {
  describe('computeFileOverlaps', () => {
    it('returns only scopes that share a file, with just the shared files', () => {
      const self = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
      const others = [
        { label: 'PR #206 (feat/x)', files: ['src/b.ts', 'src/z.ts'] },
        { label: 'PR #207 (feat/y)', files: ['src/q.ts'] }, // no overlap
        { label: 'branch origin/swarm/foo', files: ['src/a.ts', 'src/c.ts'] },
      ];
      const result = computeFileOverlaps(self, others);
      expect(result).toEqual([
        { label: 'PR #206 (feat/x)', files: ['src/b.ts'] },
        { label: 'branch origin/swarm/foo', files: ['src/a.ts', 'src/c.ts'] },
      ]);
    });

    it('returns [] when nothing overlaps', () => {
      expect(computeFileOverlaps(['a.ts'], [{ label: 'p', files: ['b.ts'] }])).toEqual([]);
    });

    it('returns [] for empty self', () => {
      expect(computeFileOverlaps([], [{ label: 'p', files: ['a.ts'] }])).toEqual([]);
    });
  });

  describe('formatOverlapReport', () => {
    it('returns empty string when there are no overlaps', () => {
      expect(formatOverlapReport([])).toBe('');
    });

    it('renders a markdown section listing each overlapping scope', () => {
      const section = formatOverlapReport([
        { label: 'PR #206 (feat/x)', files: ['src/b.ts'] },
      ]);
      expect(section).toContain('File overlap');
      expect(section).toContain('PR #206 (feat/x)');
      expect(section).toContain('`src/b.ts`');
      expect(section).toContain('INT-2388 #3');
    });

    it('truncates long file lists with a (+N more) suffix', () => {
      const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
      const section = formatOverlapReport([{ label: 'PR #1 (b)', files }]);
      expect(section).toContain('12 file(s)');
      expect(section).toContain('(+4 more)');
    });
  });
});

describe('removePreservedWorktreeAt (INT-2506)', () => {
  let root: string;
  let repo: string;

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-wt-lifecycle-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    const originBare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 't@t.com');
    git(repo, 'config', 'user.name', 'T');
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

  it('commits the partial work to the branch, then removes the tree', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');
    await preserveWorktree(info, 'stuck test');

    await removePreservedWorktreeAt(info.worktreePath);

    expect(existsSync(info.worktreePath)).toBe(false);
    // The partial work survives on the branch for human inspection.
    const show = execFileSync('git', ['-C', repo, 'show', 'swarm/INT-9-test:app.py'], { encoding: 'utf8' });
    expect(show).toBe('base\npartial\n');
  });

  it('does not apply a stale terminal cleanup after another owner resumed the tree', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');
    await preserveWorktree(info, 'retryable failure');

    const resumed = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    await removePreservedWorktreeAt(info.worktreePath);

    expect(existsSync(resumed.worktreePath)).toBe(true);
    expect(readFileSync(join(resumed.worktreePath, 'app.py'), 'utf8')).toBe('base\npartial\n');
    await removeWorktree(resumed);
  });

  it('fails closed while another connection owns the issue lifecycle lock', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');
    await preserveWorktree(info, 'retryable failure');
    const lockPath = join(repo, '.git', 'openswarm', 'worktree-lifecycle-locks', 'INT-9.db');
    const competingOwner = new Database(lockPath, { timeout: 0 });
    competingOwner.exec('BEGIN IMMEDIATE');
    try {
      await expect(removePreservedWorktreeAt(info.worktreePath)).rejects.toThrow(/lifecycle is busy/i);
      expect(existsSync(info.worktreePath)).toBe(true);
    } finally {
      competingOwner.exec('ROLLBACK');
      competingOwner.close();
    }

    await removePreservedWorktreeAt(info.worktreePath);
    expect(existsSync(info.worktreePath)).toBe(false);
  });

  // AGT-4067: the daemon calls this itself when a run concludes. A marker left
  // behind by a boot that crashed mid-run kept reading as live — pids repeat in
  // a container, so `processAppearsAlive` finds the recorded pid alive again as
  // something unrelated — and this site has no age check to eventually release
  // it. The daemon then skipped its own cleanup forever and leaked the tree.
  itWithPidSpace('cleans up when the only active marker predates this process (AGT-4067)', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');
    await preserveWorktree(info, 'daemon died mid-run');

    // Re-create the marker the crashed boot never got to clear: our own pid
    // (as a container hands back), written before this process started.
    const markerDir = join(repo, '.git', 'openswarm', 'active-worktrees', 'INT-9');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, 'crashed-boot-token.json'), JSON.stringify({
      issueId: 'INT-9',
      branchName: info.branchName,
      worktreePath: info.worktreePath,
      originalPath: repo,
      ownerPid: process.pid,
      ownerToken: 'crashed-boot-token',
      ownerNamespace: processNamespaceId(),
      createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    }));

    await removePreservedWorktreeAt(info.worktreePath);

    expect(existsSync(info.worktreePath)).toBe(false);
  });

  it('keeps a preserved tree whose marker names another pid space, dead-looking pid or not (AGT-4068)', async () => {
    // This site has no age escape, so a "not alive" answer here authorises
    // deletion outright. The pid is from another container's space, where our
    // local probe means nothing — the tree may still have a live owner.
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');
    await preserveWorktree(info, 'daemon died mid-run');

    const markerDir = join(repo, '.git', 'openswarm', 'active-worktrees', 'INT-9');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, 'foreign-space-token.json'), JSON.stringify({
      issueId: 'INT-9',
      branchName: info.branchName,
      worktreePath: info.worktreePath,
      originalPath: repo,
      ownerPid: 2_147_483_647, // certainly not alive HERE — but that says nothing there
      ownerToken: 'foreign-space-token',
      ownerNamespace: 'some-other-host:pid:[4026531999]',
      createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    }));

    await removePreservedWorktreeAt(info.worktreePath);

    expect(existsSync(info.worktreePath)).toBe(true);
  });

  it('no-ops on paths that are not managed worktrees', async () => {
    await removePreservedWorktreeAt(repo); // repo root — no /worktree/ segment
    expect(existsSync(repo)).toBe(true);
  });

  // The publish hook exists so a terminally stuck run's work reaches a PR
  // instead of sitting on a branch that was never pushed.
  it('runs the publish hook with the tree intact and every commit already made', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');
    await preserveWorktree(info, 'stuck test');

    const seen: { branchName: string; repoRoot: string; treeExists: boolean; clean: boolean }[] = [];
    await removePreservedWorktreeAt(info.worktreePath, async (ctx) => {
      seen.push({
        branchName: ctx.branchName,
        repoRoot: ctx.repoRoot,
        // Publication pushes from this directory, so it must still be there.
        treeExists: existsSync(ctx.worktreePath),
        // The pre-cleanup WIP commit runs first, so there is nothing left
        // uncommitted for `committedOnly: true` publication to miss.
        clean: execFileSync('git', ['-C', ctx.worktreePath, 'status', '--porcelain'], { encoding: 'utf8' }).trim() === '',
      });
    });

    expect(seen).toEqual([{
      branchName: 'swarm/INT-9-test',
      repoRoot: repo,
      treeExists: true,
      clean: true,
    }]);
    expect(existsSync(info.worktreePath)).toBe(false);
  });

  it('does not publish a tree a live owner resumed — the same check that blocks removal', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');
    await preserveWorktree(info, 'retryable failure');
    const resumed = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');

    const publish = vi.fn();
    await removePreservedWorktreeAt(info.worktreePath, publish);

    // Pushing here would publish a tree another worker is still editing.
    expect(publish).not.toHaveBeenCalled();
    await removeWorktree(resumed);
  });

  it('still removes the tree when publication fails — cleanup cannot depend on GitHub', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');
    await preserveWorktree(info, 'stuck test');

    // Throws synchronously: removal must survive a hook that never returns a
    // promise at all, not just a rejected one.
    await removePreservedWorktreeAt(info.worktreePath, () => {
      throw new Error('gh: could not reach github.com');
    });

    expect(existsSync(info.worktreePath)).toBe(false);
    // The work still survives on the branch, as it did before publication existed.
    expect(execFileSync('git', ['-C', repo, 'show', 'swarm/INT-9-test:app.py'], { encoding: 'utf8' }))
      .toBe('base\npartial\n');
  });

  // The pre-cleanup WIP commit runs no binary guard on purpose — unstaging
  // there would strip the file from the only copy that outlives the directory.
  // That was safe while the branch stayed local; publishing it is not.
  it('does not publish a branch carrying binary data, but still keeps it locally', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');
    writeFileSync(join(info.worktreePath, 'dump.parquet'), 'binary-ish\n');
    await preserveWorktree(info, 'stuck test');

    const publish = vi.fn();
    await removePreservedWorktreeAt(info.worktreePath, publish);

    expect(publish).not.toHaveBeenCalled();
    expect(existsSync(info.worktreePath)).toBe(false);
    // Local preservation is unchanged: both files survive on the branch.
    const tree = execFileSync('git', ['-C', repo, 'ls-tree', '--name-only', 'swarm/INT-9-test'], { encoding: 'utf8' });
    expect(tree).toContain('dump.parquet');
    expect(execFileSync('git', ['-C', repo, 'show', 'swarm/INT-9-test:app.py'], { encoding: 'utf8' }))
      .toBe('base\npartial\n');
  });

  it('publishes a branch whose files are all safe', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');
    await preserveWorktree(info, 'stuck test');

    const publish = vi.fn();
    await removePreservedWorktreeAt(info.worktreePath, publish);

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('skips publication on a detached HEAD rather than pushing the wrong branch', async () => {
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'app.py'), 'base\npartial\n');
    await preserveWorktree(info, 'stuck test');
    git(info.worktreePath, 'checkout', '--detach');

    const publish = vi.fn();
    await removePreservedWorktreeAt(info.worktreePath, publish);

    expect(publish).not.toHaveBeenCalled();
    expect(existsSync(info.worktreePath)).toBe(false);
  });
});

describe('resolveBaseRef / createWorktree on non-main-default repos (INT-2545)', () => {
  let root: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  // Build a repo whose origin default branch is `defaultBranch`, pushed to a bare
  // remote named `remoteName`. Returns the repo path.
  function makeRepo(name: string, defaultBranch: string, remoteName: string): string {
    const repo = join(root, name);
    const bare = join(root, `${name}.git`);
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', defaultBranch, bare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', defaultBranch, repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'app.py'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', remoteName, bare);
    git(repo, 'push', remoteName, defaultBranch);
    // Set <remote>/HEAD so symbolic-ref resolves (mirrors a normal clone).
    git(repo, 'remote', 'set-head', remoteName, defaultBranch);
    return repo;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-baseref-'));
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves origin/main, origin/master, and a non-origin remote', async () => {
    const mainRepo = makeRepo('mainrepo', 'main', 'origin');
    expect(await resolveBaseRef(mainRepo)).toEqual({ remote: 'origin', branch: 'main', ref: 'origin/main' });

    const masterRepo = makeRepo('masterrepo', 'master', 'origin');
    expect(await resolveBaseRef(masterRepo)).toEqual({ remote: 'origin', branch: 'master', ref: 'origin/master' });

    const forkRepo = makeRepo('forkrepo', 'main', 'unohee'); // remote not named origin (vega-agent case)
    expect(await resolveBaseRef(forkRepo)).toEqual({ remote: 'unohee', branch: 'main', ref: 'unohee/main' });
  });

  it('createWorktree succeeds on a master-default repo (was: fatal invalid reference origin/main)', async () => {
    const repo = makeRepo('masterrepo', 'master', 'origin');
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    expect(existsSync(info.worktreePath)).toBe(true);
    // Branched from origin/master — app.py from the base commit is present.
    expect(existsSync(join(info.worktreePath, 'app.py'))).toBe(true);
    expect(execFileSync('git', ['-C', info.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim())
      .toBe('swarm/INT-9-test');
    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });

  it('createWorktree succeeds on a repo whose remote is not named origin', async () => {
    const repo = makeRepo('forkrepo', 'main', 'unohee');
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    expect(existsSync(info.worktreePath)).toBe(true);
    expect(existsSync(join(info.worktreePath, 'app.py'))).toBe(true);
    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });

  it('committedOnly publishes committed work and leaves the working tree untouched (AGT-4076)', async () => {
    // The shape a parked run is in: one commit made, and dirty files the worker
    // was still holding when it stopped for the operator. The commit must ship;
    // the dirty files must stay dirty so the resume continues from the same place.
    const repo = makeRepo('parkrepo', 'main', 'origin');
    const bare = join(root, 'parkrepo.git');
    const info = await createWorktree(repo, 'INT-76', 'swarm/INT-76-park');
    writeFileSync(join(info.worktreePath, 'done.py'), 'finished work\n');
    git(info.worktreePath, 'add', 'done.py');
    git(info.worktreePath, 'commit', '-m', 'feat: finished part');
    writeFileSync(join(info.worktreePath, 'wip.py'), 'half-written\n');

    const bin = join(root, 'bin-park');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh-park.log');
    writeFileSync(join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\ncase "$*" in *"pr create"*) echo "https://example.test/park";; esac\n`);
    chmodSync(join(bin, 'gh'), 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      const publication = await commitAndCreatePRWithHead(
        info,
        'parked',
        'INT-76',
        'desc',
        { draft: true, committedOnly: true },
      );
      expect(publication).toEqual({
        prUrl: 'https://example.test/park',
        headSha: String(git(info.worktreePath, 'rev-parse', 'HEAD')).trim(),
      });
    } finally {
      process.env.PATH = prevPath;
    }

    // The committed work reached the remote.
    expect(execFileSync('git', ['-C', bare, 'branch', '--list', 'swarm/INT-76-park'], { encoding: 'utf8' }))
      .toContain('swarm/INT-76-park');
    // The dirty file was NOT committed — it is still an untracked change.
    expect(String(git(info.worktreePath, 'status', '--porcelain'))).toContain('wip.py');
    expect(String(git(info.worktreePath, 'log', '--oneline', '-1'))).toContain('finished part');
    // Draft, because nothing reviewed this.
    expect(readFileSync(ghLog, 'utf8')).toContain('--draft');
  });

  it('promotes a reused draft PR to ready when the reviewed path republishes (AGT-4076)', async () => {
    // The exact sequence the fifth gate round flagged: a parked run opens a
    // draft, the branch later passes review, and commitAndCreatePR reuses the
    // existing PR. Without promotion the approved work ships as a draft.
    const repo = makeRepo('promoterepo', 'main', 'origin');
    const info = await createWorktree(repo, 'INT-77', 'swarm/INT-77-promote');
    writeFileSync(join(info.worktreePath, 'done.py'), 'work\n');
    git(info.worktreePath, 'add', 'done.py');
    git(info.worktreePath, 'commit', '-m', 'feat: done');

    const bin = join(root, 'bin-promote');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh-promote.log');
    // `pr list` reports an existing PR; `pr view --json isDraft` says it is one.
    writeFileSync(join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n`
      + `case "$*" in\n`
      + `  *"pr list"*) echo "https://example.test/pull/5";;\n`
      + `  *"isDraft"*) echo "true";;\n`
      + `esac\n`);
    chmodSync(join(bin, 'gh'), 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      const url = await commitAndCreatePR(info, 'reviewed', 'INT-77', 'desc');
      expect(url).toBe('https://example.test/pull/5');
    } finally {
      process.env.PATH = prevPath;
    }
    expect(readFileSync(ghLog, 'utf8')).toContain('pr ready https://example.test/pull/5');
  });

  it('promotes the PR it loses a create race to, when the losing publish is reviewed (AGT-4076)', async () => {
    // `gh pr create` fails (the winner already made one), the fallback finds
    // that PR, and it is a draft because the winner was a parked run. A reviewed
    // publication must still end up open for review.
    const repo = makeRepo('racerepo', 'main', 'origin');
    const info = await createWorktree(repo, 'INT-81', 'swarm/INT-81-race');
    writeFileSync(join(info.worktreePath, 'done.py'), 'work\n');
    git(info.worktreePath, 'add', 'done.py');
    git(info.worktreePath, 'commit', '-m', 'feat: done');

    const bin = join(root, 'bin-race');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh-race.log');
    // First `pr list` (the pre-create check) finds nothing, so creation is tried;
    // creation fails; the fallback `pr list` then finds the winner's draft.
    const stateFile = join(root, 'race-state');
    writeFileSync(join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n`
      + `case "$*" in\n`
      + `  *"--search"*) echo '[]';;\n`
      + `  *"pr create"*) echo "already exists" >&2; exit 1;;\n`
      + `  *"isDraft"*) echo "true";;\n`
      + `  *"pr list"*) if [ -f "${stateFile}" ]; then echo "https://example.test/pull/9"; else touch "${stateFile}"; fi;;\n`
      + `esac\n`);
    chmodSync(join(bin, 'gh'), 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      const url = await commitAndCreatePR(info, 'reviewed', 'INT-81', 'desc');
      expect(url).toBe('https://example.test/pull/9');
    } finally {
      process.env.PATH = prevPath;
    }
    expect(readFileSync(ghLog, 'utf8')).toContain('pr ready https://example.test/pull/9');
  });

  it('keeps a reused PR draft while another branch also closes the issue (AGT-4076)', async () => {
    // A PR is opened draft when a duplicate implementation exists (INT-2544).
    // Promoting on the caller's `draft` option alone would defeat that guard.
    const repo = makeRepo('duprepo', 'main', 'origin');
    const info = await createWorktree(repo, 'INT-80', 'swarm/INT-80-dup');
    writeFileSync(join(info.worktreePath, 'done.py'), 'work\n');
    git(info.worktreePath, 'add', 'done.py');
    git(info.worktreePath, 'commit', '-m', 'feat: done');

    const bin = join(root, 'bin-dup');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh-dup.log');
    // `pr list --search` (the duplicate probe) reports a sibling PR on another branch.
    writeFileSync(join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n`
      + `case "$*" in\n`
      + `  *"--search"*) echo '[{"number":3,"url":"https://example.test/pull/3","headRefName":"swarm/other"}]';;\n`
      + `  *"pr list"*) echo "https://example.test/pull/8";;\n`
      + `  *"isDraft"*) echo "true";;\n`
      + `esac\n`);
    chmodSync(join(bin, 'gh'), 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      const url = await commitAndCreatePR(info, 'reviewed', 'INT-80', 'desc');
      expect(url).toBe('https://example.test/pull/8');
    } finally {
      process.env.PATH = prevPath;
    }
    expect(readFileSync(ghLog, 'utf8')).not.toContain('pr ready');
  });

  it('does not re-ready a PR that is already open for review (AGT-4076)', async () => {
    // `gh pr ready` on a non-draft PR fails, and the reviewed path treats a
    // publication failure as retryable infra_error — so a run that actually
    // succeeded would be marked broken. The isDraft check is what prevents that.
    const repo = makeRepo('readyrepo', 'main', 'origin');
    const info = await createWorktree(repo, 'INT-79', 'swarm/INT-79-ready');
    writeFileSync(join(info.worktreePath, 'done.py'), 'work\n');
    git(info.worktreePath, 'add', 'done.py');
    git(info.worktreePath, 'commit', '-m', 'feat: done');

    const bin = join(root, 'bin-ready');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh-ready.log');
    // Existing PR is NOT a draft, and `pr ready` fails the way real gh does.
    writeFileSync(join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n`
      + `case "$*" in\n`
      + `  *"pr list"*) echo "https://example.test/pull/7";;\n`
      + `  *"isDraft"*) echo "false";;\n`
      + `  *"pr ready"*) echo "not a draft" >&2; exit 1;;\n`
      + `esac\n`);
    chmodSync(join(bin, 'gh'), 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      const url = await commitAndCreatePR(info, 'reviewed', 'INT-79', 'desc');
      expect(url).toBe('https://example.test/pull/7');
    } finally {
      process.env.PATH = prevPath;
    }
    expect(readFileSync(ghLog, 'utf8')).not.toContain('pr ready');
  });

  it('leaves a reused PR alone when publishing as a draft (AGT-4076)', async () => {
    // The parked path must not promote: nothing has reviewed this work.
    const repo = makeRepo('nopromoterepo', 'main', 'origin');
    const info = await createWorktree(repo, 'INT-78', 'swarm/INT-78-nopromote');
    writeFileSync(join(info.worktreePath, 'done.py'), 'work\n');
    git(info.worktreePath, 'add', 'done.py');
    git(info.worktreePath, 'commit', '-m', 'feat: done');

    const bin = join(root, 'bin-nopromote');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh-nopromote.log');
    writeFileSync(join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n`
      + `case "$*" in\n`
      + `  *"pr list"*) echo "https://example.test/pull/6";;\n`
      + `  *"isDraft"*) echo "true";;\n`
      + `esac\n`);
    chmodSync(join(bin, 'gh'), 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      await commitAndCreatePR(info, 'parked', 'INT-78', 'desc', { draft: true, committedOnly: true });
    } finally {
      process.env.PATH = prevPath;
    }
    expect(readFileSync(ghLog, 'utf8')).not.toContain('pr ready');
  });

  it('commitAndCreatePR pushes to the RESOLVED remote and PRs against the resolved base (non-origin)', async () => {
    const repo = makeRepo('forkrepo', 'main', 'unohee');
    const bare = join(root, 'forkrepo.git');
    const info = await createWorktree(repo, 'INT-9', 'swarm/INT-9-test');
    writeFileSync(join(info.worktreePath, 'feature.py'), 'new work\n'); // a change to commit + PR

    // Fake `gh` on PATH: record its args, return a non-/pull/ URL so registerOwnedPR
    // (which parses github.com/owner/repo#/pull/N) is skipped — no state written.
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh-args.log');
    writeFileSync(join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\ncase "$*" in *"pr create"*) echo "https://example.test/created";; esac\n`);
    chmodSync(join(bin, 'gh'), 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      const url = await commitAndCreatePR(info, 'test title', 'INT-9', 'desc');
      expect(url).toBe('https://example.test/created');
    } finally {
      process.env.PATH = prevPath;
    }

    // The push landed on the NON-origin remote (had base ref stayed origin/main, the
    // commits-ahead count would be 0 and it would have bailed BEFORE pushing).
    expect(execFileSync('git', ['-C', bare, 'branch', '--list', 'swarm/INT-9-test'], { encoding: 'utf8' }))
      .toContain('swarm/INT-9-test');
    // gh pr create used the resolved base branch, not a hardcoded 'main'-that-happens-to-match.
    expect(readFileSync(ghLog, 'utf8')).toMatch(/pr create .*--base main/);

    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });
});

describe('unsafe binary staging guard (INT-2430)', () => {
  let root: string;
  let repo: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  function fakeGh(): void {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'),
      '#!/bin/sh\ncase "$*" in *"pr create"*) echo "https://example.test/created";; *"pr list"*) echo "[]";; esac\n');
    chmodSync(join(bin, 'gh'), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-binary-guard-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('strips a mis-staged .duckdb/.parquet binary from the commit but keeps the real source change', async () => {
    const originBare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');

    // A tracked binary data file, as if checked out via LFS smudge in the real repo.
    writeFileSync(join(repo, 'data.duckdb'), Buffer.from([0x01, 0x02, 0x03]));
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', originBare);
    git(repo, 'push', 'origin', 'main');

    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-test');

    // Simulate the filter-bypass mis-stage (INT-2430): the worker's `git status`
    // workaround made this untouched binary look "modified", so it edits it too.
    writeFileSync(join(info.worktreePath, 'data.duckdb'), Buffer.from([0x01, 0x02, 0x03, 0x04]));
    // A real, in-scope source change that must survive the guard.
    writeFileSync(join(info.worktreePath, 'src', 'index.ts'), 'export const x = 2;\n');
    // A new .parquet the worker also (mistakenly) added.
    writeFileSync(join(info.worktreePath, 'cache.parquet'), Buffer.from([0x05, 0x06]));

    const prevPath = process.env.PATH;
    fakeGh();
    try {
      await commitAndCreatePR(info, 'Test change', 'INT-1', 'desc');
    } finally {
      process.env.PATH = prevPath;
    }

    const committedFiles = git(info.worktreePath, 'diff', '--name-only', 'HEAD~1', 'HEAD').toString();
    expect(committedFiles).not.toContain('data.duckdb');
    expect(committedFiles).not.toContain('cache.parquet');
    expect(committedFiles).toContain('src/index.ts');

    // Unstaged, not deleted — still present on disk, just never committed.
    expect(existsSync(join(info.worktreePath, 'data.duckdb'))).toBe(true);
    expect(existsSync(join(info.worktreePath, 'cache.parquet'))).toBe(true);

    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });

  it('commits normally when no unsafe binary is staged', async () => {
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

    const info = await createWorktree(repo, 'INT-2', 'swarm/INT-2-test');
    writeFileSync(join(info.worktreePath, 'src', 'index.ts'), 'export const x = 2;\n');

    const prevPath = process.env.PATH;
    fakeGh();
    try {
      await commitAndCreatePR(info, 'Test change', 'INT-2', 'desc');
    } finally {
      process.env.PATH = prevPath;
    }

    const committedFiles = git(info.worktreePath, 'diff', '--name-only', 'HEAD~1', 'HEAD').toString();
    expect(committedFiles.trim()).toBe('src/index.ts');

    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });
});

describe('sibling merged-PR staleness warning (INT-2421)', () => {
  let root: string;
  let repo: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-stale-sibling-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("flags a merged PR touching the same file that this branch's history does not contain", async () => {
    const originBare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');

    writeFileSync(join(repo, 'watchlist.py'), 'def gate():\n    return True  # bug: soft-penalty escape hatch\n');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', originBare);
    git(repo, 'push', 'origin', 'main');

    // Our branch forks HERE — before the sibling fix below lands on main.
    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-test');

    // A sibling PR fixes watchlist.py and merges to main AFTER our fork point.
    git(repo, 'checkout', '-b', 'fix/sibling');
    writeFileSync(join(repo, 'watchlist.py'), 'def gate():\n    return False  # escape hatch removed\n');
    git(repo, 'commit', '-am', 'fix sibling bug');
    git(repo, 'checkout', 'main');
    git(repo, 'merge', '--no-ff', '-m', 'Merge fix/sibling', 'fix/sibling');
    git(repo, 'push', 'origin', 'main');
    const mergeCommitOid = git(repo, 'rev-parse', 'main').trim();

    // Our branch also touches watchlist.py — unaware of the sibling's fix, exactly
    // the shape of the real incident (both PRs touch the same gate function).
    writeFileSync(join(info.worktreePath, 'watchlist.py'), 'def gate():\n    return True  # raised threshold, escape hatch still present\n');
    writeFileSync(join(info.worktreePath, 'src', 'index.ts'), 'export const x = 2;\n');

    // Fake `gh`: no existing PR for our branch, no other open PRs, one merged PR
    // (#218) whose mergeCommit is the sibling fix above, and it touches watchlist.py.
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh-args.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "${ghLog}"
case "$*" in
  *"pr list --head"*) echo "";;
  *"pr list --state open"*) echo "[]";;
  *"pr list --state merged"*) echo '[{"number":218,"headRefName":"fix/sibling","mergeCommit":{"oid":"${mergeCommitOid}"}}]';;
  *"pr diff 218"*) echo "watchlist.py";;
  *"pr create"*) echo "https://example.test/created";;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      await commitAndCreatePR(info, 'Our change', 'INT-1', 'desc');
    } finally {
      process.env.PATH = prevPath;
    }

    // The fake gh script logs raw args ($*) verbatim, including any literal
    // newlines inside --body's value, so the PR body can span multiple lines
    // in the log file — check the whole log, not a single split('\n') line.
    const calls = readFileSync(ghLog, 'utf8');
    expect(calls).toContain('pr create');
    expect(calls).toContain('MERGED PR #218');
    expect(calls).toContain('watchlist.py');

    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });

  it('does not warn when the merged PR is already in this branch\'s history', async () => {
    const originBare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', originBare], { stdio: 'pipe' });
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');

    writeFileSync(join(repo, 'watchlist.py'), 'def gate():\n    return False\n');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', originBare);
    git(repo, 'push', 'origin', 'main');

    // Our branch forks AFTER the "sibling fix" is already on main.
    const info = await createWorktree(repo, 'INT-2', 'swarm/INT-2-test');
    const mergeCommitOid = git(repo, 'rev-parse', 'main').trim();
    writeFileSync(join(info.worktreePath, 'src', 'index.ts'), 'export const x = 2;\n');

    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh-args.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "${ghLog}"
case "$*" in
  *"pr list --head"*) echo "";;
  *"pr list --state open"*) echo "[]";;
  *"pr list --state merged"*) echo '[{"number":218,"headRefName":"fix/sibling","mergeCommit":{"oid":"${mergeCommitOid}"}}]';;
  *"pr diff 218"*) echo "watchlist.py";;
  *"pr create"*) echo "https://example.test/created";;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);

    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:${prevPath}`;
    try {
      await commitAndCreatePR(info, 'Our change', 'INT-2', 'desc');
    } finally {
      process.env.PATH = prevPath;
    }

    const calls = readFileSync(ghLog, 'utf8');
    expect(calls).toContain('pr create');
    expect(calls).not.toContain('MERGED PR');

    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });
});

describe('duplicate-issue-PR guard (INT-2544)', () => {
  let root: string;
  let repo: string;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });

  function setUpRepo(): void {
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
  }

  function fakeGh(script: string): string {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const ghLog = join(root, 'gh-args.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n${script}\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    return ghLog;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-dup-pr-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('opens as a draft with a warning when another PR already closes the same issue', async () => {
    setUpRepo();
    const info = await createWorktree(repo, 'INT-1', 'swarm/INT-1-test');
    writeFileSync(join(info.worktreePath, 'src', 'index.ts'), 'export const x = 2;\n');

    const ghLog = fakeGh(`case "$*" in
  *"pr list --head"*) echo "";;
  *"in:body"*) echo '[{"number":226,"url":"https://example.test/pull/226","headRefName":"swarm/other-branch"}]';;
  *"pr list --state open"*) echo "[]";;
  *"pr create"*) echo "https://example.test/pull/999";;
esac`);

    const prevPath = process.env.PATH;
    process.env.PATH = `${join(root, 'bin')}:${prevPath}`;
    try {
      await commitAndCreatePR(info, 'Our change', 'INT-1', 'desc');
    } finally {
      process.env.PATH = prevPath;
    }

    const calls = readFileSync(ghLog, 'utf8');
    expect(calls).toMatch(/pr create.*--draft/s);
    expect(calls).toContain('Possible duplicate work');
    expect(calls).toContain('https://example.test/pull/226');

    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });

  it('opens normally (no draft, no warning) when no other PR closes the issue', async () => {
    setUpRepo();
    const info = await createWorktree(repo, 'INT-2', 'swarm/INT-2-test');
    writeFileSync(join(info.worktreePath, 'src', 'index.ts'), 'export const x = 2;\n');

    const ghLog = fakeGh(`case "$*" in
  *"pr list --head"*) echo "";;
  *"in:body"*) echo "[]";;
  *"pr list --state open"*) echo "[]";;
  *"pr create"*) echo "https://example.test/pull/999";;
esac`);

    const prevPath = process.env.PATH;
    process.env.PATH = `${join(root, 'bin')}:${prevPath}`;
    try {
      await commitAndCreatePR(info, 'Our change', 'INT-2', 'desc');
    } finally {
      process.env.PATH = prevPath;
    }

    const calls = readFileSync(ghLog, 'utf8');
    const createCall = calls.split('\n').find((l) => l.startsWith('pr create'));
    expect(createCall).toBeTruthy();
    expect(createCall).not.toContain('--draft');
    expect(calls).not.toContain('Possible duplicate work');

    git(repo, 'worktree', 'remove', '--force', info.worktreePath);
  });
});
