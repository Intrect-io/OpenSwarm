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

import { closeSync, chmodSync, mkdirSync, openSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

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
  const codepoints = [...input].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
  const flags = Object.entries(key)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join('|');
  const flagsPart = flags ? ` [${flags}]` : '';
  return `${JSON.stringify(input)} ${codepoints}${flagsPart}`;
}

/** Check if input debugging is enabled via env var. (INT-1964) */
export function inputDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OPENSWARM_DEBUG_INPUT;
  return v === '1' || v === 'true';
}

/**
 * Enforce private permissions (0o600) on a pre-existing file.
 * Throws if the file exists and has permissions more permissive than 0o600.
 */
function enforcePrivatePermissions(path: string): void {
  try {
    const stat = statSync(path);
    // Check if any bits outside owner-read/write are set.
    if (stat.mode & 0o077) {
      throw new Error(
        `Refusing to append to ${path}: permissions are ${(stat.mode & 0o777).toString(8)} (expected 600). ` +
        `Fix with: chmod 600 ${path}`,
      );
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // file doesn't exist yet — fine
    throw err;
  }
}

/** Enforce private file permissions (0o600) on pre-existing files. */
function enforcePrivatePermissions(path: string): void {
  try {
    const stat = statSync(path);
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error(`File ${path} has unsafe permissions: ${stat.mode.toString(8)}`);
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/** Append a diagnostic line to the debug log (best-effort, never throws). (INT-1964) */
export function appendInputDebug(input: string, key: DebugKeyFlags = {}, path = INPUT_DEBUG_LOG): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Check pre-existing file permissions before opening.
    enforcePrivatePermissions(path);
    const fd = openSync(path, 'a', 0o600);
    try {
      writeFileSync(fd, `${formatInputDebug(input, key)}\n`, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    // diagnostics must never break input handling
  }
}