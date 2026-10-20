// ============================================
// OpenSwarm — the exec hold that keeps an elevated run for its orchestrator
// ============================================
//
// `openswarm exec --issue` deploys a run behind a hold so the daemon's
// idle_fill cannot silently re-run what the external orchestrator is still
// deciding on (AGT-4155, AGT-4257, AGT-4306). The whole contract is the pair of
// asymmetries pinned here: writes fail CLOSED (a run deployed without its hold
// is one idle_fill will steal), reads fail OPEN (the heartbeat hot path must
// degrade to the old behaviour, never die), and the TTL clock is `updated_at`
// so an `exec answer` re-mark extends the session.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  EXEC_HOLD_TTL_MS, clearExecHold, isExecHeld, listHeldIssueIds, markExecHold, resetExecHoldForTests,
} from './execHold.js';

let dir: string;
const ORIGINAL = process.env.OPENSWARM_AUTOMATION_DB;

beforeEach(() => {
  // Per-test file: vitest.setup's globals are shared across fork workers, so a
  // fixed path would let one test's holds reach another's assertions.
  dir = mkdtempSync(join(tmpdir(), 'openswarm-exechold-'));
  process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'automation.db');
  resetExecHoldForTests();
});

afterEach(() => {
  resetExecHoldForTests();
  if (ORIGINAL === undefined) delete process.env.OPENSWARM_AUTOMATION_DB;
  else process.env.OPENSWARM_AUTOMATION_DB = ORIGINAL;
  rmSync(dir, { recursive: true, force: true });
});

describe('exec hold store', () => {
  it('records a hold and lists it, and only it', () => {
    markExecHold('i1', 'external:cli');

    expect(isExecHeld('i1')).toBe(true);
    const held = listHeldIssueIds();
    expect(held.has('i1')).toBe(true);
    expect(held.has('i2')).toBe(false);
    expect(held.size).toBe(1);
  });

  it('expires a hold past the TTL and keeps one inside it', () => {
    // Explicit `now` on both sides, so the boundary is exact rather than racing
    // the wall clock between marking and asserting.
    const base = Date.now();
    markExecHold('expired', 'a', base - EXEC_HOLD_TTL_MS - 1);
    markExecHold('alive', 'a', base - EXEC_HOLD_TTL_MS + 1000);

    expect(listHeldIssueIds(base)).toEqual(new Set(['alive']));
    expect(isExecHeld('expired', base)).toBe(false);
    expect(isExecHeld('alive', base)).toBe(true);
  });

  it('refreshes the TTL from updated_at, not created_at, when re-marked', () => {
    const t0 = 1_000_000;
    const t1 = t0 + 60_000; // a later `exec answer` re-marks the same hold
    markExecHold('i1', 'first', t0);
    markExecHold('i1', 'second', t1);

    expect(isExecHeld('i1', t1)).toBe(true);

    // t0's expiry has already passed. That this still reads as held is only
    // possible because the clock is the refreshed `updated_at` (t1), not the
    // preserved `created_at` (t0) — which would have expired it.
    expect(isExecHeld('i1', t0 + EXEC_HOLD_TTL_MS + 1)).toBe(true);
    expect(listHeldIssueIds(t0 + EXEC_HOLD_TTL_MS + 1).has('i1')).toBe(true);

    // The refreshed clock does expire: t1 + TTL is past the hold.
    expect(isExecHeld('i1', t1 + EXEC_HOLD_TTL_MS + 1)).toBe(false);
    expect(listHeldIssueIds(t1 + EXEC_HOLD_TTL_MS + 1).has('i1')).toBe(false);
  });

  it('clears a hold, and clearing an unknown id is a no-op', () => {
    markExecHold('i1', 'a');

    clearExecHold('i1');

    expect(isExecHeld('i1')).toBe(false);
    expect(listHeldIssueIds().size).toBe(0);
    expect(() => clearExecHold('never-marked')).not.toThrow();
  });

  it('re-resolves the path after a reset, so a redirect takes effect', () => {
    markExecHold('i1', 'a');
    expect(isExecHeld('i1')).toBe(true);

    // The daemon and the CLI are different processes over the same file; a test
    // that redirects mid-run must not keep reading the handle it already had.
    process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'second.db');
    resetExecHoldForTests();

    expect(isExecHeld('i1')).toBe(false);
    expect(listHeldIssueIds().size).toBe(0);
    markExecHold('i2', 'a');
    expect(isExecHeld('i2')).toBe(true);

    // And back: the per-path isolation runs both ways.
    process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'automation.db');
    resetExecHoldForTests();
    expect(isExecHeld('i1')).toBe(true);
    expect(isExecHeld('i2')).toBe(false);
  });

  it('fails open when the store cannot be opened, without throwing or rejecting', async () => {
    // `not-a-directory` is a file, so the DB path beneath it cannot be created —
    // the same broken-deployment shape coordinationStore.test.ts pins for the
    // trace. A read that died here would kill the heartbeat it runs in.
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'x');
    process.env.OPENSWARM_AUTOMATION_DB = join(blocker, 'nested', 'automation.db');
    resetExecHoldForTests();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      expect(() => listHeldIssueIds()).not.toThrow();
      expect(listHeldIssueIds()).toEqual(new Set());
      expect(isExecHeld('x')).toBe(false);
      expect(() => clearExecHold('x')).not.toThrow();

      // Let any stray async work settle before calling the pass clean.
      const settled = Promise.withResolvers<void>();
      setImmediate(settled.resolve);
      await settled.promise;
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
      warn.mockRestore();
    }
  });

  it('keeps the asymmetry when the store opens but its table is gone', () => {
    markExecHold('i1', 'external:cli');
    // Another process (or a damaged file) removes the table behind the cached
    // handle: every statement now fails rather than the open.
    const other = new Database(process.env.OPENSWARM_AUTOMATION_DB!);
    other.exec('DROP TABLE automation_exec_runs');
    other.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => markExecHold('i1', 'external:cli')).toThrow(/Could not record the exec hold for i1/);
      expect(isExecHeld('i1')).toBe(false);
      expect(listHeldIssueIds().size).toBe(0);
      expect(() => clearExecHold('i1')).not.toThrow();
      expect(warn.mock.calls.map(([tag]) => tag)).toEqual([
        '[ExecHold] Read failed:', '[ExecHold] List failed:', '[ExecHold] Clear failed:',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('drops the old handle when the database path moves under it', () => {
    markExecHold('i1', 'external:cli');
    process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'moved.db');

    expect(isExecHeld('i1')).toBe(false);
    markExecHold('i2', 'external:cli');
    expect([...listHeldIssueIds()]).toEqual(['i2']);
  });
});
