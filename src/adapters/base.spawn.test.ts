import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from './types.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { spawnCli, terminateCliProcessTree } from './base.js';
import {
  prepareCliProcessTreeSpawn,
  trackCliProcessTree,
} from './processTree.js';

beforeEach(() => spawnMock.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('CLI process tree termination', () => {
  it('kills the whole POSIX process group so native CLI and MCP children cannot survive a timeout', () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const directKill = vi.fn(() => true);

    // The lookup answers "7654 leads its own group and is our child": only
    // then may the whole group be signalled.
    terminateCliProcessTree({ pid: 7654, kill: directKill } as never, 'linux', () => ({ pgid: 7654, ppid: process.pid }));

    expect(processKill).toHaveBeenCalledWith(-7654, 'SIGKILL');
    expect(directKill).not.toHaveBeenCalled();
  });

  it('falls back to the direct child when the POSIX process group is already gone', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process group'), { code: 'ESRCH' });
    });
    const directKill = vi.fn(() => true);

    terminateCliProcessTree({ pid: 7655, kill: directKill } as never, 'linux', () => ({ pgid: 7655, ppid: process.pid }));

    expect(directKill).toHaveBeenCalledWith('SIGKILL');
  });

  it('terminates the retained Windows supervisor handle without a PID lookup', () => {
    const directKill = vi.fn(() => true);

    terminateCliProcessTree({ pid: 7656, kill: directKill } as never, 'win32');

    expect(directKill).toHaveBeenCalledWith('SIGKILL');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('creates the Windows Job Object before launching an argv-safe target', () => {
    const originalEnv = { SystemRoot: 'D:\\Windows', KEEP_ME: 'yes' };
    const targetArgs = ['exec', '--model', 'gpt 5', 'quote"and&shell'];

    const prepared = prepareCliProcessTreeSpawn(
      'C:\\Tools\\codex.exe',
      targetArgs,
      originalEnv,
      'win32',
    );
    const encodedSpec = prepared.env.OPENSWARM_WINDOWS_JOB_SPEC;
    const decodedSpec = JSON.parse(Buffer.from(encodedSpec!, 'base64').toString('utf8'));
    const supervisorCommand = prepared.args.at(-1)!;
    const encodedSupervisor = supervisorCommand.match(/FromBase64String\('([^']+)'\)/)?.[1];
    const supervisor = Buffer.from(encodedSupervisor!, 'base64').toString('utf16le');
    const assignment = supervisor.indexOf(
      'AssignProcessToJobObject($job, [OpenSwarmJobObject]::GetCurrentProcess())',
    );
    const targetLaunch = supervisor.indexOf('[OpenSwarmJobObject]::RunTarget');

    expect(prepared.command).toBe(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(prepared.args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-InputFormat',
      'Text',
      '-OutputFormat',
      'Text',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      expect.stringContaining("[ScriptBlock]::Create("),
    ]);
    expect(encodedSupervisor).toBeTruthy();
    expect(decodedSpec).toMatchObject({
      command: 'C:\\Tools\\codex.exe',
      args: targetArgs,
      nodePath: process.execPath,
      nodeSupervisor: expect.any(String),
      crossSpawnPath: expect.stringContaining('cross-spawn'),
    });
    expect(originalEnv).not.toHaveProperty('OPENSWARM_WINDOWS_JOB_SPEC');
    expect(supervisor).toContain('[Console]::OutputEncoding = $utf8NoBom');
    expect(supervisor).toContain('$OutputEncoding = $utf8NoBom');
    expect(supervisor).toContain('Arguments = BuildCommandLine(arguments)');
    expect(supervisor).toContain('BaseStream.CopyToAsync(Console.OpenStandardOutput())');
    expect(supervisor).toContain('Task.WaitAll(new Task[] { stdout, stderr });');
    expect(decodedSpec.nodeSupervisor).toContain('const crossSpawn = require(spec.crossSpawnPath)');
    expect(decodedSpec.nodeSupervisor).toContain("stdio: ['pipe', 'pipe', 'pipe']");
    expect(supervisor).toContain('LimitFlags = 0x00002000');
    expect(assignment).toBeGreaterThan(-1);
    expect(targetLaunch).toBeGreaterThan(assignment);
  });

  it('cannot target a reused Windows PID after the wrapper has exited', () => {
    const exitedWrapperKill = vi.fn(() => false);
    const unrelatedReusedPidKill = vi.fn(() => true);

    terminateCliProcessTree({ pid: 7657, kill: exitedWrapperKill } as never, 'win32');

    expect(exitedWrapperKill).toHaveBeenCalledWith('SIGKILL');
    expect(unrelatedReusedPidKill).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('preserves a pre-existing one-shot graceful SIGINT handler', () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const gracefulShutdown = vi.fn();
    process.once('SIGINT', gracefulShutdown);

    trackCliProcessTree({ pid: 7659, kill: vi.fn() } as never);
    process.emit('SIGINT', 'SIGINT');

    expect(gracefulShutdown).toHaveBeenCalledOnce();
    expect(processKill).not.toHaveBeenCalledWith(-7659, 'SIGKILL');
    expect(processKill).not.toHaveBeenCalledWith(process.pid, 'SIGINT');
  });

  it.skipIf(process.platform === 'win32')('refuses the group signal for an unverifiable pid on AbortSignal and removes parent hooks', async () => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 7658,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      kill: vi.fn(),
    });
    spawnMock.mockReturnValueOnce(proc);
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const beforeSigint = process.listenerCount('SIGINT');
    const beforeSigterm = process.listenerCount('SIGTERM');
    const controller = new AbortController();
    const adapter: CliAdapter = {
      name: 'fixture',
      capabilities: {
        supportsStreaming: false,
        supportsJsonOutput: false,
        supportsModelSelection: false,
        managedGit: false,
        supportedSkills: [],
      },
      isAvailable: async () => true,
      getDefaultModel: async () => 'fixture',
      buildCommand: () => ({ command: 'fixture-cli', args: [] }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve', feedback: '', issues: [], suggestions: [] }),
    };

    const running = spawnCli(adapter, { prompt: 'hello', cwd: process.cwd(), signal: controller.signal });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    expect(process.listenerCount('SIGINT')).toBe(beforeSigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm + 1);

    controller.abort(new Error('cancelled by test'));

    await expect(running).rejects.toThrow('cancelled by test');
    // 7658 is fabricated: the ownership lookup cannot verify it leads a group,
    // so the group signal must NOT be sent — kill(-fakepid, SIGKILL) from this
    // very suite once wiped the operator's login session. The direct handle is
    // still killed.
    expect(processKill).not.toHaveBeenCalledWith(-7658, 'SIGKILL');
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(process.listenerCount('SIGINT')).toBe(beforeSigint);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
  });
});

