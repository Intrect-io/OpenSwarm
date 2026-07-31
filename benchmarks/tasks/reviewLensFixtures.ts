// ============================================
// OpenSwarm - Multi-Lens Reviewer A/B Fixtures (INT-2230)
// Created: 2026-07-01
// Purpose: Planted-defect fixtures to measure whether the 3-lens fan-out
//          reviewer catches more real defects than a single reviewer, and how
//          much the lenses overlap. Each fixture is a tiny git repo: `committed`
//          is the pre-change HEAD, `changed` is the worker's working-tree diff.
//          Six carry one planted defect (2 per lens category); two are clean
//          controls that a good reviewer must approve.
// ============================================

/** Which review concern the planted defect belongs to. */
export type LensCategory = 'correctness' | 'security' | 'regression' | 'clean';

export interface LensFixture {
  key: string;
  /** The lens the planted defect naturally falls under (or 'clean'). */
  category: LensCategory;
  taskTitle: string;
  taskDescription: string;
  /** Files as they exist at HEAD before the worker's change. */
  committed: Record<string, string>;
  /** Working-tree contents after the worker's change (subset of paths). */
  changed: Record<string, string>;
  /** Worker's self-reported summary (fed to the reviewer prompt). */
  summary: string;
  commands: string[];
  /** true = defect present (reviewer should NOT approve); false = clean. */
  expectDefect: boolean;
  /**
   * Lowercased substrings that indicate the reviewer named THE planted defect
   * (not just any complaint). Detection = not-approve AND any keyword hit.
   * Empty for clean fixtures.
   */
  detectionKeywords: string[];
}

