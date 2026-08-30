// ============================================
// OpenSwarm - Inline diagnostics tool (INT-3105)
// ============================================
//
// Compiler/linter feedback INSIDE the agentic loop. Guards and deterministic
// verify only run after the worker finishes, so a worker that broke a type
// contract learns it one whole iteration later (reviewer reject → retry).
// This tool lets the model ask "is the project still sound?" right after an
// edit — the highest-value slice of what an LSP integration would provide,
// without any language-server lifecycle (stateless per call, so it also works
// in the ephemeral fix/fan-out sandboxes).
//
// Spike scope: TypeScript (project tsc, filtered to the requested files) and
// Python (ruff). Other languages fall back to the bash tool as before.
//
// MEASURED VERDICT (2026-07-29, benchmarks/diagnosticsAb.ts, N=48 runs across
// z-ai/glm-4.7-flash and openai/gpt-5-mini, with and without a verify nudge):
// success control 19/24 vs diag 20/24 — no measurable uplift. Models that
// verify do it through the bash tool anyway; failures were turn-budget
// starvation, not verification blindness. The tool therefore stays OPT-IN
// (`diagnosticsTool` loop option) for future re-measurement and is deliberately
// NOT enabled by any production caller. Full LSP integration was rejected on
// the same evidence. (INT-3105)

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildBashToolEnv, type ToolDefinition } from './tools.js';

const execFileAsync = promisify(execFile);

const OUTPUT_CHAR_LIMIT = 4_000;
const TSC_TIMEOUT_MS = 120_000;
const RUFF_TIMEOUT_MS = 30_000;

export const DIAGNOSTICS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'diagnostics',
    description:
      'Run the project type checker / linter and return current errors (TypeScript: tsc, Python: ruff). ' +
      'Call this right after editing to catch broken contracts (missed callers, wrong signatures) before finishing. ' +
      'Pass the files you changed in "paths" to see their errors first; errors elsewhere are summarized. ' +
      'This subprocess tool is unavailable when humanSurfaceReadOnly.enabled is true.',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files you changed (relative to the project root). Their diagnostics are shown in full.',
        },
      },
      required: ['paths'],
    },
  },
};

interface CheckOutcome {
  label: string;
  /** Diagnostics text, '' when clean. */
  output: string;
  /** Tooling itself failed to run (missing binary, no config) — not a finding. */
  infraError?: string;
}

