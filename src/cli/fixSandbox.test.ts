import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloneSandbox, createSharedPathSnapshot, promoteValidatedFiles } from '../agents/workerFanout.js';
import { runIsolatedFixBatch } from './fixSandbox.js';

describe('runIsolatedFixBatch', () => {
  let repo: string;
  let extraRoots: string[];

  beforeEach(async () => {
    extraRoots = [];
    repo = await mkdtemp(join(tmpdir(), 'openswarm-fix-sandbox-'));
    await mkdir(join(repo, 'src'));
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
    await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
    await writeFile(join(repo, 'src', 'shared.ts'), 'export const shared = 1;\n');
    await mkdir(join(repo, 'node_modules'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'base'], { cwd: repo });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await Promise.all(extraRoots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it('runs independent units concurrently in isolated clones and promotes both disjoint diffs', async () => {
    let active = 0;
    let maxActive = 0;
    let releaseBoth!: () => void;
    const bothActive = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const results = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 2,
      items: [
        { label: 'a', allowedPaths: ['src/a.ts'] },
        { label: 'b', allowedPaths: ['src/b.ts'] },
      ],
      run: async (item, sandbox) => {
        active++;
        maxActive = Math.max(maxActive, active);
        if (active === 2) releaseBoth();
        await bothActive;
        await writeFile(join(sandbox, item.allowedPaths[0]), `export const ${item.label} = 2;\n`);
        active--;
        return { success: true };
      },
    });

    expect(maxActive).toBe(2);
    expect(results.every((result) => result.success)).toBe(true);
    expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toContain('= 2');
    expect(await readFile(join(repo, 'src', 'b.ts'), 'utf8')).toContain('= 2');
  });

  it('rejects the whole unit when its diff mixes allowed and out-of-scope files', async () => {
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'a', allowedPaths: ['src/a.ts'] }],
      run: async (_item, sandbox) => {
        await writeFile(join(sandbox, 'src', 'a.ts'), 'export const a = 9;\n');
        await writeFile(join(sandbox, 'src', 'shared.ts'), 'export const shared = 9;\n');
        return { success: true };
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside dependency closure');
    expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toContain('= 1');
    expect(await readFile(join(repo, 'src', 'shared.ts'), 'utf8')).toContain('= 1');
  });

  it('does not promote a completed worker after the batch signal is aborted', async () => {
    const controller = new AbortController();
    await expect(runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      signal: controller.signal,
      items: [{ label: 'aborted', allowedPaths: ['src/a.ts'] }],
      run: async (_item, sandbox) => {
        await writeFile(join(sandbox, 'src', 'a.ts'), 'export const a = 99;\n');
        controller.abort();
        return { success: true };
      },
    })).rejects.toThrow();

    expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('preserves an external edit that lands in the project while a sandbox worker is running', async () => {
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'drift', allowedPaths: ['src/a.ts'] }],
      run: async (_item, sandbox) => {
        await writeFile(join(sandbox, 'src', 'a.ts'), 'export const a = "worker";\n');
        await writeFile(join(repo, 'src', 'a.ts'), 'export const a = "external";\n');
        return { success: true };
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('project changed while sandbox worker ran');
    expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toBe('export const a = "external";\n');
  });

  it('seeds prior-round dirty work into each sandbox without attributing it to the new unit', async () => {
    await writeFile(join(repo, 'src', 'shared.ts'), 'export const shared = 2; // prior round\n');
    let observedBaseline = '';
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'a', allowedPaths: ['src/a.ts'] }],
      run: async (_item, sandbox) => {
        observedBaseline = await readFile(join(sandbox, 'src', 'shared.ts'), 'utf8');
        await writeFile(join(sandbox, 'src', 'a.ts'), 'export const a = 3;\n');
        return { success: true };
      },
    });
    expect(observedBaseline).toContain('prior round');
    expect(result.filesChanged).toEqual(['src/a.ts']);
    expect(await readFile(join(repo, 'src', 'shared.ts'), 'utf8')).toContain('prior round');
  });

  it('copies shared dependencies so worker writes cannot leak into the original repository', async () => {
    // Audit worktrees themselves expose node_modules as a symlink. The nested fix
    // sandbox must dereference that outer link into an isolated copy.
    await rm(join(repo, 'node_modules'), { recursive: true, force: true });
    await mkdir(join(repo, 'dependency-store'));
    await writeFile(join(repo, 'dependency-store', 'mutable.txt'), 'original\n');
    await symlink('dependency-store', join(repo, 'node_modules'), 'dir');
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'deps', allowedPaths: ['src/a.ts'] }],
      run: async (_item, sandbox) => {
        await writeFile(join(sandbox, 'node_modules', 'mutable.txt'), 'worker-write\n');
        await writeFile(join(sandbox, 'src', 'a.ts'), 'export const a = 4;\n');
        return { success: true };
      },
    });

    expect(result.success, result.error).toBe(true);
    expect(await readFile(join(repo, 'dependency-store', 'mutable.txt'), 'utf8')).toBe('original\n');
  });

  it('gives concurrent workers independent clones of the shared dependency snapshot', async () => {
    await writeFile(join(repo, 'node_modules', 'mutable.txt'), 'original\n');
    let arrived = 0;
    let release!: () => void;
    const allReady = new Promise<void>((resolve) => { release = resolve; });
    const observed = new Map<string, string>();

    const results = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 2,
      items: [
        { label: 'left', allowedPaths: ['src/a.ts'] },
        { label: 'right', allowedPaths: ['src/b.ts'] },
      ],
      run: async (item, sandbox) => {
        const dependency = join(sandbox, 'node_modules', 'mutable.txt');
        observed.set(item.label, await readFile(dependency, 'utf8'));
        arrived += 1;
        if (arrived === 2) release();
        await allReady;
        await writeFile(dependency, `${item.label}\n`);
        const source = item.label === 'left' ? 'src/a.ts' : 'src/b.ts';
        await writeFile(join(sandbox, source), `export const worker = '${item.label}';\n`);
        return { success: true };
      },
    });

    expect(results.every((result) => result.success), JSON.stringify(results)).toBe(true);
    expect([...observed.values()]).toEqual(['original\n', 'original\n']);
    expect(await readFile(join(repo, 'node_modules', 'mutable.txt'), 'utf8')).toBe('original\n');
  });

  it('revalidates a shared snapshot whose symlinks changed after sanitization', async () => {
    await writeFile(join(repo, 'node_modules', 'marker.txt'), 'dependency\n');
    await writeFile(join(repo, 'external.txt'), 'external-original\n');
    const root = await mkdtemp(join(tmpdir(), 'openswarm-shared-snapshot-'));
    extraRoots.push(root);
    const snapshot = await createSharedPathSnapshot(repo, join(root, 'snapshot'));
    const injected = join(snapshot.root, 'node_modules', 'injected-link');
    await symlink(join(repo, 'external.txt'), injected);

    const { sandbox } = await cloneSandbox(repo, root, 'candidate', 'copy', snapshot);
    const copied = join(sandbox, 'node_modules', 'injected-link');
    const copiedHandle = await open(copied, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      expect((await copiedHandle.stat()).isFile()).toBe(true);
      expect(await copiedHandle.readFile('utf8')).toBe('external-original\n');
      await copiedHandle.truncate(0);
      await copiedHandle.writeFile('sandbox-only\n');
    } finally {
      await copiedHandle.close();
    }
    expect(await readFile(join(repo, 'external.txt'), 'utf8')).toBe('external-original\n');
  });

  it('keeps a broken external dependency link dangling but retargets it inside the sandbox', async () => {
    await symlink('/tmp/openswarm-external-dependency', join(repo, 'node_modules', 'external-link'));
    let workerRan = false;
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'external-deps', allowedPaths: ['src/a.ts'] }],
      run: async (_item, sandbox) => {
        workerRan = true;
        const copiedLink = join(sandbox, 'node_modules', 'external-link');
        expect(await readlink(copiedLink)).not.toContain('/tmp/openswarm-external-dependency');
        await expect(realpath(copiedLink)).rejects.toMatchObject({ code: 'ENOENT' });
        await writeFile(join(sandbox, 'src', 'a.ts'), 'export const a = 7;\n');
        return { success: true };
      },
    });

    expect(workerRan).toBe(true);
    expect(result.success, result.error).toBe(true);
  });

  it('preserves a sandbox-contained dangling dependency link exactly', async () => {
    await symlink('optional-package-missing', join(repo, 'node_modules', 'optional-link'));
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'internal-dangling-deps', allowedPaths: ['src/a.ts'] }],
      run: async (_item, sandbox) => {
        expect(await readlink(join(sandbox, 'node_modules', 'optional-link'))).toBe('optional-package-missing');
        await writeFile(join(sandbox, 'src', 'a.ts'), 'export const a = 8;\n');
        return { success: true };
      },
    });

    expect(result.success, result.error).toBe(true);
  });

  it('dereferences a valid external dependency link into the sandbox before workers run', async () => {
    await writeFile(join(repo, 'external-dependency.txt'), 'external-original\n');
    await symlink(join(repo, 'external-dependency.txt'), join(repo, 'node_modules', 'external-link'));
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'external-deps-copy', allowedPaths: ['src/a.ts'] }],
      run: async (_item, sandbox) => {
        expect((await lstat(join(sandbox, 'node_modules', 'external-link'))).isSymbolicLink()).toBe(false);
        await writeFile(join(sandbox, 'node_modules', 'external-link'), 'sandbox-only\n');
        await writeFile(join(sandbox, 'src', 'a.ts'), 'export const a = 6;\n');
        return { success: true };
      },
    });

    expect(result.success, result.error).toBe(true);
    expect(await readFile(join(repo, 'external-dependency.txt'), 'utf8')).toBe('external-original\n');
  });

  it('fails all overlapping candidates instead of applying timing-dependent edits', async () => {
    const results = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 2,
      items: [
        { label: 'left', allowedPaths: ['src/shared.ts'] },
        { label: 'right', allowedPaths: ['src/shared.ts'] },
      ],
      run: async (item, sandbox) => {
        await writeFile(join(sandbox, 'src', 'shared.ts'), `export const shared = '${item.label}';\n`);
        return { success: true };
      },
    });
    expect(results.every((result) => !result.success)).toBe(true);
    expect(results.every((result) => result.error?.includes('fix-unit conflict'))).toBe(true);
    expect(await readFile(join(repo, 'src', 'shared.ts'), 'utf8')).toContain('= 1');
  });

  it.each(['../escape.ts', 'src/../../escape.ts', '/tmp/escape.ts'])(
    'rejects an unsafe validated promotion path before mutating the repository: %s',
    async (unsafePath) => {
      await expect(promoteValidatedFiles(repo, repo, [unsafePath])).rejects.toThrow('unsafe sandbox path');
      expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toContain('= 1');
    },
  );

  it('rejects a promoted symlink whose target escapes the sandbox repository', async () => {
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'escape-link', allowedPaths: ['src/escape.ts'] }],
      run: async (_item, sandbox) => {
        await symlink('../../outside-secret', join(sandbox, 'src', 'escape.ts'));
        return { success: true };
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('symlink escapes repository');
    await expect(lstat(join(repo, 'src', 'escape.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recreates a safe relative symlink instead of dereferencing its source', async () => {
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'safe-link', allowedPaths: ['src/alias.ts'] }],
      run: async (_item, sandbox) => {
        await symlink('a.ts', join(sandbox, 'src', 'alias.ts'));
        return { success: true };
      },
    });

    expect(result.success, result.error).toBe(true);
    expect((await lstat(join(repo, 'src', 'alias.ts'))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(repo, 'src', 'alias.ts'))).toBe('a.ts');
  });

  it('replaces an existing destination symlink without overwriting its target', async () => {
    await writeFile(join(repo, 'protected.txt'), 'protected\n');
    await rm(join(repo, 'src', 'a.ts'));
    await symlink('../protected.txt', join(repo, 'src', 'a.ts'));
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'replace-link', allowedPaths: ['src/a.ts'] }],
      run: async (_item, sandbox) => {
        await rm(join(sandbox, 'src', 'a.ts'));
        await writeFile(join(sandbox, 'src', 'a.ts'), 'export const a = 5;\n');
        return { success: true };
      },
    });

    expect(result.success, result.error).toBe(true);
    expect(await readFile(join(repo, 'protected.txt'), 'utf8')).toBe('protected\n');
    expect((await lstat(join(repo, 'src', 'a.ts'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toContain('= 5');
  });

  it('rolls back every promoted write and deletion when a later destination write fails', async () => {
    await writeFile(join(repo, 'src', 'obsolete.ts'), 'export const obsolete = true;\n');
    execFileSync('git', ['add', 'src/obsolete.ts'], { cwd: repo });
    execFileSync('git', [
      '-c', 'user.email=test@example.com', '-c', 'user.name=Test',
      'commit', '-m', 'add obsolete fixture',
    ], { cwd: repo });

    const candidateRoot = await mkdtemp(join(tmpdir(), 'openswarm-promotion-candidate-'));
    extraRoots.push(candidateRoot);
    const candidate = join(candidateRoot, 'candidate');
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', '--', repo, candidate]);
    await writeFile(join(candidate, 'src', 'a.ts'), 'export const a = 9;\n');
    await writeFile(join(candidate, 'src', 'b.ts'), 'export const b = 9;\n');
    await rm(join(candidate, 'src', 'obsolete.ts'));

    await expect(promoteValidatedFiles(
      repo,
      candidate,
      ['src/a.ts', 'src/b.ts', 'src/obsolete.ts'],
      [],
      {
        beforeWrite: (path) => {
          if (path === 'src/b.ts') throw new Error('injected destination failure');
        },
      },
    )).rejects.toThrow('injected destination failure');

    expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(await readFile(join(repo, 'src', 'b.ts'), 'utf8')).toBe('export const b = 1;\n');
    expect(await readFile(join(repo, 'src', 'obsolete.ts'), 'utf8')).toBe('export const obsolete = true;\n');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe('');
  });

  it('promotes a newline-containing Git filename through NUL-delimited change parsing', async () => {
    const path = 'src/line\nbreak.ts';
    const [result] = await runIsolatedFixBatch({
      projectPath: repo,
      concurrency: 1,
      items: [{ label: 'newline', allowedPaths: [path] }],
      run: async (_item, sandbox) => {
        await writeFile(join(sandbox, path), 'export const newline = true;\n');
        return { success: true };
      },
    });
    expect(result.success).toBe(true);
    expect(await readFile(join(repo, path), 'utf8')).toContain('true');
  });
});
