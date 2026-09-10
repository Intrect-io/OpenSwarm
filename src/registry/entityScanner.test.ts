import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisterEntityInput } from './sqliteStore.js';

const registered: RegisterEntityInput[] = [];

vi.mock('./sqliteStore.js', () => ({
  LIST_ENTITIES_MAX_LIMIT: 5_000,
  getRegistryStore: () => ({
    listEntities: () => ({ entities: [], total: 0 }),
    registerEntity: (input: RegisterEntityInput) => {
      registered.push(input);
      return { id: input.name };
    },
    updateEntity: vi.fn(),
    changeEntityStatus: vi.fn(),
  }),
}));

describe('entity scanner', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'openswarm-registry-'));
    registered.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeProjectFile(path: string, content: string): Promise<void> {
    const fullPath = join(tmp, path);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
  }

  it('maps Python test_ files to matching source entities', async () => {
    await writeProjectFile('src/foo.py', 'def foo():\n    return 1\n');
    await writeProjectFile('tests/test_foo.py', 'def test_foo():\n    assert foo() == 1\n');

    const { scanRepository } = await import('./entityScanner.js');
    const result = await scanRepository(tmp, 'test-project', { allowNonRepo: true });

    expect(result.testsMapped).toBe(1);
    expect(registered).toContainEqual(expect.objectContaining({
      projectId: 'test-project',
      name: 'foo',
      filePath: 'src/foo.py',
      hasTests: true,
      testFile: 'tests/test_foo.py',
    }));
  });
});

describe('scanRepository non-repo guard (INT-2507)', () => {
  it('refuses to scan the home directory', async () => {
    const { scanRepository } = await import('./entityScanner.js');
    const { homedir } = await import('node:os');
    await expect(scanRepository(homedir(), 'junk')).rejects.toThrow(/Refusing to scan the home directory/);
  });

  it('refuses a non-git directory unless allowNonRepo', async () => {
    const { scanRepository } = await import('./entityScanner.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'osw-nonrepo-'));
    await expect(scanRepository(dir, 'junk')).rejects.toThrow(/non-git directory/);
  });
});
