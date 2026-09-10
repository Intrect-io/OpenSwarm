// ============================================
// OpenSwarm - Entity Scanner coverage tests
// Created: 2026-07-10
// Purpose: Cover branches left untested by entityScanner.test.ts —
//          non-Python (brace-block) languages, TS import-based test mapping,
//          isNearbyTest directory-shape branches, walk() I/O error paths,
//          and the existing-entity update / removed-entity registry sync paths.
// Dependencies: registry/entityScanner, registry/sqliteStore (mocked)
// ============================================

import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisterEntityInput, UpdateEntityInput } from './sqliteStore.js';
import type { CodeEntity } from './schema.js';

interface MockState {
  existingEntities: CodeEntity[];
  registered: RegisterEntityInput[];
  updated: Array<{ id: string; patch: UpdateEntityInput }>;
  statusChanges: Array<{ id: string; status: string }>;
  registerShouldThrowFor: Set<string>;
  listCalls: Array<{ limit: number; offset: number }>;
}

const state: MockState = {
  existingEntities: [],
  registered: [],
  updated: [],
  statusChanges: [],
  registerShouldThrowFor: new Set(),
  listCalls: [],
};

function resetState(): void {
  state.existingEntities = [];
  state.registered = [];
  state.updated = [];
  state.statusChanges = [];
  state.registerShouldThrowFor = new Set();
  state.listCalls = [];
}

vi.mock('./sqliteStore.js', () => ({
  LIST_ENTITIES_MAX_LIMIT: 2,
  getRegistryStore: () => ({
    listEntities: (filter?: { limit?: number; offset?: number }) => {
      const limit = filter?.limit ?? state.existingEntities.length;
      const offset = filter?.offset ?? 0;
      state.listCalls.push({ limit, offset });
      return {
        entities: state.existingEntities.slice(offset, offset + limit),
        total: state.existingEntities.length,
      };
    },
    registerEntity: (input: RegisterEntityInput) => {
      if (state.registerShouldThrowFor.has(input.name)) {
        throw new Error(`simulated register failure for ${input.name}`);
      }
      state.registered.push(input);
      return { id: input.name };
    },
    updateEntity: (id: string, patch: UpdateEntityInput) => {
      state.updated.push({ id, patch });
      return null;
    },
    changeEntityStatus: (id: string, status: string) => {
      state.statusChanges.push({ id, status });
      return null;
    },
  }),
}));

/** Minimal CodeEntity factory — fills required schema fields with fixed defaults. */
function makeExistingEntity(overrides: Partial<CodeEntity> & { qualifiedName: string; filePath: string }): CodeEntity {
  return {
    id: overrides.qualifiedName,
    projectId: 'test-project',
    kind: 'function',
    name: overrides.qualifiedName.split('::').pop() ?? 'unknown',
    status: 'active',
    hasTests: false,
    riskLevel: 'low',
    description: '',
    notes: '',
    tags: [],
    warnings: [],
    linkedIssueIds: [],
    linkedMemoryIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Best-effort recursive chmod restore — some tests deliberately lock down
 * permissions to exercise error paths and must undo that before rm(). */
async function chmodRecursive(path: string): Promise<void> {
  try {
    await chmod(path, 0o755);
  } catch {
    return;
  }
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      await chmodRecursive(full);
    } else {
      try {
        await chmod(full, 0o644);
      } catch {
        // best effort
      }
    }
  }
}

