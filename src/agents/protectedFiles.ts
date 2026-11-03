// ============================================
// OpenSwarm — the worker may not edit the grader by default
// ============================================
//
// `protectedFiles` has been enforced by the edit/write tools since INT-1914
// (tools.ts `isProtectedPath`, agenticLoop's pre-write check), but no
// production caller ever set it, so every worker could rewrite the existing
// tests that define acceptance and the config that decides which of them run.
// Round-1 redteam (2026-11-03, A-F3) confirmed it. The pair pipeline now
// protects, from the run's start:
//
//   - every tracked test file (the same kinds deletedTestGuard counts), and
//   - every tracked test-runner config file (the set verify pins to base).
//
// New test files stay writable — adding tests is the behaviour we want. Two
// ways lift protection for an existing file, both of them the issue author's
// call, never the worker's:
//
//   - the DoD contract's `"tests": { "allowEdits": ["glob", …] }`, and
//   - the issue naming the file (its path, or its basename when that is
//     unambiguous), because "update src/a.test.ts for the new rule" is a task
//     about that file.
//
// Delegated CLI adapters (claude/codex/cursor) run their own tool loop and do
// not receive this list; for them the active-test gate (testRemovalGate.ts)
// and the trusted verify config are the backstop.

import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { testFileKind } from '../automation/deletedTestGuard.js';
import { parseDoDContract } from '../automation/dodContract.js';
import { isPinnedTestConfig } from '../verify/trustedConfig.js';

const exec = promisify(execFile);

/** Glob → RegExp for `allowEdits`: `**` spans directories, `*` and `?` do not. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += /[\\^$.|+()[\]{}]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Should the worker be kept off `file` (a repo-relative path)? */
export function isGraderFile(file: string): boolean {
  return testFileKind(file) !== null || isPinnedTestConfig(file);
}

/**
 * Files the issue itself puts in scope: named by path, or by a basename that
 * only one candidate carries (`conftest.py` alone names nothing in a repo with
 * five of them).
 */
function namedByIssue(candidates: string[], text: string): Set<string> {
  const named = new Set<string>();
  if (!text) return named;
  const byBase = new Map<string, string[]>();
  for (const file of candidates) {
    const list = byBase.get(basename(file)) ?? [];
    list.push(file);
    byBase.set(basename(file), list);
  }
  for (const file of candidates) {
    if (text.includes(file)) named.add(file);
  }
  for (const [base, files] of byBase) {
    if (files.length === 1 && new RegExp(`(?<![\\w./-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text)) {
      named.add(files[0]);
    }
  }
  return named;
}

export interface ProtectedFilesInput {
  title?: string;
  description?: string;
}

/**
 * The repo-relative grader files the worker may not edit in this run.
 *
 * Reads the files git tracks in `projectPath` (the run's worktree, at the
 * revision the run starts from). A checkout git cannot list yields an empty
 * list and a warning — the tools then behave as before rather than the run
 * failing over a protection it never had.
 */
export async function computeProtectedFiles(projectPath: string, task: ProtectedFilesInput): Promise<string[]> {
  let tracked: string[];
  try {
    const { stdout } = await exec('git', ['-C', projectPath, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 });
    tracked = stdout.split('\0').filter(Boolean);
  } catch (error) {
    console.warn(`[ProtectedFiles] Could not list tracked files in ${projectPath}; no files protected:`, error);
    return [];
  }
  const candidates = tracked.filter(isGraderFile);
  const allowEdits = parseDoDContract(task.description).contract?.tests?.allowEdits ?? [];
  const allowed = allowEdits.map(globToRegExp);
  const named = namedByIssue(candidates, `${task.title ?? ''}\n${task.description ?? ''}`);
  return candidates.filter((file) => !named.has(file) && !allowed.some((pattern) => pattern.test(file)));
}
