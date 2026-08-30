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
  if (binDir === null) return stripHumanSurfaceEnv(base);

  const existingPath = base.PATH ?? base.Path ?? '';
  // Avoid duplicate entries if this env is reused across spawns.
  const parts = existingPath.split(delimiter).filter(Boolean);
  if (parts[0] === binDir) {
    return stripHumanSurfaceEnv(base);
  }
  const nextPath = [binDir, ...parts.filter((p) => p !== binDir)].join(delimiter);

  return stripHumanSurfaceEnv({ ...base, PATH: nextPath });
}
