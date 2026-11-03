// Round-1 redteam A-F3 (2026-11-03): `protectedFiles` was enforced by the edit
// tools but no production caller set it, so the worker could rewrite the tests
// that define acceptance. The pair pipeline now protects them from the start.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const runWorker = vi.hoisted(() => vi.fn());
vi.mock('./worker.js', async () => {
  const actual = await vi.importActual<typeof import('./worker.js')>('./worker.js');
  return { ...actual, runWorker };
});
vi.mock('../knowledge/index.js', () => ({ hasRepoSnapshot: () => true, scanAndCache: vi.fn(), analyzeIssue: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../memory/repoKnowledge.js', () => ({ recallRepoKnowledge: vi.fn().mockResolvedValue([]) }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../coordination/runCoordination.js', () => ({ publishCoordination: vi.fn(async () => {}) }));

import { computeProtectedFiles, globToRegExp } from './protectedFiles.js';
import { isProtectedPath } from '../adapters/tools.js';

const FILES: Record<string, string> = {
  'src/a.ts': 'export const a = 1;\n',
  'src/a.test.ts': "it('a', () => {});\n",
  'src/legacy/b.spec.js': "it('b', () => {});\n",
  'tests/test_x.py': 'def test_x():\n    pass\n',
  'pkg/x_test.go': 'package pkg\n',
  'vitest.config.ts': 'export default {};\n',
  'tests/conftest.py': '\n',
  'pyproject.toml': '[project]\nname = "x"\n',
  'package.json': '{}\n',
};

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'openswarm-protected-files-'));
  for (const [file, content] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), content);
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  // Untracked: a test the worker is about to add is not "the grader" yet.
  await writeFile(path.join(repo, 'src/new.test.ts'), "it('n', () => {});\n");
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  runWorker.mockReset();
  runWorker.mockResolvedValue({ success: true, summary: 'done', filesChanged: [], commands: [], output: '', confidencePercent: 100 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
});

function task(overrides: Partial<TaskItem> = {}): TaskItem {
  return { id: 't1', source: 'linear', title: 'Fix the rounding bug', description: 'Rounding is off by one.', priority: 1, createdAt: Date.now(), ...overrides };
}

const GRADER = ['pkg/x_test.go', 'src/a.test.ts', 'src/legacy/b.spec.js', 'tests/conftest.py', 'tests/test_x.py', 'vitest.config.ts'];

describe('protected files by default', () => {
  it('passes base test files and verify config as protected files to the worker', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    await new PairPipeline({ stages: ['worker'], maxIterations: 1, roles: { worker: { enabled: true, model: 'w', timeoutMs: 0 } } })
      .run(task(), repo);

    const options = runWorker.mock.calls.at(-1)?.[0] as { protectedFiles?: string[] };
    expect([...(options.protectedFiles ?? [])].sort()).toEqual(GRADER);
    // Production code, manifests and a brand-new test stay writable.
    for (const writable of ['src/a.ts', 'pyproject.toml', 'package.json', 'src/new.test.ts']) {
      expect(options.protectedFiles).not.toContain(writable);
    }
    // The tools' own check refuses the protected test and allows the new one.
    expect(isProtectedPath(path.join(repo, 'src/a.test.ts'), options.protectedFiles)).toBe(true);
    expect(isProtectedPath(path.join(repo, 'src/new.test.ts'), options.protectedFiles)).toBe(false);
  });

  it('allowTestEdits unprotects the matching files', async () => {
    const description = [
      'Rewrite the legacy specs.',
      '```openswarm:dod',
      JSON.stringify({ version: 1, completion: { noChanges: 'park' }, automation: { scopeMismatch: 'park' }, tests: { allowEdits: ['src/legacy/**', '**/conftest.py'] } }),
      '```',
    ].join('\n');

    const files = await computeProtectedFiles(repo, { title: 'Legacy specs', description });

    expect(files.sort()).toEqual(['pkg/x_test.go', 'src/a.test.ts', 'tests/test_x.py', 'vitest.config.ts']);
  });

  it('unprotects a file the issue names, by path or by an unambiguous basename', async () => {
    expect(await computeProtectedFiles(repo, { title: 'Update src/a.test.ts for the new rule' })).not.toContain('src/a.test.ts');
    expect(await computeProtectedFiles(repo, { description: 'test_x.py asserts the old rounding' })).not.toContain('tests/test_x.py');
    // A word that merely contains the name does not count.
    expect(await computeProtectedFiles(repo, { description: 'see mytest_x.py.bak' })).toContain('tests/test_x.py');
  });

  it('protects nothing where git cannot list files, instead of failing the run', async () => {
    expect(await computeProtectedFiles(path.join(repo, 'missing'), { title: 'x' })).toEqual([]);
  });

  it('matches allowEdits globs the way a person writes them', () => {
    expect(globToRegExp('src/legacy/**').test('src/legacy/deep/b.spec.js')).toBe(true);
    expect(globToRegExp('**/conftest.py').test('conftest.py')).toBe(true);
    expect(globToRegExp('**/conftest.py').test('a/b/conftest.py')).toBe(true);
    expect(globToRegExp('src/*.test.ts').test('src/a.test.ts')).toBe(true);
    expect(globToRegExp('src/*.test.ts').test('src/x/a.test.ts')).toBe(false);
    expect(globToRegExp('a.test.ts').test('aXtest.ts')).toBe(false);
  });
});
