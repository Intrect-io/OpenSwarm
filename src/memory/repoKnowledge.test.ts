import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageMemory } from '../agents/stagedMemory.js';

const mocks = vi.hoisted(() => ({
  saveMemory: vi.fn(async () => 'memory-id'),
}));

// Stub the memory core so searchRepoMemoryText is tested without LanceDB / embeddings.
// Branch on the query string to exercise each path.
vi.mock('./memoryCore.js', () => ({
  saveMemory: mocks.saveMemory,
  searchMemorySafe: async (query: string) => {
    if (query === 'fail') return { success: false, memories: [], errorCode: 'DB_INIT_FAILED' };
    if (query === 'empty') return { success: true, memories: [] };
    return {
      success: true,
      memories: [{ type: 'system_pattern', title: 'Solved: add logout', content: 'wired it into the header' }],
    };
  },
}));

import { promoteStagedMemories, recordTaskOutcome, searchRepoMemoryText, repoKey } from './repoKnowledge.js';

describe('repoKey', () => {
  it('normalizes a per-issue worktree path back to the repo', () => {
    expect(repoKey('/Users/x/dev/vega-agent/worktree/abc-123')).toBe('/Users/x/dev/vega-agent');
  });
  it('leaves a plain repo path unchanged', () => {
    expect(repoKey('/Users/x/dev/vega-agent')).toBe('/Users/x/dev/vega-agent');
  });
  it('strips a worktree path with a trailing slash too', () => {
    expect(repoKey('/Users/x/dev/vega-agent/worktree/id/')).toBe('/Users/x/dev/vega-agent');
  });
});

describe('searchRepoMemoryText', () => {
  it('requires a non-empty query', async () => {
    expect(await searchRepoMemoryText('/repo', '   ')).toContain('non-empty query');
  });

  it('reports gracefully when memory is unavailable', async () => {
    const text = await searchRepoMemoryText('/repo', 'fail');
    expect(text).toContain('Memory unavailable');
    expect(text).toContain('DB_INIT_FAILED');
  });

  it('returns a friendly note when nothing matches', async () => {
    expect(await searchRepoMemoryText('/repo', 'empty')).toContain('No matching repo knowledge yet');
  });

  it('formats hits with type tags and a count', async () => {
    const text = await searchRepoMemoryText('/repo', 'logout');
    expect(text).toContain('Repository knowledge (1):');
    expect(text).toContain('[system_pattern] Solved: add logout');
    expect(text).toContain('wired it into the header');
  });
});

describe('recordTaskOutcome', () => {
  it('does not store transient reviewer/API failures as repo constraints', async () => {
    mocks.saveMemory.mockClear();

    await recordTaskOutcome('/repo', {
      taskTitle: 'run benchmark',
      derivedFrom: 'INT-1',
      rejectionFeedback: 'API error: Codex responses error (429): {"error":{"type":"usage_limit_reached"}}',
    });

    expect(mocks.saveMemory).not.toHaveBeenCalled();
  });

  it('stores actionable reviewer rejection with calibrated importance and metadata', async () => {
    mocks.saveMemory.mockClear();

    await recordTaskOutcome('/repo', {
      taskTitle: 'wire logout',
      derivedFrom: 'INT-2',
      rejectionFeedback: 'Implementation changed no files and did not run verification.',
    });

    expect(mocks.saveMemory).toHaveBeenCalledTimes(1);
    const call = mocks.saveMemory.mock.calls[0];
    expect(call[0]).toBe('constraint');
    expect(call[3]).toContain('Actionable reviewer feedback');
    expect(call[4]).toMatchObject({
      importance: 0.82,
      confidence: 0.82,
      metadata: {
        kind: 'review_rejection',
        transient: false,
        actionable: true,
      },
    });
  });
});

describe('promoteStagedMemories', () => {
  it('promotes staged lessons only when the green completion path calls it, with provenance', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-memory-stage-'));
    const previous = process.env.OPENSWARM_SCRATCHPAD_DIR;
    process.env.OPENSWARM_SCRATCHPAD_DIR = root;
    try {
      mocks.saveMemory.mockClear();
      await stageMemory('AX-1', { kind: 'pattern', title: 'migration order', content: 'run reader first', taskId: 'AX-1', iteration: 2 });
      await promoteStagedMemories('/repo', 'AX-1', { taskId: 'AX-1', attempt: 4 });
      expect(mocks.saveMemory).toHaveBeenCalledWith('system_pattern', '/repo', 'migration order', 'run reader first', expect.objectContaining({
        metadata: expect.objectContaining({ kind: 'agent_remember', taskId: 'AX-1', attempt: 4, iteration: 2 }),
      }));
    } finally {
      if (previous === undefined) delete process.env.OPENSWARM_SCRATCHPAD_DIR; else process.env.OPENSWARM_SCRATCHPAD_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
