// ============================================
// OpenSwarm - Re-dispatch only when the issue's input changed (AGT-4787)
// ============================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  inputFingerprint, isDaemonComment, mayRedispatch, recordParkedInput, recordRunInput,
  resetDispatchFingerprintForTests,
} from './dispatchFingerprint.js';
import { EXECUTION_COMMENT_CONTEXT_HEADING, refreshExecutionTaskContext } from './executionTaskContext.js';

let dir: string;
const saved = process.env.OPENSWARM_AUTOMATION_DB;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'osw-dispatch-fp-'));
  process.env.OPENSWARM_AUTOMATION_DB = path.join(dir, 'automation.db');
  resetDispatchFingerprintForTests();
});
afterEach(() => {
  resetDispatchFingerprintForTests();
  if (saved === undefined) delete process.env.OPENSWARM_AUTOMATION_DB; else process.env.OPENSWARM_AUTOMATION_DB = saved;
  rmSync(dir, { recursive: true, force: true });
});

const issue = { title: 'Fix the importer', description: 'It drops rows.' };

describe('isDaemonComment', () => {
  it.each([
    '🧭 **[OpenSwarm] Task execution started**\n\nattempt 3',
    '**[OpenSwarm] Worker halted**\n\nreason',
    '**Worker actions — Halted (attempt #1/5)**\n\nsummary\n\n_via OpenSwarm_',
    '**Heading**\n\nbody\n\n_via OpenSwarm · run abc_',
  ])('recognises the daemon\'s own shapes: %s', (body) => {
    expect(isDaemonComment(body)).toBe(true);
  });

  it.each([
    'Please use option B.',
    'I looked at OpenSwarm and it is fine',
    'via OpenSwarm is the footer they use',
    'The [OpenSwarm] label is wrong',
  ])('does not mistake a person for the daemon: %s', (body) => {
    expect(isDaemonComment(body)).toBe(false);
  });
});

describe('inputFingerprint', () => {
  it('is stable for the same input and ignores surrounding whitespace', () => {
    expect(inputFingerprint(issue)).toBe(inputFingerprint({ title: ' Fix the importer ', description: 'It drops rows.\n' }));
  });

  it('changes with the title, the description, or a human comment', () => {
    const base = inputFingerprint({ ...issue, comments: [{ body: 'one' }] });
    expect(inputFingerprint({ ...issue, title: 'Fix the importer v2', comments: [{ body: 'one' }] })).not.toBe(base);
    expect(inputFingerprint({ ...issue, description: 'changed', comments: [{ body: 'one' }] })).not.toBe(base);
    expect(inputFingerprint({ ...issue, comments: [{ body: 'one' }, { body: 'two' }] })).not.toBe(base);
  });

  it('does not change when only the daemon commented', () => {
    const base = inputFingerprint({ ...issue, comments: [{ body: 'one' }] });
    const withDaemon = inputFingerprint({
      ...issue,
      comments: [{ body: 'one' }, { body: '🧭 **[OpenSwarm] Task execution started**' }, { body: '**x**\n\n_via OpenSwarm_' }],
    });
    expect(withDaemon).toBe(base);
  });

  it('treats a missing description like an empty one', () => {
    expect(inputFingerprint({ title: 't' })).toBe(inputFingerprint({ title: 't', description: '', comments: [] }));
  });
});

