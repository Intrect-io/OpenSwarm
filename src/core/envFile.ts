// ============================================
// OpenSwarm - .env auto-loader
// ============================================
//
// Minimal, zero-dependency .env loader. Populates process.env by layering
// every .env file found across the search path (project-local first, then
// the global fallbacks), searching locations parallel to the config
// resolver. Existing process.env values are never overwritten — a shell
// export always wins over any file, and a key already set by an
// earlier (more specific) file wins over the same key in a later,
// more general one.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../support/atomicFile.js';

export interface EnvLoadResult {
  paths: string[];
  loadedKeys: string[];
}

function getSearchPaths(): string[] {
  const paths: string[] = [];

  // Explicit override wins.
  const override = process.env.OPENSWARM_ENV;
  if (override && override.length > 0) paths.push(override);

  // .env next to the config file, if one was explicitly pointed at.
  const configOverride = process.env.OPENSWARM_CONFIG;
  if (configOverride && configOverride.length > 0) {
    paths.push(join(dirname(configOverride), '.env'));
  }

  // Project-local (matches cwd-priority from findConfigFile).
  paths.push(join(process.cwd(), '.env'));

  const home = homedir();
  paths.push(join(home, '.config', 'openswarm', '.env'));
  paths.push(join(home, '.openswarm', '.env'));

  return paths;
}

/**
 * Parse a single line of a .env file. Returns [key, value] or null for
 * blank/comment lines. Supports KEY=value, KEY="value", KEY='value',
 * optional `export ` prefix, and basic backslash escapes (\n, \r, \t, \\, \")
 * inside double-quoted values.
 */
function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null;

  const stripped = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed;
  const eq = stripped.indexOf('=');
  if (eq < 1) return null;

  const key = stripped.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = stripped.slice(eq + 1).trim();

  // Strip inline comments on unquoted values (but keep `#` inside quoted strings).
  if (value.length === 0) {
    return [key, ''];
  }

  const first = value[0];
  if (first === '"' || first === "'") {
    const end = value.lastIndexOf(first);
    if (end > 0) {
      let inner = value.slice(1, end);
      if (first === '"') {
        inner = inner
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      return [key, inner];
    }
    // Unterminated quote — fall through and treat raw.
  }

  const hash = value.indexOf(' #');
  if (hash >= 0) value = value.slice(0, hash).trimEnd();
  return [key, value];
}

/** Serialize a single KEY=value entry, double-quoting when the value needs it. */
function formatEnvLine(key: string, value: string): string {
  const needsQuote = value === '' || /[\s#"'$]/.test(value);
  if (!needsQuote) return `${key}=${value}`;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${key}="${escaped}"`;
}

/**
 * Upsert KEY=value pairs into a .env file (used by `openswarm init`). Existing
 * lines for a key are replaced in place (order + comments preserved); new keys
 * are appended. The file is written 0600 since it holds secrets.
 */
export function writeEnvVars(path: string, kv: Record<string, string>): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = existing.length ? existing.split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(kv));

  const out: string[] = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed && remaining.has(parsed[0])) {
      const key = parsed[0];
      out.push(formatEnvLine(key, remaining.get(key)!));
      remaining.delete(key);
    } else {
      out.push(line);
    }
  }
  // Trim trailing blank lines before appending new keys.
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  for (const [key, value] of remaining) out.push(formatEnvLine(key, value));

  atomicWriteFileSync(path, out.join('\n') + '\n');
}

/**
 * Load every discovered .env file into process.env without overwriting
 * existing values. A project-local `.env` shadows the global fallback ones
 * key-by-key, not file-by-file — a repo whose own `.env` predates a
 * credential that only lives in `~/.config/openswarm/.env` still picks that
 * credential up, instead of the global file being skipped entirely because
 * the local one was found first. (INT-3256: `ATLASCLOUD_API_KEY` set only in
 * the global .env was invisible to every run from a repo with its own,
 * older `.env` — every subagent failed auth instantly, project-wide.)
 *
 * Returns the paths actually read (in precedence order) and the list of
 * keys that were newly applied — callers can log this for diagnostics.
 */
export function loadEnvFile(): EnvLoadResult {
  const paths: string[] = [];
  const loadedKeys: string[] = [];

  for (const path of getSearchPaths()) {
    if (!existsSync(path)) continue;
    paths.push(path);

    const content = readFileSync(path, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const parsed = parseLine(rawLine);
      if (parsed === null) continue;
      const [key, value] = parsed;
      if (process.env[key] !== undefined) continue;
      process.env[key] = value;
      loadedKeys.push(key);
    }
  }

  return { paths, loadedKeys };
}
