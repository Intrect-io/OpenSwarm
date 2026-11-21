import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  formatStrandedBranchesSummary, registerStrandedBranchesCommand, runStrandedBranchesCommand,
  type StrandedBranchesDeps,
} from './strandedBranchesCommand.js';
import type { RunRecord } from '../automation/runLedger.js';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

function commit(repo: string, file: string): void {
  writeFileSync(join(repo, file), file);
  sh(repo, 'add', file);
  sh(repo, 'commit', '-q', '-m', file);
}

/** A bare remote plus a clone with three swarm branches: pushed, ahead-unpushed, and empty. */
function makeRepo(root: string, remoteName: string): string {
  const bare = join(root, 'remote.git');
  const seed = join(root, 'seed');
  sh(root, 'init', '-q', '--bare', '-b', 'main', bare);
  sh(root, 'init', '-q', '-b', 'main', seed);
  commit(seed, 'README');
  sh(seed, 'push', '-q', bare, 'main');
  const repo = join(root, 'clone');
  sh(root, 'clone', '-q', '-o', remoteName, bare, repo);
  sh(repo, 'checkout', '-q', '-b', 'swarm/AX-1-pushed');
  commit(repo, 'pushed.txt');
  sh(repo, 'push', '-q', remoteName, 'swarm/AX-1-pushed');
  sh(repo, 'checkout', '-q', '-b', 'swarm/AX-2-stranded', 'main');
  commit(repo, 'a.txt');
  commit(repo, 'b.txt');
  sh(repo, 'checkout', '-q', '-b', 'swarm/AX-3-empty', 'main');
  sh(repo, 'checkout', '-q', 'main');
  return repo;
}

/** Real git runner that records every argv it is given. */
function spyGit() {
  const calls: string[][] = [];
  const git = vi.fn(async (repoPath: string, ...args: string[]) => {
    calls.push(args);
    return execFileSync('git', ['-C', repoPath, ...args], { env: GIT_ENV, encoding: 'utf8' });
  });
  return { git, calls };
}

function ledgerWith(runs: Partial<RunRecord>[]) {
  return {
    listRuns: vi.fn(() => runs as RunRecord[]),
    close: vi.fn(),
  };
}

function assertReadOnly(calls: string[][]): void {
  for (const argv of calls) {
    expect(['fetch', 'push', 'pull', 'gh', 'remote', 'update-ref']).not.toContain(argv[0]);
    expect(argv[0] === 'branch' && argv.some((a) => a === '-D' || a === '-d' || a === '--delete')).toBe(false);
  }
  expect(calls.map((argv) => argv[0]).sort()).toEqual(
    expect.arrayContaining(['for-each-ref', 'ls-remote']),
  );
}

