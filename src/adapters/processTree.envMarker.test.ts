import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { terminateProcessesWithEnvMarker } from './processTree.js';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Claude Code's Bash tool runs each command under setsid, so it leaves the
// detached group a group kill reaches. Reproduce that shape with a real
// process and prove the marker sweep still finds it.
describe.runIf(process.platform === 'linux' && existsSync('/usr/bin/setsid'))('terminateProcessesWithEnvMarker (linux)', () => {
  async function startEscaped(env: Record<string, string>): Promise<number> {
    const child = spawn('/usr/bin/setsid', ['sleep', '30'], { env: { ...process.env, ...env }, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(true);
    return pid;
  }

  it('kills a session-escaped process carrying a KEY=value marker', async () => {
    const value = `osw-cli-${randomUUID()}`;
    const pid = await startEscaped({ OPENSWARM_CLI_PROCESS_MARKER: value });
    await terminateProcessesWithEnvMarker(`OPENSWARM_CLI_PROCESS_MARKER=${value}`);
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  });

  it('matches a bare marker value too (the sandbox passes only the value)', async () => {
    const value = `sandbox-${randomUUID()}`;
    const pid = await startEscaped({ OPENSWARM_SANDBOX_PROCESS_MARKER: value });
    await terminateProcessesWithEnvMarker(value);
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  });

  it('leaves a process with a different marker alone', async () => {
    const pid = await startEscaped({ OPENSWARM_CLI_PROCESS_MARKER: `osw-cli-${randomUUID()}` });
    try {
      await terminateProcessesWithEnvMarker(`OPENSWARM_CLI_PROCESS_MARKER=osw-cli-${randomUUID()}`);
      expect(alive(pid)).toBe(true);
    } finally {
      process.kill(pid, 'SIGKILL');
    }
  });
});
