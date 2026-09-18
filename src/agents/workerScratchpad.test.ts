import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scratchNotesSection, workerScratchpadRunId } from './workerScratchpad.js';
import { writeNote } from '../support/scratchpad.js';

let root: string;
const previousDir = process.env.OPENSWARM_SCRATCHPAD_DIR;
const previousFlag = process.env.OPENSWARM_SCRATCHPAD;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worker-scratch-'));
  process.env.OPENSWARM_SCRATCHPAD_DIR = root;
  delete process.env.OPENSWARM_SCRATCHPAD;
});
afterEach(() => {
  if (previousDir === undefined) delete process.env.OPENSWARM_SCRATCHPAD_DIR;
  else process.env.OPENSWARM_SCRATCHPAD_DIR = previousDir;
  if (previousFlag === undefined) delete process.env.OPENSWARM_SCRATCHPAD;
  else process.env.OPENSWARM_SCRATCHPAD = previousFlag;
  rmSync(root, { recursive: true, force: true });
});

const task = { id: 'uuid-1', issueId: 'uuid-1', issueIdentifier: 'AX-1556' };

describe('workerScratchpadRunId', () => {
  it('keys on the human identifier, the same key the cost ledger uses', () => {
    expect(workerScratchpadRunId(task)).toBe('AX-1556');
  });

  it('falls back when a task has no identifier', () => {
    expect(workerScratchpadRunId({ id: 'uuid-1', issueId: 'uuid-1' })).toBe('uuid-1');
    expect(workerScratchpadRunId({ id: 'uuid-1' })).toBe('uuid-1');
  });

  it('is undefined when the scratchpad is switched off', () => {
    process.env.OPENSWARM_SCRATCHPAD = '0';
    expect(workerScratchpadRunId(task)).toBeUndefined();
  });
});

describe('scratchNotesSection', () => {
  it('is absent before the agent has written anything', async () => {
    expect(await scratchNotesSection(task)).toBeUndefined();
  });

  it('carries a note written under the same task into the next prompt', async () => {
    await writeNote('AX-1556', 'ruled-out', 'the adapter registry is not the seam');
    const section = await scratchNotesSection(task) ?? '';
    expect(section).toContain('Your notes from earlier in this task');
    expect(section).toContain('the adapter registry is not the seam');
  });

  it('tells the agent the notes are its own, not the reviewer’s', async () => {
    await writeNote('AX-1556', 'approach', 'x');
    expect(await scratchNotesSection(task)).toContain('not the reviewer');
  });

  it('is absent when the scratchpad is switched off, even with notes on disk', async () => {
    await writeNote('AX-1556', 'approach', 'x');
    process.env.OPENSWARM_SCRATCHPAD = '0';
    expect(await scratchNotesSection(task)).toBeUndefined();
  });
});