describe('stranded-branches', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'stranded-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); process.exitCode = undefined; });

  it('lists swarm branches with commits that are not on the remote', async () => {
    const repo = makeRepo(root, 'origin');
    const { git, calls } = spyGit();
    const ledger = ledgerWith([
      { issueId: 'uuid-2', identifier: 'AX-2', branchName: 'swarm/AX-2-stranded', state: 'NEEDS_HUMAN', projectPath: repo },
    ]);

    const summary = await runStrandedBranchesCommand({ path: repo }, { git, createLedger: () => ledger });

    expect(summary.baseRef).toBe('origin/main');
    expect(summary.originLookupFailed).toBe(false);
    expect(summary.pushed).toEqual(['swarm/AX-1-pushed']);
    expect(summary.empty).toEqual(['swarm/AX-3-empty']);
    expect(summary.stranded).toEqual([{
      branch: 'swarm/AX-2-stranded', ahead: 2, headSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      ledgerState: 'NEEDS_HUMAN', issueId: 'AX-2',
    }]);
    expect(ledger.close).toHaveBeenCalledOnce();
    expect(calls).toContainEqual(['ls-remote', '--heads', 'origin']);
    expect(calls.filter((argv) => argv[0] === 'ls-remote')).toHaveLength(1);
    assertReadOnly(calls);

    const text = formatStrandedBranchesSummary(summary);
    expect(text.split('\n')[0]).toBe('branches_with_commits=1 total_commits=2');
    expect(text).toContain('swarm/AX-2-stranded');
    expect(text).toContain('issue=AX-2');
    expect(text).toMatch(/origin\/main was not fetched; squash-merged branches deleted from the remote still appear/);
    expect(text).not.toContain('warning:');
  });

  it('treats every branch as not on the remote when the remote lookup fails', async () => {
    const repo = makeRepo(root, 'origin');
    const { git, calls } = spyGit();
    const lsRemoteHeads = vi.fn(async () => { throw new Error('network down'); });

    const summary = await runStrandedBranchesCommand(
      { path: repo }, { git, lsRemoteHeads, createLedger: () => undefined },
    );

    expect(lsRemoteHeads).toHaveBeenCalledWith(repo, 'origin');
    expect(summary.originLookupFailed).toBe(true);
    expect(summary.pushed).toEqual([]);
    expect(summary.empty).toEqual(['swarm/AX-3-empty']);
    expect(summary.stranded.map((row) => [row.branch, row.ahead])).toEqual([
      ['swarm/AX-1-pushed', 1], ['swarm/AX-2-stranded', 2],
    ]);
    const text = formatStrandedBranchesSummary(summary);
    expect(text.split('\n')[0]).toBe('branches_with_commits=2 total_commits=3');
    expect(text).toMatch(/warning: remote lookup .* failed; every branch was treated as not on the remote/);
    expect(calls.some((argv) => ['fetch', 'push'].includes(argv[0]))).toBe(false);
  });

  it('looks up the base remote from resolveBaseRef, not a hardcoded origin', async () => {
    const repo = makeRepo(root, 'unohee');
    const { git, calls } = spyGit();

    const summary = await runStrandedBranchesCommand({ path: repo }, { git, createLedger: () => undefined });

    expect(summary.baseRef).toBe('unohee/main');
    expect(calls).toContainEqual(['ls-remote', '--heads', 'unohee']);
    expect(calls.some((argv) => argv.includes('origin'))).toBe(false);
    expect(summary.pushed).toEqual(['swarm/AX-1-pushed']);
    expect(summary.stranded.map((row) => row.branch)).toEqual(['swarm/AX-2-stranded']);
    assertReadOnly(calls);
  });

  it('keeps the plain branch name when a tag shadows it', async () => {
    const repo = makeRepo(root, 'origin');
    sh(repo, 'tag', 'swarm/AX-1-pushed', 'main');
    sh(repo, 'tag', 'swarm/AX-2-stranded', 'main');
    const { git, calls } = spyGit();

    const summary = await runStrandedBranchesCommand({ path: repo }, { git, createLedger: () => undefined });

    expect(summary.pushed).toEqual(['swarm/AX-1-pushed']);
    expect(summary.stranded.map((row) => [row.branch, row.ahead])).toEqual([['swarm/AX-2-stranded', 2]]);
    expect(calls).toContainEqual(['rev-list', '--count', 'origin/main..refs/heads/swarm/AX-2-stranded']);
  });

  it('joins the newest same-repo run for a branch', async () => {
    const repo = makeRepo(root, 'origin');
    const { git } = spyGit();
    const ledger = ledgerWith([
      { issueId: 'u-old', identifier: 'AX-2', branchName: 'swarm/AX-2-stranded', state: 'FAILED', projectPath: repo },
      { issueId: 'u-new', identifier: 'AX-2b', branchName: 'swarm/AX-2-stranded', state: 'NEEDS_HUMAN', projectPath: repo },
      { issueId: 'u-other', identifier: 'ZZ-9', branchName: 'swarm/AX-2-stranded', state: 'DONE', projectPath: join(root, 'elsewhere') },
    ]);

    const summary = await runStrandedBranchesCommand({ path: repo }, { git, createLedger: () => ledger });

    expect(summary.stranded[0]).toMatchObject({ issueId: 'AX-2b', ledgerState: 'NEEDS_HUMAN' });
  });

  describe('CLI', () => {
    async function run(argv: string[], deps: StrandedBranchesDeps) {
      const out: string[] = [];
      const program = new Command().exitOverride();
      registerStrandedBranchesCommand(program, { ...deps, out: (line) => out.push(line) });
      await program.parseAsync(['node', 'openswarm', 'stranded-branches', ...argv]);
      return out;
    }

    it('prints the summary object with --json and exits 0 by default', async () => {
      const repo = makeRepo(root, 'origin');
      const { git, calls } = spyGit();
      const out = await run(['--path', repo, '--json'], { git, createLedger: () => undefined });

      const parsed = JSON.parse(out.join('\n'));
      expect(Object.keys(parsed).sort()).toEqual(['baseRef', 'empty', 'originLookupFailed', 'pushed', 'stranded']);
      expect(parsed.stranded).toEqual([{ branch: 'swarm/AX-2-stranded', ahead: 2, headSha: expect.any(String) }]);
      expect(process.exitCode).toBeUndefined();
      assertReadOnly(calls);
    });

    it('sets exit code 1 with --fail-on-stranded only when something is stranded', async () => {
      const repo = makeRepo(root, 'origin');
      const { git } = spyGit();
      const out = await run(['--path', repo, '--fail-on-stranded'], { git, createLedger: () => undefined });
      expect(out[0].split('\n')[0]).toBe('branches_with_commits=1 total_commits=2');
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      sh(repo, 'branch', '-q', '-D', 'swarm/AX-2-stranded');
      await run(['--path', repo, '--fail-on-stranded'], { git, createLedger: () => undefined });
      expect(process.exitCode).toBeUndefined();
    });
  });
});
