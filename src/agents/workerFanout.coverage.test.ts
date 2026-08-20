// ============================================
// OpenSwarm - workerFanout.ts coverage top-up
// ============================================
//
// Companion to workerFanout.test.ts, which already exercises the "happy path"
// promotion scenarios (dirty-worktree seeding, rename/add/delete promotion).
// This file targets the branches that were still uncovered per `vitest run
// src/agents/workerFanout.test.ts --coverage`: the early bail-outs, the
// per-candidate error path, guard-driven ineligibility, promotion failure, and
// the shared-path copy/link helpers. Real git subprocesses are used (same
// convention as workerFanout.test.ts); only the LLM worker call (`runWorker`)
// and, for one scenario, `node:fs/promises#copyFile`, are mocked.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { constants, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkerOptions } from './worker.js';
import type { WorkerFanoutCandidateConfig } from '../core/types.js';

const runWorker = vi.fn();
vi.mock('./worker.js', async () => {
  const actual = await vi.importActual<typeof import('./worker.js')>('./worker.js');
  return { ...actual, runWorker };
});

// Controllable failure switch for the promotion-failure scenario. Every other
// fs/promises call passes straight through to the real implementation, so all
// the real-git-based scenarios in this file behave exactly as they would
// without this mock in place.
let copyFileShouldFail = false;
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: vi.fn(async (...args: Parameters<typeof actual.copyFile>) => {
      if (copyFileShouldFail) throw new Error('simulated disk failure during copy');
      return actual.copyFile(...args);
    }),
  };
});

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

const baseWorkerOptions = {
  projectPath: '',
  adapterName: 'codex-responses',
  model: 'gpt-5.4-mini',
  timeoutMs: 0,
} as unknown as WorkerOptions;

