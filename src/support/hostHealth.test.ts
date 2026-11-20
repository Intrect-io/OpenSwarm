// ============================================
// OpenSwarm - Host health: stop dispatching when the disk is nearly full (AGT-4785)
// ============================================

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MIN_FREE_BYTES, HostDiskGate, checkHostHealth, dispatchWritePaths, formatGiB, freeBytesFor, hostDiskVerdict,
  isHostResourceError, lowestFreeBytes,
} from './hostHealth.js';

const GiB = 1024 ** 3;

describe('hostDiskVerdict', () => {
  it('is low strictly below the floor and ok at or above it', () => {
    expect(hostDiskVerdict({ freeBytes: 2 * GiB, minFreeBytes: 10 * GiB })).toBe('low');
    expect(hostDiskVerdict({ freeBytes: 10 * GiB - 1, minFreeBytes: 10 * GiB })).toBe('low');
    expect(hostDiskVerdict({ freeBytes: 10 * GiB, minFreeBytes: 10 * GiB })).toBe('ok');
    expect(hostDiskVerdict({ freeBytes: 50 * GiB, minFreeBytes: 10 * GiB })).toBe('ok');
  });

  it('a floor of zero never pauses, which is how the check is turned off', () => {
    expect(hostDiskVerdict({ freeBytes: 0, minFreeBytes: 0 })).toBe('ok');
  });
});

