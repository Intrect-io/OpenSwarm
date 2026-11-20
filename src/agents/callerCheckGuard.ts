// ============================================
// OpenSwarm — a removed public symbol must take its callers with it (AGT-4417)
// ============================================
//
// cgf-portal #215 redesigned `a2_inputs.py`: it deleted `AccountingRule`,
// renamed `read_bank_accounts` and replaced `FixedExpense` fields, and shipped
// without the four consumer files — the package import graph broke on merge.
// #217 added a gate without touching the CLI that had to carry it. Both were
// visible from one grep per changed public symbol, which is what this does:
// for every top-level Python `def`/`class` and TypeScript/JavaScript `export`
// the diff removes (and does not re-add under the same name), grep the project
// for references. A file with a hit counts as a caller only when it imports
// the symbol (or a module through which it reaches `module.symbol`); a file
// that merely defines its own non-exported `Props`, or names it in a comment,
// is not one. Any caller is a blocking finding. Off unless `guards.callerCheck: true`.
//
// Paths: every git command runs in `projectPath` and reports paths relative to
// it (`git diff --relative`, `git grep` without `--full-name`), so a project
// that is a subdirectory of its repository is scanned consistently.
//
// It fails closed: if git cannot be asked, or there are too many references
// to examine, the change is not cleared.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GuardResult } from './pipelineGuards.js';

