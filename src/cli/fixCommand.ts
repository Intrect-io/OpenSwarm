// ============================================
// OpenSwarm - `openswarm fix` — CI/test gate fan-out auto-fix (INT-2267)
// ============================================
//
// Run the project's objective checks (lint / typecheck / build / test), group
// the failures by file into areas, fan a fix-worker out over each area (same
// concurrency machinery as `review --max`), then RE-RUN the checks and repeat
// until green or the round budget runs out. Unlike `review --max --fix` (an LLM
// opinion, no re-verify), the checks are deterministic so the loop can actually
// converge. Edits land in the working tree — the user reviews the diff.
//
// Pure pieces (resolveChecks / parseFailingFiles / deriveFixAreas /
// buildFixCheckTask) are unit-tested; the orchestration shell wires spawn +
// runWorker + the concurrency pool (all injectable).

import { execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { balanceAreasToConcurrency, type AuditArea } from './reviewAudit.js';
import { runPool } from '../support/concurrencyPool.js';
import { startProgressHeartbeat } from './reviewProgress.js';
import { status, c } from '../support/colors.js';
import type { AdapterName } from '../adapters/types.js';
import type { FixBoardHandle } from './fixBoard.js';

/** A resolvable objective check (`npm run lint`, `cargo test`, `pytest`, …). */
export interface Check {
  key: string;
  program: string;
  args: string[];
  /** Human-readable command (for prompts) when program+args is a shell wrapper. */
  display?: string;
}

/** The result of running one check, with the source files its output blamed. */
export interface CheckOutcome {
  key: string;
  passed: boolean;
  output: string;
  files: string[];
}

/** One fix unit: a directory-shaped area plus the failing-check output for it. */
export interface FixArea {
  label: string;
  dir: string;
  files: string[];
  failures: string[];
}

/** The named checks `--checks` understands, mapped to a package.json script. */
const KNOWN_CHECKS: Record<string, string> = {
  lint: 'lint',
  type: 'typecheck',
  typecheck: 'typecheck',
  build: 'build',
  test: 'test',
};
const DEFAULT_ORDER = ['lint', 'typecheck', 'build', 'test'];

/**
 * Resolve named checks to `npm run <script>` commands using the repo's
 * package.json scripts. `requested` is the `--checks` list (keys); when omitted,
 * every default check that has a script is used. Unknown/missing scripts are
 * dropped. Pure.
 */
export function resolveChecks(scripts: Record<string, string>, requested?: string[]): Check[] {
  const keys = requested?.length
    ? requested.map((k) => KNOWN_CHECKS[k.trim()] ?? k.trim())
    : DEFAULT_ORDER.filter((k) => k in scripts);
  const seen = new Set<string>();
  const checks: Check[] = [];
  for (const script of keys) {
    if (seen.has(script) || !(script in scripts)) continue;
    seen.add(script);
    checks.push({ key: script, program: 'npm', args: ['run', script] });
  }
  return checks;
}

/** Read `<cwd>/package.json` scripts (empty when absent/unparseable). */
export function readScripts(cwd: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    return pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  } catch {
    return {};
  }
}

// ── Multi-language check detection (INT-2303) ───────────────────────────────

/** What `probeProject` found on disk; `resolveProjectChecks` turns it into checks. */
export interface ProjectProbe {
  /** `openswarm.json` `"checks"` map (key → shell command) — any language, highest priority. */
  configChecks?: Record<string, string>;
  /** `package.json` scripts. */
  npmScripts?: Record<string, string>;
  /** `Cargo.toml` present. */
  cargo?: boolean;
  /** Python project markers + which tools are configured. */
  python?: { marker: boolean; ruff: boolean; mypy: boolean; pytest: boolean };
}

/** Cargo check table. Defaults skip clippy (optional component) and build (subsumed by test). */
const CARGO_CHECKS: Record<string, Pick<Check, 'program' | 'args'>> = {
  lint: { program: 'cargo', args: ['clippy', '--no-deps', '--', '-D', 'warnings'] },
  typecheck: { program: 'cargo', args: ['check', '--all-targets'] },
  build: { program: 'cargo', args: ['build'] },
  test: { program: 'cargo', args: ['test'] },
};
const CARGO_DEFAULT_ORDER = ['typecheck', 'test'];

/** Python check table. Defaults include only the tools the repo is configured for. */
const PYTHON_CHECKS: Record<string, Pick<Check, 'program' | 'args'>> = {
  lint: { program: 'ruff', args: ['check', '.'] },
  typecheck: { program: 'mypy', args: ['.'] },
  test: { program: 'pytest', args: [] },
};

