#!/usr/bin/env node
// Hard file-size gate: fails when a tracked source file exceeds 1500 code LOC.
//
// Code LOC is the number of lines that are neither blank nor comment-only.
// Comment detection is a deliberately simple, line-based heuristic:
//   - a line whose trimmed text starts with `//` is a comment line;
//   - a block comment is recognised only when `/*` starts the trimmed line.
//     It ends at the first `*/`; text after the `*/` on that line counts as
//     code. A `/*` that appears after code on a line (for example inside a
//     glob string such as 'src/**/*.ts') never opens a block comment.
// The heuristic errs toward over-counting: a comment opened mid-line is code,
// and the only way to under-count is a multi-line string or template literal
// whose continuation line starts with `//` or `/*`.
//
// Scope: files from `git ls-files` under src/, web/static/js/ and scripts/
// ending in .ts, .tsx, .js or .mjs. Test files (`*.test.*`) and fixtures
// (any path segment named `fixtures` or `__fixtures__`) are excluded: the gate
// is about production modules, and test files grow with the behaviour they pin.
//
// Allowlist (.loc-allowlist at the repository root): one entry per line,
//   <path> <expires YYYY-MM-DD> <reason...>
// with `#` starting a comment. An entry lets its file exceed the limit up to
// and including the expiry date. The check fails when:
//   - a file that is not allowlisted exceeds the limit;
//   - an allowlisted file still exceeds the limit after its expiry date;
//   - an allowlist entry names a file that no longer exceeds the limit (or no
//     longer exists): remove the stale entry.
//
// Usage:
//   node scripts/loc-check.mjs                     check every tracked source file
//   node scripts/loc-check.mjs --files a.ts b.mjs  check only these paths (pre-commit)
//   node scripts/loc-check.mjs --staged --files …  read the staged (index) content
//   node scripts/loc-check.mjs --json              print the result as JSON
//   --today YYYY-MM-DD and --allowlist <path> exist for tests.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LIMIT = 1500;
export const SCOPE_DIRS = ['src/', 'web/static/js/', 'scripts/'];
export const SCOPE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];
export const ALLOWLIST_FILE = '.loc-allowlist';

/**
 * Counts code lines: non-blank lines that are not comment-only.
 * @param {string} text
 * @returns {number}
 */
export function countCodeLines(text) {
  let count = 0;
  let inBlock = false;
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
    }
    // A line may hold several leading block comments: `/* a */ /* b */ code`.
    while (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2);
      if (end === -1) {
        inBlock = true;
        line = '';
        break;
      }
      line = line.slice(end + 2).trim();
    }
    if (line === '' || line.startsWith('//')) continue;
    count += 1;
  }
  return count;
}

/**
 * Whether a repository-relative path is measured by the gate.
 * @param {string} file
 */
export function isInScope(file) {
  const path = file.replace(/\\/g, '/');
  if (!SCOPE_DIRS.some((dir) => path.startsWith(dir))) return false;
  if (!SCOPE_EXTENSIONS.some((ext) => path.endsWith(ext))) return false;
  if (/\.test\.[^/]+$/.test(path)) return false;
  if (path.split('/').some((segment) => segment === 'fixtures' || segment === '__fixtures__')) return false;
  return true;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses .loc-allowlist text.
 * @param {string} text
 * @returns {{ entries: Array<{ path: string; expires: string; reason: string; line: number }>; errors: string[] }}
 */
export function parseAllowlist(text) {
  const entries = [];
  const errors = [];
  const seen = new Set();
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') return;
    const [path, expires, ...reason] = line.split(/\s+/);
    const lineNo = index + 1;
    if (!expires || !DATE.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {
      errors.push(`${ALLOWLIST_FILE}:${lineNo}: expected "<path> <expires YYYY-MM-DD> <reason>", got "${raw.trim()}"`);
      return;
    }
    if (reason.length === 0) {
      errors.push(`${ALLOWLIST_FILE}:${lineNo}: entry for ${path} has no reason`);
      return;
    }
    if (seen.has(path)) {
      errors.push(`${ALLOWLIST_FILE}:${lineNo}: duplicate entry for ${path}`);
      return;
    }
    seen.add(path);
    entries.push({ path, expires, reason: reason.join(' '), line: lineNo });
  });
  return { entries, errors };
}

/**
 * Judges measured files against the limit and the allowlist.
 * @param {object} input
 * @param {Array<{ path: string; loc: number | null }>} input.files measured files; loc null = file absent
 * @param {Array<{ path: string; expires: string; reason: string }>} input.allowlist
 * @param {string} input.today YYYY-MM-DD
 * @param {number} [input.limit]
 * @param {boolean} [input.partial] true when only some files were measured (--files):
 *   allowlist entries for unmeasured files are then not judged.
 * @returns {{ ok: boolean; failures: Array<{ path: string; kind: 'over-limit' | 'expired' | 'stale'; loc: number | null; message: string }>; allowed: Array<{ path: string; loc: number; expires: string }> }}
 */