describe('entity scanner coverage extensions', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'openswarm-registry-cov-'));
    resetState();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await chmodRecursive(tmp);
    await rm(tmp, { recursive: true, force: true });
  });

  async function writeProjectFile(path: string, content: string): Promise<void> {
    const fullPath = join(tmp, path);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
  }

  it('extracts brace-block TS entities and maps import-based test coverage (incl. index.ts candidate fallback)', async () => {
    // Direct match: tests/util.test.ts imports { add } from '../src/util' -> candidate 'src/util.ts' hits on first try.
    await writeProjectFile(
      'src/util.ts',
      [
        'export function add(a: number, b: number): number {',
        '  const result = a + b;',
        '  return result;',
        '}',
        '',
        'export class Calculator {',
        '  value: number;',
        '  constructor() {',
        '    this.value = 0;',
        '  }',
        '}',
      ].join('\n'),
    );
    await writeProjectFile(
      'tests/util.test.ts',
      [
        "import { describe, it, expect } from 'vitest';",
        "import { add } from '../src/util';",
        "describe('add', () => {",
        "  it('adds', () => { expect(add(1, 2)).toBe(3); });",
        '});',
      ].join('\n'),
    );

    // Index-fallback match: import '../src/widget' resolves through .ts/.tsx/.js misses
    // before landing on 'src/widget/index.ts' (exercises the candidate-loop continue branch).
    await writeProjectFile(
      'src/widget/index.ts',
      ['export function render(): string {', "  return 'ok';", '}'].join('\n'),
    );
    await writeProjectFile(
      'tests/widget.test.ts',
      [
        "import { render } from '../src/widget';",
        "test('renders', () => { render(); });",
      ].join('\n'),
    );

    const { scanRepository } = await import('./entityScanner.js');
    const result = await scanRepository(tmp, 'test-project', { allowNonRepo: true, verbose: true });

    expect(result.errors).toEqual([]);
    const addEntity = state.registered.find(e => e.name === 'add');
    const renderEntity = state.registered.find(e => e.name === 'render');
    expect(addEntity?.hasTests).toBe(true);
    expect(addEntity?.testFile).toBe('tests/util.test.ts');
    expect(renderEntity?.hasTests).toBe(true);
    expect(renderEntity?.testFile).toBe('tests/widget.test.ts');

    const calculatorEntity = state.registered.find(e => e.name === 'Calculator');
    expect(calculatorEntity).toBeDefined();
    expect(calculatorEntity?.kind).toBe('class');
  });

  it('maps referenced-name test coverage across every isNearbyTest directory shape', async () => {
    // same directory, different basenames -> sourceDir === testDir (line ~600)
    await writeProjectFile('src/samedir/one.ts', 'export function alpha(): void {\n  return;\n}\n');
    await writeProjectFile(
      'src/samedir/two.test.ts',
      "import { it } from 'vitest';\nit('x', () => { alpha(); });\n",
    );

    // sourceDir/__tests__ (line ~601)
    await writeProjectFile('src/mod2/helper.ts', 'export function beta(): void {\n  return;\n}\n');
    await writeProjectFile(
      'src/mod2/__tests__/other.test.ts',
      "import { it } from 'vitest';\nit('x', () => { beta(); });\n",
    );

    // sourceDir/tests (line ~602)
    await writeProjectFile('src/mod3/thing.ts', 'export function gamma(): void {\n  return;\n}\n');
    await writeProjectFile(
      'src/mod3/tests/other2.test.ts',
      "import { it } from 'vitest';\nit('x', () => { gamma(); });\n",
    );

    // sourceDir/test (line ~603)
    await writeProjectFile('src/mod4/piece.ts', 'export function delta(): void {\n  return;\n}\n');
    await writeProjectFile(
      'src/mod4/test/other3.test.ts',
      "import { it } from 'vitest';\nit('x', () => { delta(); });\n",
    );

    // dirname(sourceDir)/__tests__ (lines ~605-606)
    await writeProjectFile('src/mod5/deep/inner.ts', 'export function epsilon(): void {\n  return;\n}\n');
    await writeProjectFile(
      'src/mod5/__tests__/other4.test.ts',
      "import { it } from 'vitest';\nit('x', () => { epsilon(); });\n",
    );

    // Completely unrelated dirs/names -> falls through every branch to `return false` (line ~608)
    await writeProjectFile('src/mod6/xray.ts', 'export function zeta(): void {\n  return;\n}\n');
    await writeProjectFile(
      'zzzrandom/place.test.ts',
      "import { it } from 'vitest';\nit('x', () => { zeta(); });\n",
    );

    const { scanRepository } = await import('./entityScanner.js');
    await scanRepository(tmp, 'test-project', { allowNonRepo: true });

    const byName = (name: string) => state.registered.find(e => e.name === name);
    expect(byName('alpha')?.hasTests).toBe(true);
    expect(byName('beta')?.hasTests).toBe(true);
    expect(byName('gamma')?.hasTests).toBe(true);
    expect(byName('delta')?.hasTests).toBe(true);
    expect(byName('epsilon')?.hasTests).toBe(true);
    expect(byName('zeta')?.hasTests).toBe(false);
  });

  it('logs skip and continues when a subdirectory cannot be read (permission denied)', async () => {
    await writeProjectFile('src/readable.ts', 'export function readableFn(): void {\n  return;\n}\n');
    await mkdir(join(tmp, 'src', 'locked'), { recursive: true });
    await writeProjectFile('src/locked/hidden.ts', 'export function hiddenFn(): void {\n  return;\n}\n');
    await chmod(join(tmp, 'src', 'locked'), 0o000);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { scanRepository } = await import('./entityScanner.js');
    const result = await scanRepository(tmp, 'test-project', { allowNonRepo: true, verbose: true });

    // The locked subtree is skipped entirely — its function never gets extracted —
    // while the sibling file outside it still scans fine.
    expect(state.registered.some(e => e.name === 'readableFn')).toBe(true);
    expect(state.registered.some(e => e.name === 'hiddenFn')).toBe(false);
    expect(result.errors.some(error => error.includes('src/locked'))).toBe(true);
    expect(logSpy.mock.calls.some(call => String(call[0]).includes('skip dir'))).toBe(true);
    logSpy.mockRestore();
  });

  it('records an error and skips a file whose stat() call fails mid-walk', async () => {
    // A directory with read but no execute/search permission lets readdir() list
    // names successfully while stat() on any child fails with EACCES.
    await mkdir(join(tmp, 'src', 'nostat'), { recursive: true });
    await writeProjectFile('src/nostat/unreachable.ts', 'export function unreachableFn(): void {\n  return;\n}\n');
    await chmod(join(tmp, 'src', 'nostat'), 0o444);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { scanRepository } = await import('./entityScanner.js');
    const result = await scanRepository(tmp, 'test-project', { allowNonRepo: true, verbose: true });

    expect(state.registered.some(e => e.name === 'unreachableFn')).toBe(false);
    expect(result.errors.some(error => error.includes('src/nostat/unreachable.ts'))).toBe(true);
    logSpy.mockRestore();
  });

  it('records an error when readFile fails for an unreadable file', async () => {
    await writeProjectFile('src/locked.ts', 'export function lockedFn(): void {\n  return;\n}\n');
    await chmod(join(tmp, 'src', 'locked.ts'), 0o000);

    const { scanRepository } = await import('./entityScanner.js');
    const result = await scanRepository(tmp, 'test-project', { allowNonRepo: true });

    expect(state.registered.some(e => e.name === 'lockedFn')).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('src/locked.ts');
  });

  it('updates an existing entity whose signature/line data changed and reports the registerEntity failure path', async () => {
    await writeProjectFile('src/changed.ts', 'export function changedFn(a: number): number {\n  return a;\n}\n');
    await writeProjectFile('src/willFail.ts', 'export function willFailFn(): void {\n  return;\n}\n');

    state.existingEntities = [
      makeExistingEntity({
        qualifiedName: 'src/changed.ts::changedFn',
        filePath: 'src/changed.ts',
        name: 'changedFn',
        lineStart: 999, // deliberately stale so needsUpdate evaluates true
        lineEnd: 999,
        signature: '(stale)',
        author: 'scanner',
      }),
    ];
    state.registerShouldThrowFor.add('willFailFn');

    const { scanRepository } = await import('./entityScanner.js');
    const result = await scanRepository(tmp, 'test-project', { allowNonRepo: true });

    expect(result.updated).toBe(1);
    expect(state.updated).toHaveLength(1);
    expect(state.updated[0].id).toBe('src/changed.ts::changedFn');
    expect(state.updated[0].patch.lineStart).not.toBe(999);

    expect(result.errors).toEqual([
      expect.stringContaining('register src/willFail.ts::willFailFn'),
    ]);
    expect(state.registered.some(e => e.name === 'willFailFn')).toBe(false);
  });

  it('leaves an existing entity untouched when nothing changed (needsUpdate false)', async () => {
    await writeProjectFile('src/stable.ts', 'export function stableFn(): void {\n  return;\n}\n');

    const { scanRepository: scanFirst } = await import('./entityScanner.js');
    await scanFirst(tmp, 'test-project', { allowNonRepo: true });
    const firstRegistered = state.registered.find(e => e.name === 'stableFn');
    expect(firstRegistered).toBeDefined();

    // Second scan: pretend the store already has exactly what was just extracted.
    state.existingEntities = [
      makeExistingEntity({
        qualifiedName: 'src/stable.ts::stableFn',
        filePath: 'src/stable.ts',
        name: 'stableFn',
        lineStart: firstRegistered!.lineStart,
        lineEnd: firstRegistered!.lineEnd,
        signature: firstRegistered!.signature,
        hasTests: false,
        testFile: undefined,
        complexityScore: 0,
        riskLevel: 'low',
        author: 'scanner',
      }),
    ];
    state.registered = [];

    const { scanRepository } = await import('./entityScanner.js');
    const result = await scanRepository(tmp, 'test-project', { allowNonRepo: true });

    expect(result.updated).toBe(0);
    expect(result.registered).toBe(0);
    expect(state.updated).toEqual([]);
  });

  it('falls back to an undefined block end for a malformed file whose braces never close', async () => {
    // Truncated/malformed source: the function's opening brace never finds a
    // matching close within the file, so findBraceBlockEnd must fall through
    // its scan loop and return undefined instead of a line index.
    await writeProjectFile(
      'src/truncated.ts',
      [
        'export function truncatedFn(): void {',
        '  const x = 1;',
        '  if (x > 0) {',
        '    console.log(x);',
        // deliberately no closing braces at all — malformed/unparseable tail
      ].join('\n'),
    );

    const { scanRepository } = await import('./entityScanner.js');
    const result = await scanRepository(tmp, 'test-project', { allowNonRepo: true });

    expect(result.errors).toEqual([]);
    const entity = state.registered.find(e => e.name === 'truncatedFn');
    expect(entity).toBeDefined();
    expect(entity?.lineEnd).toBeUndefined();
  });

  it('marks scanner-authored entities as broken when their source file is gone, and skips non-eligible ones', async () => {
    await writeProjectFile('src/stillHere.ts', 'export function stillHereFn(): void {\n  return;\n}\n');

    state.existingEntities = [
      // Still extracted this scan -> must be skipped (continue branch on extractedQNames.has).
      makeExistingEntity({
        qualifiedName: 'src/stillHere.ts::stillHereFn',
        filePath: 'src/stillHere.ts',
        name: 'stillHereFn',
        author: 'scanner',
        status: 'active',
      }),
      // Not scanner-authored -> must be skipped (continue branch on author check).
      makeExistingEntity({
        qualifiedName: 'src/manual.ts::manualFn',
        filePath: 'src/manual.ts',
        name: 'manualFn',
        author: 'human',
        status: 'active',
      }),
      // Already broken -> must be skipped (continue branch on status check).
      makeExistingEntity({
        qualifiedName: 'src/already.ts::alreadyBroken',
        filePath: 'src/already.ts',
        name: 'alreadyBroken',
        author: 'scanner',
        status: 'broken',
      }),
      // Scanner-authored, active, file no longer on disk -> should be marked broken.
      makeExistingEntity({
        qualifiedName: 'src/gone.ts::goneFn',
        filePath: 'src/gone.ts',
        name: 'goneFn',
        author: 'scanner',
        status: 'active',
      }),
    ];

    const { scanRepository } = await import('./entityScanner.js');
    const result = await scanRepository(tmp, 'test-project', { allowNonRepo: true });

    expect(result.removed).toBe(1);
    expect(state.statusChanges).toEqual([{ id: 'src/gone.ts::goneFn', status: 'broken' }]);
  });

  it('reconciles every page when the registry exceeds one listEntities page', async () => {
    await writeProjectFile('src/keep.ts', 'export function keepFn(): void {\n  return;\n}\n');

    // With LIST_ENTITIES_MAX_LIMIT mocked to 2, five stale entities force 3+ pages.
    state.existingEntities = [
      makeExistingEntity({
        qualifiedName: 'src/keep.ts::keepFn',
        filePath: 'src/keep.ts',
        name: 'keepFn',
        author: 'scanner',
        status: 'active',
      }),
      ...[0, 1, 2, 3, 4].map((i) => makeExistingEntity({
        qualifiedName: `src/stale${i}.ts::stale${i}`,
        filePath: `src/stale${i}.ts`,
        name: `stale${i}`,
        author: 'scanner',
        status: 'active',
      })),
    ];

    const { scanRepository } = await import('./entityScanner.js');
    const result = await scanRepository(tmp, 'test-project', { allowNonRepo: true });

    expect(state.listCalls.length).toBeGreaterThan(1);
    expect(state.listCalls[0]).toEqual({ limit: 2, offset: 0 });
    expect(state.listCalls[1]).toEqual({ limit: 2, offset: 2 });
    expect(result.removed).toBe(5);
    expect(state.statusChanges.map((c) => c.id).sort()).toEqual([
      'src/stale0.ts::stale0',
      'src/stale1.ts::stale1',
      'src/stale2.ts::stale2',
      'src/stale3.ts::stale3',
      'src/stale4.ts::stale4',
    ]);
  });
});

describe('normalizeScanTraversalOptions', () => {
  it('parses, clamps, and falls back for depth/timeout overrides', async () => {
    const { normalizeScanTraversalOptions } = await import('./entityScanner.js');
    expect(normalizeScanTraversalOptions()).toEqual({ maxDepth: 15, timeoutMs: 180_000 });
    expect(normalizeScanTraversalOptions({ maxDepth: 3, timeoutMs: 5_000 }))
      .toEqual({ maxDepth: 3, timeoutMs: 5_000 });
    expect(normalizeScanTraversalOptions({ maxDepth: 999, timeoutMs: 999_999 }))
      .toEqual({ maxDepth: 15, timeoutMs: 180_000 });
    expect(normalizeScanTraversalOptions({ maxDepth: 0, timeoutMs: 10 }))
      .toEqual({ maxDepth: 1, timeoutMs: 1_000 });
    expect(normalizeScanTraversalOptions({ maxDepth: Number.NaN, timeoutMs: Number.POSITIVE_INFINITY }))
      .toEqual({ maxDepth: 15, timeoutMs: 180_000 });
  });
});
