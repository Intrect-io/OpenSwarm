import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import net from 'node:net';
import { dirname } from 'node:path';
import {
  SANDBOX_EXECUTOR_ENV_KEYS,
  SANDBOX_EXECUTOR_PROTOCOL,
  type SandboxExecResponse,
  type SandboxExecutorClientConfig,
  type SandboxExecutorContract,
  type SandboxExecutorRequest,
  type SandboxExecutorResponse,
  type SandboxExecutorSession,
  type SandboxExecutionResult,
  type SandboxRegisterResponse,
  SandboxOutcomeUnknownError,
} from './protocol.js';

function stableStrings(values: string[]): string[] {
  return [...values].sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify(stableStrings(left)) === JSON.stringify(stableStrings(right));
}

interface SocketIdentity { dev: bigint; ino: bigint }

async function assertPrivateSocket(path: string): Promise<SocketIdentity> {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || await realpath(dirname(path)) !== dirname(path)
      || (parent.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && parent.uid !== process.getuid())) {
    throw new Error(`Sandbox executor socket parent is not private and same-uid: ${dirname(path)}`);
  }
  const metadata = await lstat(path);
  if (!metadata.isSocket() || metadata.isSymbolicLink()) {
    throw new Error(`Sandbox executor endpoint is not a Unix socket: ${path}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Sandbox executor socket must not grant group/other access: ${path}`);
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new Error(`Sandbox executor socket uid ${metadata.uid} does not match daemon uid ${process.getuid()}`);
  }
  return { dev: BigInt(metadata.dev), ino: BigInt(metadata.ino) };
}

