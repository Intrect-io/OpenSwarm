// Created: 2026-11-21
// Purpose: operator-owned per-repository merge grants for the merge steward, fail-closed (AGT-4414)
// Dependencies: node:fs, node:os, node:path
// Test Status: mergeGrant.test.ts

/**
 * A repository is eligible for steward merges only when the operator wrote a
 * grant for it in a file the operator owns: `OPENSWARM_MERGE_GRANTS`, else
 * `~/.openswarm/steward/merge-grants.json`. Never the target repository or the
 * cwd, so a PR cannot grant itself.
 *
 * Format: `{"owner/name": true}`. Keys match case-insensitively. Only the literal
 * boolean `true` grants. Anything else grants nothing: a missing or unreadable
 * file, invalid JSON, a non-object root, a wildcard or malformed key, a
 * non-boolean value. Entries that disagree for the same repository (by case)
 * resolve to not granted.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface MergeGrantResult {
  granted: boolean;
  reason: string;
  path: string;
}

export interface ParsedMergeGrants {
  /** Null when the file as a whole is unusable; otherwise why entries were dropped is in `rejected`. */
  error: string | null;
  /** Lower-cased `owner/name` -> granted. A non-boolean value is recorded as false. */
  grants: ReadonlyMap<string, boolean>;
  /** Keys that can never grant (wildcards, malformed names). */
  rejected: readonly string[];
}

const REPO_KEY = /^[\w.-]+\/[\w.-]+$/;

/** The operator's grants file. */
export function defaultMergeGrantsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENSWARM_MERGE_GRANTS;
  if (override !== undefined && override.trim() !== '') return override;
  return join(homedir(), '.openswarm', 'steward', 'merge-grants.json');
}

/** Pure parser. Never throws. */
export function parseMergeGrants(raw: string): ParsedMergeGrants {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch (err) {
    return { error: `invalid JSON (${err instanceof Error ? err.message : String(err)})`, grants: new Map(), rejected: [] };
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return { error: 'root is not a JSON object', grants: new Map(), rejected: [] };
  }
  const grants = new Map<string, boolean>();
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    if (key.includes('*') || !REPO_KEY.test(key)) {
      rejected.push(key);
      continue;
    }
    const repo = key.toLowerCase();
    const granted = value === true;
    // Disagreeing duplicates (e.g. by case) fail closed.
    grants.set(repo, grants.has(repo) ? grants.get(repo) === true && granted : granted);
  }
  return { error: null, grants, rejected };
}

export interface ReadMergeGrantOptions {
  /** Grants file; defaults to `defaultMergeGrantsPath()`. */
  path?: string;
  /** Injected for tests; defaults to a UTF-8 `readFileSync`. */
  readFile?: (path: string) => string;
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err);
}

/** Whether the operator granted steward merges for `repo` (`owner/name`). */
export function readMergeGrant(repo: string, options: ReadMergeGrantOptions = {}): MergeGrantResult {
  const path = options.path ?? defaultMergeGrantsPath();
  const deny = (reason: string): MergeGrantResult => ({ granted: false, reason, path });
  if (!REPO_KEY.test(repo)) return deny(`repository ${JSON.stringify(repo)} is not owner/name`);
  if (!isAbsolute(path)) return deny(`grants path ${JSON.stringify(path)} is not absolute`);
  let raw: string;
  try {
    raw = (options.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(path);
  } catch (err) {
    const code = errorCode(err);
    return deny(code === 'ENOENT' ? `no grants file at ${path}` : `grants file at ${path} is unreadable (${code})`);
  }
  const parsed = parseMergeGrants(raw);
  if (parsed.error !== null) return deny(`grants file at ${path} is malformed: ${parsed.error}`);
  const entry = parsed.grants.get(repo.toLowerCase());
  if (entry === undefined) return deny(`no entry for ${repo} in ${path}`);
  if (entry !== true) return deny(`entry for ${repo} in ${path} is not true`);
  return { granted: true, reason: `${repo} granted by ${path}`, path };
}