/** Build checks from a canonical-key table. `requested` bypasses the default gating. */
function resolveTableChecks(
  table: Record<string, Pick<Check, 'program' | 'args'>>,
  defaults: string[],
  requested?: string[],
): Check[] {
  const keys = requested?.length ? requested.map((k) => KNOWN_CHECKS[k.trim()] ?? k.trim()) : defaults;
  const seen = new Set<string>();
  const checks: Check[] = [];
  for (const key of keys) {
    if (seen.has(key) || !(key in table)) continue;
    seen.add(key);
    checks.push({ key, ...table[key] });
  }
  return checks;
}

/**
 * Read the project markers `resolveProjectChecks` needs: `openswarm.json` `checks`,
 * package.json scripts, `Cargo.toml`, and Python config (pyproject/setup/requirements
 * plus per-tool markers for ruff / mypy / pytest).
 */
export function probeProject(cwd: string): ProjectProbe {
  const read = (f: string): string => {
    try {
      return readFileSync(join(cwd, f), 'utf8');
    } catch {
      return '';
    }
  };
  const has = (f: string): boolean => existsSync(join(cwd, f));

  let configChecks: Record<string, string> | undefined;
  try {
    const meta = JSON.parse(read('openswarm.json') || '{}');
    if (meta.checks && typeof meta.checks === 'object' && !Array.isArray(meta.checks)) {
      const entries = Object.entries(meta.checks).filter((e): e is [string, string] => typeof e[1] === 'string');
      if (entries.length) configChecks = Object.fromEntries(entries);
    }
  } catch {
    // tolerate a malformed openswarm.json — fall through to auto-detection
  }

  const pyproject = read('pyproject.toml');
  const setupCfg = read('setup.cfg');
  return {
    configChecks,
    npmScripts: readScripts(cwd),
    cargo: has('Cargo.toml'),
    python: {
      marker: !!pyproject || has('setup.py') || !!setupCfg || has('requirements.txt'),
      ruff: pyproject.includes('[tool.ruff') || has('ruff.toml') || has('.ruff.toml'),
      mypy: pyproject.includes('[tool.mypy') || setupCfg.includes('[mypy]') || has('mypy.ini') || has('.mypy.ini'),
      pytest:
        pyproject.includes('[tool.pytest') || has('pytest.ini') || has('conftest.py') || has('tests') || has('test'),
    },
  };
}

/**
 * Resolve checks across ecosystems, first non-empty source wins:
 * openswarm.json `checks` (any language, explicit) → package.json scripts →
 * Cargo.toml → Python markers. Mixed repos disambiguate via openswarm.json. Pure.
 */
export function resolveProjectChecks(probe: ProjectProbe, requested?: string[]): Check[] {
  const cfg = probe.configChecks ?? {};
  if (Object.keys(cfg).length) {
    const keys = requested?.length
      ? requested.map((k) => (k.trim() in cfg ? k.trim() : KNOWN_CHECKS[k.trim()] ?? k.trim()))
      : Object.keys(cfg);
    const seen = new Set<string>();
    const checks: Check[] = [];
    for (const key of keys) {
      if (seen.has(key) || !(key in cfg)) continue;
      seen.add(key);
      checks.push({ key, program: 'sh', args: ['-c', cfg[key]], display: cfg[key] });
    }
    if (checks.length) return checks;
  }

  const fromNpm = probe.npmScripts ? resolveChecks(probe.npmScripts, requested) : [];
  if (fromNpm.length) return fromNpm;

  if (probe.cargo) {
    const fromCargo = resolveTableChecks(CARGO_CHECKS, CARGO_DEFAULT_ORDER, requested);
    if (fromCargo.length) return fromCargo;
  }

  if (probe.python?.marker) {
    const py = probe.python;
    const defaults = [py.ruff ? 'lint' : '', py.mypy ? 'typecheck' : '', py.pytest ? 'test' : ''].filter(Boolean);
    const fromPython = resolveTableChecks(PYTHON_CHECKS, defaults, requested);
    if (fromPython.length) return fromPython;
  }

  return [];
}

const SOURCE_EXT = 'tsx?|jsx?|mjs|cjs|py|rs|go|java|kt|kts|scala|rb|php|swift|c|cc|cpp|cxx|h|hpp|cs|ex|exs|lua|jl|zig|nim';
const FILE_RE = new RegExp(String.raw`(?:^|[\s('"\`])((?:[\w.\-]+\/)*[\w.\-]+\.(?:${SOURCE_EXT}))`, 'g');
const ABS_FILE_RE = new RegExp(String.raw`(?:^|[\s('"\`])((?:\/[\w.\-]+)+\.(?:${SOURCE_EXT}))`, 'g');

