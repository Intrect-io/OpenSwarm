import { availableParallelism, freemem, loadavg } from 'node:os';

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
