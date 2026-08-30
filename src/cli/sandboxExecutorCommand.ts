import { isAbsolute, relative, resolve, sep } from 'node:path';
import { SandboxExecutorClient } from '../sandboxExecutor/client.js';
import {
  DEFAULT_SANDBOX_EXECUTOR_LIMITS,
  type SandboxExecutorClientConfig,
} from '../sandboxExecutor/protocol.js';
import { SandboxExecutorServer } from '../sandboxExecutor/server.js';

export interface SandboxExecutorCliOptions extends SandboxExecutorClientConfig {}

const SECRET_ENV_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|WEBHOOK|DSN|DATABASE_URL|AUTH_SOCK|DOCKER_HOST|CREDENTIALS?|COOKIE|ACCESS_KEY(?:_ID)?|CLIENT_SECRET|SESSION|PGPASSWORD|MYSQL_PWD)(?:$|_)/i;

export function ambientCredentialKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => value !== undefined && value !== ''
      && (SECRET_ENV_PATTERN.test(key) || /_KEY$/i.test(key)
        || ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'].includes(key)))
    .map(([key]) => key)
    .sort();
}

function isWorkRoot(path: string): boolean {
  const canonical = resolve(path);
  const rel = relative('/work', canonical);
  return canonical === '/work' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function validateOptions(options: SandboxExecutorCliOptions): void {
  if (process.platform !== 'linux') throw new Error('sandbox-executor is supported only on Linux');
  if (!isAbsolute(options.socketPath) || resolve(options.socketPath) !== options.socketPath
      || !options.socketPath.startsWith('/run/openswarm-sandbox/')) {
    throw new Error('sandbox-executor socket must be a normalized path under /run/openswarm-sandbox');
  }
  if (options.allowedRoots.length < 1 || options.allowedRoots.some((root) => !isWorkRoot(root))) {
    throw new Error('sandbox-executor allowed roots must be /work or descendants of /work');
  }
  if (options.maxRequestBytes < 4 * 1024 || options.maxRequestBytes > 1024 * 1024
      || options.maxOutputBytes < 1024 || options.maxOutputBytes > 4 * 1024 * 1024
      || options.maxTimeoutMs < 1_000 || options.maxTimeoutMs > 60 * 60_000
      || options.maxConcurrent < 1 || options.maxConcurrent > 64
      || options.connectTimeoutMs < 100 || options.connectTimeoutMs > 10_000) {
    throw new Error('sandbox-executor limits are outside supported bounds');
  }
}

function assertNoAmbientCredentials(env: NodeJS.ProcessEnv): void {
  const keys = ambientCredentialKeys(env);
  if (keys.length > 0) {
    throw new Error(`sandbox-executor refuses ambient credential variables: ${keys.join(', ')}`);
  }
}

export async function runSandboxExecutorCli(options: SandboxExecutorCliOptions): Promise<void> {
  validateOptions(options);
  assertNoAmbientCredentials(process.env);
  const server = new SandboxExecutorServer(options);
  const contract = await server.start();
  process.stdout.write(`Sandbox executor ready (${contract.bootGeneration}) on ${options.socketPath}\n`);
  await new Promise<void>((resolveStop, rejectStop) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void server.close().then(resolveStop, rejectStop);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export async function runSandboxExecutorHealthCli(options: SandboxExecutorCliOptions): Promise<void> {
  validateOptions(options);
  await new SandboxExecutorClient(options).attest();
  process.stdout.write('sandbox executor healthy\n');
}

export function defaultSandboxExecutorCliOptions(): SandboxExecutorCliOptions {
  return {
    socketPath: '/run/openswarm-sandbox/executor.sock',
    allowedRoots: ['/work'],
    connectTimeoutMs: 1_000,
    ...DEFAULT_SANDBOX_EXECUTOR_LIMITS,
  };
}