describe('freeBytesFor / lowestFreeBytes', () => {
  it('measures a real directory', () => {
    expect(freeBytesFor(tmpdir())).toBeGreaterThan(0);
  });

  it('throws for a path that does not exist, and the scan skips it instead', () => {
    const missing = path.join(tmpdir(), 'osw-host-health-missing', 'nested');
    expect(() => freeBytesFor(missing)).toThrow();
    expect(lowestFreeBytes([missing])).toBeUndefined();
  });

  it('returns the scarcest of several and names it, ignoring unmeasurable ones', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'osw-host-health-'));
    try {
      const result = lowestFreeBytes([path.join(dir, 'nope'), dir, tmpdir(), dir]);
      expect(result).toBeDefined();
      expect([dir, tmpdir()]).toContain(result!.dir);
      // Live volumes change between two statfs calls (other processes write while the
      // suite runs), so an exact match flakes; both paths are one volume here, so the
      // reading must be within a small band of a fresh one.
      expect(Math.abs(result!.freeBytes - freeBytesFor(dir))).toBeLessThan(1024 ** 3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('checkHostHealth', () => {
  it('is low when the measured volume is under the floor', () => {
    // No real volume has this much free space, so the real measurement is always under it.
    const health = checkHostHealth([tmpdir()], Number.MAX_SAFE_INTEGER);
    expect(health.verdict).toBe('low');
    expect(health.scarcest?.dir).toBe(tmpdir());
  });

  it('is ok when the measured volume clears the floor', () => {
    expect(checkHostHealth([tmpdir()], 1).verdict).toBe('ok');
  });

  it('fails open: nothing measurable is never a reason to stop', () => {
    const health = checkHostHealth([path.join(tmpdir(), 'osw-host-health-missing')], Number.MAX_SAFE_INTEGER);
    expect(health).toEqual({ verdict: 'ok', minFreeBytes: Number.MAX_SAFE_INTEGER });
  });

  it('defaults to a 10 GiB floor', () => {
    expect(DEFAULT_MIN_FREE_BYTES).toBe(10 * GiB);
    expect(checkHostHealth([tmpdir()]).minFreeBytes).toBe(10 * GiB);
  });
});

describe('isHostResourceError', () => {
  it('recognises ENOSPC by code', () => {
    expect(isHostResourceError(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toBe(true);
    expect(isHostResourceError({ code: 'ENOSPC' })).toBe(true);
  });

  it.each([
    'ENOSPC: no space left on device, open \'/Users/x/.claude/pipeline-history.json.lock\'',
    'tester: git exited with code 128: error: copy-fd: write returned: No space left on device',
    'fatal: write error: No space left on device',
  ])('recognises the text the incident printed: %s', (message) => {
    expect(isHostResourceError(new Error(message))).toBe(true);
    expect(isHostResourceError(message)).toBe(true);
  });

  it.each([
    'Could not resolve host: api.github.com',
    'tests failed: 3 failed, 10 passed',
    'there is no space left for the label in the header',
    'EACCES: permission denied',
    '',
  ])('does not mistake another failure for a full disk: %s', (message) => {
    expect(isHostResourceError(new Error(message))).toBe(false);
  });

  it('handles a non-error input', () => {
    expect(isHostResourceError(undefined)).toBe(false);
    expect(isHostResourceError(null)).toBe(false);
    expect(isHostResourceError(42)).toBe(false);
  });
});

describe('dispatchWritePaths / formatGiB', () => {
  it('always includes the temp dir the verification clones are made in', () => {
    expect(dispatchWritePaths(['/p'], ['/state'])).toEqual(['/p', tmpdir(), '/state']);
    expect(dispatchWritePaths([])).toEqual([tmpdir()]);
  });

  it('formats for the log line', () => {
    expect(formatGiB(2 * GiB)).toBe('2.0 GiB');
    expect(formatGiB(1.25 * GiB)).toBe('1.3 GiB');
  });
});

describe('HostDiskGate', () => {
  /** A gate whose measured free space the test controls, through the floor: the real volume is fixed, the floor moves. */
  const gate = (floorBytes: { value: number }) => new HostDiskGate(() => [tmpdir()], () => floorBytes.value);
  const OVER = Number.MAX_SAFE_INTEGER; // no volume has this much free: always low
  const UNDER = 1;                      // any volume has this much: always ok

  it('passes while the disk is fine and says nothing', () => {
    expect(gate({ value: UNDER }).evaluate()).toEqual({ pause: false });
  });

  it('pauses on a low disk and speaks once, then stays quiet while it stays low', () => {
    const floor = { value: OVER };
    const g = gate(floor);
    const first = g.evaluate();
    expect(first).toMatchObject({ pause: true, notice: expect.stringContaining('Dispatch paused') });
    for (let i = 0; i < 10; i += 1) {
      const next = g.evaluate();
      expect(next.pause).toBe(true);
      expect(next.notice).toBeUndefined();
    }
  });

  it('says once that it recovered, and not again', () => {
    const floor = { value: OVER };
    const g = gate(floor);
    g.evaluate();
    floor.value = UNDER;
    expect(g.evaluate()).toMatchObject({ pause: false, notice: expect.stringContaining('recovered') });
    expect(g.evaluate()).toEqual({ pause: false });
  });

  it('announces a second episode after a recovery', () => {
    const floor = { value: OVER };
    const g = gate(floor);
    g.evaluate();
    floor.value = UNDER; g.evaluate();
    floor.value = OVER;
    expect(g.evaluate().notice).toContain('Dispatch paused');
  });

  it('a floor of zero switches it off, and says so if it was paused', () => {
    const floor = { value: OVER };
    const g = gate(floor);
    g.evaluate();
    floor.value = 0;
    expect(g.evaluate()).toMatchObject({ pause: false, notice: expect.stringContaining('switched off') });
    expect(g.evaluate()).toEqual({ pause: false });
  });

  it('never pauses when nothing can be measured (fails open)', () => {
    const g = new HostDiskGate(() => [path.join(tmpdir(), 'osw-host-health-missing')], () => OVER);
    expect(g.evaluate()).toEqual({ pause: false });
  });

  // PR #849's own case, kept after review: the unconfirmed report holds dispatch for a
  // while and lifts itself; it is a timed `hold`, never the operator-lifted auto:disk pause.
  it('holds dispatch after a reported ENOSPC even though the disk measures fine, then resumes once', () => {
    let clock = 1_000;
    const lines: string[] = [];
    const g = new HostDiskGate(() => [tmpdir()], () => UNDER, (line) => lines.push(line), { now: () => clock, holdMs: 60_000 });
    expect(g.resourceFailure('No space left on device')).toMatchObject({ pause: true, hold: true, notice: expect.stringContaining('Dispatch paused') });
    expect(g.resourceFailure('No space left on device').notice).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('not confirmed by a free-space measurement');
    clock += 30_000;
    expect(g.evaluate()).toEqual({ pause: true, hold: true, line: 'Host resource failure: No space left on device' });
    clock += 30_001;
    expect(g.evaluate()).toMatchObject({ pause: false, notice: expect.stringContaining('recovered') });
    expect(g.evaluate()).toEqual({ pause: false });
  });

  it('pauses on a reported ENOSPC only when the re-measurement is below the floor', () => {
    const lines: string[] = [];
    const floor = { value: OVER };
    const g = new HostDiskGate(() => [tmpdir()], () => floor.value, (line) => lines.push(line));
    expect(g.resourceFailure('No space left on device')).toMatchObject({ pause: true, notice: expect.stringContaining('Dispatch paused') });
    // Further reports and heartbeats while low stay quiet; no timed hold outlives the measurement.
    expect(g.resourceFailure('No space left on device').notice).toBeUndefined();
    expect(g.evaluate()).toMatchObject({ pause: true });
    floor.value = UNDER;
    expect(g.evaluate()).toMatchObject({ pause: false, notice: expect.stringContaining('auto:disk') });
    expect(lines).toEqual([]);
  });

  it('leaves the recovery notice to the heartbeat when a report arrives after the disk was freed', () => {
    const floor = { value: OVER };
    const g = new HostDiskGate(() => [tmpdir()], () => floor.value, () => undefined);
    expect(g.evaluate().pause).toBe(true);
    floor.value = UNDER;
    expect(g.resourceFailure('No space left on device')).toMatchObject({ pause: true, hold: true });
    expect(g.evaluate()).toMatchObject({ pause: false, notice: expect.stringContaining('recovered') });
  });

  it('names the scarcest volume and the floor in the pause line', () => {
    const decision = gate({ value: OVER }).evaluate();
    expect(decision.pause && decision.line).toContain(tmpdir());
    expect(decision.pause && decision.line).toContain('below the');
  });

  it('belowFloor re-measures without spending the recovery notice (AGT-4816)', () => {
    const floor = { value: OVER };
    const g = gate(floor);
    expect(g.evaluate().pause).toBe(true);
    expect(g.belowFloor()).toBe(true);
    floor.value = UNDER;
    expect(g.belowFloor()).toBe(false);
    expect(g.belowFloor()).toBe(false);
    // evaluate() still announces the recovery exactly once.
    expect(g.evaluate()).toMatchObject({ pause: false, notice: expect.stringContaining('recovered') });
    floor.value = 0;
    expect(g.belowFloor()).toBe(false); // switched off
  });
});
