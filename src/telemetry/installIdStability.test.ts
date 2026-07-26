// Audit 2026-07-26 (src/telemetry) — getInstallId() and maybeShowNotice() each
// did read-then-write with no locking, so on a first run the daemon and the CLI
// could both find no state, both mint an install id, and whichever wrote last
// silently replaced the other. The id is meant to be stable for the install.
//
// The write was also in-place, which produces the same symptom by another route:
// a reader observing a torn file gets a JSON parse error, readState returns null,
// and the id is regenerated as if the install were new.
//
// These tests use the real filesystem in a temp HOME so the atomic write is
// actually exercised, rather than mocking node:fs (which is what the sibling
// telemetry tests do, and what would hide a non-atomic write).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let home: string;
let previousHome: string | undefined;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, default: actual, homedir: () => process.env.OSW_TEST_HOME ?? actual.homedir() };
});

function stateFile(): string {
  return join(home, '.config', 'openswarm', 'telemetry.json');
}

function readPersisted(): { installId?: string; noticeShown?: boolean } {
  return JSON.parse(readFileSync(stateFile(), 'utf8'));
}

/** Fresh module instance — STATE_DIR is resolved once at import time. */
async function loadTelemetry() {
  vi.resetModules();
  const mod = await import('./telemetry.js');
  mod.initTelemetry({ version: '0.0.0-test', enabled: true });
  return mod;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'osw-telemetry-'));
  previousHome = process.env.OSW_TEST_HOME;
  process.env.OSW_TEST_HOME = home;
  delete process.env.OPENSWARM_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OSW_TEST_HOME;
  else process.env.OSW_TEST_HOME = previousHome;
  vi.unstubAllGlobals();
});

describe('mergeState — the interleaving contract', () => {
  // This is where the race fix lives. A true read/write interleaving cannot be
  // produced deterministically from the synchronous callers, so the decision is
  // tested directly: `current` is what is on disk NOW, `next` is what the caller
  // computed from an earlier read.
  const VALID_A = 'aaaaaaaaaaaaaaaaaaaaa';
  const VALID_B = 'bbbbbbbbbbbbbbbbbbbbb';

  it('keeps the id already on disk over the one the caller minted', async () => {
    const { mergeState } = await loadTelemetry();

    expect(mergeState({ installId: VALID_A }, { installId: VALID_B }).installId).toBe(VALID_A);
  });

  it('adopts the caller id when disk has none or an invalid one', async () => {
    const { mergeState } = await loadTelemetry();

    expect(mergeState(null, { installId: VALID_B }).installId).toBe(VALID_B);
    expect(mergeState({ installId: 'too-short' }, { installId: VALID_B }).installId).toBe(VALID_B);
  });

  it('never un-shows a notice another writer already showed', async () => {
    const { mergeState } = await loadTelemetry();

    expect(mergeState({ installId: VALID_A, noticeShown: true }, { installId: VALID_A }).noticeShown)
      .toBe(true);
  });

  it('lets a caller set noticeShown when disk has not', async () => {
    const { mergeState } = await loadTelemetry();

    expect(
      mergeState({ installId: VALID_A }, { installId: VALID_A, noticeShown: true }).noticeShown,
    ).toBe(true);
  });
});

describe('install id stability', () => {
  it('keeps the id already on disk instead of replacing it', async () => {
    const { maybeShowNotice } = await loadTelemetry();
    mkdirSync(join(home, '.config', 'openswarm'), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ installId: 'aaaaaaaaaaaaaaaaaaaaa' }), 'utf8');

    // Showing the notice must not mint a replacement id along the way — that is
    // how a concurrently-written id used to be lost.
    maybeShowNotice();

    expect(readPersisted().installId).toBe('aaaaaaaaaaaaaaaaaaaaa');
    expect(readPersisted().noticeShown).toBe(true);
  });

  it('does not clear noticeShown when another writer had already set it', async () => {
    const { maybeShowNotice, track } = await loadTelemetry();
    maybeShowNotice();
    expect(readPersisted().noticeShown).toBe(true);

    await track({ command: 'run' });

    expect(readPersisted().noticeShown).toBe(true);
  });

  it('is stable across repeated runs of a fresh install', async () => {
    const first = await loadTelemetry();
    first.maybeShowNotice();
    const initial = readPersisted().installId;
    expect(initial).toMatch(/^[A-Za-z0-9_-]{21}$/);

    const second = await loadTelemetry();
    second.maybeShowNotice();
    await second.track({ command: 'chat' });

    expect(readPersisted().installId).toBe(initial);
  });

  it('writes atomically — no temp file is left behind', async () => {
    const { maybeShowNotice } = await loadTelemetry();

    maybeShowNotice();

    const entries = readdirSync(join(home, '.config', 'openswarm'));
    expect(entries).toContain('telemetry.json');
    expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0);
  });

  it('survives a torn state file without inventing a second identity per read', async () => {
    // A truncated file is what an in-place write exposes to a concurrent reader.
    // Recovery is expected; what must not happen is the recovered id changing
    // again on the very next read.
    const { maybeShowNotice, track } = await loadTelemetry();
    mkdirSync(join(home, '.config', 'openswarm'), { recursive: true });
    writeFileSync(stateFile(), '{"installId": "aaaa', 'utf8');

    maybeShowNotice();
    const recovered = readPersisted().installId;
    await track({ command: 'run' });

    expect(recovered).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(readPersisted().installId).toBe(recovered);
  });

  it('two concurrent first runs converge on a single id', async () => {
    // The audit's scenario: daemon and CLI both start with no state. Separate
    // processes so they genuinely race rather than sharing module state.
    const script = join(home, 'race.mjs');
    writeFileSync(
      script,
      `process.env.OSW_TEST_HOME = ${JSON.stringify(home)};\n` +
        `const m = await import(${JSON.stringify(join(process.cwd(), 'src/telemetry/telemetry.ts'))});\n` +
        `m.initTelemetry({ version: '0.0.0-test', enabled: true });\n` +
        `m.maybeShowNotice();\n`,
      'utf8',
    );
    const run = () =>
      execFileSync(process.execPath, ['--import', 'tsx', script], {
        env: { ...process.env, HOME: home, OSW_TEST_HOME: home },
        stdio: 'pipe',
      });

    run();
    const afterFirst = readPersisted().installId;
    run();

    expect(readPersisted().installId).toBe(afterFirst);
  });
});
