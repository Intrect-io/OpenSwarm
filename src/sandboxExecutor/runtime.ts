import type { SandboxExecutorClientConfig } from './protocol.js';

let configuredClient: Readonly<SandboxExecutorClientConfig> | undefined;

function normalized(config: SandboxExecutorClientConfig): SandboxExecutorClientConfig {
  const allowedRoots = Object.freeze([...config.allowedRoots]) as unknown as string[];
  return {
    socketPath: config.socketPath,
    allowedRoots,
    connectTimeoutMs: config.connectTimeoutMs,
    maxRequestBytes: config.maxRequestBytes,
    maxOutputBytes: config.maxOutputBytes,
    maxTimeoutMs: config.maxTimeoutMs,
    maxConcurrent: config.maxConcurrent,
  };
}

/**
 * Strict mode is monotonic for the process lifetime. Its companion capability
 * follows the same rule: a later utility config load may add the one approved
 * endpoint, but may never redirect or remove it underneath active workers.
 */
export function configureSandboxExecutor(config: SandboxExecutorClientConfig): void {
  const next = normalized(config);
  if (configuredClient === undefined) {
    configuredClient = Object.freeze(next);
    return;
  }
  if (JSON.stringify(configuredClient) !== JSON.stringify(next)) {
    throw new Error('Sandbox executor configuration cannot change during the process lifetime');
  }
}

/**
 * Wire the network-none companion whenever its block is enabled.
 * Verify-security needs that socket even if humanSurfaceReadOnly is off
 * (Cursor CLI workers still run typecheck in the daemon process). (AGT-4172)
 */
export function wireSandboxExecutorIfEnabled(
  executor: (SandboxExecutorClientConfig & { enabled?: boolean }) | undefined,
): void {
  if (executor?.enabled !== true) return;
  configureSandboxExecutor(executor);
}

export function getSandboxExecutorConfig(): Readonly<SandboxExecutorClientConfig> | undefined {
  return configuredClient;
}

/** Tests run multiple daemon configurations inside one Node process. */
export function resetSandboxExecutorForTests(): void {
  configuredClient = undefined;
}
