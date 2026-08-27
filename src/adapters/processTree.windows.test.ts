import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareCliProcessTreeSpawn, terminateCliProcessTree } from './processTree.js';

const liveProcesses = new Set<ChildProcess>();
const tempDirs: string[] = [];

function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`condition was not met within ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

afterEach(() => {
  for (const proc of liveProcesses) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  liveProcesses.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32')('Windows Job Object process ownership', () => {
  it('round-trips quoted Unicode arguments and JSON through an npm-style .cmd shim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openswarm-windows-shim-'));
    tempDirs.push(dir);
    const script = join(dir, 'fixture.cjs');
    const shim = join(dir, 'fixture.cmd');
    const expectedArgs = ['plain', 'space value', 'quote"value', 'slash\\', '메타&값'];
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0\\fixture.cjs" %*\r\n`);
    const prepared = prepareCliProcessTreeSpawn(shim, expectedArgs, process.env);
    const supervisor = spawn(prepared.command, prepared.args, {
      env: prepared.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    liveProcesses.add(supervisor);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    supervisor.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    supervisor.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      supervisor.once('error', reject);
      supervisor.once('close', resolve);
    });

    expect(Buffer.concat(stderr).toString('utf8')).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(Buffer.concat(stdout).toString('utf8'))).toEqual(expectedArgs);
  }, 15_000);

  it('drains a large native stdout stream without truncating its tail', async () => {
    const outputBytes = 2 * 1024 * 1024;
    const target = `process.stdout.write(Buffer.alloc(${outputBytes}, 0x78))`;
    const prepared = prepareCliProcessTreeSpawn(process.execPath, ['-e', target], process.env);
    const supervisor = spawn(prepared.command, prepared.args, {
      env: prepared.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    liveProcesses.add(supervisor);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    supervisor.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    supervisor.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      supervisor.once('error', reject);
      supervisor.once('close', resolve);
    });

    const output = Buffer.concat(stdout);
    expect(Buffer.concat(stderr).toString('utf8')).toBe('');
    expect(code).toBe(0);
    expect(output).toHaveLength(outputBytes);
    expect(output.subarray(-16).equals(Buffer.alloc(16, 0x78))).toBe(true);
  }, 15_000);

  it('kills only supervised descendants and leaves an outside sibling alive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openswarm-windows-job-'));
    tempDirs.push(dir);
    const readyMarker = join(dir, 'target-ready');
    const descendantMarker = join(dir, 'descendant-survived');
    const siblingMarker = join(dir, 'sibling-survived');
    const delayedWriter = [
      "const { writeFileSync } = require('node:fs')",
      "setTimeout(() => writeFileSync(process.argv[1], 'alive'), 1500)",
      'setInterval(() => {}, 1000)',
    ].join(';');

    // This process is deliberately outside the supervisor's nested Job Object.
    const sibling = spawn(process.execPath, ['-e', delayedWriter, siblingMarker], {
      stdio: 'ignore',
      windowsHide: true,
    });
    liveProcesses.add(sibling);

    const target = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      'spawn(process.execPath, [\'-e\', process.argv[1], process.argv[3]], { stdio: \'ignore\', windowsHide: true })',
      "writeFileSync(process.argv[2], 'ready')",
      'setInterval(() => {}, 1000)',
    ].join(';');
    const prepared = prepareCliProcessTreeSpawn(
      process.execPath,
      ['-e', target, delayedWriter, readyMarker, descendantMarker],
      process.env,
    );
    const supervisor = spawn(prepared.command, prepared.args, {
      env: prepared.env,
      stdio: 'ignore',
      windowsHide: true,
    });
    liveProcesses.add(supervisor);

    await waitFor(() => existsSync(readyMarker));
    terminateCliProcessTree(supervisor);
    await waitFor(() => supervisor.exitCode !== null || supervisor.signalCode !== null);
    await waitFor(() => existsSync(siblingMarker), 5_000);

    expect(existsSync(descendantMarker)).toBe(false);
    expect(existsSync(siblingMarker)).toBe(true);
  }, 15_000);
});
