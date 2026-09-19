import { availableParallelism, freemem, loadavg } from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const GIB = 1024 ** 3;
const MAX_TEST_WORKERS = 4;

export interface HostResourceSnapshot {
  logicalCpus: number;
  load1: number;
  freeMemoryBytes: number;
}

export function currentHostResourceSnapshot(): HostResourceSnapshot {
  return {
    logicalCpus: availableParallelism(),
    load1: loadavg()[0] ?? 0,
    freeMemoryBytes: freemem(),
  };
}

/**
 * Conservative per-test-command budget. One CPU is reserved for the desktop
 * and daemon, each worker is charged 1 GiB, and current one-minute load removes
 * capacity before a new test starts. The cap prevents one idle task from
 * claiming the whole machine just before other queued tasks begin.
 */
export function computeTestParallelism(snapshot: HostResourceSnapshot): number {
  const logicalCpus = Math.max(1, Math.floor(snapshot.logicalCpus));
  const cpuCapacity = Math.max(1, logicalCpus - 1);
  const cpuHeadroom = Math.max(1, Math.floor(cpuCapacity - Math.max(0, snapshot.load1)));
  const memoryCapacity = Math.max(1, Math.floor(Math.max(0, snapshot.freeMemoryBytes) / GIB));
  return Math.max(1, Math.min(MAX_TEST_WORKERS, cpuCapacity, cpuHeadroom, memoryCapacity));
}

function clampExisting(value: string | undefined, budget: number): string {
  const parsed = Number.parseInt(value ?? '', 10);
  return String(Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, budget) : budget);
}

/** Add caps understood by common test/build runtimes without raising user caps. */
export function withTestResourceBudget(
  base: NodeJS.ProcessEnv,
  snapshot = currentHostResourceSnapshot(),
): NodeJS.ProcessEnv {
  const budget = computeTestParallelism(snapshot);
  const capped = (key: string): string => clampExisting(base[key], budget);
  return {
    ...base,
    OPENSWARM_TEST_PARALLELISM: String(budget),
    PYTEST_XDIST_AUTO_NUM_WORKERS: capped('PYTEST_XDIST_AUTO_NUM_WORKERS'),
    CARGO_BUILD_JOBS: capped('CARGO_BUILD_JOBS'),
    RAYON_NUM_THREADS: capped('RAYON_NUM_THREADS'),
    CMAKE_BUILD_PARALLEL_LEVEL: capped('CMAKE_BUILD_PARALLEL_LEVEL'),
    GOMAXPROCS: capped('GOMAXPROCS'),
    UV_CONCURRENT_BUILDS: capped('UV_CONCURRENT_BUILDS'),
  };
}

/** Prefix for executors whose protocol cannot receive a per-command env map. */
export function testResourceShellPrefix(snapshot = currentHostResourceSnapshot()): string {
  const env = withTestResourceBudget({}, snapshot);
  const keys = [
    'OPENSWARM_TEST_PARALLELISM',
    'PYTEST_XDIST_AUTO_NUM_WORKERS',
    'CARGO_BUILD_JOBS',
    'RAYON_NUM_THREADS',
    'CMAKE_BUILD_PARALLEL_LEVEL',
    'GOMAXPROCS',
    'UV_CONCURRENT_BUILDS',
  ];
  return `export ${keys.map((key) => `${key}=${env[key]}`).join(' ')};`;
}

/** Apply the budget to JS runners that do not consume the generic env caps. */
export async function resourceAwareTestCommand(
  command: string,
  cwd: string,
  snapshot = currentHostResourceSnapshot(),
): Promise<string> {
  const budget = computeTestParallelism(snapshot);
  if (/--runInBand\b/.test(command)) return command;
  let hadExplicitCap = false;
  const boundedExplicit = command.replace(
    /--maxWorkers(=|\s+)(\d+)(%)?/g,
    (_match, separator: string, raw: string, percent: string | undefined) => {
      hadExplicitCap = true;
      const requested = percent
        ? Math.max(1, Math.ceil(Math.max(1, snapshot.logicalCpus) * Number(raw) / 100))
        : Number(raw);
      return `--maxWorkers${separator}${Math.min(requested, budget)}`;
    },
  );
  if (hadExplicitCap) return boundedExplicit;

  if (/^(?:node\s+\S*vitest\S*|(?:npx\s+)?vitest|(?:npx\s+)?jest)\b/.test(command.trim())) {
    return `${command} --maxWorkers=${budget}`;
  }

  const packageTest = /^(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test)\s*$/.test(command.trim());
  if (!packageTest) return command;

  try {
    const manifest = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as {
      scripts?: { test?: unknown };
    };
    const script = typeof manifest.scripts?.test === 'string' ? manifest.scripts.test : '';
    if (!/\b(?:vitest|jest)\b/.test(script)) return command;
    if (/--runInBand\b/.test(script)) return command;
    return `${command} -- --maxWorkers=${budget}`;
  } catch {
    return command;
  }
}
