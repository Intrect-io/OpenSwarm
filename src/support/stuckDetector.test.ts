import { describe, expect, it } from 'vitest';
import { StuckDetector, normalizeErrorForLoop, type HistoryEntry } from './stuckDetector.js';

let ts = 0;

function entry(patch: Partial<HistoryEntry>): HistoryEntry {
  return {
    stage: 'worker',
    success: true,
    timestamp: ++ts,
    ...patch,
  };
}

describe('StuckDetector', () => {
  it('detects consecutive repeated errors', () => {
    const detector = new StuckDetector({ sameErrorRepeat: 2 });

    detector.addEntry(entry({ success: false, error: 'boom' }));
    detector.addEntry(entry({ success: false, error: 'boom' }));

    expect(detector.check()).toMatchObject({ isStuck: true });
  });

  it('ignores invalid threshold overrides and keeps defaults (AGT-3455)', () => {
    const detector = new StuckDetector({
      sameErrorRepeat: -1 as number,
      sameOutputRepeat: Number.NaN,
      revisionLoop: 0,
      monologue: 1.5 as number,
    });
    // Defaults: sameErrorRepeat=2 — two identical errors still trip stuck.
    detector.addEntry(entry({ success: false, error: 'boom' }));
    detector.addEntry(entry({ success: false, error: 'boom' }));
    expect(detector.check()).toMatchObject({ isStuck: true });
  });

  it('does NOT treat a repeating INFRA error as a stuck loop (INT-2521)', () => {
    // An infra/capacity error recurring a few times is a retryable outage, not a
    // genuine stuck loop — it backs off and is excluded from STUCK elsewhere.
    const detector = new StuckDetector({ sameErrorRepeat: 2 });
    detector.addEntry(entry({ success: false, error: 'codex CLI failed with code 1: timed out' }));
    detector.addEntry(entry({ success: false, error: 'codex CLI failed with code 1: timed out' }));
    expect(detector.check()).toEqual({ isStuck: false });

    const d2 = new StuckDetector({ sameErrorRepeat: 2 });
    d2.addEntry(entry({ success: false, error: 'connect ECONNREFUSED 127.0.0.1:1234' }));
    d2.addEntry(entry({ success: false, error: 'connect ECONNREFUSED 127.0.0.1:1234' }));
    expect(d2.check()).toEqual({ isStuck: false });
  });

  it('still flags a repeating genuine (non-infra) task error as stuck', () => {
    const detector = new StuckDetector({ sameErrorRepeat: 2 });
    detector.addEntry(entry({ success: false, error: 'TypeError: cannot read property x of undefined' }));
    detector.addEntry(entry({ success: false, error: 'TypeError: cannot read property x of undefined' }));
    expect(detector.check()).toMatchObject({ isStuck: true });
  });

  it('does not treat historical matching errors as consecutive after progress', () => {
    const detector = new StuckDetector({ sameErrorRepeat: 2 });

    detector.addEntry(entry({ success: false, error: 'boom' }));
    detector.addEntry(entry({ success: true, output: 'made progress' }));
    detector.addEntry(entry({ success: false, error: 'boom' }));

    expect(detector.check()).toEqual({ isStuck: false });
  });

  it('detects consecutive repeated outputs', () => {
    const detector = new StuckDetector({ sameOutputRepeat: 3 });

    detector.addEntry(entry({ output: 'same output' }));
    detector.addEntry(entry({ output: 'same output' }));
    detector.addEntry(entry({ output: 'same output' }));

    expect(detector.check()).toMatchObject({ isStuck: true });
  });

  it('does not treat historical matching outputs as consecutive after a different event', () => {
    const detector = new StuckDetector({ sameOutputRepeat: 3 });

    detector.addEntry(entry({ output: 'same output' }));
    detector.addEntry(entry({ output: 'same output' }));
    detector.addEntry(entry({ stage: 'reviewer', success: true, decision: 'APPROVE' }));
    detector.addEntry(entry({ output: 'same output' }));

    expect(detector.check()).toEqual({ isStuck: false });
  });
});

describe('normalizeErrorForLoop (INT-2507)', () => {
  it('equates the same logical error across volatile tokens', () => {
    const a = 'Error at /Users/u/dev/WAVE/worktree/abc123/src/main.rs:42:7 — build failed in 3.2s (2026-07-05T01:02:03Z)';
    const b = 'Error at /Users/u/dev/WAVE/worktree/def456/src/main.rs:99:1 — build failed in 12s (2026-07-05T09:08:07Z)';
    expect(normalizeErrorForLoop(a)).toBe(normalizeErrorForLoop(b));
  });

  it('keeps genuinely different errors distinct', () => {
    expect(normalizeErrorForLoop('cargo build failed: missing symbol foo'))
      .not.toBe(normalizeErrorForLoop('pytest failed: assertion error in test_bar'));
  });
});
