import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import net, { type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  BubblewrapSandboxBackend,
  canonicalAllowedRoots,
  canonicalWorkspaceIdentity,
  type SandboxIsolationBackend,
  type WorkspaceIdentity,
} from './bubblewrap.js';
import {
  SANDBOX_EXECUTOR_ENV_KEYS,
  SANDBOX_EXECUTOR_PROTOCOL,
  type SandboxExecutorContract,
  type SandboxExecutorLimits,
  type SandboxExecutorRequest,
  type SandboxExecutorResponse,
} from './protocol.js';

interface WorkspaceRegistration {
  identity: WorkspaceIdentity;
  expiresAt: number;
}

export interface SandboxExecutorServerOptions extends SandboxExecutorLimits {
  socketPath: string;
  allowedRoots: string[];
  backend?: SandboxIsolationBackend;
  requestIdleTimeoutMs?: number;
  registrationTtlMs?: number;
  maxRegistrations?: number;
  now?: () => number;
}

function isSafeRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128;
}

function responseFrame(response: SandboxExecutorResponse): string {
  return `${JSON.stringify(response)}\n`;
}

async function socketIsActive(path: string): Promise<boolean> {
  return await new Promise((resolveActive) => {
    const socket = net.createConnection(path);
    const finish = (active: boolean) => { socket.destroy(); resolveActive(active); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), 250);
  });
}

