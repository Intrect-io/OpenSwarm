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
import { join, dirname, isAbsolute, relative, resolve } from 'node:path';

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
  const codepoints = Array.from(input).map((ch) => (ch.codePointAt(0) ?? 0));
  const flags = Object.entries(key)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return `input=${JSON.stringify(input)} len=${codepoints.length} cp=[${codepoints.join(',')}]${
    flags.length ? ` keys=${flags.join('+')}` : ''
  }`;
}

/** Whether input diagnostics are enabled (OPENSWARM_DEBUG_INPUT truthy). */
export function inputDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OPENSWARM_DEBUG_INPUT;
  return v === '1' || v === 'true';
}

function assertPathInDebugSandbox(path: string): string {
  if (path.includes('\0')) {
    throw new Error('Diagnostic log path contains NUL');
  }
  const resolved = resolve(path);
  const sandbox = resolve(homedir(), '.openswarm');
  const rel = relative(sandbox, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Diagnostic log path escapes sandbox: ${path}`);
  }
  return resolved;
}

/** Append a diagnostic line to the debug log (best-effort, never throws). (INT-1964) */
export function appendInputDebug(input: string, key: DebugKeyFlags = {}, path = INPUT_DEBUG_LOG): void {
  try {
    const safePath = assertPathInDebugSandbox(path);
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
