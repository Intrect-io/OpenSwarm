// ============================================
// OpenSwarm — test-runner config is a trusted verification input
// ============================================
//
// `runTrustedCommand` pins package.json `scripts` to the base revision so a
// change cannot rewrite what `npm test` runs. Everything the test runner then
// reads to decide WHICH tests run and what counts as passing was still taken
// from the change under test: a `test.exclude` in vitest.config, a lowered
// coverage threshold, a `collect_ignore` in conftest.py. Round-1 redteam
// (2026-11-03, A-F2) confirmed the deterministic gate then reports a pass it
// never measured.
//
// The head sandbox therefore gets the BASE version of every test-runner config
// file the change touched. Where a file cannot be pinned without discarding a
// legitimate change too — a config the base never had, or the test sections
// of a manifest that also carries dependencies — verification fails closed
// with a `[security]` reason instead, so a person decides.

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Files that only configure the test runner: pinned to base wholesale. */
const PINNED_CONFIG = [
  /^vitest\.config\.[cm]?[jt]s$/,
  /^vitest\.workspace\.(?:[cm]?[jt]s|json)$/,
  /^jest\.config\.(?:[cm]?[jt]s|json)$/,
  /^pytest\.ini$/,
  /^conftest\.py$/,
  /^tox\.ini$/,
  /^\.coveragerc$/,
];

/** Files that mix test config with other content: only their test sections are compared. */
const SECTIONED_CONFIG: Record<string, (source: string) => string> = {
  'pyproject.toml': (s) => iniSections(s, /^\[tool\.(?:pytest|coverage)\b/),
  'setup.cfg': (s) => iniSections(s, /^\[(?:tool:pytest|coverage:[^\]]*)\]/),
  'package.json': (s) => {
    try {
      if (!s.trim()) return '';
      const pkg = JSON.parse(s) as Record<string, unknown>;
      const keys = ['jest', 'vitest', 'c8', 'nyc'].filter((key) => pkg[key] !== undefined);
      // A manifest with none of these says nothing about the test runner, present or not.
      return keys.length ? JSON.stringify(Object.fromEntries(keys.map((key) => [key, pkg[key]]))) : '';
    } catch {
      return s;
    }
  },
};

/** vite.config may carry a vitest `test:` block; only that case is in scope. */
const VITE_CONFIG = /^vite\.config\.[cm]?[jt]s$/;

export function isPinnedTestConfig(path: string): boolean {
  const name = basename(path);
  return PINNED_CONFIG.some((pattern) => pattern.test(name));
}

/** The text of every `[section]` whose header matches, in order. */
function iniSections(source: string, header: RegExp): string {
  const out: string[] = [];
  let inside = false;
  for (const line of source.split('\n')) {
    if (/^\s*\[/.test(line)) inside = header.test(line.trim());
    if (inside) out.push(line.trimEnd());
  }
  return out.join('\n');
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function atBase(projectPath: string, base: string, path: string): Promise<string | null> {
  try {
    return await git(projectPath, ['show', `${base}:${path}`]);
  } catch {
    return null;
  }
}

async function inTree(root: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(root, path), 'utf8');
  } catch {
    return null;
  }
}

export interface PinnedConfigResult {
  /** Paths whose base version replaced the change's in the sandbox. */
  pinned: string[];
}

/**
 * Put the base version of every changed test-runner config into `sandbox`.
 *
 * `projectPath` is the checkout under verification (its working tree is the
 * head side); `sandbox` is the disposable copy commands will run in. Throws an
 * Error whose message starts with `[security]` when a change cannot be pinned.
 * Without a merge base there is no base to pin to and nothing is changed — the
 * base run then fails as infrastructure on its own.
 */
export async function pinTrustedTestConfig(
  projectPath: string,
  sandbox: string,
  baseRef: string,
): Promise<PinnedConfigResult> {
  const base = (await git(projectPath, ['merge-base', 'HEAD', baseRef]).catch(() => '')).trim();
  if (!base) return { pinned: [] };
  const changed = new Set(
    `${await git(projectPath, ['diff', '--name-only', base, '--'])}\n${await git(projectPath, ['ls-files', '--others', '--exclude-standard'])}`
      .split('\n').map((p) => p.trim()).filter(Boolean),
  );
  const pinned: string[] = [];
  const refusals: string[] = [];
  for (const path of [...changed].sort()) {
    const target = resolve(sandbox, path);
    if (relative(sandbox, target).startsWith(`..${sep}`)) continue;
    const name = basename(path);
    if (isPinnedTestConfig(path)) {
      const original = await atBase(projectPath, base, path);
      if (original === null) {
        refusals.push(`${path} (a test-runner config the base revision does not have)`);
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { force: true });
      await writeFile(target, original, 'utf8');
      pinned.push(path);
      continue;
    }
    const sections = SECTIONED_CONFIG[name];
    const vite = VITE_CONFIG.test(name);
    if (!sections && !vite) continue;
    const [before, after] = await Promise.all([atBase(projectPath, base, path), inTree(projectPath, path)]);
    if (sections) {
      if (sections(before ?? '') !== sections(after ?? '')) {
        refusals.push(`${path} (its test/coverage settings changed)`);
      }
      continue;
    }
    if (/\btest\s*:/.test(`${before ?? ''}\n${after ?? ''}`)) {
      refusals.push(`${path} (it carries a vitest \`test\` block)`);
    }
  }
  if (refusals.length > 0) {
    throw new Error(
      `[security] verification refuses a change to test-runner configuration it cannot pin to the base revision: ${refusals.join('; ')}. `
      + 'The runner would otherwise measure the change with settings the change itself chose.',
    );
  }
  if (pinned.length > 0) console.log(`[Verify] pinned test-runner config to the base revision: ${pinned.join(', ')}`);
  return { pinned };
}
