// Deliberately standalone: do not import src/cli.ts, config loading, .env
// loading, telemetry, provider adapters, or update checks into the sidecar TCB.
import {
  defaultSandboxExecutorCliOptions,
  runSandboxExecutorCli,
  runSandboxExecutorHealthCli,
  type SandboxExecutorCliOptions,
} from '../cli/sandboxExecutorCommand.js';

function positive(value: string, flag: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return Number(value);
}

export function parseSandboxExecutorArgs(argv: string[]): {
  mode: 'serve' | 'health';
  options: SandboxExecutorCliOptions;
} {
  const mode = argv[2];
  if (mode !== 'serve' && mode !== 'health') throw new Error('Expected serve or health');
  const options = defaultSandboxExecutorCliOptions();
  const roots: string[] = [];
  for (let index = 3; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    switch (flag) {
      case '--socket': options.socketPath = value; break;
      case '--allow-root': roots.push(value); break;
      case '--connect-timeout-ms': options.connectTimeoutMs = positive(value, flag); break;
      case '--max-request-bytes': options.maxRequestBytes = positive(value, flag); break;
      case '--max-output-bytes': options.maxOutputBytes = positive(value, flag); break;
      case '--max-timeout-ms': options.maxTimeoutMs = positive(value, flag); break;
      case '--max-concurrent': options.maxConcurrent = positive(value, flag); break;
      default: throw new Error(`Unknown sandbox executor argument: ${flag}`);
    }
  }
  if (roots.length > 0) options.allowedRoots = roots;
  return { mode, options };
}

async function main(): Promise<void> {
  const parsed = parseSandboxExecutorArgs(process.argv);
  if (parsed.mode === 'serve') await runSandboxExecutorCli(parsed.options);
  else await runSandboxExecutorHealthCli(parsed.options);
}

if (process.argv[1]?.endsWith('/sandboxExecutor/entrypoint.js')
    || process.argv[1]?.endsWith('sandboxExecutor\\entrypoint.js')) {
  main().catch((error) => {
    process.stderr.write(`Sandbox executor failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
