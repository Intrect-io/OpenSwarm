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
import { existsSync } from 'node:fs';
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
      'Pass the files you changed in "paths" to see their errors first; errors elsewhere are summarized.',
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
 * Project-wide `tsc --noEmit`, split into "your files" vs "elsewhere".
 * Targeted single-file tsc would drop the tsconfig (wrong lib/paths → false
 * errors), so the project run is the correct unit; filtering keeps the model's
 * context spend proportional to its own edit.
 */
async function runTsc(cwd: string, requested: Set<string>): Promise<CheckOutcome> {
  const label = 'tsc';
  if (!existsSync(path.join(cwd, 'tsconfig.json'))) {
    return { label, output: '', infraError: 'no tsconfig.json — TypeScript check skipped' };
  }
  try {
    await execFileAsync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
      cwd,
      timeout: TSC_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: buildBashToolEnv(),
    });
    return { label, output: '' };
  } catch (err) {
    if (isMissingBinary(err)) return { label, output: '', infraError: 'npx/tsc unavailable' };
    const all = checkOutput(err).split('\n').filter(Boolean);
    // tsc error lines start with the relative file path: `src/a.ts(3,5): error TS...`
    const requestedNorm = [...requested].map((p) => p.replaceAll('\\', '/'));
    const mine = all.filter((line) => requestedNorm.some((p) => line.replaceAll('\\', '/').startsWith(p)));
    const elsewhere = all.length - mine.length;
    const parts = [];
    if (mine.length > 0) parts.push(mine.join('\n'));
    if (elsewhere > 0) parts.push(`(+${elsewhere} error line(s) in other files — run with those paths to see them)`);
    if (parts.length === 0) parts.push(all.join('\n')); // errors exist but none matched the filter — show them
    return { label, output: truncate(parts.join('\n')) };
  }
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

  const tsFiles = requested.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));
  const pyFiles = requested.filter((f) => f.endsWith('.py'));
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