async function prepareSocketPath(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(path));
  const canonicalParent = await realpath(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || canonicalParent !== dirname(path)
      || (parent.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && parent.uid !== process.getuid())) {
    throw new Error(`Sandbox executor socket parent must be a private, same-uid real directory: ${dirname(path)}`);
  }
  try {
    const existing = await lstat(path);
    if (!existing.isSocket() || existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-socket sandbox executor path: ${path}`);
    }
    if (typeof process.getuid === 'function' && existing.uid !== process.getuid()) {
      throw new Error(`Refusing to replace sandbox executor socket owned by uid ${existing.uid}`);
    }
    if (await socketIsActive(path)) throw new Error(`Sandbox executor socket is already active: ${path}`);
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function parseRequest(value: string): SandboxExecutorRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Malformed JSON request');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Request must be an object');
  const request = parsed as Record<string, unknown>;
  if (request.protocol !== SANDBOX_EXECUTOR_PROTOCOL) throw new Error('Unsupported sandbox executor protocol');
  if (!isSafeRequestId(request.id)) throw new Error('Invalid request id');
  const exactKeys = (keys: string[]): void => {
    const actual = Object.keys(request).sort();
    const expected = keys.sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Request contains missing or unknown fields');
  };
  if (request.type === 'health') {
    exactKeys(['protocol', 'id', 'type']);
  } else if (request.type === 'register') {
    exactKeys(['protocol', 'id', 'type', 'bootGeneration', 'workspace']);
    if (typeof request.bootGeneration !== 'string' || request.bootGeneration.length < 16 || request.bootGeneration.length > 128
        || typeof request.workspace !== 'string' || request.workspace.includes('\0')) {
      throw new Error('Invalid workspace registration request');
    }
  } else if (request.type === 'exec') {
    exactKeys(['protocol', 'id', 'type', 'bootGeneration', 'workspaceToken', 'command', 'timeoutMs']);
    if (typeof request.bootGeneration !== 'string' || request.bootGeneration.length < 16 || request.bootGeneration.length > 128
        || typeof request.workspaceToken !== 'string' || request.workspaceToken.length < 32 || request.workspaceToken.length > 256
        || typeof request.command !== 'string' || request.command.includes('\0') || typeof request.timeoutMs !== 'number') {
      throw new Error('Invalid execution request');
    }
  } else {
    throw new Error('Unknown request type');
  }
  return request as unknown as SandboxExecutorRequest;
}

export class SandboxExecutorServer {
  private readonly backend: SandboxIsolationBackend;
  private readonly now: () => number;
  private readonly sockets = new Set<Socket>();
  private readonly registrations = new Map<string, WorkspaceRegistration>();
  private server?: Server;
  private contract?: SandboxExecutorContract;
  private socketIdentity?: { dev: bigint; ino: bigint };
  private activeExecutions = 0;
  private readonly activeWorkspaces = new Set<string>();

  constructor(private readonly options: SandboxExecutorServerOptions) {
    this.backend = options.backend ?? new BubblewrapSandboxBackend();
    this.now = options.now ?? Date.now;
  }

  getContract(): SandboxExecutorContract {
    if (!this.contract) throw new Error('Sandbox executor is not ready');
    return { ...this.contract, allowedRoots: [...this.contract.allowedRoots], environmentKeys: [...this.contract.environmentKeys] };
  }

  async start(): Promise<SandboxExecutorContract> {
    if (this.server) throw new Error('Sandbox executor is already started');
    const allowedRoots = await canonicalAllowedRoots(this.options.allowedRoots);
    // The server TCB may see all configured roots, but no socket is opened and
    // no capability is advertised until the real network/mount/PID proof passes.
    await this.backend.prove(allowedRoots, this.options.socketPath);
    await prepareSocketPath(this.options.socketPath);
    const contract: SandboxExecutorContract = {
      protocol: SANDBOX_EXECUTOR_PROTOCOL,
      bootGeneration: randomUUID(),
      allowedRoots,
      environmentKeys: [...SANDBOX_EXECUTOR_ENV_KEYS, 'OPENSWARM_SANDBOX_PROCESS_MARKER'].sort(),
      networkIsolation: 'loopback-only',
      filesystemIsolation: 'bubblewrap-workspace-bind-v1',
      processIsolation: 'bubblewrap-pid-namespace-v1',
      secretMasking: 'workspace-sensitive-path-overlay-v1',
      maxRequestBytes: this.options.maxRequestBytes,
      maxOutputBytes: this.options.maxOutputBytes,
      maxTimeoutMs: this.options.maxTimeoutMs,
      maxConcurrent: this.options.maxConcurrent,
    };
    const server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(this.options.socketPath, () => {
        server.removeListener('error', rejectListen);
        resolveListen();
      });
    });
    await chmod(this.options.socketPath, 0o600);
    const socketMetadata = await lstat(this.options.socketPath, { bigint: true });
    if (!socketMetadata.isSocket()
        || (socketMetadata.mode & 0o077n) !== 0n
        || (typeof process.getuid === 'function' && socketMetadata.uid !== BigInt(process.getuid()))) {
      server.close();
      throw new Error('Sandbox executor socket ownership/type/mode attestation failed');
    }
    this.server = server;
    this.contract = contract;
    this.socketIdentity = { dev: socketMetadata.dev, ino: socketMetadata.ino };
    return this.getContract();
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setTimeout(this.options.requestIdleTimeoutMs ?? 5_000);
    let frame = Buffer.alloc(0);
    let handled = false;
    const fail = (id: string, type: SandboxExecutorResponse['type'], error: string) => {
      if (handled || !this.contract) return;
      handled = true;
      socket.end(responseFrame({ protocol: SANDBOX_EXECUTOR_PROTOCOL, id, type, ok: false, contract: this.getContract(), error } as SandboxExecutorResponse));
    };
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      frame = Buffer.concat([frame, chunk]);
      if (frame.length > this.options.maxRequestBytes) {
        fail('invalid', 'health', 'Request exceeds maxRequestBytes');
        return;
      }
      const newline = frame.indexOf(0x0a);
      if (newline < 0) return;
      if (frame.subarray(newline + 1).toString('utf8').trim() !== '') {
        fail('invalid', 'health', 'Exactly one request frame is allowed');
        return;
      }
      handled = true;
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(0, newline));
        if (decoded.includes('\0')) throw new Error('Request frame contains NUL');
        void this.handleFrame(socket, decoded);
      } catch (error) {
        socket.end(responseFrame({
          protocol: SANDBOX_EXECUTOR_PROTOCOL,
          id: 'invalid',
          type: 'health',
          ok: false,
          contract: this.getContract(),
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    });
    socket.on('timeout', () => fail('invalid', 'health', 'Request frame timed out'));
    socket.on('error', () => undefined);
    socket.on('close', () => this.sockets.delete(socket));
  }

  private async handleFrame(socket: Socket, frame: string): Promise<void> {
    let request: SandboxExecutorRequest;
    let executionStarted = false;
    try {
      request = parseRequest(frame);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      socket.end(responseFrame({
        protocol: SANDBOX_EXECUTOR_PROTOCOL,
        id: 'invalid',
        type: 'health',
        ok: false,
        contract: this.getContract(),
        error: message,
      }));
      return;
    }
    const base = {
      protocol: SANDBOX_EXECUTOR_PROTOCOL,
      id: request.id,
      type: request.type,
      contract: this.getContract(),
    } as const;
    try {
      if (request.type === 'health') {
        socket.end(responseFrame({ ...base, ok: true }));
        return;
      }
      if (request.bootGeneration !== this.contract?.bootGeneration) {
        throw new Error('Sandbox executor boot generation changed; re-attestation required');
      }
      if (request.type === 'register') {
        if (typeof request.workspace !== 'string' || request.workspace.length > 4096) {
          throw new Error('Invalid workspace registration path');
        }
        this.expireRegistrations();
        if (this.registrations.size >= (this.options.maxRegistrations ?? 1_024)) {
          throw new Error('Sandbox executor registration capacity reached');
        }
        const identity = await canonicalWorkspaceIdentity(request.workspace, this.contract.allowedRoots);
        const workspaceToken = randomBytes(32).toString('base64url');
        this.registrations.set(workspaceToken, {
          identity,
          expiresAt: this.now() + (this.options.registrationTtlMs ?? 60 * 60_000),
        });
        socket.end(responseFrame({ ...base, ok: true, workspace: identity.path, workspaceToken }));
        return;
      }
      if (typeof request.workspaceToken !== 'string' || request.workspaceToken.length < 32) {
        throw new Error('Invalid workspace token');
      }
      const registration = this.registrations.get(request.workspaceToken);
      if (!registration || registration.expiresAt <= this.now()) {
        this.registrations.delete(request.workspaceToken);
        throw new Error('Workspace registration is missing or expired');
      }
      if (typeof request.command !== 'string' || request.command.length < 1) throw new Error('Command is empty');
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > this.options.maxTimeoutMs) {
        throw new Error('Command timeout exceeds sandbox contract');
      }
      if (this.activeExecutions >= this.options.maxConcurrent) throw new Error('Sandbox executor is at concurrency capacity');
      const workspaceKey = `${registration.identity.dev}:${registration.identity.ino}`;
      if (this.activeWorkspaces.has(workspaceKey)) throw new Error('Sandbox workspace already has an active command');
      registration.expiresAt = this.now() + (this.options.registrationTtlMs ?? 60 * 60_000);
      this.activeExecutions += 1;
      this.activeWorkspaces.add(workspaceKey);
      try {
        executionStarted = true;
        const result = await this.backend.execute(
          registration.identity,
          request.command,
          request.timeoutMs,
          this.options.maxOutputBytes,
        );
        socket.end(responseFrame({ ...base, ok: true, executionStarted: true, ...result }));
      } finally {
        this.activeExecutions -= 1;
        this.activeWorkspaces.delete(workspaceKey);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      socket.end(responseFrame({
        ...base,
        ok: false,
        ...(request.type === 'exec' ? { executionStarted } : {}),
        error: message,
      } as SandboxExecutorResponse));
    }
  }

  private expireRegistrations(): void {
    const now = this.now();
    for (const [token, registration] of this.registrations) {
      if (registration.expiresAt <= now) this.registrations.delete(token);
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await this.backend.close();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    try {
      const current = await lstat(this.options.socketPath, { bigint: true });
      if (current.isSocket() && this.socketIdentity
          && current.dev === this.socketIdentity.dev && current.ino === this.socketIdentity.ino) {
        await unlink(this.options.socketPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.contract = undefined;
    this.registrations.clear();
    this.activeWorkspaces.clear();
  }
}