const cleanupDirs: string[] = [];
afterEach(async () => {
  copyFileShouldFail = false;
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('runWorkerFanout early bail-outs', () => {
  beforeEach(() => {
    runWorker.mockReset();
  });

  it('bails out with a fallback reason when fewer than two candidates are given', async () => {
    const { runWorkerFanout } = await import('./workerFanout.js');
    const result = await runWorkerFanout({
      projectPath: '/does/not/matter',
      baseWorkerOptions,
      candidates: [{ id: 'solo', adapter: 'codex-responses' }],
      concurrency: 1,
    });

    expect(result.candidates).toEqual([]);
    expect(result.fallbackReason).toBe('fan-out needs at least two candidates');
    expect(result.winner).toBeUndefined();
    expect(runWorker).not.toHaveBeenCalled();
  });

  it('reports no-eligible-candidate when every candidate errors out during sandbox setup', async () => {
    // A projectPath that is not a git repository fails `git add -A` (baseline
    // capture, swallowed to '') AND `git clone` (per-candidate sandbox setup,
    // caught inside runCandidate) — exercising both fallback paths at once.
    const notARepo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-not-a-repo-'));
    cleanupDirs.push(notARepo);
    await writeFile(path.join(notARepo, 'README.md'), 'no git here\n', 'utf8');

    const { runWorkerFanout } = await import('./workerFanout.js');
    const result = await runWorkerFanout({
      projectPath: notARepo,
      baseWorkerOptions: { ...baseWorkerOptions, projectPath: notARepo },
      candidates: [
        { id: 'primary', adapter: 'codex-responses', model: 'gpt-5.4-mini' },
        { id: 'spark', adapter: 'codex-responses', model: 'gpt-5.3-codex-spark' },
      ],
      concurrency: 2,
    });

    expect(result.winner).toBeUndefined();
    expect(result.fallbackReason).toBe('no eligible fan-out candidate produced a guarded diff');
    expect(result.candidates).toHaveLength(2);
    for (const candidate of result.candidates) {
      expect(candidate.eligible).toBe(false);
      expect(candidate.error).toBeTruthy();
      expect(candidate.result.success).toBe(false);
    }
    // The worker itself is never reached — sandbox setup fails first.
    expect(runWorker).not.toHaveBeenCalled();
  });

  it('settles a candidate that throws synchronously before its own try/catch as a pool error', async () => {
    // safeCandidateId() runs on `candidate.id` before runCandidate's try block.
    // A non-string id throws a TypeError there, which the pool (not
    // runCandidate) catches — exercising runPool's `{ error }` settle path and
    // the fan-out's "candidate N failed" log line.
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-bad-id-'));
    cleanupDirs.push(repo);
    await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
    initRepo(repo);

    runWorker.mockImplementation(async (opts: WorkerOptions) => {
      await writeFile(path.join(opts.projectPath, 'ok.txt'), 'ok\n', 'utf8');
      return { success: true, summary: 'ok', filesChanged: ['ok.txt'], commands: [], output: '' };
    });

    const logs: string[] = [];
    const badCandidates = [
      { id: undefined, adapter: 'codex-responses', model: 'gpt-5.4-mini' },
      { id: 'good', adapter: 'codex-responses', model: 'gpt-5.3-codex-spark' },
    ] as unknown as WorkerFanoutCandidateConfig[];

    const { runWorkerFanout } = await import('./workerFanout.js');
    const result = await runWorkerFanout({
      projectPath: repo,
      baseWorkerOptions: { ...baseWorkerOptions, projectPath: repo },
      candidates: badCandidates,
      concurrency: 2,
      onLog: (line) => logs.push(line),
    });

    // The malformed candidate never produced a WorkerFanoutCandidateRun value
    // (it rejected before returning one), so only the well-formed candidate
    // shows up in the settled results.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toBe('good');
    expect(result.winner?.id).toBe('good');
    expect(logs.some((l) => l.includes('candidate 1 failed'))).toBe(true);
  });
});

describe('runWorkerFanout guard-driven ineligibility', () => {
  beforeEach(() => {
    runWorker.mockReset();
  });

  it('excludes a candidate whose diff trips a blocking guard, and still promotes the clean winner', async () => {
    // dependencyAntiPatternCheck is blocking and cheap to trip deterministically
    // (no subprocess toolchain required): a worker report that mentions a
    // module-not-found failure, paired with a new package-scaffold file in the
    // diff, is flagged regardless of the file's actual content.
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-guard-'));
    cleanupDirs.push(repo);
    await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
    initRepo(repo);

    runWorker.mockImplementation(async (opts: WorkerOptions) => {
      const isSpark = opts.model === 'gpt-5.3-codex-spark';
      if (isSpark) {
        // Guard-tripping candidate: claims a dependency failure and scaffolds a
        // package.json in the same diff.
        await writeFile(path.join(opts.projectPath, 'package.json'), '{}\n', 'utf8');
        return {
          success: true,
          summary: 'Cannot find module "left-pad"; scaffolded package.json',
          filesChanged: ['package.json'],
          commands: [],
          output: '',
          confidencePercent: 95,
        };
      }
      await writeFile(path.join(opts.projectPath, 'primary.txt'), 'primary\n', 'utf8');
      return {
        success: true, summary: 'clean patch', filesChanged: ['primary.txt'],
        commands: [], output: '', confidencePercent: 70,
      };
    });

    const { runWorkerFanout } = await import('./workerFanout.js');
    const result = await runWorkerFanout({
      projectPath: repo,
      baseWorkerOptions: { ...baseWorkerOptions, projectPath: repo },
      candidates: [
        { id: 'primary', adapter: 'codex-responses', model: 'gpt-5.4-mini' },
        { id: 'spark-diversity', adapter: 'codex-responses', model: 'gpt-5.3-codex-spark' },
      ],
      concurrency: 2,
      guards: { dependencyAntiPatternCheck: true },
    });

    expect(result.fallbackReason).toBeUndefined();
    // The spark candidate scores higher on confidence but is disqualified by
    // the blocking guard, so the plain "primary" candidate wins by default.
    expect(result.winner?.id).toBe('primary');
    const sparkRun = result.candidates.find((c) => c.id === 'spark-diversity');
    expect(sparkRun?.eligible).toBe(false);
    expect(sparkRun?.guards?.allPassed).toBe(false);
    expect(sparkRun?.guards?.combinedIssues.length).toBeGreaterThan(0);
    expect(existsSync(path.join(repo, 'primary.txt'))).toBe(true);
    expect(existsSync(path.join(repo, 'package.json'))).toBe(false);
  });
});

describe('runWorkerFanout promotion failure', () => {
  beforeEach(() => {
    runWorker.mockReset();
    copyFileShouldFail = false;
  });

  it('falls back with a reason when copying the winner files fails', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-promote-fail-'));
    cleanupDirs.push(repo);
    await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
    initRepo(repo);

    runWorker.mockImplementation(async (opts: WorkerOptions) => {
      await writeFile(path.join(opts.projectPath, 'winner.txt'), 'winner\n', 'utf8');
      return { success: true, summary: 'ok', filesChanged: ['winner.txt'], commands: [], output: '' };
    });

    const { runWorkerFanout } = await import('./workerFanout.js');
    copyFileShouldFail = true;
    const result = await runWorkerFanout({
      projectPath: repo,
      baseWorkerOptions: { ...baseWorkerOptions, projectPath: repo },
      candidates: [
        { id: 'primary', adapter: 'codex-responses', model: 'gpt-5.4-mini' },
        { id: 'spark', adapter: 'codex-responses', model: 'gpt-5.3-codex-spark' },
      ],
      concurrency: 2,
    });

    expect(result.winner).toBeUndefined();
    expect(result.fallbackReason).toMatch(/^winner promotion failed: /);
    expect(existsSync(path.join(repo, 'winner.txt'))).toBe(false);
  });
});

describe('runWorkerFanout shared-path handling and sandbox retention', () => {
  beforeEach(() => {
    runWorker.mockReset();
  });

  async function setupRepoWithSharedNodeModules(): Promise<string> {
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-shared-'));
    cleanupDirs.push(repo);
    await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
    // Gitignored so captureBaselinePatch's `git add -A` never stages these —
    // otherwise the dirty-worktree seeding patch would try to re-create
    // node_modules/marker.txt inside a sandbox that already has it from the
    // shared-path copy/link step, and `git apply` would conflict. Keep the
    // realistic directory-only pattern: Git does not apply `node_modules/` to
    // a symlink, so fanout must exclude the harness-created link explicitly.
    await writeFile(path.join(repo, '.gitignore'), 'node_modules/\nopenswarm.json\n', 'utf8');
    initRepo(repo);
    // Uncommitted (so `git clone` never carries it into a sandbox) — the
    // realistic shape of a gitignored deps dir.
    await mkdir(path.join(repo, 'node_modules'), { recursive: true });
    await writeFile(path.join(repo, 'node_modules', 'marker.txt'), 'shared-dep\n', 'utf8');
    // Invalid JSON forces loadRepoMetadata() to throw, exercising the
    // link/copySharedPaths catch-and-fall-back-to-auto-detect path.
    await writeFile(path.join(repo, 'openswarm.json'), '{ not valid json', 'utf8');
    return repo;
  }

  function findKeptSandboxRoot(logs: string[]): string {
    const line = logs.find((l) => l.includes('kept sandboxes at'));
    if (!line) throw new Error('expected a "kept sandboxes" log line');
    const match = line.match(/kept sandboxes at (.+)$/);
    if (!match) throw new Error(`could not parse sandbox root from: ${line}`);
    return match[1];
  }

  it('copies shared paths into every sandbox by default and keeps sandboxes on request', async () => {
    const repo = await setupRepoWithSharedNodeModules();

    runWorker.mockImplementation(async (opts: WorkerOptions) => {
      const isSpark = opts.model === 'gpt-5.3-codex-spark';
      await writeFile(path.join(opts.projectPath, isSpark ? 'spark.txt' : 'primary.txt'), 'x\n', 'utf8');
      return {
        success: true, summary: 'ok', filesChanged: [isSpark ? 'spark.txt' : 'primary.txt'],
        commands: [], output: '', confidencePercent: isSpark ? 90 : 50,
      };
    });

    const logs: string[] = [];
    const { runWorkerFanout } = await import('./workerFanout.js');
    const result = await runWorkerFanout({
      projectPath: repo,
      baseWorkerOptions: { ...baseWorkerOptions, projectPath: repo },
      candidates: [
        { id: 'primary', adapter: 'codex-responses', model: 'gpt-5.4-mini' },
        { id: 'spark-diversity', adapter: 'codex-responses', model: 'gpt-5.3-codex-spark' },
      ],
      concurrency: 2,
      keepSandboxes: true,
      onLog: (line) => logs.push(line),
    });

    expect(result.fallbackReason).toBeUndefined();
    const root = findKeptSandboxRoot(logs);
    cleanupDirs.push(root);
    // Copy mode: a real, independent file — not a symlink.
    const copiedMarker = path.join(root, 'primary', 'node_modules', 'marker.txt');
    const copiedHandle = await open(copiedMarker, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      expect((await copiedHandle.stat()).isFile()).toBe(true);
      expect(await copiedHandle.readFile('utf8')).toBe('shared-dep\n');
    } finally {
      await copiedHandle.close();
    }
  });

  it('symlinks shared paths into every sandbox when linkSharedPaths is true', async () => {
    const repo = await setupRepoWithSharedNodeModules();

    runWorker.mockImplementation(async (opts: WorkerOptions) => {
      await writeFile(path.join(opts.projectPath, 'edited.txt'), 'x\n', 'utf8');
      return { success: true, summary: 'ok', filesChanged: ['edited.txt'], commands: [], output: '' };
    });

    const logs: string[] = [];
    const { runWorkerFanout } = await import('./workerFanout.js');
    const result = await runWorkerFanout({
      projectPath: repo,
      baseWorkerOptions: { ...baseWorkerOptions, projectPath: repo },
      candidates: [
        { id: 'primary', adapter: 'codex-responses', model: 'gpt-5.4-mini' },
        { id: 'spark', adapter: 'codex-responses', model: 'gpt-5.3-codex-spark' },
      ],
      concurrency: 2,
      linkSharedPaths: true,
      keepSandboxes: true,
      onLog: (line) => logs.push(line),
    });

    expect(result.fallbackReason).toBeUndefined();
    expect(result.winner?.filesChanged).toEqual(['edited.txt']);
    const root = findKeptSandboxRoot(logs);
    cleanupDirs.push(root);
    const linkedMarker = path.join(root, 'primary', 'node_modules');
    expect(existsSync(linkedMarker)).toBe(true);
    expect(lstatSync(linkedMarker).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkedMarker)).toBe(path.resolve(repo, 'node_modules'));
  });

  it('provides no shared paths when linkSharedPaths is explicitly false', async () => {
    const repo = await setupRepoWithSharedNodeModules();

    runWorker.mockImplementation(async (opts: WorkerOptions) => {
      await writeFile(path.join(opts.projectPath, 'edited.txt'), 'x\n', 'utf8');
      return { success: true, summary: 'ok', filesChanged: ['edited.txt'], commands: [], output: '' };
    });

    const logs: string[] = [];
    const { runWorkerFanout } = await import('./workerFanout.js');
    const result = await runWorkerFanout({
      projectPath: repo,
      baseWorkerOptions: { ...baseWorkerOptions, projectPath: repo },
      candidates: [
        { id: 'primary', adapter: 'codex-responses', model: 'gpt-5.4-mini' },
        { id: 'spark', adapter: 'codex-responses', model: 'gpt-5.3-codex-spark' },
      ],
      concurrency: 2,
      linkSharedPaths: false,
      keepSandboxes: true,
      onLog: (line) => logs.push(line),
    });

    expect(result.fallbackReason).toBeUndefined();
    const root = findKeptSandboxRoot(logs);
    cleanupDirs.push(root);
    expect(existsSync(path.join(root, 'primary', 'node_modules'))).toBe(false);
  });

  it('skips copying a shared path that is already checked out from git (tracked)', async () => {
    // A tracked node_modules dir survives `git clone` on its own — the copy
    // step must not clobber it (existsSync(target) => continue).
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-shared-tracked-copy-'));
    cleanupDirs.push(repo);
    await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
    await mkdir(path.join(repo, 'node_modules'), { recursive: true });
    await writeFile(path.join(repo, 'node_modules', 'marker.txt'), 'tracked-dep\n', 'utf8');
    initRepo(repo); // commits node_modules too — it is tracked, not gitignored

    runWorker.mockImplementation(async (opts: WorkerOptions) => {
      await writeFile(path.join(opts.projectPath, 'edited.txt'), 'x\n', 'utf8');
      return { success: true, summary: 'ok', filesChanged: ['edited.txt'], commands: [], output: '' };
    });

    const logs: string[] = [];
    const { runWorkerFanout } = await import('./workerFanout.js');
    const result = await runWorkerFanout({
      projectPath: repo,
      baseWorkerOptions: { ...baseWorkerOptions, projectPath: repo },
      candidates: [
        { id: 'primary', adapter: 'codex-responses', model: 'gpt-5.4-mini' },
        { id: 'spark', adapter: 'codex-responses', model: 'gpt-5.3-codex-spark' },
      ],
      concurrency: 2,
      keepSandboxes: true,
      onLog: (line) => logs.push(line),
    });

    expect(result.fallbackReason).toBeUndefined();
    const root = findKeptSandboxRoot(logs);
    cleanupDirs.push(root);
    // The git-checked-out (tracked) copy survives untouched — proves the copy
    // step took the "already exists" early-continue instead of overwriting it.
    expect(await readFile(path.join(root, 'primary', 'node_modules', 'marker.txt'), 'utf8')).toBe('tracked-dep\n');
  });

  it('skips symlinking a shared path that is already checked out from git (tracked)', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-shared-tracked-link-'));
    cleanupDirs.push(repo);
    await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
    await mkdir(path.join(repo, 'node_modules'), { recursive: true });
    await writeFile(path.join(repo, 'node_modules', 'marker.txt'), 'tracked-dep\n', 'utf8');
    initRepo(repo);

    runWorker.mockImplementation(async (opts: WorkerOptions) => {
      await writeFile(path.join(opts.projectPath, 'edited.txt'), 'x\n', 'utf8');
      return { success: true, summary: 'ok', filesChanged: ['edited.txt'], commands: [], output: '' };
    });

    const logs: string[] = [];
    const { runWorkerFanout } = await import('./workerFanout.js');
    const result = await runWorkerFanout({
      projectPath: repo,
      baseWorkerOptions: { ...baseWorkerOptions, projectPath: repo },
      candidates: [
        { id: 'primary', adapter: 'codex-responses', model: 'gpt-5.4-mini' },
        { id: 'spark', adapter: 'codex-responses', model: 'gpt-5.3-codex-spark' },
      ],
      concurrency: 2,
      linkSharedPaths: true,
      keepSandboxes: true,
      onLog: (line) => logs.push(line),
    });

    expect(result.fallbackReason).toBeUndefined();
    const root = findKeptSandboxRoot(logs);
    cleanupDirs.push(root);
    const nodeModulesPath = path.join(root, 'primary', 'node_modules');
    // Not a symlink — the git-checked-out real directory was left alone.
    expect(lstatSync(nodeModulesPath).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(nodeModulesPath, 'marker.txt'), 'utf8')).toBe('tracked-dep\n');
  });
});

