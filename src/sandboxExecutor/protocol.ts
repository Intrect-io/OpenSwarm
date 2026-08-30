export const SANDBOX_EXECUTOR_PROTOCOL = 'openswarm-sandbox-executor/v1' as const;
export const SANDBOX_OUTCOME_UNKNOWN_PARK_REASON = 'execution_outcome_unknown';
export const DEFAULT_SANDBOX_EXECUTOR_SOCKET = '/run/openswarm-sandbox/executor.sock';
export const DEFAULT_SANDBOX_EXECUTOR_LIMITS = {
  maxRequestBytes: 64 * 1024,
  maxOutputBytes: 512 * 1024,
  maxTimeoutMs: 15 * 60_000,
  maxConcurrent: 8,
} as const;

export const SANDBOX_EXECUTOR_ENV_KEYS = [
  'CI',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'PATH',
  'PYTHONDONTWRITEBYTECODE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'UV_PYTHON_INSTALL_DIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
] as const;

export interface SandboxExecutorLimits {
  maxRequestBytes: number;
  maxOutputBytes: number;
  maxTimeoutMs: number;
  maxConcurrent: number;
}

export interface SandboxExecutorContract extends SandboxExecutorLimits {
  protocol: typeof SANDBOX_EXECUTOR_PROTOCOL;
  bootGeneration: string;
  allowedRoots: string[];
  environmentKeys: string[];
  networkIsolation: 'loopback-only';
  filesystemIsolation: 'bubblewrap-workspace-bind-v1';
  processIsolation: 'bubblewrap-pid-namespace-v1';
  secretMasking: 'workspace-sensitive-path-overlay-v1';
}

export interface SandboxHealthRequest {
  protocol: typeof SANDBOX_EXECUTOR_PROTOCOL;
  id: string;
  type: 'health';
}

export interface SandboxRegisterRequest {
  protocol: typeof SANDBOX_EXECUTOR_PROTOCOL;
  id: string;
  type: 'register';
  bootGeneration: string;
  workspace: string;
}

export interface SandboxExecRequest {
  protocol: typeof SANDBOX_EXECUTOR_PROTOCOL;
  id: string;
  type: 'exec';
  bootGeneration: string;
  workspaceToken: string;
  command: string;
  timeoutMs: number;
}

export type SandboxExecutorRequest = SandboxHealthRequest | SandboxRegisterRequest | SandboxExecRequest;

interface SandboxResponseBase {
  protocol: typeof SANDBOX_EXECUTOR_PROTOCOL;
  id: string;
  ok: boolean;
  contract: SandboxExecutorContract;
  error?: string;
}

export interface SandboxHealthResponse extends SandboxResponseBase {
  type: 'health';
}

export interface SandboxRegisterResponse extends SandboxResponseBase {
  type: 'register';
  workspace?: string;
  workspaceToken?: string;
}

export interface SandboxExecResponse extends SandboxResponseBase {
  type: 'exec';
  executionStarted?: boolean;
  output?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  truncated?: boolean;
  outputLimitExceeded?: boolean;
}

export type SandboxExecutorResponse = SandboxHealthResponse | SandboxRegisterResponse | SandboxExecResponse;

export interface SandboxExecutorClientConfig extends SandboxExecutorLimits {
  socketPath: string;
  allowedRoots: string[];
  connectTimeoutMs: number;
}

export interface SandboxExecutionResult {
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  outputLimitExceeded: boolean;
}

export interface SandboxExecutorSession {
  execute(command: string, timeoutMs: number): Promise<SandboxExecutionResult>;
}

export class SandboxOutcomeUnknownError extends Error {
  readonly code = 'OUTCOME_UNKNOWN_DO_NOT_RETRY';

  constructor(message: string, options?: ErrorOptions) {
    super(`OUTCOME_UNKNOWN_DO_NOT_RETRY: ${message}`, options);
    this.name = 'SandboxOutcomeUnknownError';
  }
}
