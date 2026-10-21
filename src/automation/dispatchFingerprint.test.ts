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
