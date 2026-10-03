import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A real registry store on a throwaway database, because the behaviour under
// test — which rows exist after a scan, and how writes are batched — is the
// store's, not a mock's. DEFAULT_DB_PATH is read at import time, so HOME has to
// be set before the modules load.
const yields = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../support/yieldToEventLoop.js', () => ({
  yieldToEventLoop: async () => { yields.calls += 1; },
}));

describe('entity scanner: worktrees/ and write batching (AGT-4665)', () => {
  let home: string;
  let repo: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'openswarm-registry-home-'));
    repo = join(home, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    vi.stubEnv('HOME', home);
    vi.resetModules();
    yields.calls = 0;
  });

  afterEach(async () => {
    const { closeRegistryStore } = await import('./sqliteStore.js');
    closeRegistryStore();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function writeRepoFile(path: string, content: string): Promise<void> {
    const fullPath = join(repo, path);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
  }

  it('does not register entities from checkouts under worktrees/', async () => {
    await writeRepoFile('src/real.ts', 'export function realThing(): number {\n  return 1;\n}\n');
    await writeRepoFile('worktrees/feature-x/src/copy.ts', 'export function copiedThing(): number {\n  return 2;\n}\n');

    const { scanRepository } = await import('./entityScanner.js');
    const { getRegistryStore } = await import('./sqliteStore.js');
    await scanRepository(repo, 'p', { allowNonRepo: true });

    const names = getRegistryStore().listEntities({ projectId: 'p' }).entities.map((entity) => entity.name);
    expect(names).toContain('realThing');
    expect(names).not.toContain('copiedThing');
  });

  it('retires rows an earlier scan registered under worktrees/', async () => {
    await writeRepoFile('src/real.ts', 'export function realThing(): number {\n  return 1;\n}\n');
    // The tree still exists on disk, which is exactly why the old "file exists
    // => keep" rule left these active forever.
    await writeRepoFile('worktrees/feature-x/src/copy.ts', 'export function copiedThing(): number {\n  return 2;\n}\n');
    const { getRegistryStore } = await import('./sqliteStore.js');
    const store = getRegistryStore();
    const stale = store.registerEntity({
      projectId: 'p', kind: 'function', name: 'copiedThing', filePath: 'worktrees/feature-x/src/copy.ts',
      status: 'active', author: 'scanner',
    });

    const { scanRepository } = await import('./entityScanner.js');
    const result = await scanRepository(repo, 'p', { allowNonRepo: true });

    expect(store.getEntity(stale.id)?.status).toBe('broken');
    expect(result.removed).toBe(1);
  });

  it('hands the event loop a turn for every slice of writes, and still registers everything', async () => {
    const functions = Array.from({ length: 600 }, (_, index) => `export function bulk${index}(): number {\n  return ${index};\n}\n`);
    await writeRepoFile('src/bulk.ts', functions.join('\n'));

    const { scanRepository } = await import('./entityScanner.js');
    const { getRegistryStore } = await import('./sqliteStore.js');
    const result = await scanRepository(repo, 'p', { allowNonRepo: true });

    expect(result.registered).toBe(600);
    expect(getRegistryStore().listEntities({ projectId: 'p', limit: 1 }).total).toBe(600);
    // 600 rows at 250 per slice is three slices, each followed by a yield.
    expect(yields.calls).toBeGreaterThanOrEqual(3);
  });

  it('retires a large stale set in slices instead of one blocking loop', async () => {
    await writeRepoFile('src/real.ts', 'export function realThing(): number {\n  return 1;\n}\n');
    const { getRegistryStore } = await import('./sqliteStore.js');
    const store = getRegistryStore();
    store.inTransaction(() => {
      for (let index = 0; index < 600; index++) {
        store.registerEntity({
          projectId: 'p', kind: 'function', name: `stale${index}`, filePath: `worktrees/old/file${index}.ts`,
          status: 'active', author: 'scanner',
        });
      }
    });

    const { scanRepository } = await import('./entityScanner.js');
    yields.calls = 0;
    const result = await scanRepository(repo, 'p', { allowNonRepo: true });

    expect(result.removed).toBe(600);
    expect(store.listEntities({ projectId: 'p', status: ['active'], limit: 1000 }).entities.map((entity) => entity.name)).toEqual(['realThing']);
    expect(yields.calls).toBeGreaterThanOrEqual(3);
  });
});
