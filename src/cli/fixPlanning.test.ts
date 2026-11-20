import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../knowledge/index.js', () => ({
  scanProject: vi.fn().mockRejectedValue(new Error('graph unavailable')),
  toProjectSlug: (path: string) => path,
}));
vi.mock('../memory/repoKnowledge.js', () => ({
  recallRepoKnowledge: vi.fn().mockResolvedValue([{ type: 'constraint', title: 'Use real deps', content: 'Do not stub packages.' }]),
  repoKey: (path: string) => path.replace(/\/worktree\/[^/]+\/?$/, ''),
}));

const { buildFixRepositoryContext, pathWithinScope, planFixUnits, workerContextForFixUnit } = await import('./fixPlanning.js');
import type { FixRepositoryContext } from './fixPlanning.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function context(overrides: Partial<FixRepositoryContext> = {}): FixRepositoryContext {
  return {
    canonicalRoot: '/repo', packageManager: 'pnpm', workspaces: ['packages/*'],
    manifests: ['package.json', 'packages/app/package.json'], verificationCommands: ['pnpm test'],
    sharedPaths: ['node_modules'], repoMemories: [], dependencyGraphAvailable: true,
    dependencyMap: {}, preflight: { ready: true, issues: [] }, ...overrides,
  };
}

describe('buildFixRepositoryContext', () => {
  it('captures package-manager/verify context and blocks a missing installed Node runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openswarm-fix-context-'));
    roots.push(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@10.0.0', workspaces: ['packages/*'], devDependencies: { vitest: '^4' },
    }));
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const plan = {
      commands: [{ name: 'test', run: 'pnpm test', kind: 'test' as const }],
      packageJsonByDirectory: { '': '{}' },
    };

    const missing = await buildFixRepositoryContext(root, plan, 'fix review issue');
    expect(missing.packageManager).toBe('pnpm');
    expect(missing.workspaces).toEqual(['packages/*']);
    expect(missing.verificationCommands).toEqual(['pnpm test']);
    expect(missing.preflight.ready).toBe(false);
    expect(missing.preflight.issues.join('\n')).toContain('no node_modules');
    expect(missing.repoMemories[0]?.title).toBe('Use real deps');

    await mkdir(join(root, 'node_modules'));
    const ready = await buildFixRepositoryContext(root, plan, 'fix review issue');
    expect(ready.preflight).toEqual({ ready: true, issues: [] });
  });

  it('discovers tracked nested ecosystem manifests and scans the exact worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openswarm-fix-context-rust-'));
    roots.push(root);
    await mkdir(join(root, 'crates', 'core'), { recursive: true });
    await writeFile(join(root, 'Cargo.toml'), '[workspace]\nmembers = ["crates/core"]\n');
    await writeFile(join(root, 'Cargo.lock'), '# lock\n');
    await writeFile(join(root, 'crates', 'core', 'Cargo.toml'), '[package]\nname = "core"\nversion = "0.1.0"\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });

    const result = await buildFixRepositoryContext(root, undefined, 'fix rust review issue');

    expect(result.manifests).toEqual(['Cargo.lock', 'Cargo.toml', 'crates/core/Cargo.toml']);
    const { scanProject } = await import('../knowledge/index.js');
    expect(scanProject).toHaveBeenCalledWith(root, root);
  });
});

describe('planFixUnits', () => {
  it('merges related areas and carries callers, tests, and the nearest manifest into scope', () => {
    const ctx = context({
      dependencyMap: {
        'packages/app/src/a.ts': {
          imports: ['packages/app/src/b.ts'],
          dependents: ['packages/app/src/caller.ts'],
          tests: ['packages/app/src/a.test.ts'],
        },
        'packages/app/src/b.ts': { imports: [], dependents: [], tests: [] },
        'src/independent.ts': { imports: [], dependents: [], tests: [] },
      },
    });
    const units = planFixUnits([
      { area: { label: 'app/a', dir: 'packages/app/src/a', files: ['packages/app/src/a.ts'] }, review: { decision: 'revise', feedback: '' } },
      { area: { label: 'app/b', dir: 'packages/app/src/b', files: ['packages/app/src/b.ts'] }, review: { decision: 'revise', feedback: '' } },
      { area: { label: 'independent', dir: 'src/independent', files: ['src/independent.ts'] }, review: { decision: 'revise', feedback: '' } },
    ], ctx);

    expect(units).toHaveLength(2);
    const related = units.find((unit) => unit.targetLabels.includes('app/a'))!;
    expect(related.targetLabels.sort()).toEqual(['app/a', 'app/b']);
    expect(related.dependencyFiles).toContain('packages/app/src/caller.ts');
    expect(related.testFiles).toContain('packages/app/src/a.test.ts');
    expect(related.manifestFiles).toEqual(['package.json', 'packages/app/package.json']);
    expect(related.allowedPaths).toContain('packages/app/src/caller.ts');
  });

  it('keeps independent areas separate and supports directory-or-file scope checks', () => {
    const units = planFixUnits([
      { area: { label: 'a', dir: 'src/a', files: ['src/a/x.ts'] }, review: { decision: 'revise', feedback: '' } },
      { area: { label: 'b', dir: 'src/b', files: ['src/b/y.ts'] }, review: { decision: 'revise', feedback: '' } },
    ], context({
      dependencyMap: {
        'src/a/x.ts': { imports: [], dependents: [], tests: [] },
        'src/b/y.ts': { imports: [], dependents: [], tests: [] },
      },
    }));
    expect(units).toHaveLength(2);
    expect(pathWithinScope('src/a/new.test.ts', ['src/a'])).toBe(true);
    expect(pathWithinScope('src/ab/escape.ts', ['src/a'])).toBe(false);
  });

  it('merges targets connected through transitive callers/imports and scopes the full closure', () => {
    const units = planFixUnits([
      { area: { label: 'entry', dir: 'src/entry', files: ['src/entry.ts'] }, review: { decision: 'revise', feedback: '' } },
      { area: { label: 'leaf', dir: 'src/leaf', files: ['src/leaf.ts'] }, review: { decision: 'revise', feedback: '' } },
    ], context({
      dependencyMap: {
        'src/entry.ts': { imports: ['src/middle.ts'], dependents: [], tests: [] },
        'src/middle.ts': { imports: ['src/leaf.ts'], dependents: ['src/entry.ts'], tests: [] },
        'src/leaf.ts': { imports: [], dependents: ['src/middle.ts', 'src/deep-caller.ts'], tests: ['test/leaf.test.ts'] },
        'src/deep-caller.ts': { imports: ['src/leaf.ts'], dependents: [], tests: [] },
        'test/leaf.test.ts': { imports: ['src/leaf.ts'], dependents: [], tests: [] },
      },
    }));

    expect(units).toHaveLength(1);
    expect(units[0].targetLabels.sort()).toEqual(['entry', 'leaf']);
    expect(units[0].dependencyFiles).toEqual(expect.arrayContaining(['src/middle.ts', 'src/deep-caller.ts']));
    expect(units[0].testFiles).toContain('test/leaf.test.ts');
    expect(units[0].allowedPaths).toEqual(expect.arrayContaining(['src/middle.ts', 'src/deep-caller.ts', 'test']));
  });

  it('uses one repository-wide unit when the graph is missing or only partially covers targets', () => {
    const units = planFixUnits([
      { area: { label: 'a', dir: 'src/a', files: ['src/a/x.rs'] }, review: { decision: 'revise', feedback: '' } },
      { area: { label: 'b', dir: 'src/b', files: ['src/b/y.rs'] }, review: { decision: 'revise', feedback: '' } },
    ], context({ dependencyGraphAvailable: true, dependencyMap: {} }));

    expect(units).toHaveLength(1);
    expect(units[0].dependencyGraphBacked).toBe(false);
    expect(units[0].allowedPaths).toEqual(['.']);
    expect(pathWithinScope('src/shared/contract.rs', units[0].allowedPaths)).toBe(true);
    expect(pathWithinScope('../escape.rs', units[0].allowedPaths)).toBe(false);
  });

  it('scopes root source files exactly and keeps manifest plus lockfile atomic', () => {
    const [unit] = planFixUnits([
      { area: { label: '.', dir: '.', files: ['main.js'] }, review: { decision: 'revise', feedback: '' } },
    ], context({
      manifests: ['package-lock.json', 'package.json'],
      dependencyMap: { 'main.js': { imports: [], dependents: [], tests: [] } },
    }));

    expect(unit.allowedPaths).not.toContain('.');
    expect(unit.manifestFiles).toEqual(['package-lock.json', 'package.json']);
    expect(pathWithinScope('main.js', unit.allowedPaths)).toBe(true);
    expect(pathWithinScope('package.json', unit.allowedPaths)).toBe(true);
    expect(pathWithinScope('package-lock.json', unit.allowedPaths)).toBe(true);
    expect(pathWithinScope('unrelated.js', unit.allowedPaths)).toBe(false);
  });
});

describe('incomplete dependency graph', () => {
  it('carries graph.incomplete from the scan into the repository context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openswarm-fix-context-incomplete-'));
    roots.push(root);
    const { scanProject } = await import('../knowledge/index.js');
    const node = { id: 'src/a.ts', type: 'module' };
    vi.mocked(scanProject).mockResolvedValueOnce({
      incomplete: true,
      getAllNodes: () => [node],
      getImports: () => [],
      getDependents: () => [],
      getTests: () => [],
    } as never);

    const result = await buildFixRepositoryContext(root, undefined, 'fix');

    expect(result.dependencyGraphAvailable).toBe(true);
    expect(result.dependencyGraphIncomplete).toBe(true);
    expect(result.dependencyMap['src/a.ts']).toEqual({ imports: [], dependents: [], tests: [] });
  });

  it('does not treat empty dependents as authoritative when the graph is incomplete', () => {
    const targets = [
      { area: { label: 'a', dir: 'src/a', files: ['src/a/x.ts'] }, review: { decision: 'revise' as const, feedback: '' } },
      { area: { label: 'b', dir: 'src/b', files: ['src/b/y.ts'] }, review: { decision: 'revise' as const, feedback: '' } },
    ];
    const dependencyMap = {
      'src/a/x.ts': { imports: [], dependents: [], tests: [] },
      'src/b/y.ts': { imports: [], dependents: [], tests: [] },
    };
    // Complete graph: empty dependents prove independence, so two units.
    expect(planFixUnits(targets, context({ dependencyMap }))).toHaveLength(2);

    // Incomplete graph: a caller could sit in an unscanned file, so independence
    // is unknown and planning falls back to one repository-wide unit.
    const ctx = context({ dependencyMap, dependencyGraphIncomplete: true });
    const units = planFixUnits(targets, ctx);
    expect(units).toHaveLength(1);
    expect(units[0].dependencyGraphBacked).toBe(false);
    expect(units[0].allowedPaths).toEqual(['.']);

    const worker = workerContextForFixUnit(units[0], ctx);
    expect(worker.repository.dependencyGraphAvailable).toBe(false);
    expect(worker.repository.dependencyGraphIncomplete).toBe(true);
  });
});
