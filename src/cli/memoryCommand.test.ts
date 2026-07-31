import { describe, it, expect, vi } from 'vitest';
import {
  formatMemoryStatus,
  runMemoryCommand,
  type MemoryStatus,
} from './memoryCommand.js';

const status = (over: Partial<MemoryStatus> = {}): MemoryStatus => ({
  memoryDir: '/tmp/.openswarm/memory',
  sqliteMirror: {
    path: '/tmp/.openswarm/memory/cognitive_memory.sqlite',
    exists: true,
    modifiedAt: '2026-07-02T00:00:00.000Z',
  },
  table: 'cognitive_memory',
  exists: true,
  rows: 262,
  schemaFields: ['id', 'type', 'content', 'revisionCount', 'decay', 'stability'],
  legacyColumns: ['revisionCount', 'decay', 'stability'],
  legacyRows: 262,
  transientReviewRejections: 15,
  expiredRows: 2,
  lowImportanceRows: 1,
  avgImportance: 0.84,
  ...over,
});

describe('formatMemoryStatus', () => {
  it('shows legacy/noisy memory counters and cleanup hint', () => {
    const out = formatMemoryStatus(status());
    expect(out).toContain('/tmp/.openswarm/memory');
    expect(out).toContain('legacy schema: revisionCount, decay, stability');
    expect(out).toContain('legacy rows:   262');
    expect(out).toContain('noisy reviewer failures: 15');
    expect(out).toContain('openswarm memory compact');
  });

  it('omits the cleanup hint for a clean lean table', () => {
    const out = formatMemoryStatus(status({
      schemaFields: ['id', 'type', 'content', 'importance'],
      legacyColumns: [],
      legacyRows: 0,
      transientReviewRejections: 0,
      expiredRows: 0,
      lowImportanceRows: 0,
    }));
    expect(out).toContain('legacy schema: none');
    expect(out).not.toContain('cleanup available');
  });
});

describe('runMemoryCommand', () => {
  it('returns JSON status when requested', async () => {
    const out = await runMemoryCommand('status', { json: true }, { inspect: async () => status() });
    expect(JSON.parse(out)).toMatchObject({ rows: 262, transientReviewRejections: 15 });
  });

  it('blocks compact while the daemon is running unless forced', async () => {
    await expect(runMemoryCommand('compact', {}, {
      inspect: async () => status(),
      compact: vi.fn(),
      daemonRunning: () => true,
    })).rejects.toThrow(/daemon is running/);
  });

  it('compacts explicitly and reports before/after cleanup', async () => {
    const compact = vi.fn(async () => ({ before: 262, after: 247, removed: 15, deduplicated: 0 }));
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({
        rows: 247,
        schemaFields: ['id', 'type', 'content', 'importance'],
        legacyColumns: [],
        legacyRows: 0,
        transientReviewRejections: 0,
        expiredRows: 0,
        lowImportanceRows: 0,
        avgImportance: 0.83,
      }));

    const out = await runMemoryCommand('compact', { force: true }, {
      inspect,
      compact,
      daemonRunning: () => true,
    });

    expect(compact).toHaveBeenCalled();
    expect(out).toContain('rows: 262 -> 247');
    expect(out).toContain('legacy schema: none');
    expect(out).toContain('noisy reviewer failures: 15 -> 0');
  });

  it('blocks reembed while the daemon is running unless forced', async () => {
    // Re-embedding swaps the whole table; a concurrent daemon writer would race it.
    const reembed = vi.fn();
    await expect(runMemoryCommand('reembed', {}, {
      inspect: async () => status(),
      reembed,
      daemonRunning: () => true,
    })).rejects.toThrow(/daemon is running/);
    expect(reembed).not.toHaveBeenCalled();
  });

  it('re-embeds and reports the resulting signature', async () => {
    const reembed = vi.fn(async () => ({
      total: 455,
      reembedded: 455,
      empty: 0,
      signature: 'Xenova/multilingual-e5-base|dtype=q8|dim=768|max=512|pp=passage: |qp=query: ',
    }));

    const out = await runMemoryCommand('reembed', { force: true }, {
      inspect: async () => status(),
      reembed,
      daemonRunning: () => true,
    });

    expect(reembed).toHaveBeenCalled();
    expect(out).toContain('records:   455 (455 encoded, 0 empty)');
    expect(out).toContain('dim=768');
  });

  it('returns JSON for reembed when requested', async () => {
    const out = await runMemoryCommand('reembed', { json: true }, {
      inspect: async () => status(),
      reembed: async () => ({ total: 2, reembedded: 1, empty: 1, signature: 'sig' }),
      daemonRunning: () => false,
    });
    expect(JSON.parse(out)).toMatchObject({ total: 2, reembedded: 1, empty: 1, signature: 'sig' });
  });

  it('rejects unknown actions', async () => {
    await expect(runMemoryCommand('wat', {}, { inspect: async () => status() })).rejects.toThrow(/Unknown memory action/);
  });
});
