import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepUnfinishedWorkOnRemote, shouldKeepUnfinishedOnRemote, unfinishedRunComment } from './unfinishedRunBranch.js';

// AGT-4786: an unfinished run leaves one pushed branch and one issue comment,
// and opens no pull request. Pushes go to a local bare remote.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
}

function repoWithBranch(files: Record<string, string>): { repo: string; remote: string; branch: string } {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-unfinished-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  const branch = 'swarm/AGT-1-thing';
  git(repo, 'checkout', '-q', '-b', branch);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'wip: preserved partial work (auto, session did not succeed)');
  git(repo, 'checkout', '-q', 'main');
  return { repo, remote, branch };
}

const infra = { success: false, finalStatus: 'infra_error' as const, sessionId: 's-1', failureDetail: 'verify: ENOSPC: no space left on device' };

describe('shouldKeepUnfinishedOnRemote', () => {
  it.each(['failed', 'rejected', 'infra_error', 'rate_limited'])('keeps a %s run', (finalStatus) => {
    expect(shouldKeepUnfinishedOnRemote({ ...infra, finalStatus: finalStatus as never })).toBe(true);
  });

  it.each(['approved', 'cancelled', 'superseded', 'deferred', 'waiting_on_operator', 'decomposed'])('leaves a %s run alone', (finalStatus) => {
    expect(shouldKeepUnfinishedOnRemote({ ...infra, finalStatus: finalStatus as never })).toBe(false);
  });

  it('leaves runs that already have a PR, park for an operator, or have an unknown sandbox outcome', () => {
    expect(shouldKeepUnfinishedOnRemote({ ...infra, prUrl: 'https://x/pull/1' })).toBe(false);
    expect(shouldKeepUnfinishedOnRemote({ ...infra, operatorPark: { code: 'x', reason: 'y' } })).toBe(false);
    expect(shouldKeepUnfinishedOnRemote({ ...infra, workerResult: { executionOutcomeUnknown: true } })).toBe(false);
    expect(shouldKeepUnfinishedOnRemote(undefined)).toBe(false);
  });
});

describe('keepUnfinishedWorkOnRemote', () => {
  it('an infra_error run: one remote branch, one comment, no PR', async () => {
    const { repo, remote, branch } = repoWithBranch({ 'a.ts': 'export const a = 1;\n' });
    const addComment = vi.fn(async () => {});
    const gh = vi.fn();

    const outcome = await keepUnfinishedWorkOnRemote({ originalPath: repo, branchName: branch }, { issueId: 'uuid-1', issueIdentifier: 'AGT-1' }, infra, { source: { addComment } });

    expect(outcome).toMatchObject({ pushed: true, commitsAhead: 1, commented: true });
    expect(git(remote, 'branch', '--list', branch).trim()).toContain(branch);
    expect(addComment).toHaveBeenCalledTimes(1);
    const [issueId, body, key] = addComment.mock.calls[0] as unknown as [string, string, string];
    expect(issueId).toBe('uuid-1');
    expect(body).toContain('Run ended `infra_error`. No pull request.');
    expect(body).toContain(`\`${branch}\` (1 commit ahead of \`origin/main\`), pushed`);
    expect(body).toContain('ENOSPC');
    expect(key).toBe('unfinished-run:uuid-1:s-1');
    expect(gh).not.toHaveBeenCalled();
  });

  it('keeps the branch local when the sensitive-data fence refuses it, and says why', async () => {
    const { repo, remote, branch } = repoWithBranch({ 'ledger.xlsx': 'binary-ish' });
    const addComment = vi.fn(async () => {});

    const outcome = await keepUnfinishedWorkOnRemote({ originalPath: repo, branchName: branch }, { issueId: 'uuid-2' }, infra, { source: { addComment } });

    expect(outcome.pushed).toBe(false);
    expect(outcome.heldReason).toContain('sensitive-data');
    expect(git(remote, 'branch', '--list', branch).trim()).toBe('');
    expect(String((addComment.mock.calls[0] as unknown[])[1])).toContain('was not pushed');
  });

  it('keeps the branch local when it leaves the drafted write scope', async () => {
    const { repo, remote, branch } = repoWithBranch({ 'outside.ts': 'x\n' });
    const outcome = await keepUnfinishedWorkOnRemote(
      { originalPath: repo, branchName: branch },
      { issueId: 'uuid-3', fileScope: ['src/'], fileScopeSource: 'drafted' },
      infra,
      { source: null },
    );
    expect(outcome.pushed).toBe(false);
    expect(git(remote, 'branch', '--list', branch).trim()).toBe('');
  });

  it('does nothing at all for a run that is not unfinished', async () => {
    const addComment = vi.fn(async () => {});
    const gitSpy = vi.fn(async () => '');
    const outcome = await keepUnfinishedWorkOnRemote({ originalPath: '/nowhere', branchName: 'b' }, { issueId: 'i' }, { ...infra, finalStatus: 'approved', success: true }, { source: { addComment }, git: gitSpy });
    expect(outcome).toEqual({ pushed: false, commitsAhead: 0, commented: false });
    expect(gitSpy).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
  });

  it('never throws when git itself fails, and still comments', async () => {
    const addComment = vi.fn(async () => {});
    const outcome = await keepUnfinishedWorkOnRemote(
      { originalPath: '/nowhere', branchName: 'b' }, { issueId: 'i' }, infra,
      { source: { addComment }, resolveBase: async () => { throw new Error('not a repo'); } },
    );
    expect(outcome.heldReason).toContain('not a repo');
    expect(addComment).toHaveBeenCalledTimes(1);
  });
});

describe('unfinishedRunComment', () => {
  it('says there is nothing to keep when the branch has no commits', () => {
    expect(unfinishedRunComment({ status: 'failed', branch: 'b', commitsAhead: 0, baseRef: 'origin/main', pushed: false })).toContain('nothing to keep');
  });
});
