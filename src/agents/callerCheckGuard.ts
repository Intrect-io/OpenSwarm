// ============================================
// OpenSwarm — a removed public symbol must take its callers with it (AGT-4417)
// ============================================
//
// cgf-portal #215 redesigned `a2_inputs.py`: it deleted `AccountingRule`,
// renamed `read_bank_accounts` and replaced `FixedExpense` fields, and shipped
// without the four consumer files — the package import graph broke on merge.
// #217 added a gate without touching the CLI that had to carry it. Both were
// visible from one grep per changed public symbol, which is what this does:
// for every top-level Python `def`/`class` and TypeScript `export` the diff
// removes (and does not re-add under the same name), grep the repository for
// references in files the diff did not touch. Any hit is a blocking finding
// naming the caller. Off unless `guards.callerCheck: true`.
//
// It fails closed: if git cannot be asked, the change is not cleared.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GuardResult } from './pipelineGuards.js';

const execFileAsync = promisify(execFile);
const SOURCE_GLOBS = ['*.py', '*.ts', '*.tsx'];

/** Top-level only: methods share names across classes (`__init__`, `run`) and are not import-graph edges. */
const PY_DEFINITION = /^(?:async\s+)?(?:def|class)\s+([A-Za-z][\w]*)\b/;
const TS_EXPORT = /^\s*export\s+(?:(?:default|declare|async|abstract)\s+)*(?:function\s*\*?\s*|class\s+|(?:const|let|var|enum|type|interface)\s+)([A-Za-z_$][\w$]*)\b/;

function definedSymbol(file: string, text: string): string | null {
  if (file.endsWith('.py')) return PY_DEFINITION.exec(text)?.[1] ?? null;
  return TS_EXPORT.exec(text)?.[1] ?? null;
}

/**
 * Public symbols a unified diff removes, mapped to the file they were removed
 * from. A symbol the same diff defines again (a signature change, a move to
 * another file) is not removed.
 */
export function removedPublicSymbols(diff: string): Map<string, string> {
  const removed = new Map<string, string>();
  const added = new Set<string>();
  let oldFile = '';
  let newFile = '';
  for (const line of diff.split('\n')) {
    const from = /^--- (?:a\/(.+)|\/dev\/null)$/.exec(line);
    if (from) { oldFile = from[1] ?? ''; continue; }
    const to = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(line);
    if (to) { newFile = to[1] ?? ''; continue; }
    if (line.startsWith('-') && oldFile) {
      const symbol = definedSymbol(oldFile, line.slice(1));
      if (symbol) removed.set(symbol, oldFile);
    } else if (line.startsWith('+') && newFile) {
      const symbol = definedSymbol(newFile, line.slice(1));
      if (symbol) added.add(symbol);
    }
  }
  for (const symbol of added) removed.delete(symbol);
  return removed;
}

async function git(projectPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: projectPath, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** `git grep` hits for a symbol, or none. Exit status 1 means "no match"; anything else is an error. */
async function references(projectPath: string, symbol: string): Promise<Array<{ file: string; line: string; text: string }>> {
  try {
    const out = await git(projectPath, ['grep', '-n', '-w', '--untracked', '-e', symbol, '--', ...SOURCE_GLOBS]);
    return out.split('\n').flatMap((hit) => {
      const match = /^(.+?):(\d+):(.*)$/.exec(hit);
      return match ? [{ file: match[1], line: match[2], text: match[3] }] : [];
    });
  } catch (err) {
    if ((err as { code?: unknown }).code === 1) return [];
    throw err;
  }
}

export async function runCallerCheckGuard(projectPath: string): Promise<GuardResult> {
  const guard = 'callerCheck';
  const issues: string[] = [];
  try {
    const removed = removedPublicSymbols(await git(projectPath, ['diff', '--unified=0', 'HEAD', '--', ...SOURCE_GLOBS]));
    if (removed.size > 0) {
      const changed = new Set((await git(projectPath, ['diff', '--name-only', 'HEAD'])).split('\n').filter(Boolean));
      for (const file of (await git(projectPath, ['ls-files', '--others', '--exclude-standard'])).split('\n')) {
        if (file) changed.add(file);
      }
      for (const [symbol, definitionFile] of removed) {
        const hits = await references(projectPath, symbol);
        // Still defined somewhere (`def main` in another script, a second
        // `export const config`): callers may bind to that one, so a grep
        // cannot tell a broken reference from a working one. Stay quiet.
        if (hits.some(hit => definedSymbol(hit.file, hit.text) === symbol)) continue;
        for (const hit of hits) {
          if (changed.has(hit.file)) continue;
          issues.push(`[${hit.file}:${hit.line}] still references removed public symbol "${symbol}" (removed from ${definitionFile}); update or remove this caller.`);
        }
      }
    }
  } catch (err) {
    issues.push(`Unable to verify surviving callers: ${err instanceof Error ? err.message : String(err)}`);
    console.warn('[Guard:callerCheck] Error:', err);
  }
  return { passed: issues.length === 0, guard, issues, blocking: true };
}
