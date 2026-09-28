import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from './types.js';

const spawnMock = vi.hoisted(() => vi.fn());
const savedSessionLogEnabled = process.env.OPENSWARM_SESSION_LOG;
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: spawnMock,
}));

import { spawnCli, terminateCliProcessTree, CLI_OUTPUT_MAX_BYTES } from './base.js';
import {
  prepareCliProcessTreeSpawn,
  trackCliProcessTree,
} from './processTree.js';
import { enableHumanSurfaceReadOnly, resetHumanSurfaceReadOnlyForTests } from '../mcp/humanSurfacePolicy.js';

beforeEach(() => {
  spawnMock.mockReset();
  // Most spawn tests do not assert observability; keep their fake invocations
  // from writing under the operator's real session directory.
  process.env.OPENSWARM_SESSION_LOG = '0';
});
afterEach(() => {
  resetHumanSurfaceReadOnlyForTests();
  vi.restoreAllMocks();
  if (savedSessionLogEnabled === undefined) delete process.env.OPENSWARM_SESSION_LOG;
  else process.env.OPENSWARM_SESSION_LOG = savedSessionLogEnabled;
});

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
  it('writes a CLI-level transcript with the prompt, raw output, and exit result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'osw-cli-session-'));
    const saved = process.env.OPENSWARM_SESSION_LOG_DIR;
    process.env.OPENSWARM_SESSION_LOG_DIR = root;
    process.env.OPENSWARM_SESSION_LOG = '1';
    const proc = Object.assign(new EventEmitter(), {
      pid: 121,
      stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn(),
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        proc.stdout.end('raw CLI result');
        proc.emit('close', 0);
      });
      return proc;
    });
    const adapter: CliAdapter = {
      name: 'claude', capabilities: { supportsStreaming: false, supportsJsonOutput: false, supportsModelSelection: true, managedGit: false, supportedSkills: [] },
      isAvailable: async () => true, getDefaultModel: async () => 'sonnet',
      buildCommand: () => ({ command: 'fixture-cli', args: [] }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve', feedback: '', issues: [], suggestions: [] }),
    };

    try {
      await expect(spawnCli(adapter, {
        prompt: 'repair the session log', cwd: process.cwd(), model: 'sonnet',
        usageAttribution: { adapter: 'claude', taskId: 'AGT-4456', stage: 'worker' },
      })).resolves.toMatchObject({ exitCode: 0 });
      const taskDir = join(root, 'AGT-4456');
      const [file] = readdirSync(taskDir);
      const log = readFileSync(join(taskDir, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      expect(log[0]).toMatchObject({ type: 'start', recordingLevel: 'cli', adapter: 'claude', taskId: 'AGT-4456', stage: 'worker' });
      expect(log).toContainEqual(expect.objectContaining({ type: 'notice', note: 'prompt', prompt: 'repair the session log' }));
      expect(log).toContainEqual(expect.objectContaining({ type: 'assistant', rawStdout: 'raw CLI result' }));
      expect(log.at(-1)).toMatchObject({ type: 'end', outcome: 'returned', exitCode: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (saved === undefined) delete process.env.OPENSWARM_SESSION_LOG_DIR;
      else process.env.OPENSWARM_SESSION_LOG_DIR = saved;
    }
  });

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

  /**
   * The caller gets the timeout at its deadline, not when the ignored
   * operation (settling at 300ms) finally does.
   *
   * Timers run on a fake clock; file I/O stays real. spawnCli writes the prompt
   * file and removes it again around the deadline, and the caller hears about
   * the timeout only once that local I/O is done — by design, so no prompt is
   * left behind. The wall-clock bound this replaces (`< 150ms`) therefore timed
   * the runner's disk as much as the deadline: it failed main at 190ms on a
   * loaded CI runner, while an idle machine measured p99 31ms (AGT-4537).
   * Here the clock stops at 25ms: nothing is settled at 24ms, the timeout is
   * delivered with the clock still at 25ms, and the 300ms operation has not
   * run. That is stricter than the old bound and independent of load.
   */
  async function expectRejectedAtDeadline(adapter: CliAdapter, operationStarted: Promise<void>): Promise<void> {
    const realSetTimeout = globalThis.setTimeout;
    const realTimeCap = () => new Promise<'cap'>((resolve) => realSetTimeout(() => resolve('cap'), 10_000));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let outcome: string | undefined;
      const run = spawnCli(adapter, { prompt: 'hello', cwd: process.cwd(), timeoutMs: 25 })
        .then(() => { outcome = 'resolved'; }, (error: Error) => { outcome = error.message; });
      // Move the clock only once the operation under test is pending: fake
      // time does not wait for the real prompt-file I/O in front of it.
      expect(await Promise.race([operationStarted.then(() => 'started'), realTimeCap()])).toBe('started');
      await vi.advanceTimersByTimeAsync(24);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      // Only real I/O remains. A generous real-time cap turns "never
      // delivered at the deadline" into a failure instead of a hung test.
      await Promise.race([run, realTimeCap()]);
      expect(outcome).toBe('fixture timeout after 25ms');
      // Let the abandoned operation reject. Vitest fails the test if that
      // rejection escapes unhandled.
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
  }

  it('hard-times-out command construction that ignores AbortSignal and handles its late rejection', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const adapter = {
      name: 'fixture',
      capabilities: { supportsStreaming: false, supportsJsonOutput: false, supportsModelSelection: false, managedGit: false, supportedSkills: [] },
      isAvailable: async () => true,
      getDefaultModel: async () => 'fixture',
      buildCommand: () => new Promise<never>((_resolve, reject) => {
        markStarted();
        setTimeout(() => reject(new Error('late command failure')), 300);
      }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve' as const, feedback: '', issues: [], suggestions: [] }),
    } as unknown as CliAdapter;

    await expectRejectedAtDeadline(adapter, started);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('hard-times-out adapter.run when the adapter ignores AbortSignal', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const adapter = {
      name: 'fixture',
      capabilities: { supportsStreaming: false, supportsJsonOutput: false, supportsModelSelection: false, managedGit: false, supportedSkills: [] },
      isAvailable: async () => true,
      getDefaultModel: async () => 'fixture',
      buildCommand: () => ({ command: 'fixture-cli', args: [] }),
      run: () => new Promise<never>((_resolve, reject) => {
        markStarted();
        setTimeout(() => reject(new Error('late run failure')), 300);
      }),
      parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
      parseReviewerOutput: () => ({ decision: 'approve' as const, feedback: '', issues: [], suggestions: [] }),
    } satisfies CliAdapter;

    await expectRejectedAtDeadline(adapter, started);
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

  it('warns that a role tool allow/deny list is inert on a delegated CLI, without failing the run', async () => {
    // The delegated CLI owns its own tools, so the list cannot be enforced here.
    // Warning (not throwing) keeps existing claude/codex configs running while
    // making sure a fence nobody applies is never silent. (AGT-4444 class)
    const warns: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { warns.push(String(line)); });
    const proc = Object.assign(new EventEmitter(), {
      pid: 311,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      kill: vi.fn(),
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        proc.stdout.end('ok');
        proc.emit('close', 0);
      });
      return proc;
    });
    try {
      await expect(spawnCli(delegated(), {
        prompt: 'p', cwd: process.cwd(), toolAllow: ['read_file'], toolDeny: ['scratch_*'],
      })).resolves.toMatchObject({ stdout: 'ok' });
    } finally {
      warn.mockRestore();
    }
    expect(warns.join('\n')).toContain('the role tool allow/deny list');
  });

  it('warns that protectedFiles and forbidPublication are inert on a delegated CLI (AGT-4444)', async () => {
    // Same failure class as the tool list: these fences live in the in-process
    // tool executor, so a role routed to a delegated CLI silently loses them.
    // The warning is the defect's whole point — silence is what made a dead
    // fence look like a working one.
    const warns: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { warns.push(String(line)); });
    const proc = Object.assign(new EventEmitter(), {
      pid: 312,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      kill: vi.fn(),
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        proc.stdout.end('ok');
        proc.emit('close', 0);
      });
      return proc;
    });
    try {
      await expect(spawnCli(delegated(), {
        prompt: 'p', cwd: process.cwd(),
        protectedFiles: ['secrets.env'],
        forbidPublication: true,
      })).resolves.toMatchObject({ stdout: 'ok' });
    } finally {
      warn.mockRestore();
    }
    const text = warns.join('\n');
    expect(text).toContain('1 protected path(s)');
    expect(text).toContain('the publication fence');
  });

  it('does not construct or spawn a delegated fake CLI in strict mode, even with HOME credentials', async () => {
    const buildCommand = vi.fn(() => ({ command: 'fake-codex', args: [] }));
    const adapter = { ...delegated(), name: 'fake-codex', buildCommand } satisfies CliAdapter;
    const previousHome = process.env.HOME;
    process.env.HOME = '/tmp/fake-home-with-human-credentials';
    enableHumanSurfaceReadOnly();
    try {
      await expect(spawnCli(adapter, { prompt: 'p', cwd: process.cwd() }))
        .rejects.toThrow(/HUMAN_SURFACE_READ_ONLY.*delegates to an external CLI/);
      expect(buildCommand).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('keeps native adapters and preserves the companion-shell request while forcing diagnostics off', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }));
    const base = delegated();
    const adapter = {
      ...base,
      name: 'native',
      capabilities: { ...base.capabilities, enforcesHumanSurfaceReadOnly: true },
      run,
    } satisfies CliAdapter;
    enableHumanSurfaceReadOnly();

    await expect(spawnCli(adapter, {
      prompt: 'p', cwd: process.cwd(), shellTools: true, diagnosticsTool: true,
    })).resolves.toMatchObject({ stdout: 'ok' });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ shellTools: true, diagnosticsTool: false }));
  });

  it('refuses a run adapter that has not declared strict-boundary enforcement', async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: 'unsafe', stderr: '', durationMs: 1 }));
    const adapter = { ...delegated(), name: 'untrusted-native', run } satisfies CliAdapter;
    enableHumanSurfaceReadOnly();

    await expect(spawnCli(adapter, { prompt: 'p', cwd: process.cwd() }))
      .rejects.toThrow(/does not declare enforcement/);
    expect(run).not.toHaveBeenCalled();
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

