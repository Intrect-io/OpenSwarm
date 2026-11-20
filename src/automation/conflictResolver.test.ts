// ============================================
// OpenSwarm - conflict resolver worker fence (AGT-4815)
// ============================================
//
// The resolver's worker used to run with no sandbox at all: the daemon's
// privileges and open network, whatever autonomous.workerSandbox said. It now
// takes the configured fence, explicitly. git is scripted, nothing shells out.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  runWorker: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: (_file: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: { stdout: string }) => void) => {
    Promise.resolve(mocks.git(args)).then((stdout: string) => cb(null, { stdout }), (err: Error) => cb(err));
  },
}));
vi.mock('../agents/worker.js', () => ({ runWorker: mocks.runWorker }));
vi.mock('../github/github.js', () => ({ getPRBaseBranch: vi.fn(async () => 'main'), commentOnPR: vi.fn(async () => {}) }));
vi.mock('./prOwnership.js', () => ({ isOwnedPR: vi.fn(async () => true), getOwnedPRsForRepo: vi.fn(async () => []) }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../discord/index.js', () => ({ reportEvent: vi.fn(async () => {}) }));

const { ConflictResolver } = await import('./conflictResolver.js');

const config = { enabled: true, ownershipMode: 'all' as const, maxResolutionAttempts: 3, cascadeCheck: false };
const pr = { repo: 'o/r', number: 7, title: 'Feature', branch: 'feat/x', url: 'https://example/pr/7' } as never;

/** A merge that conflicts in one file, which the worker then resolves. */
function scriptConflictedMerge(): void {
  let resolved = false;
  mocks.git.mockImplementation(async (args: string[]) => {
    if (args[0] === 'rev-parse') return 'main\n';
    if (args[0] === 'merge' && args[1] !== '--abort') throw new Error('CONFLICT (content): src/a.ts');
    if (args[0] === 'diff' && args.includes('--diff-filter=U')) return resolved ? '' : 'src/a.ts\n';
    if (args[0] === 'diff') return 'src/a.ts\n';
    return '';
  });
  mocks.runWorker.mockImplementation(async () => {
    resolved = true;
    return { success: true, summary: 'resolved', filesChanged: ['src/a.ts'], commands: [], output: '' };
  });
}

beforeEach(() => {
  mocks.git.mockReset();
  mocks.runWorker.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('ConflictResolver worker fence (AGT-4815)', () => {
  it.each(['on', 'off'] as const)('runs the resolving worker under workerSandbox %s', async (mode) => {
    scriptConflictedMerge();
    const resolver = new ConflictResolver(config, mode);

    expect(await resolver.resolve(pr, '/repo')).toBe(true);
    expect(mocks.runWorker).toHaveBeenCalledTimes(1);
    expect(mocks.runWorker.mock.calls[0][0]).toMatchObject({ sandbox: mode, projectPath: '/repo' });
    // The resolver, not the worker, commits and pushes the merge.
    const verbs = mocks.git.mock.calls.map(([args]) => (args as string[])[0]);
    expect(verbs).toContain('commit');
    expect(verbs).toContain('push');
  });

  it('refuses to be built without an explicit workerSandbox', () => {
    expect(() => new ConflictResolver(config, undefined as never)).toThrow(/workerSandbox must be 'on' or 'off'/);
    expect(() => new ConflictResolver(config, 'yes' as never)).toThrow(/workerSandbox/);
  });
});