describe('the comment history a selected run appends to the description (AGT-4787)', () => {
  // executePipeline's first line is `task = await prepareTaskExecutionContext(task)`, which appends the
  // tracker discussion to task.description; recordRunInput runs after it. The heartbeat fingerprints
  // the bulk-fetched task, which has no discussion. Both sides must still agree on an unchanged issue.
  async function selectedRun(comments: Array<{ body: string; createdAt: string }>) {
    const task = { id: 'AX-1', issueId: 'AX-1', ...issue } as { id: string; issueId: string; title: string; description: string };
    await refreshExecutionTaskContext(task as never, { getExecutionComments: async () => comments } as never);
    return task;
  }
  const history = [
    { body: '🧭 **[OpenSwarm] Task execution started**', createdAt: '2026-10-20T01:00:00Z' },
    { body: 'Please use option B.', createdAt: '2026-10-20T02:00:00Z' },
  ];

  it('fingerprints an issue the same with or without the appended history', async () => {
    const task = await selectedRun(history);
    expect(task.description).toContain(EXECUTION_COMMENT_CONTEXT_HEADING); // the helper really appended it
    expect(inputFingerprint({ title: task.title, description: task.description })).toBe(inputFingerprint(issue));
  });

  it('holds an unchanged issue after a run recorded its input post-refresh', async () => {
    recordRunInput(await selectedRun(history)); // what executePipeline does for an issue that already has comments
    expect(mayRedispatch('AX-1', inputFingerprint(issue))).toBe(false); // what the next heartbeat asks
  });

  it('still lifts once a person edits the description, with the history appended or not', async () => {
    recordRunInput(await selectedRun(history));
    expect(mayRedispatch('AX-1', inputFingerprint({ ...issue, description: 'It drops rows. Use the staging DB.' }))).toBe(true);
    const edited = await selectedRun(history);
    edited.description = `Rewritten by a person.${edited.description.slice(issue.description.length)}`;
    expect(inputFingerprint({ title: edited.title, description: edited.description })).not.toBe(inputFingerprint(issue));
  });
});

describe('the parked-input store', () => {
  it('blocks the input a run parked on, however often it is asked, and passes any other', () => {
    recordParkedInput('AX-1', inputFingerprint(issue));
    for (let i = 0; i < 18; i += 1) expect(mayRedispatch('AX-1', inputFingerprint(issue))).toBe(false);
    expect(mayRedispatch('AX-1', inputFingerprint({ ...issue, description: 'edited' }))).toBe(true);
  });

  it('keeps issues apart and passes an issue it has never seen', () => {
    recordParkedInput('AX-1', inputFingerprint(issue));
    expect(mayRedispatch('AX-2', inputFingerprint(issue))).toBe(true);
  });

  it('measures against the latest run: an edited issue that ran again is blocked on its new input', () => {
    const edited = { ...issue, description: 'edited' };
    recordRunInput({ id: 'AX-1', ...issue });
    expect(mayRedispatch('AX-1', inputFingerprint(issue))).toBe(false);
    recordRunInput({ id: 'AX-1', ...edited }); // a person edited it, the run started again
    expect(mayRedispatch('AX-1', inputFingerprint(edited))).toBe(false);
    expect(mayRedispatch('AX-1', inputFingerprint(issue))).toBe(true);
  });

  it('keys by issueId when there is one, else by id', () => {
    recordRunInput({ id: 'task-9', issueId: 'AX-9', ...issue });
    expect(mayRedispatch('AX-9', inputFingerprint(issue))).toBe(false);
    expect(mayRedispatch('task-9', inputFingerprint(issue))).toBe(true);
  });

  it('survives a reopened handle, because it lives in the database', () => {
    recordParkedInput('AX-1', inputFingerprint(issue));
    resetDispatchFingerprintForTests();
    expect(mayRedispatch('AX-1', inputFingerprint(issue))).toBe(false);
  });
});

describe('failure modes', () => {
  it('reads fail open: an unopenable store never blocks a dispatch', () => {
    process.env.OPENSWARM_AUTOMATION_DB = path.join(dir, 'missing-dir', 'nested', 'automation.db');
    resetDispatchFingerprintForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(mayRedispatch('AX-1', inputFingerprint(issue))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it('explicit writes fail closed, but recording a run input never stops the run', () => {
    process.env.OPENSWARM_AUTOMATION_DB = path.join(dir, 'missing-dir', 'nested', 'automation.db');
    resetDispatchFingerprintForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => recordParkedInput('AX-1', 'x')).toThrow(/Could not open the automation database/);
      expect(() => recordRunInput({ id: 'AX-1', ...issue })).not.toThrow();
    } finally { warn.mockRestore(); }
  });
});