describe('bounded CLI output retention', () => {
  /** An adapter whose CLI shells out, with optional incremental stream parsing. */
  const fixture = (parseStreamingChunk?: CliAdapter['parseStreamingChunk']): CliAdapter => ({
    name: 'fixture-cli',
    capabilities: {
      supportsStreaming: !!parseStreamingChunk,
      supportsJsonOutput: false,
      supportsModelSelection: false,
      managedGit: false,
      supportedSkills: [],
    },
    isAvailable: async () => true,
    getDefaultModel: async () => 'fixture',
    buildCommand: () => ({ command: 'fixture-cli', args: [] }),
    parseStreamingChunk,
    parseWorkerOutput: () => ({ success: true, summary: '', filesChanged: [], commands: [], output: '' }),
    parseReviewerOutput: () => ({ decision: 'approve', feedback: '', issues: [], suggestions: [] }),
  });

  const mockProc = (pid: number, emit: (proc: { stdout: PassThrough; stderr: PassThrough }) => void) => {
    const proc = Object.assign(new EventEmitter(), {
      pid,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      kill: vi.fn(),
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        emit(proc);
        proc.emit('close', 0);
      });
      return proc;
    });
    return proc;
  };

  it('resolves a flooding CLI and marks the retained output as truncated', async () => {
    // A wedged or adversarial CLI can write for the whole timeout window. The
    // retained copy is capped, so the daemon holds a bounded tail instead of
    // everything the child ever printed. (The marker must be in the data: a
    // silently short stdout reads as "the CLI said nothing".)
    const floodBytes = 3 * 1024 * 1024;
    mockProc(911, ({ stdout }) => {
      stdout.write('a'.repeat(floodBytes));
      stdout.end('FINAL_RESULT_LINE');
    });

    const result = await spawnCli(fixture(), { prompt: 'p', cwd: process.cwd() });

    expect(result.exitCode).toBe(0);
    // The tail is what every parser reads (`messages.at(-1)`, the stream-json
    // result event), so the terminal line must survive the clip.
    expect(result.stdout.endsWith('FINAL_RESULT_LINE')).toBe(true);
    expect(result.stdout).toContain('[openswarm-cli-output:');
    expect(result.stdout).toMatch(/\[openswarm-cli-output: \d+ bytes omitted from the head\]/);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(CLI_OUTPUT_MAX_BYTES);

    // The count is the real one: it plus what was kept accounts for every byte.
    const [, dropped] = result.stdout.match(/\[openswarm-cli-output: (\d+) bytes omitted/)!;
    const keptBytes = Buffer.byteLength(result.stdout.slice(result.stdout.indexOf('\n') + 1), 'utf8');
    expect(Number(dropped) + keptBytes).toBe(floodBytes + 'FINAL_RESULT_LINE'.length);
    // The marker line itself is what the operator sees instead of the head.
    expect(result.stdout.split('\n')[0]).toMatch(/^\[openswarm-cli-output:/);
  });

  it('bounds stderr independently and keeps the diagnostic tail', async () => {
    // stderr is where a failing CLI explains itself; the failure path below
    // reports a snippet from it, so the tail must be the part retained.
    const floodBytes = 2.5 * 1024 * 1024;
    mockProc(912, ({ stderr }) => {
      stderr.write('x'.repeat(floodBytes));
      stderr.end('Error: ENOENT: no such file or directory');
    });

    const result = await spawnCli(fixture(), { prompt: 'p', cwd: process.cwd() });

    expect(result.stderr.endsWith('Error: ENOENT: no such file or directory')).toBe(true);
    expect(result.stderr).toContain('[openswarm-cli-output:');
    expect(Buffer.byteLength(result.stderr, 'utf8')).toBeLessThanOrEqual(CLI_OUTPUT_MAX_BYTES);
    // Each stream carries its own ceiling — a flooding stdout must not eat the
    // stderr budget, and vice versa.
    expect(result.stdout).toBe('');
  });

  it('leaves a normal run byte-for-byte untouched', async () => {
    mockProc(913, ({ stdout, stderr }) => {
      stdout.end('{"type":"result","result":"all good"}');
      stderr.end('warning: deprecated flag');
    });

    const result = await spawnCli(fixture(), { prompt: 'p', cwd: process.cwd() });

    expect(result.stdout).toBe('{"type":"result","result":"all good"}');
    expect(result.stderr).toBe('warning: deprecated flag');
    expect(result.stdout).not.toContain('[openswarm-cli-output:');
    expect(result.stderr).not.toContain('[openswarm-cli-output:');
  });

  it('still feeds every byte to an incremental stream parser', async () => {
    // The bound applies to the RETAINED copy only. The live log is built by the
    // streaming parser from each chunk as it arrives; clipping its input would
    // silently drop the middle of a long assistant message from the dashboard.
    let seen = 0;
    const parseStreamingChunk = vi.fn((chunk: string, _onLog: (line: string) => void, buffer = '') => {
      seen += chunk.length;
      return buffer;
    });
    const floodBytes = 3 * 1024 * 1024;
    mockProc(914, ({ stdout }) => stdout.end('b'.repeat(floodBytes)));

    const logged: string[] = [];
    const result = await spawnCli(fixture(parseStreamingChunk), {
      prompt: 'p', cwd: process.cwd(), onLog: (line) => logged.push(line),
    });

    expect(seen).toBe(floodBytes);
    expect(result.stdout).toContain('[openswarm-cli-output:');
  });

  it('bounds multibyte output by bytes, not characters, and keeps the tail decodable', async () => {
    // 3 bytes per char: a char-wise cap would retain 3x the ceiling in bytes,
    // and clipping the string rather than the buffer would also leave a broken
    // half-character at the cut. Both are invisible with ASCII fixtures.
    const floodBytes = 3 * 1024 * 1024;
    mockProc(915, ({ stdout }) => {
      stdout.write('한'.repeat(floodBytes / 3));
      stdout.end('\n결과: 완료');
    });

    const result = await spawnCli(fixture(), { prompt: 'p', cwd: process.cwd() });

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(CLI_OUTPUT_MAX_BYTES);
    expect(result.stdout.endsWith('\n결과: 완료')).toBe(true);
    expect(result.stdout).toContain('[openswarm-cli-output:');
    // No replacement character: the cut did not split a character in place.
    expect(result.stdout).not.toContain('\uFFFD');
  });
});
