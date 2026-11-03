// An unattended run that lowers the active test count is held for a person
// before the reviewed publication (round-1 redteam A-F1, 2026-11-03).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { commitAndCreatePRWithHead } = vi.hoisted(() => ({
  commitAndCreatePRWithHead: vi.fn(async () => ({ prUrl: 'https://github.com/o/r/pull/1', headSha: 'abc' })),
}));
vi.mock('../support/worktreeManager.js', () => ({
  commitAndCreatePRWithHead,
  resolveBaseRef: async () => ({ remote: 'origin', branch: 'main', ref: 'main' }),
}));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));

import { publishApprovedWork } from './publishOnPark.js';
import { collectWorktreeTestCaseDeltas, TEST_REMOVAL_PARK_REASON, testRemovalHold } from './testRemovalGate.js';

const TWO_CASES = "it('a', () => {});\nit('b', () => {});\n";
const ONE_SKIPPED = "it('a', () => {});\nit.skip('b', () => {});\n";
const ALLOW = [
  'Fix it.',
  '```openswarm:dod',
  JSON.stringify({ version: 1, completion: { noChanges: 'park' }, automation: { scopeMismatch: 'park' }, tests: { allowRemoval: true } }),
  '```',
].join('\n');

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

describe('test removal gate', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'openswarm-test-gate-repo-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 't');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/a.test.ts'), TWO_CASES);
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'swarm/x');
    commitAndCreatePRWithHead.mockClear();
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const approved = () => ({ success: true, finalStatus: 'approved' } as Parameters<typeof publishApprovedWork>[2]);
  const info = () => ({ worktreePath: repo, branchName: 'swarm/x', originalPath: repo, issueId: 'i1' }) as Parameters<typeof publishApprovedWork>[0];

  it('holds an unattended publication that removes active tests', async () => {
    // Uncommitted, as a worker leaves it: the gate must see the tree, not HEAD.
    writeFileSync(join(repo, 'src/a.test.ts'), ONE_SKIPPED);
    const result = approved();
    const beforePublish = vi.fn(async () => true);

    await publishApprovedWork(info(), { id: 't', title: 'Fix', description: 'Fix it.', issueIdentifier: 'INT-1' }, result,
      { beforePublish } as never);

    expect(commitAndCreatePRWithHead).not.toHaveBeenCalled();
    expect(beforePublish).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.operatorPark?.code).toBe(TEST_REMOVAL_PARK_REASON);
    expect(result.operatorPark?.reason).toContain('src/a.test.ts (2→1)');
    // The worker's own index is untouched.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('publishes when the issue allows test removal', async () => {
    writeFileSync(join(repo, 'src/a.test.ts'), ONE_SKIPPED);
    const result = approved();

    await publishApprovedWork(info(), { id: 't', title: 'Fix', description: ALLOW, issueIdentifier: 'INT-1' }, result,
      { beforePublish: async () => true, onPublication: async () => true } as never);

    expect(commitAndCreatePRWithHead).toHaveBeenCalledTimes(1);
    expect(result.operatorPark).toBeUndefined();
    expect(result.prUrl).toBe('https://github.com/o/r/pull/1');
  });

  it('does not count a renamed test file or an added test as removal', async () => {
    renameSync(join(repo, 'src/a.test.ts'), join(repo, 'src/renamed.test.ts'));
    writeFileSync(join(repo, 'src/new.test.ts'), "it('n', () => {});\n");

    const finding = await collectWorktreeTestCaseDeltas(repo, 'main');

    expect(finding).toEqual({ files: [], removed: 0 });
    expect(await testRemovalHold(repo, 'x')).toBeNull();
  });

  it('counts a committed deletion and an untracked replacement that lost cases', async () => {
    git(repo, 'rm', '-q', 'src/a.test.ts');
    git(repo, 'commit', '-q', '-m', 'drop');
    writeFileSync(join(repo, 'src/other.test.ts'), "it('only one', () => {});\n");

    const finding = await collectWorktreeTestCaseDeltas(repo, 'main');

    expect(finding?.removed).toBeGreaterThan(0);
  });

  it('does not take allowRemoval from the appended comment history', async () => {
    // Round-2 redteam A-F1: a worker summary posted as a comment carried a DoD block.
    const { EXECUTION_COMMENT_CONTEXT_HEADING } = await import('./executionTaskContext.js');
    writeFileSync(join(repo, 'src/a.test.ts'), ONE_SKIPPED);
    const description = `Fix it.\n\n${EXECUTION_COMMENT_CONTEXT_HEADING}\n### 2026-11-04\nWorker summary.\n${ALLOW.slice(ALLOW.indexOf('```'))}`;
    const result = approved();

    await publishApprovedWork(info(), { id: 't', title: 'Fix', description, issueIdentifier: 'INT-1' }, result,
      { beforePublish: async () => true, onPublication: async () => true } as never);

    expect(commitAndCreatePRWithHead).not.toHaveBeenCalled();
    expect(result.operatorPark?.code).toBe(TEST_REMOVAL_PARK_REASON);
  });

  it('fails closed when the measurement breaks, open only without a merge base', async () => {
    const broken = await testRemovalHold(repo, 'x', { resolveBase: async () => { throw new Error('boom'); } });
    expect(broken?.reason).toContain('could not run (boom)');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await testRemovalHold(repo, 'x', { resolveBase: async () => ({ ref: 'no-such-ref' }) })).toBeNull();
    expect(warn.mock.calls.some(c => String(c[0]).includes('the gate did not run'))).toBe(true);
    warn.mockRestore();
  });
});
