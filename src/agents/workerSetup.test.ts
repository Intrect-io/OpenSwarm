// ============================================
// OpenSwarm - Worker dependency setup step (AGT-4798)
// ============================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Only the "sandbox on, no backend" case reaches the wrapper; every other test
// runs with the sandbox off so it does not depend on the host.
vi.mock('../support/osSandbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../support/osSandbox.js')>()),
  wrapForSandbox: () => null,
}));

const { runWorkerSetup, setupFailureBeforeWorker } = await import('./workerSetup.js');

const dirs: string[] = [];
const workdir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'osw-setup-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runWorkerSetup', () => {
  it('is a no-op when the project declares no setup', async () => {
    expect(await runWorkerSetup(undefined, workdir(), { sandbox: 'off' })).toEqual({ ok: true, ran: 0 });
    expect(await runWorkerSetup(['  '], workdir(), { sandbox: 'off' })).toEqual({ ok: true, ran: 0 });
  });

  it('runs the commands in order inside the worktree', async () => {
    const cwd = workdir();
    const result = await runWorkerSetup(['echo one > log', 'echo two >> log'], cwd, { sandbox: 'off' });
    expect(result).toEqual({ ok: true, ran: 2 });
    expect(readFileSync(path.join(cwd, 'log'), 'utf8')).toBe('one\ntwo\n');
  });

  it('stops at the first failing command and reports its output', async () => {
    const cwd = workdir();
    const result = await runWorkerSetup(
      ['echo resolving; echo "error: lockfile out of date" >&2; exit 3', 'touch second'],
      cwd,
      { sandbox: 'off' },
    );
    expect(result).toMatchObject({ ok: false, command: expect.stringContaining('exit 3') });
    expect(!result.ok && result.detail).toContain('lockfile out of date');
    expect(existsSync(path.join(cwd, 'second'))).toBe(false);
  });

  it('reports a timeout as a timeout', async () => {
    const result = await runWorkerSetup(['sleep 5'], workdir(), { sandbox: 'off', timeoutMs: 200 });
    expect(result).toMatchObject({ ok: false, detail: 'timed out' });
  });

  it('runs without the daemon\'s credentials', async () => {
    const cwd = workdir();
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'ghp_daemon_secret';
    try {
      await runWorkerSetup(['printf "%s" "${GH_TOKEN:-none}" > seen'], cwd, { sandbox: 'off' });
      expect(readFileSync(path.join(cwd, 'seen'), 'utf8')).toBe('none');
    } finally {
      if (saved === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved;
    }
  });

  it('refuses when the sandbox is on but the host has none, like the bash tool', async () => {
    const cwd = workdir();
    const result = await runWorkerSetup(['touch ran'], cwd, { sandbox: 'on' });
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('autonomous.workerSandbox: off') });
    expect(existsSync(path.join(cwd, 'ran'))).toBe(false);
  });
});

describe('setupFailureBeforeWorker', () => {
  it('lets the worker start when there is no setup or it succeeds', async () => {
    expect(await setupFailureBeforeWorker(undefined, workdir(), 'off')).toBeUndefined();
    expect(await setupFailureBeforeWorker(['true'], workdir(), 'off')).toBeUndefined();
  });

  it('ends the run as infra_error, naming the failed command, before any stage runs', async () => {
    const result = await setupFailureBeforeWorker(['echo "no lockfile" >&2; exit 1'], workdir(), 'off');
    expect(result).toMatchObject({
      success: false, iterations: 0, finalStatus: 'infra_error', stages: [],
      failureDetail: expect.stringContaining('no lockfile'),
    });
    expect(result?.failureDetail).toContain('worker setup `echo');
  });
});