describe('runWorkerFanout onLog forwarding and rename handling', () => {
  beforeEach(() => {
    runWorker.mockReset();
  });

  it('prefixes and forwards a candidate worker onLog line', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-onlog-'));
    cleanupDirs.push(repo);
    await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
    initRepo(repo);

    runWorker.mockImplementation(async (opts: WorkerOptions) => {
      opts.onLog?.('candidate progress line');
      await writeFile(path.join(opts.projectPath, 'edited.txt'), 'x\n', 'utf8');
      return { success: true, summary: 'ok', filesChanged: ['edited.txt'], commands: [], output: '' };
    });

    const logs: string[] = [];
    const { runWorkerFanout } = await import('./workerFanout.js');
    const result = await runWorkerFanout({
      projectPath: repo,
      baseWorkerOptions: { ...baseWorkerOptions, projectPath: repo },
      candidates: [
        { id: 'primary', adapter: 'codex-responses', model: 'gpt-5.4-mini' },
        { id: 'spark', adapter: 'codex-responses', model: 'gpt-5.3-codex-spark' },
      ],
      concurrency: 2,
      onLog: (line) => logs.push(line),
    });

    expect(result.fallbackReason).toBeUndefined();
    // runCandidate wraps the candidate's own onLog with its `[id]` prefix.
    expect(logs.some((l) => /^\[(primary|spark)\] candidate progress line$/.test(l))).toBe(true);
  });

  it('promotes a git-staged rename as a single moved file, not a delete+add pair', async () => {
    // winnerChangeSet()'s R/C token handling (git diff --name-status -z) is
    // only exercised when a rename is staged before the diff is read — plain
    // filesystem renames show up as an untracked add + a tracked delete
    // instead. A worker that stages its own edits (`git add`) exercises the
    // real rename-token path.
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-rename-'));
    cleanupDirs.push(repo);
    await writeFile(path.join(repo, 'old_name.py'), 'content\nmore content\nfor rename detection\n', 'utf8');
    initRepo(repo);

    runWorker.mockImplementation(async (opts: WorkerOptions) => {
      const isSpark = opts.model === 'gpt-5.3-codex-spark';
      if (isSpark) {
        execFileSync('git', ['mv', 'old_name.py', 'new_name.py'], { cwd: opts.projectPath });
        return {
          success: true, summary: 'renamed module', filesChanged: ['old_name.py', 'new_name.py'],
          commands: [], output: '', confidencePercent: 90,
        };
      }
      await writeFile(path.join(opts.projectPath, 'primary.txt'), 'primary\n', 'utf8');
      return {
        success: true, summary: 'primary patch', filesChanged: ['primary.txt'],
        commands: [], output: '', confidencePercent: 50,
      };
    });

    const { runWorkerFanout } = await import('./workerFanout.js');
    const result = await runWorkerFanout({
      projectPath: repo,
      baseWorkerOptions: { ...baseWorkerOptions, projectPath: repo },
      candidates: [
        { id: 'primary', adapter: 'codex-responses', model: 'gpt-5.4-mini' },
        { id: 'spark-diversity', adapter: 'codex-responses', model: 'gpt-5.3-codex-spark' },
      ],
      concurrency: 2,
    });

    expect(result.fallbackReason).toBeUndefined();
    expect(result.winner?.id).toBe('spark-diversity');
    expect(existsSync(path.join(repo, 'old_name.py'))).toBe(false);
    expect(await readFile(path.join(repo, 'new_name.py'), 'utf8')).toBe('content\nmore content\nfor rename detection\n');
  });
});