/**
 * Extract repo-relative source file paths mentioned in check output — the files
 * to hand the fix worker. Language-agnostic: matches any path ending in a source
 * extension (tsc `file.ts(1,2)`, vitest `FAIL file.test.ts`, eslint `file:1:1`,
 * pytest `file.py::test`). Pure; caller filters to files that exist. Deduped,
 * `./` stripped.
 */
export function parseFailingFiles(output: string, projectPath?: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(FILE_RE)) {
    let p = m[1];
    while (p.startsWith('./')) p = p.slice(2);
    if (p && !p.startsWith('/')) out.add(p);
  }
  if (projectPath) {
    const root = resolve(projectPath);
    for (const m of output.matchAll(ABS_FILE_RE)) {
      const absolute = resolve(m[1]);
      const rel = relative(root, absolute);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) continue;
      if (rel) out.add(rel);
    }
  }
  return [...out];
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : `…${s.slice(-n)}`);

/**
 * Group failing checks into fix areas. Files blamed across the failing checks
 * are partitioned into directory areas (sized to fill the pool); each area
 * carries the check output relevant to its files. A failing check whose output
 * has no parseable file (e.g. a bare build error) becomes its own `check:<key>`
 * area with the raw output. Pure.
 */
export function deriveFixAreas(failing: CheckOutcome[], concurrency: number, maxFilesPerArea = 8): FixArea[] {
  const areas: FixArea[] = [];
  const allFiles = [...new Set(failing.flatMap((f) => f.files))];

  if (allFiles.length) {
    for (const a of balanceAreasToConcurrency(allFiles, concurrency, maxFilesPerArea)) {
      const relevant = failing.filter((f) => f.files.some((file) => a.files.includes(file)));
      const src = relevant.length ? relevant : failing;
      areas.push({
        label: a.label,
        dir: a.dir,
        files: a.files,
        failures: src.map((f) => `[${f.key}]\n${truncate(f.output, 3000)}`),
      });
    }
  }

  for (const f of failing.filter((f) => f.files.length === 0)) {
    areas.push({ label: `check:${f.key}`, dir: '.', files: [], failures: [`[${f.key}]\n${truncate(f.output, 3000)}`] });
  }
  return areas;
}