const execFileAsync = promisify(execFile);
const SOURCE_GLOBS = ['*.py', '*.pyi', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs'];
/** Above this many grep hits the guard reports one fail-closed note instead of guessing. */
export const MAX_REFERENCE_HITS = 2000;

/**
 * Pin every setting that changes the shape of diff/grep output, so user or
 * repository git config (`diff.noprefix`, `color.ui=always`, `diff.relative`,
 * `grep.column`, an external diff driver, quoted paths) cannot make the header
 * parser see nothing and wave a broken change through.
 */
const GIT_CONFIG = [
  '-c', 'color.ui=never', '-c', 'color.diff=never', '-c', 'color.grep=never',
  '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.relative=false',
  '-c', 'core.quotePath=false',
  '-c', 'grep.fullName=false', '-c', 'grep.column=false', '-c', 'grep.lineNumber=false',
];
const DIFF = ['diff', '--no-ext-diff', '--no-color', '--no-textconv', '--relative', '--src-prefix=a/', '--dst-prefix=b/'];

/** Top-level only: methods share names across classes (`__init__`, `run`) and are not import-graph edges. */
const PY_DEFINITION = /^(?:async\s+)?(?:def|class)\s+([A-Za-z][\w]*)\b/;
const TS_EXPORT = /^\s*export\s+(?:(?:default|declare|async|abstract)\s+)*(?:function\s*\*?\s*|class\s+|(?:const\s+enum|const|let|var|enum|type|interface)\s+)([A-Za-z_$][\w$]*)\b/;

const isPython = (file: string): boolean => /\.pyi?$/.test(file);

function definedSymbol(file: string, text: string): string | null {
  if (isPython(file)) return PY_DEFINITION.exec(text)?.[1] ?? null;
  return TS_EXPORT.exec(text)?.[1] ?? null;
}

function isCommentOnly(file: string, text: string): boolean {
  const trimmed = text.trim();
  if (isPython(file)) return trimmed.startsWith('#');
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (clause: string, symbol: string): boolean =>
  new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`).test(clause);

/** Names a TS/JS file binds to whole modules: `import * as X`, `export * as X`, `const X = require(...)`. */
function tsNamespaces(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]/g)) names.push(m[1]);
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:require|await\s+import)\s*\(/g)) names.push(m[1]);
  return names;
}

/** Does a TS/JS file pull `symbol` in from some module? The module path is not resolved. */
function tsImports(source: string, symbol: string): boolean {
  const sym = escapeRegExp(symbol);
  // import { a, sym as b } from / import sym from / import type { sym } from / export { sym } from
  // The clause is anchored to real import shapes (`D`, `{...}`, `* as X`, `D, {...}`, `D, * as X`) so it
  // cannot span from an unrelated `export const` to a later `from` in semicolon-free code.
  for (const m of source.matchAll(/\b(?:import|export)\s+(?:type\s+)?((?:[A-Za-z_$][\w$]*\s*,\s*)?(?:\{[^}]*\}|\*\s*as\s+[A-Za-z_$][\w$]*)|[A-Za-z_$][\w$]*)\s*from\s*['"]/g)) {
    if (mentions(m[1], symbol)) return true;
  }
  // const { sym } = require('x') / const { sym } = await import('x')
  for (const m of source.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:require|await\s+import)\s*\(/g)) {
    if (mentions(m[1], symbol)) return true;
  }
  // require('x').sym / (await import('x')).sym
  if (new RegExp(`(?:require|import)\\s*\\([^)]*\\)\\)?\\s*\\??\\.\\s*${sym}(?![\\w$])`).test(source)) return true;
  return tsNamespaces(source).some(ns => new RegExp(`(?<![\\w$.])${escapeRegExp(ns)}\\s*\\??\\.\\s*${sym}(?![\\w$])`).test(source));
}

/** Does a Python file pull `symbol` in: `from m import sym`, `from m import *` of the defining module, or `alias.sym`? */
function pyImports(source: string, symbol: string, definitionFile: string): boolean {
  const stem = definitionFile.replace(/^.*\//, '').replace(/\.pyi?$/, '');
  const bound: string[] = [];
  for (const m of source.matchAll(/^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]*(?:\\\n[^\n#]*)*)/gm)) {
    const clause = m[2].replace(/[()\\]/g, ' ');
    if (clause.trim() === '*') {
      if (m[1].split('.').pop() === stem) return true;
      continue;
    }
    if (mentions(clause, symbol)) return true;
    // `from pkg import api [as a]`: only the defining module binds `a.sym`.
    for (const part of clause.split(',')) {
      const imported = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      if (imported && imported[1] === stem) bound.push(imported[2] ?? imported[1]);
    }
  }
  for (const m of source.matchAll(/^[ \t]*import[ \t]+([^\n#]+)/gm)) {
    for (const part of m[1].split(',')) {
      const alias = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
      // `import requests` does not make `requests.get` a caller of a removed `get` elsewhere.
      if (alias && alias[1].split('.').pop() === stem) bound.push(alias[2] ?? alias[1]);
    }
  }
  return bound.some(name => new RegExp(`(?<![\\w.])${escapeRegExp(name)}(?:\\.\\w+)*\\.${escapeRegExp(symbol)}\\b`).test(source));
}

/** True when `file` (its full text in `source`) plausibly references `symbol` removed from `definitionFile`. */
export function importsSymbol(file: string, source: string, symbol: string, definitionFile: string): boolean {
  const code = source.split('\n').map(line => (isCommentOnly(file, line) ? '' : line)).join('\n');
  return isPython(file) ? pyImports(code, symbol, definitionFile) : tsImports(code, symbol);
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

async function git(projectPath: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await execFileAsync('git', [...GIT_CONFIG, ...args], { cwd: projectPath, timeout, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

interface Hit { file: string; line: string; text: string }

/** One `git grep` for every removed symbol. Exit status 1 means "no match"; anything else is an error. */
async function references(projectPath: string, symbols: string[]): Promise<Hit[]> {
  try {
    const patterns = symbols.flatMap(symbol => ['-e', symbol]);
    const out = await git(projectPath, ['grep', '--no-color', '-z', '-n', '-I', '-F', '-w', '--untracked', ...patterns, '--', ...SOURCE_GLOBS], 60_000);
    return out.split('\n').flatMap((hit) => {
      const [file, line, ...rest] = hit.split('\0');
      return file && line !== undefined && /^\d+$/.test(line) ? [{ file, line, text: rest.join('\0') }] : [];
    });
  } catch (err) {
    if ((err as { code?: unknown }).code === 1) return [];
    throw err;
  }
}

/**
 * Grep hits per removed symbol, minus symbols still defined somewhere (`def
 * main` in another script, a second `export const config`): callers may bind
 * to that one, so a grep cannot tell a broken reference from a working one.
 */
function hitsBySymbol(removed: Map<string, string>, hits: Hit[]): Map<string, Hit[]> {
  const bySymbol = new Map<string, Hit[]>();
  for (const symbol of removed.keys()) {
    const symbolHits = hits.filter(hit => mentions(hit.text, symbol));
    if (symbolHits.some(hit => definedSymbol(hit.file, hit.text) === symbol)) continue;
    if (symbolHits.length > 0) bySymbol.set(symbol, symbolHits);
  }
  return bySymbol;
}

/** Callers of each removed symbol, as issue lines. */
async function callerIssues(projectPath: string, removed: Map<string, string>, bySymbol: Map<string, Hit[]>): Promise<string[]> {
  const issues: string[] = [];
  const sources = new Map<string, Promise<string>>();
  const sourceOf = (file: string): Promise<string> => {
    if (!sources.has(file)) sources.set(file, readFile(join(projectPath, file), 'utf8'));
    return sources.get(file)!;
  };
  for (const [symbol, symbolHits] of bySymbol) {
    const definitionFile = removed.get(symbol)!;
    for (const hit of symbolHits) {
      if (isCommentOnly(hit.file, hit.text)) continue;
      if (!importsSymbol(hit.file, await sourceOf(hit.file), symbol, definitionFile)) continue;
      issues.push(`[${hit.file}:${hit.line}] still references removed public symbol "${symbol}" (removed from ${definitionFile}); update or remove this caller.`);
    }
  }
  return issues;
}

export async function runCallerCheckGuard(projectPath: string): Promise<GuardResult> {
  const guard = 'callerCheck';
  const issues: string[] = [];
  try {
    const removed = removedPublicSymbols(await git(projectPath, [...DIFF, '--unified=0', 'HEAD', '--', ...SOURCE_GLOBS]));
    const bySymbol = hitsBySymbol(removed, removed.size > 0 ? await references(projectPath, [...removed.keys()]) : []);
    const total = [...bySymbol.values()].reduce((n, h) => n + h.length, 0);
    if (total > MAX_REFERENCE_HITS) {
      issues.push(`Unable to verify surviving callers: ${total} references to removed public symbols (${[...bySymbol.keys()].join(', ')}) exceed the ${MAX_REFERENCE_HITS}-hit cap; check the callers by hand.`);
    } else {
      issues.push(...await callerIssues(projectPath, removed, bySymbol));
    }
  } catch (err) {
    issues.push(`Unable to verify surviving callers: ${err instanceof Error ? err.message : String(err)}`);
    console.warn('[Guard:callerCheck] Error:', err);
  }
  return { passed: issues.length === 0, guard, issues, blocking: true };
}
