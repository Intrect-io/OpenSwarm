import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_DEFINITIONS, executeTool, type ToolCall } from './tools.js';
import { readNote, writeNote, SCRATCHPAD_NOTE_BYTE_CAP } from '../support/scratchpad.js';
import { readStagedMemories } from '../agents/stagedMemory.js';

const makeCall = (name: string, args: unknown): ToolCall => ({
  id: `call-${name}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

let root: string;
const previous = process.env.OPENSWARM_SCRATCHPAD_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tools-scratch-'));
  process.env.OPENSWARM_SCRATCHPAD_DIR = root;
});
afterEach(() => {
  if (previous === undefined) delete process.env.OPENSWARM_SCRATCHPAD_DIR;
  else process.env.OPENSWARM_SCRATCHPAD_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

describe('scratch tools', () => {
  it('are declared so a model can find them', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.function.name);
    expect(names).toContain('scratch_write');
    expect(names).toContain('scratch_read');
    expect(names).toContain('remember');
  });

  it('writes and reads a note back', async () => {
    const write = await executeTool(
      makeCall('scratch_write', { name: 'approach', content: 'registry first' }),
      '/work', undefined, { scratchpadRunId: 'AX-1' },
    );
    expect(write.is_error).toBe(false);
    expect(await readNote('AX-1', 'approach')).toBe('registry first');

    const read = await executeTool(
      makeCall('scratch_read', { name: 'approach' }),
      '/work', undefined, { scratchpadRunId: 'AX-1' },
    );
    expect(read.content).toBe('registry first');
  });

  it('lists notes when scratch_read is called without a name', async () => {
    await writeNote('AX-1', 'approach', 'x');
    const listed = await executeTool(
      makeCall('scratch_read', {}), '/work', undefined, { scratchpadRunId: 'AX-1' },
    );
    expect(listed.content).toContain('approach');
  });

  it('says so, rather than guessing a run, when the stage has no scratchpad', async () => {
    const result = await executeTool(makeCall('scratch_write', { name: 'a', content: 'b' }), '/work');
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('NO_SCRATCHPAD');
  });

  it('hands a budget refusal back to the model instead of throwing', async () => {
    const result = await executeTool(
      makeCall('scratch_write', { name: 'big', content: 'x'.repeat(SCRATCHPAD_NOTE_BYTE_CAP + 1) }),
      '/work', undefined, { scratchpadRunId: 'AX-1' },
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('limit for one note');
    // The refusal names a cap the model can act on, not just a failure.
    expect(result.content).toContain(String(SCRATCHPAD_NOTE_BYTE_CAP));
  });

  it('refuses an empty note name', async () => {
    const result = await executeTool(
      makeCall('scratch_write', { name: '  ', content: 'x' }),
      '/work', undefined, { scratchpadRunId: 'AX-1' },
    );
    expect(result.is_error).toBe(true);
  });

  it('lets a read-only reviewer read notes but not write them', async () => {
    await writeNote('AX-1', 'approach', 'kept');
    const write = await executeTool(
      makeCall('scratch_write', { name: 'approach', content: 'overwritten' }),
      '/work', undefined, { scratchpadRunId: 'AX-1', readOnly: true },
    );
    expect(write.is_error).toBe(true);
    expect(await readNote('AX-1', 'approach')).toBe('kept');

    const read = await executeTool(
      makeCall('scratch_read', { name: 'approach' }),
      '/work', undefined, { scratchpadRunId: 'AX-1', readOnly: true },
    );
    expect(read.is_error).toBe(false);
    expect(read.content).toBe('kept');

    const remember = await executeTool(
      makeCall('remember', { kind: 'pattern', title: 'no', content: 'write' }),
      '/work', undefined, { scratchpadRunId: 'AX-1', memoryContext: { taskId: 'AX-1', iteration: 1 }, readOnly: true },
    );
    expect(remember.is_error).toBe(true);
  });

  it('keeps one run out of another run’s notes', async () => {
    await writeNote('AX-1', 'approach', 'mine');
    const read = await executeTool(
      makeCall('scratch_read', { name: 'approach' }),
      '/work', undefined, { scratchpadRunId: 'AX-2' },
    );
    expect(read.is_error).toBe(true);
  });

  it('stages a remember entry with iteration provenance', async () => {
    const result = await executeTool(
      makeCall('remember', { kind: 'constraint', title: 'migration order', content: 'run the reader first' }),
      '/work', undefined, { scratchpadRunId: 'AX-1', memoryContext: { taskId: 'AX-1', iteration: 3 } },
    );
    expect(result.is_error).toBe(false);
    expect(await readStagedMemories('AX-1')).toEqual([expect.objectContaining({ taskId: 'AX-1', iteration: 3 })]);
  });
});
