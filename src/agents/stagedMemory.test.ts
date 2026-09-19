import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardStagedMemoriesFrom, readStagedMemories, stageMemory } from './stagedMemory.js';

let root = '';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'remember-')); process.env.OPENSWARM_SCRATCHPAD_DIR = root; });
afterEach(() => { delete process.env.OPENSWARM_SCRATCHPAD_DIR; rmSync(root, { recursive: true, force: true }); });

describe('staged agent memory (AGT-4461)', () => {
  it('stays in the scratchpad until its owner promotes it', async () => {
    await stageMemory('AX-1', { kind: 'pattern', title: 'Use migration', content: 'run it first', taskId: 'AX-1', iteration: 1 });
    expect(await readStagedMemories('AX-1')).toEqual([expect.objectContaining({ title: 'Use migration' })]);
  });
  it('drops lessons written by a reverted iteration', async () => {
    await stageMemory('AX-1', { kind: 'pattern', title: 'keep', content: 'one', taskId: 'AX-1', iteration: 1 });
    await stageMemory('AX-1', { kind: 'constraint', title: 'drop', content: 'two', taskId: 'AX-1', iteration: 2 });
    await discardStagedMemoriesFrom('AX-1', 2);
    expect(await readStagedMemories('AX-1')).toEqual([expect.objectContaining({ title: 'keep' })]);
  });
  it('refuses an over-budget lesson instead of truncating it', async () => {
    await expect(stageMemory('AX-1', { kind: 'pattern', title: 'large', content: 'x'.repeat(5000), taskId: 'AX-1', iteration: 1 })).rejects.toThrow('Nothing was written');
    expect(await readStagedMemories('AX-1')).toEqual([]);
  });
});
