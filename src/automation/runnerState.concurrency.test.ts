// Concurrent runner-state RMW: without a cross-process lock, two writers reload
// the same snapshot and the later write drops the earlier increment. (AGT-3420)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let home: string;
let rejectionFile: string;

async function loadRunnerState() {
  vi.resetModules();
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('OPENSWARM_RUNNER_REJECTION_STATE_FILE', rejectionFile);
  vi.stubEnv('OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', join(home, '.claude', 'openswarm-pipeline-history.json'));
  vi.stubEnv('OPENSWARM_RUNNER_TASK_STATE_FILE', join(home, '.claude', 'openswarm-task-state.json'));
  vi.stubEnv('OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', join(home, '.claude', 'openswarm-decomposition-state.json'));
  return await import('./runnerState.js');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'openswarm-runner-conc-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  rejectionFile = join(home, '.claude', 'openswarm-rejection-state.json');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('concurrent runner-state updates', () => {
  it('keeps every rejection increment when child processes race', async () => {
    const { incrementRejection } = await loadRunnerState();
    expect(incrementRejection('ISSUE-1', 'seed')).toBe(1);

    const fixture = fileURLToPath(new URL('./runnerState.rejection.fixture.ts', import.meta.url));
    const run = (reason: string) => new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', fixture, rejectionFile, 'ISSUE-1', reason],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            OPENSWARM_RUNNER_REJECTION_STATE_FILE: rejectionFile,
          },
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
        else resolve(Number(stdout.trim()));
      });
    });

    await Promise.all(Array.from({ length: 8 }, (_, i) => run(`reason-${i}`)));

    const raw = JSON.parse(readFileSync(rejectionFile, 'utf8')) as {
      rejections: Record<string, { count: number; reasons: string[] }>;
    };
    expect(raw.rejections['ISSUE-1'].count).toBe(9);
    expect(raw.rejections['ISSUE-1'].reasons.length).toBeLessThanOrEqual(5);
  }, 30_000);

  it('keeps every pipeline history entry across sequential locked appends', async () => {
    const { appendPipelineHistory, getPipelineHistory } = await loadRunnerState();
    for (let i = 0; i < 6; i++) {
      appendPipelineHistory({
        sessionId: `s-${i}`,
        taskTitle: `t-${i}`,
        success: true,
        finalStatus: 'done',
        iterations: 1,
        totalDuration: 1,
        stages: [],
        completedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      });
    }
    expect(getPipelineHistory(20)).toHaveLength(6);
  });
});