/** Build the fix worker's task: the failing output + a hard "verify, don't cheat" rule. */
export function buildFixCheckTask(area: FixArea, checks: Check[]): string {
  const verify = checks.map((c) => c.display ?? [c.program, ...c.args].join(' ')).join(' && ');
  return [
    `The project's checks are failing. Apply the MINIMAL edits needed to make them pass.`,
    area.files.length
      ? `Files in scope (edit only these — the failures are theirs):\n${area.files.map((f) => `- ${f}`).join('\n')}`
      : `No single file scope — find and fix the root cause of the failure below.`,
    ``,
    `Failing check output:`,
    ...area.failures.map((f) => '```\n' + f + '\n```'),
    ``,
    `Re-run \`${verify}\` to confirm before finishing. Do NOT weaken, skip, or delete tests/checks to make them pass — fix the actual cause.`,
  ].join('\n');
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface FixOptions {
  path?: string;
  checks?: string[];
  concurrency?: number;
  rounds?: number;
  adapter?: AdapterName;
  maxFilesPerArea?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Record a successful fix into repo knowledge (default true; --no-learn opts out). (INT-2268) */
  learn?: boolean;
}

export interface FixDeps {
  /** Run one check → {passed, output}. Default spawns the command. Injectable. */
  runCheck?: (check: Check, cwd: string) => Promise<{ passed: boolean; output: string }>;
  /** Apply one area's fixes → {success, filesChanged}. Default spawns a worker. Injectable. */
  runFixWorker?: (area: FixArea, checks: Check[], onLog: (l: string) => void) => Promise<{ success: boolean; filesChanged: string[] }>;
  /** Override the resolved checks (tests). */
  checks?: Check[];
  /** File-existence predicate (tests). Default fs.existsSync under cwd. */
  exists?: (relPath: string, cwd: string) => boolean;
  /** Record a green fix into repo knowledge. Default writes via recordTaskOutcome; tests pass a noop. */
  recordOutcome?: (info: { taskTitle: string; filesChanged: string[]; summary: string }) => Promise<void>;
  /**
   * Mount the live fix board over the round's areas → handle, or null to fall back
   * to plain line output. Default lazily renders the Ink board on a TTY only; tests
   * (non-TTY) get null and keep the injectable-log path. (INT-2446)
   */
  renderBoard?: (areas: AuditArea[], concurrency: number) => Promise<FixBoardHandle | null> | FixBoardHandle | null;
  log?: (line: string) => void;
}

export interface RoundReport {
  round: number;
  outcomes: CheckOutcome[];
  filesChanged: string[];
}
export interface FixReport {
  green: boolean;
  rounds: RoundReport[];
  reason?: 'green' | 'out-of-rounds' | 'no-progress' | 'no-checks';
}

/** Default check runner: spawn the command, capture combined output, pass = exit 0. */
async function defaultRunCheck(check: Check, cwd: string): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    // A check that hangs must not hang `openswarm fix`; the fix loop needs a
    // failed check it can act on, not an indefinitely parked round.
    execFile(check.program, check.args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 300_000 }, (err, stdout, stderr) => {
      resolve({ passed: !err, output: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

async function defaultRunFixWorker(
  area: FixArea,
  checks: Check[],
  cwd: string,
  opts: FixOptions,
  onLog: (l: string) => void,
): Promise<{ success: boolean; filesChanged: string[] }> {
  const { runWorker } = await import('../agents/worker.js');
  const r = await runWorker({
    taskTitle: `Fix failing checks: ${area.label}`,
    taskDescription: buildFixCheckTask(area, checks),
    projectPath: cwd,
    adapterName: opts.adapter,
    timeoutMs: opts.timeoutMs,
    nudgeMaxOnNoEdit: 1,
    signal: opts.signal,
    onLog,
  });
  return { success: r.success, filesChanged: r.filesChanged };
}

/** Run every check (sequentially — they contend for CPU/FS), blaming files from output. */
async function runAllChecks(
  checks: Check[],
  cwd: string,
  runCheck: NonNullable<FixDeps['runCheck']>,
  exists: (p: string, cwd: string) => boolean,
  log: (l: string) => void,
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const check of checks) {
    const tty = !!process.stderr.isTTY;
    const hb = tty ? startProgressHeartbeat(`${check.key}…`) : null;
    const { passed, output } = await runCheck(check, cwd);
    hb?.stop();
    const files = passed ? [] : parseFailingFiles(output, cwd).filter((f) => exists(f, cwd));
    outcomes.push({ key: check.key, passed, output, files });
    log(passed ? `  ${status.ok(check.key)}` : `  ${status.err(`${check.key} — ${files.length} file(s)`)}`);
  }
  return outcomes;
}

/**
 * Run checks → fan out fixes → re-run, until green or the round/progress budget
 * is spent. Returns a structured report; the CLI turns it into an exit code.
 */
export async function runFixCommand(opts: FixOptions = {}, deps: FixDeps = {}): Promise<FixReport> {
  const cwd = opts.path ?? process.cwd();
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const maxRounds = Math.max(1, opts.rounds ?? 3);
  const log = deps.log ?? ((l: string) => console.log(l));
  const exists = deps.exists ?? ((p, base) => existsSync(join(base, p)));
  const runCheck = deps.runCheck ?? defaultRunCheck;
  // 15 min per area by default: codex on a real area routinely exceeds the 5-min
  // adapter default and gets SIGKILLed ("codex timeout after 300000ms"). Mirrors
  // review --max --fix. `--timeout` overrides. (INT-2447)
  const workerTimeoutMs = opts.timeoutMs ?? 900_000;
  const runFixWorker =
    deps.runFixWorker ?? ((area, checks, onLog) => defaultRunFixWorker(area, checks, cwd, { ...opts, timeoutMs: workerTimeoutMs }, onLog));
  // TTY-guard the import so scripted/piped runs (and tests) never load Ink. (INT-2446)
  const renderBoard =
    deps.renderBoard ??
    (async (areas: AuditArea[], conc: number): Promise<FixBoardHandle | null> => {
      if (!(process.stderr as NodeJS.WriteStream).isTTY) return null;
      const { renderFixBoard } = await import('./fixBoard.js');
      return renderFixBoard(areas, conc);
    });
  const checks = deps.checks ?? resolveProjectChecks(probeProject(cwd), opts.checks);
  const recordOutcome =
    deps.recordOutcome ??
    (async (info) => {
      const { recordTaskOutcome } = await import('../memory/repoKnowledge.js');
      await recordTaskOutcome(cwd, {
        taskTitle: info.taskTitle,
        workerResult: { filesChanged: info.filesChanged, commands: [], summary: info.summary },
        derivedFrom: 'cli:fix',
      });
    });

  if (!checks.length) {
    log(
      status.warn(
        'No checks resolved — no package.json scripts, Cargo.toml, or Python tool config detected. ' +
          'Add lint/typecheck/build/test scripts, define "checks" in openswarm.json (key → shell command), or pass --checks.',
      ),
    );
    return { green: false, rounds: [], reason: 'no-checks' };
  }

  log(c.bold(`\nRunning ${checks.length} check(s): ${checks.map((ch) => ch.key).join(', ')} · concurrency ${concurrency} · up to ${maxRounds} round(s)\n`));

  const rounds: RoundReport[] = [];
  let prevFailKey = '';

  for (let round = 1; round <= maxRounds; round++) {
    log(c.dim(`── round ${round}/${maxRounds} ──`));
    const outcomes = await runAllChecks(checks, cwd, runCheck, exists, log);
    const failing = outcomes.filter((o) => !o.passed);

    if (!failing.length) {
      rounds.push({ round, outcomes, filesChanged: [] });
      log(`\n${status.ok(`All ${checks.length} check(s) passing.`)}`);
      // Learn: record what made the checks pass (skipped when nothing was edited —
      // an already-green repo has nothing to learn). (INT-2268)
      const changed = [...new Set(rounds.flatMap((r) => r.filesChanged))];
      if (opts.learn !== false && changed.length) {
        await recordOutcome({
          taskTitle: `Fixed checks: ${checks.map((ch) => ch.key).join(', ')}`,
          filesChanged: changed,
          summary: `Made ${checks.map((ch) => ch.key).join(', ')} pass after ${round} round(s).`,
        }).catch(() => {});
      }
      return { green: true, rounds, reason: 'green' };
    }

    if (round === maxRounds) {
      rounds.push({ round, outcomes, filesChanged: [] });
      break;
    }

    const areas = deriveFixAreas(failing, concurrency, opts.maxFilesPerArea);
    log(`\nFixing ${failing.length} failing check(s) across ${areas.length} area(s)...`);
    // Live board on a TTY; null (scripted/piped) falls back to per-area line logs.
    // Board writes to stderr, so we suppress the stdout line logs while it's up to
    // avoid clobbering it. (INT-2446)
    const board = await renderBoard(areas, concurrency);
    const total = areas.length;
    let done = 0;
    const settled = await runPool(
      areas,
      concurrency,
      async (area) => {
        board?.emit({ type: 'start', label: area.label, done, total });
        return runFixWorker(area, checks, (line) => board?.emit({ type: 'log', label: area.label, line }));
      },
      (s) => {
        done++;
        const area = areas[s.index];
        if (s.error) {
          const message = s.error instanceof Error ? s.error.message : String(s.error);
          if (board) board.emit({ type: 'error', label: area?.label ?? `area:${s.index}`, error: message, done, total });
          else log(`  ${status.err(`${area?.label ?? `area:${s.index}`} — worker error: ${message}`)}`);
        } else {
          const n = s.value?.filesChanged.length ?? 0;
          if (board) board.emit({ type: 'done', label: area.label, filesChanged: n, done, total });
          else log(n ? `  ${status.ok(`${area.label} — ${n} file(s)`)}` : `  ${status.warn(`${area.label} — no edit`)}`);
        }
      },
    );
    board?.unmount();
    const workerErrors = settled.filter((s) => s.error !== undefined);
    // The board only renders running rows, so an errored area's message never
    // showed — surface the details now that the board is torn down. (INT-2446)
    if (board) {
      for (const s of workerErrors) {
        const area = areas[s.index];
        const message = s.error instanceof Error ? s.error.message : String(s.error);
        log(`  ${status.err(`${area?.label ?? `area:${s.index}`} — worker error: ${message}`)}`);
      }
    }
    const filesChanged = [...new Set(settled.flatMap((s) => s.value?.filesChanged ?? []))];
    rounds.push({ round, outcomes, filesChanged });

    if (workerErrors.length === settled.length) {
      log(`\n${status.err(`All ${workerErrors.length} fix worker(s) failed this round — stopping.`)}`);
      return { green: false, rounds, reason: 'no-progress' };
    }

    const failKey = failing.map((f) => f.key).sort().join(',');
    if (failKey === prevFailKey && filesChanged.length === 0) {
      log(`\n${status.warn('No progress this round (same failures, no edits) — stopping.')}`);
      return { green: false, rounds, reason: 'no-progress' };
    }
    prevFailKey = failKey;
  }

  const lastFailing = rounds.at(-1)?.outcomes.filter((o) => !o.passed) ?? [];
  log(`\n${status.err(`Still failing after ${maxRounds} round(s): ${lastFailing.map((o) => o.key).join(', ')}.`)}`);
  log(c.dim('Changes are in the working tree — review the diff.'));
  return { green: false, rounds, reason: 'out-of-rounds' };
}
