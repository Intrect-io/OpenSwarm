// AGT-4024: evidence of a dot-lock-only (<=0.24.4) writer, recorded only when a
// dot-lock is released or replaced while this process holds the SQLite mutex.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { buildLockPayload, getTaskState, resetTaskStateStoreForTests, upsertTaskState } from './store.js';
import { createLegacyWriterProbe, legacyWriterEvidencePath, readLegacyWriterEvidence } from './legacyLockWriter.js';

// A <=0.24.4 writer: takes the dot-lock alone (no SQLite mutex), holds it
// until our writer has opened the mutex (so it is inside the lock loop), then
// releases it and lets the process end. Prints LOCKED once the lock is on disk.
const LEGACY_WRITER = `
const fs = require('node:fs');
const [lockPath, mutexPath] = process.argv.slice(1);
const fd = fs.openSync(lockPath, 'wx', 0o600);
fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: 'legacy-' + process.pid }), 'utf8');
fs.closeSync(fd);
process.stdout.write('LOCKED\\n');
const poll = setInterval(() => {
  if (!fs.existsSync(mutexPath)) return;
  clearInterval(poll);
  setTimeout(() => fs.unlinkSync(lockPath), 1000);
}, 5);
`;

async function startLegacyWriter(stateFile: string): Promise<{ pid: number; exit: Promise<number> }> {
  const child = spawn(process.execPath, ['-e', LEGACY_WRITER, `${stateFile}.lock`, `${stateFile}.mutex.db`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('LOCKED')) resolve();
    });
    child.on('exit', () => reject(new Error('legacy writer exited before locking')));
  });
  return { pid: child.pid!, exit };
}

describe('legacy dot-lock writer evidence (AGT-4024)', () => {
  let stateDir: string;
  let stateFile: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'openswarm-legacy-writer-'));
    stateFile = join(stateDir, 'state.json');
    process.env.OPENSWARM_TASK_STATE_FILE = stateFile;
    resetTaskStateStoreForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTaskStateStoreForTests();
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.OPENSWARM_TASK_STATE_FILE;
  });

  it('records a dot-lock-only writer seen while holding the mutex', async () => {
    const legacy = await startLegacyWriter(stateFile);
    // Synchronous: this waits on the dot-lock while holding the mutex.
    upsertTaskState('LEGACY-SEEN', { title: 'LEGACY-SEEN' });
    expect(await legacy.exit).toBe(0);

    resetTaskStateStoreForTests();
    expect(getTaskState('LEGACY-SEEN')?.title).toBe('LEGACY-SEEN');
    const evidence = readLegacyWriterEvidence(stateFile);
    expect(evidence).not.toBeNull();
    expect(evidence!.pid).toBe(legacy.pid);
    expect(evidence!.ns).toBeNull();
    expect(Date.parse(evidence!.lastSeenAt)).not.toBeNaN();
    expect(evidence!.firstSeenAt <= evidence!.lastSeenAt).toBe(true);
  });

  it('does not report a crashed dual-lock writer as a legacy writer', () => {
    // Dead pid: a writer that exited without removing its dot-lock.
    const dead = spawnSync(process.execPath, ['-e', '']);
    writeFileSync(`${stateFile}.lock`, JSON.stringify({ pid: dead.pid, token: 'crashed-dead-pid' }));
    upsertTaskState('CRASHED-1', { title: 'CRASHED-1' });
    expect(existsSync(`${stateFile}.lock`)).toBe(false);

    // Expired: a current-format lock older than LOCK_ABANDON_MS (10 minutes).
    writeFileSync(`${stateFile}.lock`, JSON.stringify(buildLockPayload('crashed-expired')));
    const old = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(`${stateFile}.lock`, old, old);
    upsertTaskState('CRASHED-2', { title: 'CRASHED-2' });

    resetTaskStateStoreForTests();
    expect(getTaskState('CRASHED-1')?.title).toBe('CRASHED-1');
    expect(getTaskState('CRASHED-2')?.title).toBe('CRASHED-2');
    expect(readLegacyWriterEvidence(stateFile)).toBeNull();
    expect(existsSync(legacyWriterEvidencePath(stateFile))).toBe(false);
  });

  it('does not fail the store write when the evidence cannot be written', async () => {
    mkdirSync(legacyWriterEvidencePath(stateFile));
    const legacy = await startLegacyWriter(stateFile);
    expect(() => upsertTaskState('EVIDENCE-BLOCKED', { title: 'EVIDENCE-BLOCKED' })).not.toThrow();
    expect(await legacy.exit).toBe(0);
    resetTaskStateStoreForTests();
    expect(getTaskState('EVIDENCE-BLOCKED')?.title).toBe('EVIDENCE-BLOCKED');
    expect(readLegacyWriterEvidence(stateFile)).toBeNull();
  });

  it('keeps firstSeenAt and ignores unreadable or reclaimed locks in the probe', () => {
    const probe = createLegacyWriterProbe(stateFile);
    probe.observe({ token: 'a', pid: 11 });
    probe.observe(null); // unreadable read: no identity, no conclusion
    probe.reclaimedByUs();
    probe.vanished(); // our own reclaim
    expect(readLegacyWriterEvidence(stateFile)).toBeNull();

    writeFileSync(legacyWriterEvidencePath(stateFile), JSON.stringify({ firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z', pid: 1, ns: null }));
    const replaced = createLegacyWriterProbe(stateFile);
    replaced.observe({ token: 'a', pid: 12, ns: 'pid:[1]' });
    replaced.observe({ token: 'b', pid: 13 });
    const evidence = readLegacyWriterEvidence(stateFile)!;
    expect(evidence.firstSeenAt).toBe('2026-01-01T00:00:00.000Z');
    expect(evidence.lastSeenAt > evidence.firstSeenAt).toBe(true);
    expect(evidence).toMatchObject({ pid: 12, ns: 'pid:[1]' });
  });
});