function truncate(text: string, limit = OUTPUT_CHAR_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n... (truncated)`;
}

/** stdout+stderr of a failed check command; execFile rejects on exit != 0. */
function checkOutput(err: unknown): string {
  const e = err as { stdout?: string; stderr?: string; message?: string };
  return [e.stdout, e.stderr].filter(Boolean).join('\n').trim() || (e.message ?? String(err));
}

function isMissingBinary(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e.code === 'ENOENT' || /not found|ENOENT/i.test(e.message ?? '');
}

/**
 * Resolve the TypeScript compiler deterministically: the nearest
 * `node_modules/.bin/tsc` walking up from the project (a real repo's own
 * dependency), else `tsc` from PATH (npm-script contexts). NOT `npx tsc` —
 * outside a project that depends on typescript, npx tries to install the
 * unrelated `tsc` placeholder package (measured on CI: garbage output in one
 * run, an interactive-install failure in another).
 */
function resolveTscBinary(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsc');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return 'tsc';
    dir = parent;
  }
}

/**
 * Nearest tsconfig.json directory walking up from a file toward the project
 * root — a monorepo's requested file may belong to `packages/app/tsconfig.json`
 * while the root has none. Returns null when no config exists within the root.
 */
function nearestTsconfigDir(cwd: string, relFile: string): string | null {
  const root = path.resolve(cwd);
  let dir = path.dirname(path.resolve(root, relFile));
  for (;;) {
    if (!dir.startsWith(root)) return null;
    if (existsSync(path.join(dir, 'tsconfig.json'))) return dir;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

/**
 * Project-wide `tsc --noEmit` per owning tsconfig, split into "your files" vs
 * a per-file summary of errors elsewhere. Targeted single-file tsc would drop
 * the tsconfig (wrong lib/paths → false errors), so the project run is the
 * correct unit. Errors OUTSIDE the requested files keep their filenames — a
 * missed caller elsewhere is exactly what this tool exists to reveal — but
 * only as `file: N error(s)` summaries so context spend stays bounded.
 */
async function runTsc(cwd: string, requested: Set<string>): Promise<CheckOutcome> {
  const label = 'tsc';
  // Canonicalize the root: tsc realpath-resolves what it prints, so a
  // symlinked project dir (macOS /var → /private/var tmp) would otherwise make
  // every output line ../../-relative and unmatchable.
  const root = realpathSync(path.resolve(cwd));
  // Canonical root-relative form of each requested path (absolute-under-root
  // and relative spellings both allowed by the loop's cwd note; symlinked
  // prefixes are realpath-resolved so they compare equal to tsc's output).
  const requestedNorm = [...requested].map((p) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
    const real = existsSync(abs) ? realpathSync(abs) : abs;
    return path.relative(root, real).replaceAll('\\', '/');
  });
  // Group the requested files by their owning tsconfig (nested workspaces).
  const configDirs = new Set<string>();
  for (const rel of requestedNorm) {
    const dir = nearestTsconfigDir(root, rel);
    if (dir) configDirs.add(dir);
  }
  if (configDirs.size === 0) {
    return { label, output: '', infraError: 'no tsconfig.json found for the given files — TypeScript check skipped' };
  }
  const all: string[] = [];
  // Bounded: one project run per distinct workspace, max 3 per call.
  for (const configDir of [...configDirs].slice(0, 3)) {
    try {
      // `-p` relative to the canonical cwd keeps output paths root-relative.
      await execFileAsync(resolveTscBinary(configDir), ['--noEmit', '--pretty', 'false', '-p', path.relative(root, configDir) || '.'], {
        cwd: root,
        timeout: TSC_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: buildBashToolEnv(),
      });
    } catch (err) {
      if (isMissingBinary(err)) return { label, output: '', infraError: 'tsc unavailable (no node_modules/.bin/tsc up the tree, none on PATH)' };
      all.push(...checkOutput(err).split('\n').filter(Boolean));
    }
  }
  if (all.length === 0) return { label, output: '' };

  const fileOf = (line: string): string | null => {
    // tsc error lines: `src/a.ts(3,5): error TS1234: ...`
    const m = line.replaceAll('\\', '/').match(/^([^\s(][^(]*)\(\d+,\d+\):/);
    return m ? m[1] : null;
  };
  const mine: string[] = [];
  const elsewhereByFile = new Map<string, number>();
  for (const line of all) {
    const file = fileOf(line);
    if (file && requestedNorm.includes(file)) mine.push(line);
    else if (file) elsewhereByFile.set(file, (elsewhereByFile.get(file) ?? 0) + 1);
    else mine.push(line); // non-file line (e.g. config error) — show as-is
  }
  const parts = [];
  if (mine.length > 0) parts.push(mine.join('\n'));
  if (elsewhereByFile.size > 0) {
    const summary = [...elsewhereByFile.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([file, count]) => `  ${file}: ${count} error(s)`)
      .join('\n');
    parts.push(`Errors in files you did not list (likely missed callers — fix or re-run with these paths):\n${summary}`);
  }
  return { label, output: truncate(parts.join('\n')) };
}

async function runRuff(cwd: string, pyFiles: string[]): Promise<CheckOutcome> {
  const label = 'ruff';
  try {
    await execFileAsync('ruff', ['check', '--output-format', 'concise', '--', ...pyFiles], {
      cwd,
      timeout: RUFF_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: buildBashToolEnv(),
    });
    return { label, output: '' };
  } catch (err) {
    if (isMissingBinary(err)) return { label, output: '', infraError: 'ruff unavailable' };
    return { label, output: truncate(checkOutput(err)) };
  }
}

/**
 * Execute the diagnostics tool. Returns model-facing text: per-check errors,
 * or an explicit all-clean line (silence would read as "tool broken").
 */
export async function runDiagnosticsTool(paths: unknown, cwd: string): Promise<string> {
  const requested = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
  if (requested.length === 0) {
    return 'diagnostics: pass the files you changed in "paths" (relative to the project root).';
  }

  const tsFiles = requested.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f));
  const pyFiles = requested.filter((f) => /\.pyi?$/.test(f));
  const checks: Promise<CheckOutcome>[] = [];
  if (tsFiles.length > 0) checks.push(runTsc(cwd, new Set(tsFiles)));
  if (pyFiles.length > 0) checks.push(runRuff(cwd, pyFiles));
  if (checks.length === 0) {
    return `diagnostics: no TypeScript/Python files among ${requested.join(', ')} — use the bash tool to run this project's own checks.`;
  }

  const outcomes = await Promise.all(checks);
  const lines: string[] = [];
  for (const { label, output, infraError } of outcomes) {
    if (infraError) lines.push(`[${label}] SKIPPED: ${infraError}`);
    else if (output) lines.push(`[${label}] errors:\n${output}`);
    else lines.push(`[${label}] clean — no errors.`);
  }
  return lines.join('\n\n');
}
