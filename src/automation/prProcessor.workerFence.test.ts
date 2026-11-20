// ============================================
// OpenSwarm - PR remediation worker fence (AGT-4815)
// ============================================
//
// The CI-fix and review-feedback pipelines were built without a workerSandbox,
// so their worker ran unfenced with open network whatever the config said. This
// builds the remediation pipeline through the real factory and runs its worker
// stage to the adapter boundary (spawnCli is the only thing faked), so the
// assertion is on what the worker's shell actually gets.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnCli = vi.hoisted(() => vi.fn());
vi.mock('../adapters/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/index.js')>()),
  getAdapter: () => ({
    parseWorkerOutput: () => ({ success: true, summary: 'fixed', filesChanged: [], commands: [], output: 'ok' }),
  }),
  getDefaultAdapterName: () => 'gpt',
  probeAdapterAvailability: async () => true,
  spawnCli,
}));
vi.mock('../knowledge/index.js', () => ({ hasRepoSnapshot: () => true, scanAndCache: vi.fn(), analyzeIssue: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../memory/repoKnowledge.js', () => ({ recallRepoKnowledge: vi.fn().mockResolvedValue([]) }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../coordination/runCoordination.js', () => ({ publishCoordination: vi.fn(async () => {}) }));
// The processor's own collaborators are not on this path; stubbed to keep the module graph small.
vi.mock('../cli/reviewCommand.js', () => ({ runReviewCommand: vi.fn(), formatReviewOutput: vi.fn() }));
vi.mock('../cli/reviewHistory.js', () => ({ saveReviewHistory: vi.fn(), loadReviewHistory: vi.fn(), captureReviewFileHashes: vi.fn(), renderReviewHistoryContext: vi.fn() }));
vi.mock('../orchestration/taskScheduler.js', () => ({ getScheduler: vi.fn() }));
vi.mock('./integrationCoordinator.js', () => ({ IntegrationCoordinator: vi.fn() }));
vi.mock('./conflictResolver.js', () => ({ ConflictResolver: vi.fn() }));
vi.mock('../discord/index.js', () => ({ reportEvent: vi.fn(async () => undefined) }));

const { PRProcessor } = await import('./prProcessor.js');
const { initLocale } = await import('../locale/index.js');

let repo: string;

beforeEach(async () => {
  initLocale('en');
  repo = await mkdtemp(path.join(tmpdir(), 'openswarm-remediation-fence-'));
  await writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  spawnCli.mockReset();
  spawnCli.mockResolvedValue('raw');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
});

const roles = {
  worker: { enabled: true, model: 'w', timeoutMs: 0 },
  reviewer: { enabled: false, model: 'r', timeoutMs: 0 },
};

function remediationPipeline(workerSandbox: 'on' | 'off') {
  const processor = new PRProcessor({ repos: [], schedule: '0 0 1 1 *', maxIterations: 1, roles: roles as never, workerSandbox });
  return (processor as unknown as { createRemediationPipeline(): import('../agents/pairPipeline.js').PairPipeline }).createRemediationPipeline();
}

const task = () => ({
  id: 'pr-9', source: 'local' as const, title: 'Fix CI failures for PR #9', description: 'CI is red.',
  priority: 2, projectPath: '', createdAt: Date.now(),
});

describe('PR remediation pipeline fence (AGT-4815)', () => {
  it('builds the remediation pipeline with workerSandbox and forbidPublication', async () => {
    await remediationPipeline('on').run({ ...task(), projectPath: repo }, repo);

    expect(spawnCli).toHaveBeenCalled();
    // The worker's shell runs under the configured OS fence and refuses
    // git commit/push and gh pr: the processor pushes the branch itself.
    expect(spawnCli.mock.calls[0][1]).toMatchObject({ sandbox: 'on', forbidPublication: true });
  });

  it('carries an explicit off through to the worker as well', async () => {
    await remediationPipeline('off').run({ ...task(), projectPath: repo }, repo);
    expect(spawnCli.mock.calls[0][1]).toMatchObject({ sandbox: 'off', forbidPublication: true });
  });

  it('refuses to build the remediation pipeline when the processor was given no fence', () => {
    expect(() => remediationPipeline(undefined as never)).toThrow(/workerSandbox must be 'on' or 'off'/);
  });
});
