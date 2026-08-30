import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxExecutorClient } from './client.js';
import type { SandboxIsolationBackend, WorkspaceIdentity } from './bubblewrap.js';
import {
  DEFAULT_SANDBOX_EXECUTOR_LIMITS,
  SANDBOX_EXECUTOR_ENV_KEYS,
  SANDBOX_EXECUTOR_PROTOCOL,
  SandboxOutcomeUnknownError,
  type SandboxExecutionResult,
  type SandboxExecutorContract,
} from './protocol.js';
import { SandboxExecutorServer, type SandboxExecutorServerOptions } from './server.js';

const success = (output = 'ok\n'): SandboxExecutionResult => ({
  output,
  exitCode: 0,
  signal: null,
  timedOut: false,
  truncated: false,
  outputLimitExceeded: false,
});

class FakeBackend implements SandboxIsolationBackend {
  prove = vi.fn(async () => undefined);
  execute = vi.fn(async (_workspace: WorkspaceIdentity, command: string) => success(command));
  close = vi.fn(async () => undefined);
}

async function rawExchange(socketPath: string, bytes: Buffer | string): Promise<Record<string, unknown>> {
  return await new Promise((resolveResponse, rejectResponse) => {
    const socket = net.createConnection(socketPath);
    let output = Buffer.alloc(0);
    socket.once('connect', () => socket.write(bytes));
    socket.on('data', (chunk: Buffer) => { output = Buffer.concat([output, chunk]); });
    socket.once('error', rejectResponse);
    socket.once('close', () => {
      try { resolveResponse(JSON.parse(output.toString('utf8').trim()) as Record<string, unknown>); }
      catch (error) { rejectResponse(error); }
    });
  });
}

