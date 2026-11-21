#!/usr/bin/env node
// Points git at the versioned hooks: `git config --local core.hooksPath .githooks`.
//
// Run by `npm install` / `npm ci` through the package.json "prepare" script,
// so it must never fail an install. It acts on the current working directory
// only and does nothing (exit 0, one line on stderr) when:
//   - the directory is not the top level of a git work tree (CI tarballs, the
//     standalone bundle staging directory, Docker builds without .git);
//   - the hooks directory (.githooks) is absent;
//   - core.hooksPath is already set to something else, locally or globally:
//     a person's custom hooks path is never overridden.
// Notices go to stderr because scripts/build-standalone.sh parses the stdout
// of `npm pack`, which also runs "prepare".
//
// Usage: node scripts/install-githooks.mjs [core.hooksPath <dir>]   (default dir: .githooks)
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_HOOKS_DIR = '.githooks';

/** @param {string[]} argv */
export function hooksDirFromArgs(argv) {
  const args = argv[0] === 'core.hooksPath' ? argv.slice(1) : argv;
  return args[0] || DEFAULT_HOOKS_DIR;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Returns git's answer, or null when git fails (not a repository, key unset, no git). */
function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Installs the hooks path for the repository at `cwd` when that is safe.
 * @param {{ cwd?: string; hooksDir?: string }} [options]
 * @returns {{ action: 'installed' | 'already' | 'skipped'; reason: string }}
 */
export function installGitHooks({ cwd = process.cwd(), hooksDir = DEFAULT_HOOKS_DIR } = {}) {
  if (tryGit(['rev-parse', '--is-inside-work-tree'], cwd) !== 'true') {
    return { action: 'skipped', reason: 'not inside a git work tree' };
  }
  // Only the top level: a package staged inside someone's checkout (for
  // example dist-standalone/.stage-*) must not configure the enclosing repo.
  if (tryGit(['rev-parse', '--show-prefix'], cwd) !== '') {
    return { action: 'skipped', reason: 'not at the top level of the git work tree' };
  }
  const dir = join(cwd, hooksDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { action: 'skipped', reason: `${hooksDir} is absent` };
  }
  const current = tryGit(['config', '--get', 'core.hooksPath'], cwd);
  if (current !== null && current !== '') {
    if (current === hooksDir || resolve(cwd, current) === resolve(dir)) {
      return { action: 'already', reason: `core.hooksPath is already ${current}` };
    }
    return { action: 'skipped', reason: `core.hooksPath is already set to ${current}; not overriding it` };
  }
  git(['config', '--local', 'core.hooksPath', hooksDir], cwd);
  return { action: 'installed', reason: `core.hooksPath set to ${hooksDir}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = installGitHooks({ hooksDir: hooksDirFromArgs(process.argv.slice(2)) });
    console.error(`install-githooks: ${result.action === 'skipped' ? 'skipped, ' : ''}${result.reason}`);
  } catch (error) {
    console.error(`install-githooks: skipped, ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 0;
}