describe('argv-safe adapter spawning', () => {
  it('passes metacharacters as one argv value with shell disabled', async () => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 123,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      kill: vi.fn(),
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => proc.emit('close', 0));
      return proc;
    });
    const injected = 'model; touch /tmp/openswarm-should-not-exist';
    const adapter: CliAdapter = {
      name: 'fixture',
      capabilities: {
        supportsStreaming: false,
        supportsJsonOutput: false,
        supportsModelSelection: true,
        managedGit: false,
        supportedSkills: [],
      },
      isAvailable: async () => true,
      getDefaultModel: async () => 'fixture',
      buildCommand: () => ({ command: 'fixture-cli', args: ['--model', injected] }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve', feedback: '', issues: [], suggestions: [] }),
    };

    await expect(spawnCli(adapter, { prompt: 'hello', cwd: process.cwd() })).resolves.toMatchObject({ exitCode: 0 });
    expect(spawnMock).toHaveBeenCalledWith(
      'fixture-cli',
      ['--model', injected],
      expect.objectContaining({
        shell: false,
        detached: process.platform !== 'win32',
      }),
    );
  });

  it('removes adapter-owned temporary paths after the child settles', async () => {
    const proc = Object.assign(new EventEmitter(), {
      pid: 124,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      kill: vi.fn(),
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => proc.emit('close', 0));
      return proc;
    });
    const temporaryDir = mkdtempSync(join(tmpdir(), 'openswarm-adapter-cleanup-'));
    writeFileSync(join(temporaryDir, 'mcp.json'), '{}');
    const adapter = {
      name: 'fixture',
      capabilities: { supportsStreaming: false, supportsJsonOutput: false, supportsModelSelection: false, managedGit: false, supportedSkills: [] },
      isAvailable: async () => true,
      getDefaultModel: async () => 'fixture',
      buildCommand: () => ({ command: 'fixture-cli', args: [], cleanupPaths: [temporaryDir] }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve' as const, feedback: '', issues: [], suggestions: [] }),
    } satisfies CliAdapter;

    await spawnCli(adapter, { prompt: 'hello', cwd: process.cwd() });

    expect(existsSync(temporaryDir)).toBe(false);
  });

  it('settles after child exit when an inherited stdio descriptor prevents close', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const proc = Object.assign(new EventEmitter(), {
        pid: 125,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
        kill: vi.fn(),
      });
      spawnMock.mockImplementationOnce(() => {
        queueMicrotask(() => proc.emit('exit', 0));
        return proc;
      });
      const adapter = {
        name: 'fixture',
        capabilities: { supportsStreaming: false, supportsJsonOutput: false, supportsModelSelection: false, managedGit: false, supportedSkills: [] },
        isAvailable: async () => true,
        getDefaultModel: async () => 'fixture',
        buildCommand: () => ({ command: 'fixture-cli', args: [] }),
        parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
        parseReviewerOutput: () => ({ decision: 'approve' as const, feedback: '', issues: [], suggestions: [] }),
      } satisfies CliAdapter;

    const started = Date.now();
    await expect(spawnCli(adapter, { prompt: 'hello', cwd: process.cwd() }))
      .resolves.toMatchObject({ exitCode: 0 });
    expect(Date.now() - started).toBeLessThan(2_000);
    // Unverifiable pid: the tree teardown must fall back to the direct handle
    // instead of signalling a group it cannot prove it owns.
    expect(processKill).not.toHaveBeenCalledWith(-125, 'SIGKILL');
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('hard-times-out command construction that ignores AbortSignal and handles its late rejection', async () => {
    const adapter = {
      name: 'fixture',
      capabilities: { supportsStreaming: false, supportsJsonOutput: false, supportsModelSelection: false, managedGit: false, supportedSkills: [] },
      isAvailable: async () => true,
      getDefaultModel: async () => 'fixture',
      buildCommand: () => new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late command failure')), 300);
      }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve' as const, feedback: '', issues: [], suggestions: [] }),
    } as unknown as CliAdapter;

    const started = Date.now();
    await expect(spawnCli(adapter, {
      prompt: 'hello',
      cwd: process.cwd(),
      timeoutMs: 25,
    })).rejects.toThrow('fixture timeout after 25ms');
    expect(Date.now() - started).toBeLessThan(150);
    expect(spawnMock).not.toHaveBeenCalled();
    // Let the abandoned operation reject. Vitest will fail this test if it
    // escapes as an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 325));
  });

  it('hard-times-out adapter.run when the adapter ignores AbortSignal', async () => {
    const adapter = {
      name: 'fixture',
      capabilities: { supportsStreaming: false, supportsJsonOutput: false, supportsModelSelection: false, managedGit: false, supportedSkills: [] },
      isAvailable: async () => true,
      getDefaultModel: async () => 'fixture',
      buildCommand: () => ({ command: 'fixture-cli', args: [] }),
      run: () => new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late run failure')), 300);
      }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve' as const, feedback: '', issues: [], suggestions: [] }),
    } satisfies CliAdapter;

    const started = Date.now();
    await expect(spawnCli(adapter, {
      prompt: 'hello',
      cwd: process.cwd(),
      timeoutMs: 25,
    })).rejects.toThrow('fixture timeout after 25ms');
    expect(Date.now() - started).toBeLessThan(150);
    await new Promise((resolve) => setTimeout(resolve, 325));
  });
});

