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

export function effectiveTestParallelism(
  snapshot: HostResourceSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return Number(clampExisting(env.OPENSWARM_TEST_PARALLELISM, computeTestParallelism(snapshot)));
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
  const budget = effectiveTestParallelism(snapshot, base);
  const capped = (key: string): string => clampExisting(base[key], budget);
  return {
    ...base,
    OPENSWARM_TEST_PARALLELISM: capped('OPENSWARM_TEST_PARALLELISM'),
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
  const env = withTestResourceBudget(process.env, snapshot);
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
  const parts = splitShellSequence(command);
  let effectiveCwd = cwd;
  let sequenceCeiling = effectiveTestParallelism(snapshot);
  for (let index = 0; index < parts.length; index += 2) {
    const part = parts[index];
    const trimmed = part.trim();
    const cd = /^cd\s+(['"]?)([^'";&|]+)\1$/.exec(trimmed);
    if (cd) {
      effectiveCwd = path.resolve(effectiveCwd, cd[2].trim());
      continue;
    }
    if (/^export\s+/.test(trimmed)) {
      const boundedExport = trimmed.replace(
        /\b(OPENSWARM_TEST_PARALLELISM|PYTEST_XDIST_AUTO_NUM_WORKERS|CARGO_BUILD_JOBS|RAYON_NUM_THREADS|CMAKE_BUILD_PARALLEL_LEVEL|GOMAXPROCS|UV_CONCURRENT_BUILDS)=(?:'([^']*)'|"([^"]*)"|([^\s]+))/g,
        (_full, key: string, single: string | undefined, double: string | undefined, bare: string | undefined) => {
          const value = clampExisting(single ?? double ?? bare, sequenceCeiling);
          if (key === 'OPENSWARM_TEST_PARALLELISM') sequenceCeiling = Number(value);
          return `${key}=${value}`;
        },
      );
      parts[index] = part.replace(trimmed, boundedExport);
      continue;
    }
    const bounded = await resourceAwareSimpleTestCommand(trimmed, effectiveCwd, snapshot, sequenceCeiling);
    parts[index] = part.replace(trimmed, bounded);
  }
  return parts.join('');
}

function splitShellSequence(command: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    const two = command.slice(index, index + 2);
    const separatorLength = two === '&&' || two === '||' ? 2 : (char === ';' || char === '|' ? 1 : 0);
    if (!separatorLength) continue;
    parts.push(command.slice(start, index), command.slice(index, index + separatorLength));
    index += separatorLength - 1;
    start = index + 1;
  }
  parts.push(command.slice(start));
  return parts;
}

async function resourceAwareSimpleTestCommand(
  command: string,
  cwd: string,
  snapshot: HostResourceSnapshot,
  sequenceCeiling: number,
): Promise<string> {
  const commentIndex = shellCommentIndex(command);
  if (commentIndex >= 0) {
    const executable = command.slice(0, commentIndex).trimEnd();
    if (!executable) return command;
    return `${await resourceAwareSimpleTestCommand(executable, cwd, snapshot, sequenceCeiling)}${command.slice(executable.length)}`;
  }
  let budget = Math.min(effectiveTestParallelism(snapshot), sequenceCeiling);
  const localCeiling = /(?:^|\s)OPENSWARM_TEST_PARALLELISM=(?:'([^']*)'|"([^"]*)"|([^\s]+))/.exec(command);
  if (localCeiling) {
    budget = Number(clampExisting(localCeiling[1] ?? localCeiling[2] ?? localCeiling[3], budget));
  }
  const budgetKeys = new Set([
    'OPENSWARM_TEST_PARALLELISM', 'PYTEST_XDIST_AUTO_NUM_WORKERS', 'CARGO_BUILD_JOBS',
    'RAYON_NUM_THREADS', 'CMAKE_BUILD_PARALLEL_LEVEL', 'GOMAXPROCS', 'UV_CONCURRENT_BUILDS',
  ]);
  const assignmentPrefix = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s]+)\s+)+/.exec(command)?.[0] ?? '';
  const boundedPrefix = assignmentPrefix.replace(
    /([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"]*)"|([^\s]+))/g,
    (full, key: string, single: string | undefined, double: string | undefined, bare: string | undefined) => {
      if (!budgetKeys.has(key)) return full;
      return `${key}=${clampExisting(single ?? double ?? bare, budget)}`;
    },
  );
  let boundedCommand = boundedPrefix + command.slice(assignmentPrefix.length);
  if (/^\s*env\s/.test(boundedCommand)) {
    boundedCommand = boundedCommand.replace(
      /\b(OPENSWARM_TEST_PARALLELISM|PYTEST_XDIST_AUTO_NUM_WORKERS|CARGO_BUILD_JOBS|RAYON_NUM_THREADS|CMAKE_BUILD_PARALLEL_LEVEL|GOMAXPROCS|UV_CONCURRENT_BUILDS)=(?:'([^']*)'|"([^"]*)"|([^\s]+))/g,
      (_full, key: string, single: string | undefined, double: string | undefined, bare: string | undefined) =>
        `${key}=${clampExisting(single ?? double ?? bare, budget)}`,
    );
  }
  let executableCommand = boundedCommand.trim().replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s]+)\s+)+/,
    '',
  );
  let previous = '';
  while (executableCommand !== previous) {
    previous = executableCommand;
    executableCommand = executableCommand
      .replace(/^(?:command|exec)\s+/, '')
      .replace(/^env\s+(?:(?:-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s]+))\s+)*/, '')
      .replace(/^(?:timeout|gtimeout)\s+(?:(?:-[^\s]+)\s+)*(?:\d+(?:\.\d+)?[smhd]?\s+)/, '')
      .replace(/^nice\s+(?:-n\s+\d+\s+)?/, '');
  }
  const pytestRunner = /^(?:pytest\b|python(?:\d+(?:\.\d+)?)?\s+-m\s+pytest\b|uv\s+run\s+pytest\b)/.test(executableCommand);
  if (pytestRunner) {
    return boundedCommand
      .replace(/(-n(?:=|\s+)|--numprocesses(?:=|\s+))(\d+)/g, (_full, flag: string, raw: string) =>
        `${flag}${Math.max(1, Math.min(Number(raw), budget))}`);
  }
  const cargoTest = /^cargo\s+test\b/.test(executableCommand);
  if (cargoTest) {
    return boundedCommand
      .replace(/(-j(?:=|\s*)|--jobs(?:=|\s+))(\d+)/g, (_full, flag: string, raw: string) =>
        `${flag}${Math.max(1, Math.min(Number(raw), budget))}`);
  }
  const directRunner = /^(?:(?:npx\s+)?(?:vitest|jest)\b|node(?:\s+--\S+)*\s+\S*vitest(?:[/\\]\S+|\S*\.m?js)\b)/.test(executableCommand);
  const packageTest = /^(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test)(?:\s|$)/.test(executableCommand);
  let packageRunner = false;
  let packageSerial = false;
  if (packageTest) {
    try {
      const manifest = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as {
        scripts?: { test?: unknown };
      };
      const script = typeof manifest.scripts?.test === 'string' ? manifest.scripts.test : '';
      packageRunner = /\b(?:vitest|jest)\b/.test(script);
      packageSerial = /--runInBand\b/.test(script);
    } catch {
      return command;
    }
  }
  if (!directRunner && !packageRunner) return boundedCommand;
  if (/--runInBand\b/.test(boundedCommand) || packageSerial) return boundedCommand;

  let hadExplicitCap = false;
  const boundedExplicit = boundedCommand.replace(
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

  if (directRunner) {
    return `${boundedCommand} --maxWorkers=${budget}`;
  }
  return boundedCommand.includes(' -- ')
    ? `${boundedCommand} --maxWorkers=${budget}`
    : `${boundedCommand} -- --maxWorkers=${budget}`;
}

function shellCommentIndex(command: string): number {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '#' && (index === 0 || /\s/.test(command[index - 1]))) return index;
  }
  return -1;
}
