// Coverage for the real (non-dependency-injected) code paths in memoryCommand.ts:
// memoryDir(), sqliteMirrorInfo(), and inspectMemoryStatus(). memoryCommand.test.ts
// already covers formatMemoryStatus() and runMemoryCommand() via injected deps.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// memoryDir() derives its path from homedir() at call time — point it at an
// isolated temp dir so this suite never touches the real ~/.openswarm/memory.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'osw-memory-cmd-test-home-'));
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => TEST_HOME };
});

interface FakeTable {
  schema: () => Promise<{ fields: Array<{ name: string }> }>;
  search: (vector: number[]) => { limit: (n: number) => { toArray: () => Promise<unknown[]> } };
}

function fakeTable(schemaFields: string[], rows: unknown[]): FakeTable {
  return {
    schema: async () => ({ fields: schemaFields.map((name) => ({ name })) }),
    search: () => ({
      limit: () => ({
        toArray: async () => rows,
      }),
    }),
  };
}

const connectMock = vi.fn();
vi.mock('@lancedb/lancedb', () => ({
  connect: (...args: unknown[]) => connectMock(...args),
}));

const { memoryDir, inspectMemoryStatus } = await import('./memoryCommand.js');

const MEMORY_DIR = join(TEST_HOME, '.openswarm', 'memory');

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('memoryDir', () => {
  it('resolves under the (mocked) home directory', () => {
    expect(memoryDir()).toBe(MEMORY_DIR);
  });
});

describe('inspectMemoryStatus', () => {
  it('reports a missing memory dir without touching LanceDB', async () => {
    const status = await inspectMemoryStatus(MEMORY_DIR);
    expect(status).toEqual({
      memoryDir: MEMORY_DIR,
      sqliteMirror: { path: join(MEMORY_DIR, 'cognitive_memory.sqlite'), exists: false },
      table: null,
      exists: false,
      rows: 0,
      schemaFields: [],
      legacyColumns: [],
      legacyRows: 0,
      transientReviewRejections: 0,
      expiredRows: 0,
      lowImportanceRows: 0,
      avgImportance: 0,
    });
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('detects the SQLite mirror file when present', async () => {
    mkdirSync(MEMORY_DIR, { recursive: true });
    const sqlitePath = join(MEMORY_DIR, 'cognitive_memory.sqlite');
    writeFileSync(sqlitePath, 'fake-sqlite-bytes');
    connectMock.mockResolvedValue({
      tableNames: async () => [],
      openTable: async () => { throw new Error('should not be called'); },
    });

    const status = await inspectMemoryStatus(MEMORY_DIR);
    expect(status.sqliteMirror.exists).toBe(true);
    expect(status.sqliteMirror.path).toBe(sqlitePath);
    expect(status.sqliteMirror.modifiedAt).toBeDefined();
    // No table found (empty tableNames) -> early-return branch, table stays null.
    expect(status.table).toBeNull();
    expect(status.exists).toBe(true);
    expect(status.rows).toBe(0);
  });

  it('falls back to a table whose name merely contains "memory"', async () => {
    mkdirSync(MEMORY_DIR, { recursive: true });
    // No table literally named "cognitive_memory", but "legacy_memory_table"
    // matches the `.includes('memory')` fallback, so openTable IS called on it.
    connectMock.mockResolvedValue({
      tableNames: async () => ['legacy_memory_table'],
      openTable: async (name: string) => {
        expect(name).toBe('legacy_memory_table');
        return fakeTable(['id', 'content'], []);
      },
    });

    const status = await inspectMemoryStatus(MEMORY_DIR);
    expect(status.table).toBe('legacy_memory_table');
    expect(status.rows).toBe(0);
    expect(status.avgImportance).toBe(0);
  });

  it('aggregates legacy columns, transient rejections, expiry, and low-importance rows', async () => {
    mkdirSync(MEMORY_DIR, { recursive: true });
    const now = Date.now();
    const rows = [
      // Legacy schema columns present on the row itself.
      { id: '1', type: 'fact', content: 'x', revisionCount: 3, importance: 0.5, expiresAt: 9999999999999 },
      // Transient review-rejection memory (recognized by memoryFilters).
      {
        id: '2',
        type: 'constraint',
        title: 'Review rejection: flaky lint',
        content: 'reviewer execution failed: rate limit exceeded, retry later',
        importance: 0.4,
        expiresAt: 9999999999999,
      },
      // Expired row (expiresAt in the past, below the permanent-expiry sentinel).
      { id: '3', type: 'fact', content: 'stale', importance: 0.3, expiresAt: now - 1000 },
      // Low-importance row.
      { id: '4', type: 'fact', content: 'noise', importance: 0.05, expiresAt: 9999999999999 },
      // Plain healthy row — no flags set.
      { id: '5', type: 'fact', content: 'healthy', importance: 0.9, expiresAt: 9999999999999 },
    ];
    connectMock.mockResolvedValue({
      tableNames: async () => ['cognitive_memory'],
      openTable: async (name: string) => {
        expect(name).toBe('cognitive_memory');
        return fakeTable(['id', 'type', 'content', 'title', 'importance', 'expiresAt', 'revisionCount'], rows);
      },
    });

    const status = await inspectMemoryStatus(MEMORY_DIR);
    expect(status.table).toBe('cognitive_memory');
    expect(status.rows).toBe(5);
    expect(status.legacyColumns).toEqual(['revisionCount']);
    expect(status.legacyRows).toBe(1);
    expect(status.transientReviewRejections).toBe(1);
    expect(status.expiredRows).toBe(1);
    expect(status.lowImportanceRows).toBe(1);
    expect(status.avgImportance).toBeCloseTo((0.5 + 0.4 + 0.3 + 0.05 + 0.9) / 5, 10);
  });
});
