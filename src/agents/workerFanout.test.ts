import { beforeEach, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkerOptions } from './worker.js';

const runWorker = vi.fn();
vi.mock('./worker.js', async () => {
  const actual = await vi.importActual<typeof import('./worker.js')>('./worker.js');
  return { ...actual, runWorker };
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

describe('captureBaselinePatch', () => {
  it('tolerates an ignored shared dependency path that is absent from the temporary index', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-ignored-shared-'));
    try {
      await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n', 'utf8');
      await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
      initRepo(repo);
      await mkdir(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'ignored\n', 'utf8');
      await writeFile(path.join(repo, 'README.md'), 'base\ndirty\n', 'utf8');

      const { captureBaselinePatch } = await import('./workerFanout.js');
      const dest = path.join(repo, '..', `baseline-${path.basename(repo)}.patch`);
      const baseline = await captureBaselinePatch(repo, dest);
      const patch = await readFile(baseline.path, 'utf8');

      expect(patch).toContain('README.md');
      expect(patch).not.toContain('node_modules');
      await rm(dest, { force: true });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports a clean worktree as no patch at all', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-clean-'));
    try {
      await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
      initRepo(repo);

      const { captureBaselinePatch } = await import('./workerFanout.js');
      const dest = path.join(repo, '..', `baseline-clean-${path.basename(repo)}.patch`);
      const baseline = await captureBaselinePatch(repo, dest);

      expect(baseline.path).toBe('');
      expect(existsSync(dest)).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('streams a patch far larger than the exec stdout buffer instead of failing', async () => {
    // Production failure (enzyme, `review --max --fix`): a dirty tree carrying
    // ~271MB of uncommitted files made `git diff --cached --binary` overflow the
    // 20MB execFile buffer, and "stdout maxBuffer length exceeded" killed the
    // whole audit after every reviewer had already run. (INT-3098)
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-huge-'));
    try {
      await writeFile(path.join(repo, 'big.txt'), 'seed\n', 'utf8');
      initRepo(repo);
      // Tracked (so the size limit for untracked artifacts does not apply) and
      // well past the old 20MB ceiling.
      await writeFile(path.join(repo, 'big.txt'), `${'x'.repeat(1024)}\n`.repeat(25 * 1024), 'utf8');

      const { captureBaselinePatch } = await import('./workerFanout.js');
      const dest = path.join(repo, '..', `baseline-huge-${path.basename(repo)}.patch`);
      const baseline = await captureBaselinePatch(repo, dest);

      expect(baseline.path).toBe(dest);
      expect((await stat(dest)).size).toBeGreaterThan(24 * 1024 * 1024);
      await rm(dest, { force: true });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 60_000);

  it('leaves oversized untracked artifacts out of the baseline but keeps source edits', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-artifact-'));
    try {
      await writeFile(path.join(repo, 'src.ts'), 'export const a = 1;\n', 'utf8');
      initRepo(repo);
      await writeFile(path.join(repo, 'src.ts'), 'export const a = 2;\n', 'utf8');
      await writeFile(path.join(repo, 'new-source.ts'), 'export const b = 3;\n', 'utf8');
      await mkdir(path.join(repo, 'trash'), { recursive: true });
      await writeFile(path.join(repo, 'trash', 'bundle.bin'), 'z'.repeat(3 * 1024 * 1024), 'utf8');

      const { captureBaselinePatch } = await import('./workerFanout.js');
      const dest = path.join(repo, '..', `baseline-artifact-${path.basename(repo)}.patch`);
      const baseline = await captureBaselinePatch(repo, dest);
      const patch = await readFile(baseline.path, 'utf8');

      // git reports repository-relative paths with forward slashes on every platform.
      expect(baseline.skippedUntracked).toEqual(['trash/bundle.bin']);
      expect(patch).toContain('src.ts');
      expect(patch).toContain('new-source.ts');
      expect(patch).not.toContain('bundle.bin');
      // The project keeps the file — only the temporary index dropped it.
      expect(existsSync(path.join(repo, 'trash', 'bundle.bin'))).toBe(true);
      await rm(dest, { force: true });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('runWorkerFanout on a dirty worktree', () => {
  beforeEach(() => {
    runWorker.mockReset();
  });

  it('promotes a winner that modifies a file which is itself dirty in the project', async () => {
    // Production failure (kyte-portal): the winner patched files that were part
    // of the pre-existing dirty state. `git apply --3way` validates the preimage
    // against the INDEX (= HEAD), not the worktree, so the promote died with
    // "does not match index" even though the worktree matched exactly.
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-dirty-overlap-'));
    try {
      await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
      initRepo(repo);
      await writeFile(path.join(repo, 'README.md'), 'base\npreexisting-edit\n', 'utf8');

      runWorker.mockImplementation(async (opts: WorkerOptions) => {
        const isSpark = opts.model === 'gpt-5.3-codex-spark';
        if (isSpark) {
          // Winner edits the SAME file that is dirty in the project.
          const current = await readFile(path.join(opts.projectPath, 'README.md'), 'utf8');
          await writeFile(path.join(opts.projectPath, 'README.md'), `${current}winner-edit\n`, 'utf8');
          return {
            success: true, summary: 'spark patch', filesChanged: ['README.md'],
            commands: [], output: '', confidencePercent: 95,
          };
        }
        await writeFile(path.join(opts.projectPath, 'primary.txt'), 'primary\n', 'utf8');
        return {
          success: true, summary: 'primary patch', filesChanged: ['primary.txt'],
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
      });

      expect(result.fallbackReason).toBeUndefined();
      expect(result.winner?.id).toBe('spark-diversity');
      expect(await readFile(path.join(repo, 'README.md'), 'utf8')).toBe('base\npreexisting-edit\nwinner-edit\n');
      expect(existsSync(path.join(repo, 'primary.txt'))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('seeds pre-existing uncommitted changes and promotes only the incremental winner diff', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-dirty-'));
    try {
      await writeFile(path.join(repo, 'README.md'), 'base\n', 'utf8');
      initRepo(repo);

      // Make the project worktree DIRTY (a self-repair retry still holding the
      // previous iteration's edits): a tracked modification + an untracked file.
      await writeFile(path.join(repo, 'README.md'), 'base\npreexisting-edit\n', 'utf8');
      await writeFile(path.join(repo, 'preexisting.txt'), 'from a prior iteration\n', 'utf8');

      // Each candidate adds its own new file on top of the seeded dirty base.
      runWorker.mockImplementation(async (opts: WorkerOptions) => {
        const isSpark = opts.model === 'gpt-5.3-codex-spark';
        const file = isSpark ? 'spark.txt' : 'primary.txt';
        await writeFile(path.join(opts.projectPath, file), isSpark ? 'spark\n' : 'primary\n', 'utf8');
        return {
          success: true,
          summary: isSpark ? 'spark patch' : 'primary patch',
          filesChanged: [file],
          commands: [],
          output: '',
          confidencePercent: isSpark ? 95 : 70,
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

      // Fan-out ran (not bailed on the dirty tree) and picked the higher-confidence spark.
      expect(result.fallbackReason).toBeUndefined();
      expect(result.winner?.id).toBe('spark-diversity');
      expect(runWorker).toHaveBeenCalledTimes(2);

      // The pre-existing dirty state survives, AND the winner's incremental diff
      // is layered on top of it — the loser's file is not promoted.
      expect(await readFile(path.join(repo, 'README.md'), 'utf8')).toBe('base\npreexisting-edit\n');
      expect(existsSync(path.join(repo, 'preexisting.txt'))).toBe(true);
      expect(await readFile(path.join(repo, 'spark.txt'), 'utf8')).toBe('spark\n');
      expect(existsSync(path.join(repo, 'primary.txt'))).toBe(false);
      // filesChanged reflects the promoted worktree (accumulated dirty base +
      // the winner's increment) so downstream review sees the full change set —
      // it includes spark.txt but never the losing candidate's primary.txt.
      expect(result.winner?.result.filesChanged).toEqual(
        expect.arrayContaining(['spark.txt', 'README.md', 'preexisting.txt']),
      );
      expect(result.winner?.result.filesChanged).not.toContain('primary.txt');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('promotes the winner when it deletes a tracked file and adds a new one', async () => {
    // File-copy promote (not `git apply`) so add/delete/modify all survive
    // regardless of context — the mode that made the patch route fail in prod.
    const repo = await mkdtemp(path.join(tmpdir(), 'osw-fanout-adddel-'));
    try {
      await writeFile(path.join(repo, 'keep.py'), 'keep\n', 'utf8');
      await writeFile(path.join(repo, 'obsolete.py'), 'delete me\n', 'utf8');
      initRepo(repo);

      runWorker.mockImplementation(async (opts: WorkerOptions) => {
        const isSpark = opts.model === 'gpt-5.3-codex-spark';
        if (isSpark) {
          await rm(path.join(opts.projectPath, 'obsolete.py'), { force: true });
          await writeFile(path.join(opts.projectPath, 'brand_new.py'), 'new\n', 'utf8');
          await writeFile(path.join(opts.projectPath, 'keep.py'), 'keep\nedited\n', 'utf8');
          return {
            success: true, summary: 'spark patch',
            filesChanged: ['obsolete.py', 'brand_new.py', 'keep.py'],
            commands: [], output: '', confidencePercent: 95,
          };
        }
        await writeFile(path.join(opts.projectPath, 'primary.txt'), 'primary\n', 'utf8');
        return {
          success: true, summary: 'primary patch', filesChanged: ['primary.txt'],
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
      });

      expect(result.fallbackReason).toBeUndefined();
      expect(result.winner?.id).toBe('spark-diversity');
      expect(existsSync(path.join(repo, 'obsolete.py'))).toBe(false); // deleted
      expect(await readFile(path.join(repo, 'brand_new.py'), 'utf8')).toBe('new\n'); // added
      expect(await readFile(path.join(repo, 'keep.py'), 'utf8')).toBe('keep\nedited\n'); // modified
      expect(existsSync(path.join(repo, 'primary.txt'))).toBe(false); // loser not promoted
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