describe('read-only fail-closed guard (INT-3189)', () => {
  const stub = (enforcesReadOnly?: boolean): CliAdapter => ({
    name: 'fixture',
    capabilities: {
      supportsStreaming: false,
      supportsJsonOutput: false,
      supportsModelSelection: false,
      managedGit: false,
      supportedSkills: [],
      ...(enforcesReadOnly === undefined ? {} : { enforcesReadOnly }),
    },
    isAvailable: async () => true,
    getDefaultModel: async () => 'fixture',
    buildCommand: () => ({ command: 'fixture-cli', args: [] }),
    run: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }),
    parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
    parseReviewerOutput: () => ({ decision: 'approve', feedback: '', issues: [], suggestions: [] }),
  });

  it('refuses a read-only run on an adapter that cannot enforce it', async () => {
    // The alternative is running with full tool access while the caller believes
    // writes and shell are denied — the failure mode the flag exists to prevent.
    await expect(
      spawnCli(stub(), { prompt: 'p', cwd: process.cwd(), readOnly: true }),
    ).rejects.toThrow(/cannot enforce read-only/);
  });

  it('lets the same adapter run when read-only was never asked for', async () => {
    await expect(spawnCli(stub(), { prompt: 'p', cwd: process.cwd() })).resolves.toMatchObject({ exitCode: 0 });
  });

  it('runs read-only on an adapter that declares enforcement', async () => {
    await expect(
      spawnCli(stub(true), { prompt: 'p', cwd: process.cwd(), readOnly: true }),
    ).resolves.toMatchObject({ exitCode: 0 });
  });
});