export const LENS_FIXTURES: LensFixture[] = [
  // ---- correctness ----
  {
    key: 'correctness-offbyone',
    category: 'correctness',
    taskTitle: 'Fix getPage to return exactly `size` items per page',
    taskDescription:
      'paginate() should return the slice for the given zero-based page. Page 0 returns items[0..size), page 1 returns items[size..2*size), etc. Fix the slice bounds.',
    committed: {
      'src/paginate.ts':
        `export function paginate<T>(items: T[], page: number, size: number): T[] {\n` +
        `  const start = page * size;\n` +
        `  return items.slice(start, start + size);\n` +
        `}\n`,
    },
    changed: {
      // Off-by-one: end bound is inclusive of one extra element -> pages overlap.
      'src/paginate.ts':
        `export function paginate<T>(items: T[], page: number, size: number): T[] {\n` +
        `  const start = page * size;\n` +
        `  return items.slice(start, start + size + 1);\n` +
        `}\n`,
    },
    summary: 'Adjusted paginate slice bounds so each page returns the correct window.',
    commands: ['npx tsc --noEmit'],
    expectDefect: true,
    detectionKeywords: ['off-by-one', 'off by one', 'size + 1', 'extra', 'overlap', 'one more', 'boundary', 'inclusive'],
  },
  {
    key: 'correctness-missing-await',
    category: 'correctness',
    taskTitle: 'Persist the session before returning its id',
    taskDescription:
      'saveSession() must durably write the session via store.set() and only then return the id, so a caller that immediately reads back the session sees it.',
    committed: {
      'src/session.ts':
        `export async function saveSession(store: { set(k: string, v: unknown): Promise<void> }, id: string, data: unknown): Promise<string> {\n` +
        `  await store.set(id, data);\n` +
        `  return id;\n` +
        `}\n`,
    },
    changed: {
      // Dropped the await: returns before the write settles -> lost write / race.
      'src/session.ts':
        `export async function saveSession(store: { set(k: string, v: unknown): Promise<void> }, id: string, data: unknown): Promise<string> {\n` +
        `  store.set(id, data);\n` +
        `  return id;\n` +
        `}\n`,
    },
    summary: 'Simplified saveSession to persist the session and return its id.',
    commands: ['npx tsc --noEmit'],
    expectDefect: true,
    detectionKeywords: ['await', 'not awaited', 'unawaited', 'promise', 'race', 'floating', 'before', 'persist'],
  },

  // ---- security ----
  {
    key: 'security-command-injection',
    category: 'security',
    taskTitle: 'Generate a report file for the given project name',
    taskDescription:
      'generateReport(name) should invoke the local `reportgen` binary for the named project. `name` comes from an HTTP request body.',
    committed: {
      'src/report.ts':
        `import { execFile } from 'node:child_process';\n` +
        `import { promisify } from 'node:util';\n` +
        `const run = promisify(execFile);\n` +
        `export async function generateReport(name: string): Promise<void> {\n` +
        `  await run('reportgen', ['--project', name]);\n` +
        `}\n`,
    },
    changed: {
      // Switched to string exec with concatenated untrusted input -> injection.
      'src/report.ts':
        `import { exec } from 'node:child_process';\n` +
        `import { promisify } from 'node:util';\n` +
        `const run = promisify(exec);\n` +
        `export async function generateReport(name: string): Promise<void> {\n` +
        `  await run('reportgen --project ' + name);\n` +
        `}\n`,
    },
    summary: 'Refactored generateReport to call reportgen via a single shell command.',
    commands: ['npx tsc --noEmit'],
    expectDefect: true,
    detectionKeywords: ['injection', 'shell', 'exec', 'untrusted', 'sanitiz', 'command', 'execfile', 'arbitrary', 'unsafe input'],
  },
  {
    key: 'security-secret-leak',
    category: 'security',
    taskTitle: 'Improve auth error logging for debugging',
    taskDescription:
      'When authentication fails, log enough context to debug the failure. `apiKey` is a secret loaded from the environment.',
    committed: {
      'src/auth.ts':
        `export function onAuthFailure(apiKey: string, status: number): void {\n` +
        `  console.error('auth failed status=' + status + ' keyLen=' + apiKey.length);\n` +
        `}\n`,
    },
    changed: {
      // Logs the raw secret to stderr.
      'src/auth.ts':
        `export function onAuthFailure(apiKey: string, status: number): void {\n` +
        `  console.error('auth failed status=' + status + ' apiKey=' + apiKey);\n` +
        `}\n`,
    },
    summary: 'Added the API key to the auth-failure log line for easier debugging.',
    commands: [],
    expectDefect: true,
    detectionKeywords: ['secret', 'api key', 'apikey', 'leak', 'credential', 'token', 'redact', 'log', 'sensitive', 'plaintext'],
  },

  // ---- regression ----
  {
    key: 'regression-signature-break',
    category: 'regression',
    taskTitle: 'Add currency support to formatPrice',
    taskDescription:
      'formatPrice should support multiple currencies. Add a `currency` parameter. Keep existing callers working.',
    committed: {
      'src/format.ts':
        `export function formatPrice(cents: number): string {\n` +
        `  return '$' + (cents / 100).toFixed(2);\n` +
        `}\n`,
      // Existing caller — NOT changed by the worker; still calls the old arity.
      'src/checkout.ts':
        `import { formatPrice } from './format.js';\n` +
        `export function lineTotal(cents: number): string {\n` +
        `  return 'Total: ' + formatPrice(cents);\n` +
        `}\n`,
    },
    changed: {
      // currency is REQUIRED and callers were not updated -> checkout.ts breaks.
      'src/format.ts':
        `export function formatPrice(cents: number, currency: string): string {\n` +
        `  const sym = currency === 'USD' ? '$' : currency + ' ';\n` +
        `  return sym + (cents / 100).toFixed(2);\n` +
        `}\n`,
    },
    summary: 'Added a required currency parameter to formatPrice for multi-currency support.',
    commands: ['npx tsc --noEmit'],
    expectDefect: true,
    detectionKeywords: ['caller', 'checkout', 'signature', 'required', 'breaks', 'breaking', 'arity', 'regression', 'not updated', 'optional', 'default'],
  },
  {
    key: 'regression-removed-guard',
    category: 'regression',
    taskTitle: 'Simplify resolveUser by removing redundant checks',
    taskDescription:
      'Clean up resolveUser(). Remove code that looks redundant, but do not change observable behavior for callers.',
    committed: {
      'src/user.ts':
        `export interface User { id: string; name: string }\n` +
        `export function resolveUser(raw: User | null): User | null {\n` +
        `  if (!raw) return null;\n` +
        `  return raw;\n` +
        `}\n`,
      // Caller relies on the null-guard: it dereferences only when non-null is preserved.
      'src/greet.ts':
        `import { resolveUser } from './user.js';\n` +
        `export function greet(raw: import('./user.js').User | null): string {\n` +
        `  const u = resolveUser(raw);\n` +
        `  return u ? 'Hi ' + u.name : 'Hi guest';\n` +
        `}\n`,
    },
    changed: {
      // Removed the null guard AND changed the return type contract: now returns
      // raw.name access indirectly — dereferences null when raw is null.
      'src/user.ts':
        `export interface User { id: string; name: string }\n` +
        `export function resolveUser(raw: User | null): User {\n` +
        `  return { id: raw!.id, name: raw!.name };\n` +
        `}\n`,
    },
    summary: 'Removed the redundant null check in resolveUser and normalized the return.',
    commands: ['npx tsc --noEmit'],
    expectDefect: true,
    detectionKeywords: ['null', 'guard', 'removed', 'deref', 'crash', 'throw', 'regression', 'contract', 'non-null assertion', 'greet', 'caller'],
  },

  // ---- clean controls (must approve) ----
  {
    key: 'clean-extract-helper',
    category: 'clean',
    taskTitle: 'Extract a helper for the discount calculation',
    taskDescription:
      'Refactor applyDiscount() to extract the percentage math into a small pure helper. Behavior must not change.',
    committed: {
      'src/discount.ts':
        `export function applyDiscount(price: number, pct: number): number {\n` +
        `  return Math.round(price - price * (pct / 100));\n` +
        `}\n`,
    },
    changed: {
      // Behavior-preserving extraction.
      'src/discount.ts':
        `function discounted(price: number, pct: number): number {\n` +
        `  return price - price * (pct / 100);\n` +
        `}\n` +
        `export function applyDiscount(price: number, pct: number): number {\n` +
        `  return Math.round(discounted(price, pct));\n` +
        `}\n`,
    },
    summary: 'Extracted discounted() helper; applyDiscount rounds its result. No behavior change.',
    commands: ['npx tsc --noEmit'],
    expectDefect: false,
    detectionKeywords: [],
  },
  {
    key: 'clean-validated-feature',
    category: 'clean',
    taskTitle: 'Add clamp() utility with input validation',
    taskDescription:
      'Add a clamp(value, min, max) utility that constrains value to [min, max] and throws a clear error if min > max.',
    committed: {
      'src/math.ts':
        `export function sum(a: number, b: number): number {\n` +
        `  return a + b;\n` +
        `}\n`,
    },
    changed: {
      // Correct, defensive new function.
      'src/math.ts':
        `export function sum(a: number, b: number): number {\n` +
        `  return a + b;\n` +
        `}\n` +
        `export function clamp(value: number, min: number, max: number): number {\n` +
        `  if (min > max) throw new Error('clamp: min (' + min + ') > max (' + max + ')');\n` +
        `  return Math.min(Math.max(value, min), max);\n` +
        `}\n`,
    },
    summary: 'Added clamp() with a min>max guard that throws a descriptive error.',
    commands: ['npx tsc --noEmit'],
    expectDefect: false,
    detectionKeywords: [],
  },
  {
    // A rename is the change most likely to be wrongly flagged: the reviewer sees a
    // symbol disappear and has to check every call site before concluding anything.
    key: 'clean-rename-all-callers',
    category: 'clean',
    taskTitle: 'Rename fetchUser() to loadUser() across the module',
    taskDescription:
      'Rename fetchUser to loadUser. Every caller must be updated; no behavior change.',
    committed: {
      'src/user.ts':
        `export function fetchUser(id: string): string {\n` +
        `  return 'user:' + id;\n` +
        `}\n`,
      'src/profile.ts':
        `import { fetchUser } from './user.js';\n` +
        `export function profile(id: string): string {\n` +
        `  return fetchUser(id).toUpperCase();\n` +
        `}\n`,
    },
    changed: {
      'src/user.ts':
        `export function loadUser(id: string): string {\n` +
        `  return 'user:' + id;\n` +
        `}\n`,
      'src/profile.ts':
        `import { loadUser } from './user.js';\n` +
        `export function profile(id: string): string {\n` +
        `  return loadUser(id).toUpperCase();\n` +
        `}\n`,
    },
    summary: 'Renamed fetchUser to loadUser and updated the only caller in profile.ts.',
    commands: ['npx tsc --noEmit'],
    expectDefect: false,
    detectionKeywords: [],
  },
  {
    // Tests-only diffs invite "where is the implementation change?" objections even
    // though adding coverage for existing behavior is complete on its own.
    key: 'clean-tests-only',
    category: 'clean',
    taskTitle: 'Add test coverage for parsePort()',
    taskDescription:
      'parsePort() is untested. Add tests for the valid, out-of-range and non-numeric cases. Do not change the implementation.',
    committed: {
      'src/port.ts':
        `export function parsePort(raw: string): number | undefined {\n` +
        `  const n = Number(raw);\n` +
        `  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;\n` +
        `  return n;\n` +
        `}\n`,
    },
    changed: {
      'src/port.test.ts':
        `import { describe, it, expect } from 'vitest';\n` +
        `import { parsePort } from './port.js';\n` +
        `\n` +
        `describe('parsePort', () => {\n` +
        `  it('accepts a valid port', () => expect(parsePort('8080')).toBe(8080));\n` +
        `  it('rejects out-of-range', () => expect(parsePort('70000')).toBeUndefined());\n` +
        `  it('rejects non-numeric', () => expect(parsePort('http')).toBeUndefined());\n` +
        `});\n`,
    },
    summary: 'Added port.test.ts covering valid, out-of-range and non-numeric input. Implementation untouched.',
    commands: ['npx vitest run src/port.test.ts'],
    expectDefect: false,
    detectionKeywords: [],
  },
  {
    // Widening a type is safe for every existing caller, but reads as an API change.
    key: 'clean-widen-parameter-type',
    category: 'clean',
    taskTitle: 'Accept Iterable<string> in joinLines()',
    taskDescription:
      'joinLines() only takes string[]. Widen it to Iterable<string> so Sets and generators work. Existing callers must keep compiling.',
    committed: {
      'src/lines.ts':
        `export function joinLines(lines: string[]): string {\n` +
        `  return Array.from(lines).join('\\n');\n` +
        `}\n`,
    },
    changed: {
      'src/lines.ts':
        `export function joinLines(lines: Iterable<string>): string {\n` +
        `  return Array.from(lines).join('\\n');\n` +
        `}\n`,
    },
    summary: 'Widened joinLines to Iterable<string>. string[] satisfies Iterable<string>, so all callers still compile.',
    commands: ['npx tsc --noEmit'],
    expectDefect: false,
    detectionKeywords: [],
  },
];
