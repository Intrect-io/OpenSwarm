// ============================================
// OpenSwarm - Worker environment PATH helper
// ============================================
//
// Workers spawned by OpenSwarm need access to bundled CLI dependencies
// (notably `cxt` from @intrect/cxt) without the user having them installed
// globally. We inject OpenSwarm's own `node_modules/.bin` into PATH for the
// spawned process only — user's shell PATH and ~/.claude/* are untouched.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripHumanSurfaceEnv } from '../mcp/humanSurfacePolicy.js';

/**
 * Resolve OpenSwarm's bundled `node_modules/.bin` directory.
 *
 * envPath.js lives at `<pkg>/dist/adapters/envPath.js` after build, so the
 * package root is two directories up. During `npm run dev` / `tsx`, the file
 * is at `<pkg>/src/adapters/envPath.ts` — same relative structure.
 *
 * Returns null if the .bin directory does not exist (e.g. dev checkout
 * without `npm install`), so callers can fall back to process.env.PATH as-is.
 */
export function getBundledBinDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(here, '..', '..');
  const binDir = join(pkgRoot, 'node_modules', '.bin');
  return existsSync(binDir) ? binDir : null;
}

/**
 * Build an env object for spawned workers with OpenSwarm's bundled `.bin`
 * directory prepended to PATH. Keeps every other env var untouched.
 *
 * Prepending (not appending) means a locally-bundled `cxt` wins over an
 * older global install, which matters when we start pinning cxt versions.
 */
export function buildWorkerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const binDir = getBundledBinDir();
  if (binDir === null) return withoutDeadKeys(stripHumanSurfaceEnv(base));

  const existingPath = base.PATH ?? base.Path ?? '';
  // Avoid duplicate entries if this env is reused across spawns.
  const parts = existingPath.split(delimiter).filter(Boolean);
  if (parts[0] === binDir) {
    return withoutDeadKeys(stripHumanSurfaceEnv(base));
  }
  const nextPath = [binDir, ...parts.filter((p) => p !== binDir)].join(delimiter);

  return withoutDeadKeys(stripHumanSurfaceEnv({ ...base, PATH: nextPath }));
}

/**
 * Credentials the daemon has probed and found dead. Workers inherit the
 * daemon's environment wholesale, so a `LINEAR_API_KEY` the daemon itself
 * never used (it ran on OAuth) reached every agent as its only Linear
 * credential and 401'd on every write — two runs parked on it (AGT-4028).
 * A key that fails its probe is withheld instead: an agent with no
 * credential says so up front; one with a dead credential spends its turns
 * discovering it.
 */
const deadWorkerEnvKeys = new Map<string, string>();

export function markWorkerEnvKeyDead(key: string, reason: string): void {
  deadWorkerEnvKeys.set(key, reason);
}

export function clearDeadWorkerEnvKeys(): void {
  deadWorkerEnvKeys.clear();
}

/** Keys withheld from workers, with the probe result that condemned each. */
export function deadWorkerEnvKeyReasons(): ReadonlyMap<string, string> {
  return deadWorkerEnvKeys;
}

function withoutDeadKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (deadWorkerEnvKeys.size === 0) return env;
  const next = { ...env };
  for (const key of deadWorkerEnvKeys.keys()) delete next[key];
  return next;
}
