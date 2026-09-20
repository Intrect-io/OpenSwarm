// AGT-3490 — scan limits must produce an explicit incompleteness signal,
// not silently absent coverage.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'openswarm-coverage-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('incomplete scan coverage', () => {
  it('reports oversized source files in the entity scanner instead of dropping them silently', async () => {
    const store: { warnings: string[] } = { warnings: [] };
    vi.doMock('./sqliteStore.js', () => ({
      LIST_ENTITIES_MAX_LIMIT: 2,
      getRegistryStore: () => ({
        listEntities: () => ({ entities: [], total: 0 }),
        registerEntity: (input: { name: string }) => {
          store.warnings.push(input.name);
        },
        updateEntity: () => null,
        changeEntityStatus: () => null,
      }),
    }));
    const { scanRepository } = await import('./entityScanner.js');

    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(join(tmp, 'src/normal.ts'), 'export function normalFn(): void {\n  return;\n}\n', 'utf-8');
    await writeFile(
      join(tmp, 'src/huge.ts'),
      `// ${'x'.repeat(600 * 1024)}\nexport function hugeFn(): void {\n  return;\n}\n`,
      'utf-8',
    );

    const result = await scanRepository(tmp, 'test-project', { allowNonRepo: true });
    expect(result.scanned).toBe(1);
    expect(result.errors.some((error) => error.includes('src/huge.ts'))).toBe(true);
    expect(result.incomplete).toBe(true);
    expect(result.incompleteReasons.some((reason) => reason.includes('src/huge.ts'))).toBe(true);
    expect(result.errors.length).toBe(1);
  });

  it('reports depth and timeout truncation in the entity scanner', async () => {
    vi.doMock('./sqliteStore.js', () => ({
      LIST_ENTITIES_MAX_LIMIT: 2,
      getRegistryStore: () => ({
        listEntities: () => ({ entities: [], total: 0 }),
        registerEntity: () => null,
        updateEntity: () => null,
        changeEntityStatus: () => null,
      }),
    }));
    const { scanRepository } = await import('./entityScanner.js');

    await mkdir(join(tmp, 'a/b/c/d/e/f/g'), { recursive: true });
    await writeFile(
      join(tmp, 'a/b/c/d/e/f/g/deep.ts'),
      'export function deepFn(): void {\n  return;\n}\n',
      'utf-8',
    );

    const result = await scanRepository(tmp, 'test-project', {
      allowNonRepo: true,
      maxDepth: 2,
      timeoutMs: 180_000,
    });
    expect(result.incomplete).toBe(true);
    expect(result.incompleteReasons.some((reason) => reason.includes('depth limit 2'))).toBe(true);
  });

  it('reports oversized source files in the BS detector instead of dropping them silently', async () => {
    const { scanRepository } = await import('./bsDetector.js');

    await mkdir(join(tmp, 'src'), { recursive: true });
    await writeFile(
      join(tmp, 'src/huge.ts'),
      `// ${'x'.repeat(600 * 1024)}\nfunction huge(): void {}\n`,
      'utf-8',
    );

    const result = await scanRepository(tmp, { verbose: false });
    expect(result.incomplete).toBe(true);
    expect(result.incompleteReasons.some((reason) => reason.includes('src/huge.ts'))).toBe(true);
    expect(result.issues.some((issue) => issue.message.includes('src/huge.ts'))).toBe(true);
  });
});