export function evaluate({ files, allowlist, today, limit = LIMIT, partial = false }) {
  const failures = [];
  const allowed = [];
  const byPath = new Map(files.map((file) => [file.path, file]));
  const entries = new Map(allowlist.map((entry) => [entry.path, entry]));

  for (const file of files) {
    if (file.loc === null || file.loc <= limit) continue;
    const entry = entries.get(file.path);
    if (!entry) {
      failures.push({
        path: file.path,
        kind: 'over-limit',
        loc: file.loc,
        message: `${file.path}: ${file.loc} code LOC exceeds the ${limit} limit. Split the module (an ${ALLOWLIST_FILE} entry is for existing offenders only).`,
      });
    } else if (today > entry.expires) {
      failures.push({
        path: file.path,
        kind: 'expired',
        loc: file.loc,
        message: `${file.path}: ${file.loc} code LOC exceeds the ${limit} limit and its ${ALLOWLIST_FILE} entry expired on ${entry.expires} (${entry.reason}).`,
      });
    } else {
      allowed.push({ path: file.path, loc: file.loc, expires: entry.expires });
    }
  }

  for (const entry of allowlist) {
    const file = byPath.get(entry.path);
    if (!file) {
      if (partial) continue;
      failures.push({
        path: entry.path,
        kind: 'stale',
        loc: null,
        message: `${ALLOWLIST_FILE}: ${entry.path} is not a tracked source file in scope; remove the stale entry.`,
      });
    } else if (file.loc === null || file.loc <= limit) {
      failures.push({
        path: entry.path,
        kind: 'stale',
        loc: file.loc,
        message: `${ALLOWLIST_FILE}: ${entry.path} is now ${file.loc ?? 'absent'}${file.loc === null ? '' : ' code LOC'}, within the ${limit} limit; remove the stale entry.`,
      });
    }
  }

  return { ok: failures.length === 0, failures, allowed };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const options = { files: /** @type {string[] | null} */ (null), json: false, staged: false, today: null, allowlist: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--staged') options.staged = true;
    else if (arg === '--today') options.today = argv[++i] ?? null;
    else if (arg === '--allowlist') options.allowlist = argv[++i] ?? null;
    else if (arg === '--files') {
      options.files = options.files ?? [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) options.files.push(argv[++i]);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function localToday() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Reads a file's text, or null when it does not exist (working tree or index). */
function readSource(root, path, staged) {
  try {
    if (staged) return git(['show', `:${path}`], root);
    return readFileSync(`${root}/${path}`, 'utf8');
  } catch {
    return null;
  }
}

function main(argv) {
  const options = parseArgs(argv);
  const root = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  const today = options.today ?? localToday();
  if (!DATE.test(today)) throw new Error(`--today must be YYYY-MM-DD, got ${today}`);

  const allowlistPath = options.allowlist ?? `${root}/${ALLOWLIST_FILE}`;
  let allowlistText = '';
  try {
    allowlistText = readFileSync(allowlistPath, 'utf8');
  } catch {
    // No allowlist file means no allowances.
  }
  const { entries, errors } = parseAllowlist(allowlistText);

  const partial = options.files !== null;
  const paths = partial
    ? options.files.map((file) => file.replace(/\\/g, '/').replace(/^\.\//, ''))
    : git(['ls-files', '-z', '--', ...SCOPE_DIRS], root).split('\0').filter(Boolean);
  const files = [...new Set(paths)]
    .filter(isInScope)
    .map((path) => {
      const text = readSource(root, path, options.staged);
      return { path, loc: text === null ? null : countCodeLines(text) };
    })
    // A tracked file deleted in the working tree is not measured; in full mode
    // an allowlist entry for it is then reported as stale.
    .filter((file) => file.loc !== null || entries.some((entry) => entry.path === file.path));

  const result = evaluate({ files, allowlist: entries, today, partial });
  const ok = result.ok && errors.length === 0;

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok, limit: LIMIT, today, checked: files.length, errors, ...result }, null, 2)}\n`);
  } else {
    for (const error of errors) console.error(`loc-check: ${error}`);
    for (const failure of result.failures) console.error(`loc-check: ${failure.message}`);
    if (ok) {
      console.log(`loc-check: ${files.length} file(s) within ${LIMIT} code LOC (${result.allowed.length} allowlisted).`);
    } else {
      console.error(`loc-check: FAILED (${result.failures.length + errors.length} problem(s)). See CONTRIBUTING.md, "LOC gate and git hooks".`);
    }
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`loc-check: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