describe('stdin EPIPE must not take the process down (INT-2961)', () => {
  it('handles an error on the child stdin stream', async () => {
    // A CLI that exits before draining the pipe — a rejected flag, an auth
    // failure, our own SIGKILL on timeout — makes the pending write emit EPIPE.
    // An 'error' event with no listener is rethrown by Node as an uncaught
    // exception; it arrives asynchronously, so neither the promise nor the
    // caller's try/catch sees it and the daemon dies. `proc.on('error')` is a
    // different emitter and does not cover this.
    const stdinStream = Object.assign(new EventEmitter(), { end: vi.fn() });
    const proc = Object.assign(new EventEmitter(), {
      pid: 321,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: stdinStream,
      kill: vi.fn(),
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        stdinStream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        proc.emit('close', 1);
      });
      return proc;
    });

    const logged: string[] = [];
    const adapter = {
      name: 'fixture',
      capabilities: { supportsStreaming: false, supportsJsonOutput: false, supportsModelSelection: false, managedGit: false, supportedSkills: [] },
      isAvailable: async () => true,
      getDefaultModel: async () => 'fixture',
      buildCommand: (o: { prompt: string }) => ({ command: 'fixture-cli', args: [], stdinFile: o.prompt }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve', feedback: '', issues: [], suggestions: [] }),
    } as unknown as CliAdapter;

    // Fails through the normal 'close' path with the child's real exit code,
    // rather than throwing out of band where nothing can catch it.
    await expect(
      spawnCli(adapter, { prompt: 'p', cwd: process.cwd(), onLog: (l) => logged.push(l) }),
    ).rejects.toThrow(/failed with code 1/);
    expect(stdinStream.listenerCount('error')).toBeGreaterThan(0);
    expect(logged.join('\n')).toContain('EPIPE');
  });
});

describe('delegated-CLI capability guards', () => {
  /** An adapter with no `run()` — spawnCli shells out to its CLI, which brings its own tool loop. */
  const delegated = (): CliAdapter => ({
    name: 'fixture-cli',
    capabilities: {
      supportsStreaming: false,
      supportsJsonOutput: false,
      supportsModelSelection: false,
      managedGit: false,
      supportedSkills: [],
      enforcesReadOnly: true,
    },
    isAvailable: async () => true,
    getDefaultModel: async () => 'fixture',
    buildCommand: () => ({ command: 'fixture-cli', args: [] }),
    parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
    parseReviewerOutput: () => ({ decision: 'approve', feedback: '', issues: [], suggestions: [] }),
  });

  it('refuses to run an agent that requires the shell withheld', async () => {
    // The orchestrator's containment depends on this: it holds GitHub, Linear,
    // and Cloudflare credentials, and a delegated CLI would hand it a shell.
    await expect(
      spawnCli(delegated(), { prompt: 'p', cwd: process.cwd(), shellTools: false }),
    ).rejects.toThrow(/cannot withhold shell access/);
  });

  it('warns rather than silently dropping MCP and coordination tools', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const proc = Object.assign(new EventEmitter(), {
      pid: 1, stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn(),
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => proc.emit('close', 0));
      return proc;
    });

    await spawnCli(delegated(), {
      prompt: 'p',
      cwd: process.cwd(),
      mcpTools: [{ type: 'function', function: { name: 'github__get_issue', description: '', parameters: { type: 'object' } } }],
      coordinationContext: { repository: '/repo', taskId: 't1', actor: 'magos-test' },
    });

    expect(warn.mock.calls.flat().join(' ')).toMatch(/1 MCP tool\(s\) and coordination tools will not be available/);
    warn.mockRestore();
  });
});