describe('sandbox executor Unix protocol', () => {
  let disposableRoot: string;
  let root: string;
  let workspace: string;
  let socketParent: string;
  let socketPath: string;
  let backend: FakeBackend;
  let server: SandboxExecutorServer | undefined;

  const options = (): SandboxExecutorServerOptions => ({
    socketPath,
    allowedRoots: [root],
    backend,
    connectTimeoutMs: 500,
    maxRequestBytes: 4 * 1024,
    maxOutputBytes: 4 * 1024,
    maxTimeoutMs: 5_000,
    maxConcurrent: 2,
  });

  const client = (): SandboxExecutorClient => new SandboxExecutorClient({
    socketPath,
    allowedRoots: [root],
    connectTimeoutMs: 500,
    maxRequestBytes: 4 * 1024,
    maxOutputBytes: 4 * 1024,
    maxTimeoutMs: 5_000,
    maxConcurrent: 2,
  });

  beforeEach(async () => {
    disposableRoot = await mkdtemp('/tmp/osw-srv-');
    root = await realpath(disposableRoot);
    workspace = join(root, 'r');
    socketParent = join(root, 's');
    socketPath = join(socketParent, 'e.sock');
    await Promise.all([
      mkdir(join(workspace, '.git'), { recursive: true }),
      mkdir(socketParent, { mode: 0o700 }),
    ]);
    await chmod(socketParent, 0o700);
    backend = new FakeBackend();
  });

  afterEach(async () => {
    await server?.close();
    await rm(disposableRoot, { recursive: true, force: true });
  });

  it('proves the backend before listening, registers an inode-bound workspace, and executes it', async () => {
    server = new SandboxExecutorServer(options());
    const contract = await server.start();
    const session = await client().createSession(workspace);

    await expect(session.execute('npm test', 1_000)).resolves.toMatchObject({ output: 'npm test' });
    expect(backend.prove).toHaveBeenCalledWith([root], socketPath);
    expect(backend.execute).toHaveBeenCalledWith(
      expect.objectContaining({ path: workspace, dev: expect.any(BigInt), ino: expect.any(BigInt) }),
      'npm test',
      1_000,
      4 * 1024,
    );
    expect(contract.bootGeneration).toHaveLength(36);
    expect((await lstat(socketPath)).mode & 0o077).toBe(0);
  });

  it('does not create a capability socket when the production isolation proof fails', async () => {
    backend.prove.mockRejectedValueOnce(new Error('bwrap probe failed'));
    server = new SandboxExecutorServer(options());

    await expect(server.start()).rejects.toThrow('bwrap probe failed');
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a group-accessible socket parent instead of trusting socket mode alone', async () => {
    await chmod(socketParent, 0o770);
    server = new SandboxExecutorServer(options());

    await expect(server.start()).rejects.toThrow(/private, same-uid real directory/);
  });

  it('rejects symlinked workspace registrations even when their target is under an allowed root', async () => {
    server = new SandboxExecutorServer(options());
    await server.start();
    const alias = join(root, 'repo-link');
    await symlink(workspace, alias);

    await expect(client().createSession(alias)).rejects.toThrow(/real directory|traverse symlinks/);
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('rejects unknown fields, invalid UTF-8, and oversized newline frames', async () => {
    server = new SandboxExecutorServer(options());
    await server.start();
    const unknown = await rawExchange(socketPath, `${JSON.stringify({
      protocol: SANDBOX_EXECUTOR_PROTOCOL,
      id: 'one',
      type: 'health',
      injected: true,
    })}\n`);
    const invalidUtf8 = await rawExchange(socketPath, Buffer.from([0xff, 0x0a]));
    const oversized = await rawExchange(socketPath, `${'x'.repeat(4 * 1024 + 1)}\n`);

    expect(unknown).toMatchObject({ ok: false, error: 'Request contains missing or unknown fields' });
    expect(invalidUtf8).toMatchObject({ ok: false, error: expect.stringMatching(/encoded|UTF-8/i) });
    expect(oversized).toMatchObject({ ok: false, error: 'Request exceeds maxRequestBytes' });
  });

  it('serializes commands by workspace identity and rejects a concurrent duplicate before start', async () => {
    let release!: (value: SandboxExecutionResult) => void;
    backend.execute.mockImplementationOnce(async () => await new Promise<SandboxExecutionResult>((resolveResult) => {
      release = resolveResult;
    }));
    server = new SandboxExecutorServer(options());
    await server.start();
    const session = await client().createSession(workspace);
    const first = session.execute('first', 1_000);
    await vi.waitFor(() => expect(backend.execute).toHaveBeenCalledOnce());

    await expect(session.execute('second', 1_000)).rejects.toThrow('already has an active command');
    expect(backend.execute).toHaveBeenCalledOnce();
    release(success('first complete'));
    await expect(first).resolves.toMatchObject({ output: 'first complete' });
  });
});

describe('sandbox executor unknown-outcome client boundary', () => {
  let disposableRoot: string;
  let root: string;
  let workspace: string;
  let socketParent: string;
  let socketPath: string;
  let fakeServer: net.Server | undefined;

  beforeEach(async () => {
    disposableRoot = await mkdtemp('/tmp/osw-cli-');
    root = await realpath(disposableRoot);
    workspace = join(root, 'r');
    socketParent = join(root, 's');
    socketPath = join(socketParent, 'e.sock');
    await Promise.all([
      mkdir(join(workspace, '.git'), { recursive: true }),
      mkdir(socketParent, { mode: 0o700 }),
    ]);
    await chmod(socketParent, 0o700);
  });

  afterEach(async () => {
    if (fakeServer) await new Promise<void>((resolveClose) => fakeServer!.close(() => resolveClose()));
    await rm(disposableRoot, { recursive: true, force: true });
  });

  it('returns OUTCOME_UNKNOWN_DO_NOT_RETRY when the response is lost after an exec frame is written', async () => {
    const bootGeneration = randomUUID();
    const contract: SandboxExecutorContract = {
      protocol: SANDBOX_EXECUTOR_PROTOCOL,
      bootGeneration,
      allowedRoots: [root],
      environmentKeys: [...SANDBOX_EXECUTOR_ENV_KEYS, 'OPENSWARM_SANDBOX_PROCESS_MARKER'].sort(),
      networkIsolation: 'loopback-only',
      filesystemIsolation: 'bubblewrap-workspace-bind-v1',
      processIsolation: 'bubblewrap-pid-namespace-v1',
      secretMasking: 'workspace-sensitive-path-overlay-v1',
      ...DEFAULT_SANDBOX_EXECUTOR_LIMITS,
    };
    fakeServer = net.createServer((socket) => {
      let frame = '';
      socket.on('data', (chunk: Buffer) => {
        frame += chunk.toString('utf8');
        if (!frame.includes('\n')) return;
        const request = JSON.parse(frame.trim()) as { id: string; type: string };
        if (request.type === 'exec') {
          socket.destroy();
          return;
        }
        const response = request.type === 'health'
          ? { protocol: SANDBOX_EXECUTOR_PROTOCOL, id: request.id, type: 'health', ok: true, contract }
          : {
              protocol: SANDBOX_EXECUTOR_PROTOCOL,
              id: request.id,
              type: 'register',
              ok: true,
              contract,
              workspace,
              workspaceToken: 'x'.repeat(43),
            };
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      fakeServer!.once('error', rejectListen);
      fakeServer!.listen(socketPath, resolveListen);
    });
    await chmod(socketPath, 0o600);
    const client = new SandboxExecutorClient({
      socketPath,
      allowedRoots: [root],
      connectTimeoutMs: 500,
      ...DEFAULT_SANDBOX_EXECUTOR_LIMITS,
    });
    const session = await client.createSession(workspace);

    const execution = session.execute('printf partial > artifact', 1_000);
    await expect(execution).rejects.toBeInstanceOf(SandboxOutcomeUnknownError);
    await expect(execution).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN_DO_NOT_RETRY' });
  });
});
