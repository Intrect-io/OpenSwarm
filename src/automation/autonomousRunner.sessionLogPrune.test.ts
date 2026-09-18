// Purpose: the session-transcript sweep is actually wired into the heartbeat,
// not merely implemented. Session logs are written per agent invocation, so
// without a caller the directory grows for as long as the daemon runs — and
// `cleanupOldCheckpoints` in support/rollback.ts is the standing example in
// this repo of a retention helper that was never called. (AGT-4442)
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutonomousRunner } from './autonomousRunner.js';
import type { AutonomousConfig } from './runnerTypes.js';

const cfg = (over: Partial<AutonomousConfig> = {}): AutonomousConfig => ({
  linearTeamId: 'team',
  allowedProjects: [],
  heartbeatSchedule: '0 * * * *',
  autoExecute: false,
  dryRun: true,
  pairMode: true,
  maxConcurrentTasks: 1,
  autonomousHeartbeat: false,
  ...over,
});

let root: string;
const saved = process.env.OPENSWARM_SESSION_LOG_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'osw-hb-session-'));
  process.env.OPENSWARM_SESSION_LOG_DIR = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (saved === undefined) delete process.env.OPENSWARM_SESSION_LOG_DIR;
  else process.env.OPENSWARM_SESSION_LOG_DIR = saved;
});

describe('heartbeat sweeps session transcripts (AGT-4442)', () => {
  it('drops a transcript past the retention window and keeps a recent one', async () => {
    const dir = join(root, 'AX-1556');
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, 'stale.jsonl');
    const recent = join(dir, 'recent.jsonl');
    writeFileSync(stale, '{"type":"start"}\n');
    writeFileSync(recent, '{"type":"start"}\n');
    const longAgo = Date.now() / 1000 - 30 * 24 * 60 * 60;
    utimesSync(stale, longAgo, longAgo);

    const runner = new AutonomousRunner(cfg());
    try {
      await runner.heartbeat();
    } finally {
      await runner.stop();
    }

    expect(readdirSync(dir)).toEqual(['recent.jsonl']);
  });
});
