// ============================================
// OpenSwarm - TUI input diagnostics (INT-1964)
// ============================================
//
// Mobile SSH clients (e.g. Termius) can show doubled multibyte input
// ('이이렇렇게'). To tell apart an ink-level doubling (ink hands us the char
// twice) from a terminal-side echo artifact (the value is correct, the terminal
// draws an extra copy), set OPENSWARM_DEBUG_INPUT=1 and type: each key event is
// logged with its code points to ~/.openswarm/input-debug.log. If a single
// keypress logs one code point but the screen shows two glyphs, it's terminal
// echo (fix in the client); if it logs the code point twice, it's ink-level.

import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, normalize, relative, resolve } from 'node:path';

export const INPUT_DEBUG_LOG = join(homedir(), '.openswarm', 'input-debug.log');

/** Key flags we care about for diagnostics (subset of ink's Key). */
export interface DebugKeyFlags {
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  tab?: boolean;
}

/**
 * One diagnostic line for an input event: the raw string, its Unicode code
 * points (so doubling is visible), and any active key flags. Pure. (INT-1964)
 */
export function formatInputDebug(input: string, key: DebugKeyFlags = {}): string {
  const codepoints = Array.from(input)
    .map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`)
    .join(' ');

  const flags = Object.entries(key)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(' ');

  return flags ? `${codepoints} [${flags}]` : codepoints;
}

/**
 * Check whether OPENSWARM_DEBUG_INPUT is enabled. Pure. (INT-1964)
 */
export function inputDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OPENSWARM_DEBUG_INPUT;
  return v === '1' || v === 'true';
}

/**
 * The sandbox directory under which diagnostic logs are allowed.
 * Resolved once at module load for containment checks.
 */
const DEBUG_LOG_SANDBOX = resolve(homedir(), '.openswarm');

/**
 * Validate that a path is contained within the debug log sandbox.
 * Returns the resolved path if valid, or throws if it would escape.
 */
function validateDebugLogPath(path: string): string {
  const resolved = resolve(path);
  const normalized = normalize(resolved);
  const rel = relative(DEBUG_LOG_SANDBOX, normalized);
  if (rel.startsWith('..') || resolve(DEBUG_LOG_SANDBOX, rel) !== normalized) {
    throw new Error(`Diagnostic log path escapes sandbox: ${path}`);
  }
  return normalized;
}

/**
 * Append a diagnostic line to the debug log (best-effort, never throws).
 * The path is validated to stay within the ~/.openswarm sandbox, and parent
 * directories are created safely. (INT-1964)
 */
export function appendInputDebug(input: string, key: DebugKeyFlags = {}, path = INPUT_DEBUG_LOG): void {
  try {
    const safePath = validateDebugLogPath(path);
    // Ensure parent directories are created with restrictive permissions
    mkdirSync(dirname(safePath), { recursive: true, mode: 0o700 });
    const fd = openSync(safePath, 'a', 0o600);
    try {
      writeFileSync(fd, `${formatInputDebug(input, key)}\n`, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    // diagnostics must never break input handling
  }
}