function parseResponse(frame: string): SandboxExecutorResponse {
  let parsed: unknown;
  try { parsed = JSON.parse(frame); } catch { throw new Error('Sandbox executor returned malformed JSON'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Sandbox executor response is not an object');
  const response = parsed as Record<string, unknown>;
  if (response.protocol !== SANDBOX_EXECUTOR_PROTOCOL || typeof response.id !== 'string'
      || !['health', 'register', 'exec'].includes(String(response.type)) || typeof response.ok !== 'boolean'
      || !response.contract || typeof response.contract !== 'object') {
    throw new Error('Sandbox executor response envelope is invalid');
  }
  const contract = response.contract as Record<string, unknown>;
  const contractKeys = [
    'allowedRoots', 'bootGeneration', 'environmentKeys', 'filesystemIsolation', 'maxConcurrent',
    'maxOutputBytes', 'maxRequestBytes', 'maxTimeoutMs', 'networkIsolation', 'processIsolation', 'protocol', 'secretMasking',
  ].sort();
  if (JSON.stringify(Object.keys(contract).sort()) !== JSON.stringify(contractKeys)
      || contract.protocol !== SANDBOX_EXECUTOR_PROTOCOL
      || !Array.isArray(contract.allowedRoots) || !contract.allowedRoots.every((value) => typeof value === 'string')
      || !Array.isArray(contract.environmentKeys) || !contract.environmentKeys.every((value) => typeof value === 'string')
      || typeof contract.bootGeneration !== 'string'
      || contract.networkIsolation !== 'loopback-only'
      || contract.filesystemIsolation !== 'bubblewrap-workspace-bind-v1'
      || contract.processIsolation !== 'bubblewrap-pid-namespace-v1'
      || contract.secretMasking !== 'workspace-sensitive-path-overlay-v1'
      || !['maxConcurrent', 'maxOutputBytes', 'maxRequestBytes', 'maxTimeoutMs'].every((key) => Number.isSafeInteger(contract[key]))) {
    throw new Error('Sandbox executor contract shape is invalid');
  }
  const required = ['protocol', 'id', 'type', 'ok', 'contract'];
  let allowed: string[];
  if (!response.ok) allowed = [...required, 'error', ...(response.type === 'exec' ? ['executionStarted'] : [])];
  else if (response.type === 'health') allowed = required;
  else if (response.type === 'register') allowed = [...required, 'workspace', 'workspaceToken'];
  else allowed = [...required, 'executionStarted', 'output', 'exitCode', 'signal', 'timedOut', 'truncated', 'outputLimitExceeded'];
  if (JSON.stringify(Object.keys(response).sort()) !== JSON.stringify(allowed.sort())) {
    throw new Error('Sandbox executor response contains missing or unknown fields');
  }
  if (!response.ok) {
    if (typeof response.error !== 'string' || response.error.length < 1
        || (response.type === 'exec' && typeof response.executionStarted !== 'boolean')) {
      throw new Error('Sandbox executor error response shape is invalid');
    }
  } else if (response.type === 'register') {
    if (typeof response.workspace !== 'string' || response.workspace.length < 1
        || typeof response.workspaceToken !== 'string' || response.workspaceToken.length < 32) {
      throw new Error('Sandbox executor registration response shape is invalid');
    }
  } else if (response.type === 'exec') {
    const validExitCode = response.exitCode === null || Number.isSafeInteger(response.exitCode);
    const validSignal = response.signal === null || typeof response.signal === 'string';
    if (response.executionStarted !== true || typeof response.output !== 'string'
        || !validExitCode || !validSignal || typeof response.timedOut !== 'boolean'
        || typeof response.truncated !== 'boolean' || typeof response.outputLimitExceeded !== 'boolean') {
      throw new Error('Sandbox executor execution response shape is invalid');
    }
  }
  return response as unknown as SandboxExecutorResponse;
}

export class SandboxExecutorClient {
  constructor(private readonly config: SandboxExecutorClientConfig) {}

  async attest(): Promise<{ contract: SandboxExecutorContract; roots: string[] }> {
    const expectedRoots = stableStrings(await Promise.all(this.config.allowedRoots.map((root) => realpath(root))));
    const healthId = randomUUID();
    const health = await this.request({ protocol: SANDBOX_EXECUTOR_PROTOCOL, id: healthId, type: 'health' });
    if (health.type !== 'health' || !health.ok) throw new Error(health.error ?? 'Sandbox executor health proof failed');
    this.assertContract(health.contract, expectedRoots);
    return { contract: health.contract, roots: expectedRoots };
  }

  async createSession(workspace: string): Promise<SandboxExecutorSession> {
    const { contract, roots: expectedRoots } = await this.attest();

    const registerId = randomUUID();
    const registered = await this.request({
      protocol: SANDBOX_EXECUTOR_PROTOCOL,
      id: registerId,
      type: 'register',
      bootGeneration: contract.bootGeneration,
      workspace,
    }) as SandboxRegisterResponse;
    this.assertContract(registered.contract, expectedRoots, contract.bootGeneration);
    if (registered.type !== 'register' || !registered.ok || !registered.workspaceToken || !registered.workspace) {
      throw new Error(registered.error ?? 'Sandbox executor rejected the workspace registration');
    }
    return new AttestedSandboxExecutorSession(
      this,
      expectedRoots,
      contract.bootGeneration,
      registered.workspaceToken,
    );
  }

  private assertContract(contract: SandboxExecutorContract, roots: string[], bootGeneration?: string): void {
    const expectedEnvironment = stableStrings([...SANDBOX_EXECUTOR_ENV_KEYS, 'OPENSWARM_SANDBOX_PROCESS_MARKER']);
    if (contract.protocol !== SANDBOX_EXECUTOR_PROTOCOL
        || contract.networkIsolation !== 'loopback-only'
        || contract.filesystemIsolation !== 'bubblewrap-workspace-bind-v1'
        || contract.processIsolation !== 'bubblewrap-pid-namespace-v1'
        || contract.secretMasking !== 'workspace-sensitive-path-overlay-v1'
        || !sameStrings(contract.allowedRoots, roots)
        || !sameStrings(contract.environmentKeys, expectedEnvironment)
        || contract.maxRequestBytes !== this.config.maxRequestBytes
        || contract.maxOutputBytes !== this.config.maxOutputBytes
        || contract.maxTimeoutMs !== this.config.maxTimeoutMs
        || contract.maxConcurrent !== this.config.maxConcurrent
        || typeof contract.bootGeneration !== 'string'
        || contract.bootGeneration.length < 16
        || (bootGeneration !== undefined && contract.bootGeneration !== bootGeneration)) {
      throw new Error('Sandbox executor contract attestation failed');
    }
  }

  private async request(request: SandboxExecutorRequest, executionTimeoutMs = 0): Promise<SandboxExecutorResponse> {
    const socketIdentity = await assertPrivateSocket(this.config.socketPath);
    const frame = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(frame) > this.config.maxRequestBytes) {
      throw new Error('Sandbox executor request exceeds maxRequestBytes');
    }
    return await new Promise((resolveResponse, rejectResponse) => {
      const socket = net.createConnection(this.config.socketPath);
      let settled = false;
      let requestSent = false;
      let buffer = Buffer.alloc(0);
      const maxResponseBytes = this.config.maxOutputBytes * 6 + 64 * 1024;
      const settle = (error?: Error, response?: SandboxExecutorResponse) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) {
          rejectResponse(request.type === 'exec' && requestSent
            ? new SandboxOutcomeUnknownError(error.message, { cause: error })
            : error);
        }
        else resolveResponse(response!);
      };
      socket.setTimeout((executionTimeoutMs || 0) + this.config.connectTimeoutMs + 2_000);
      socket.once('connect', () => {
        void assertPrivateSocket(this.config.socketPath).then((connectedIdentity) => {
          if (connectedIdentity.dev !== socketIdentity.dev || connectedIdentity.ino !== socketIdentity.ino) {
            settle(new Error('Sandbox executor socket changed during connect'));
            return;
          }
          requestSent = true;
          socket.write(frame);
        }, (error) => settle(error instanceof Error ? error : new Error(String(error))));
      });
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > maxResponseBytes) return settle(new Error('Sandbox executor response exceeds output contract'));
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        if (buffer.subarray(newline + 1).toString('utf8').trim() !== '') {
          return settle(new Error('Sandbox executor returned multiple response frames'));
        }
        try {
          const response = parseResponse(buffer.subarray(0, newline).toString('utf8'));
          if (response.id !== request.id || response.type !== request.type) {
            return settle(new Error('Sandbox executor response correlation failed'));
          }
          settle(undefined, response);
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once('timeout', () => settle(new Error('Sandbox executor request timed out')));
      socket.once('error', (error) => settle(error));
      socket.once('close', () => {
        if (!settled) settle(new Error('Sandbox executor closed before a complete response'));
      });
    });
  }

  async executeAttested(
    roots: string[],
    bootGeneration: string,
    workspaceToken: string,
    command: string,
    timeoutMs: number,
  ): Promise<SandboxExecutionResult> {
    const id = randomUUID();
    const response = await this.request({
      protocol: SANDBOX_EXECUTOR_PROTOCOL,
      id,
      type: 'exec',
      bootGeneration,
      workspaceToken,
      command,
      timeoutMs,
    }, timeoutMs) as SandboxExecResponse;
    try {
      this.assertContract(response.contract, roots, bootGeneration);
    } catch (error) {
      throw new SandboxOutcomeUnknownError('execution response failed contract re-attestation', { cause: error });
    }
    if (!response.ok) {
      if (response.executionStarted) {
        throw new SandboxOutcomeUnknownError(response.error ?? 'executor failed after command start');
      }
      throw new Error(response.error ?? 'Sandbox executor command was rejected before start');
    }
    if (response.executionStarted !== true) {
      throw new SandboxOutcomeUnknownError('execution response did not prove command start state');
    }
    if (response.output === undefined || response.timedOut === undefined
        || response.truncated === undefined || response.outputLimitExceeded === undefined) {
      throw new Error('Sandbox executor returned an incomplete execution result');
    }
    return {
      output: response.output,
      exitCode: response.exitCode ?? null,
      signal: response.signal ?? null,
      timedOut: response.timedOut,
      truncated: response.truncated,
      outputLimitExceeded: response.outputLimitExceeded,
    };
  }
}

class AttestedSandboxExecutorSession implements SandboxExecutorSession {
  constructor(
    private readonly client: SandboxExecutorClient,
    private readonly roots: string[],
    private readonly bootGeneration: string,
    private readonly workspaceToken: string,
  ) {}

  execute(command: string, timeoutMs: number): Promise<SandboxExecutionResult> {
    return this.client.executeAttested(this.roots, this.bootGeneration, this.workspaceToken, command, timeoutMs);
  }
}
