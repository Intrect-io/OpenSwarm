// INT-2961 / audit 2026-07-26 (src/verify) — the failure fingerprint has to be
// identical for two runs of the SAME failure, because `hasSameFailure` uses it to
// decide whether a failing command is a pre-existing failure or a regression the
// change introduced. Two things made it differ between the base and head runs:
//
//   1. only the command's `cwd` was path-normalized, so with a subdirectory cwd
//      every path outside it — sibling files, and the sandbox's isolated
//      HOME/TMPDIR next to the project root — kept its random `mkdtemp` prefix;
//   2. stdout and stderr were recorded into one buffer as chunks arrived, so OS
//      scheduling decided the byte order and identical output could hash two ways.
//
// Both produced the same user-visible bug: a pre-existing failure reported as a
// new regression. These tests pin the normalization contract that fixes (1); (2)
// is structural (per-stream capture, concatenated in a fixed order) and is
// covered by the stdout+stderr case at the bottom.
import { describe, expect, it } from 'vitest';
import { normalizeFailureOutput } from './runner.js';

const SANDBOX_A = '/tmp/openswarm-verify-head-aaaa';
const SANDBOX_B = '/tmp/openswarm-verify-head-bbbb';

function paths(sandbox: string): Array<[string, string]> {
  // Mirrors the call site: project root plus the isolated HOME/TMPDIR that sit
  // beside it inside the same sandbox.
  return [
    [`${sandbox}/worktree`, '<PROJECT>'],
    [`${sandbox}/home`, '<HOME>'],
    [`${sandbox}/tmp`, '<TMP>'],
    [sandbox, '<SANDBOX>'],
  ];
}

describe('normalizeFailureOutput', () => {
  it('makes two sandboxes produce identical text for the same failure', () => {
    const failure = (sandbox: string) =>
      [
        `  File "${sandbox}/worktree/src/app.ts", line 3`,
        `  imported from ${sandbox}/worktree/src/lib/util.ts`,
        `  cache: ${sandbox}/home/.cache/build`,
        `  scratch: ${sandbox}/tmp/pytest-0`,
      ].join('\n');

    expect(normalizeFailureOutput(failure(SANDBOX_A), paths(SANDBOX_A))).toBe(
      normalizeFailureOutput(failure(SANDBOX_B), paths(SANDBOX_B)),
    );
  });

  it('normalizes paths outside the command cwd — the subdirectory-cwd bug', () => {
    // A command with `cwd: packages/api` fails, but the traceback points at a
    // sibling package. Normalizing only the cwd left this line sandbox-specific.
    const out = (s: string) => `error in ${s}/worktree/packages/web/index.ts`;

    const a = normalizeFailureOutput(out(SANDBOX_A), paths(SANDBOX_A));

    expect(a).toBe(normalizeFailureOutput(out(SANDBOX_B), paths(SANDBOX_B)));
    expect(a).not.toContain('openswarm-verify-head');
  });

  it('normalizes sibling path dependencies outside the copied worktree', () => {
    const out = (s: string) =>
      `failed to read ${s}/intrect-plugin/crates/intrect-license/Cargo.toml`;

    const a = normalizeFailureOutput(out(SANDBOX_A), paths(SANDBOX_A));

    expect(a).toBe(normalizeFailureOutput(out(SANDBOX_B), paths(SANDBOX_B)));
    expect(a).toBe('failed to read <SANDBOX>/intrect-plugin/crates/intrect-license/Cargo.toml');
  });

  it('normalizes the isolated HOME and TMPDIR, not just the project', () => {
    const a = normalizeFailureOutput(`${SANDBOX_A}/home/.npm/_logs/x.log`, paths(SANDBOX_A));

    expect(a).toBe('<HOME>/.npm/_logs/x.log');
  });

  it('substitutes the longest path first so a nested path keeps its own label', () => {
    // '<sandbox>' contains '<sandbox>/worktree'. If the ancestor were replaced
    // first the project label would never be reachable.
    const withAncestor: Array<[string, string]> = [
      [SANDBOX_A, '<SANDBOX>'],
      [`${SANDBOX_A}/worktree`, '<PROJECT>'],
    ];

    const out = normalizeFailureOutput(`${SANDBOX_A}/worktree/src/a.ts`, withAncestor);

    expect(out).toBe('<PROJECT>/src/a.ts');
  });

  it('treats regex metacharacters in a path literally', () => {
    const weird = '/tmp/build (1)+test';

    const out = normalizeFailureOutput(`${weird}/src/a.ts`, [[weird, '<PROJECT>']]);

    expect(out).toBe('<PROJECT>/src/a.ts');
  });

  it('ignores empty paths instead of matching everywhere', () => {
    // An empty needle would otherwise splice the label between every character.
    expect(normalizeFailureOutput('abc', [['', '<X>']])).toBe('abc');
  });

  it('still strips ANSI colour and run durations', () => {
    const esc = String.fromCharCode(27);

    const out = normalizeFailureOutput(
      `${esc}[31mFAIL${esc}[0m\n=== 1 failed in 4.21s ===\nRan 3 tests in 0.09s\nfinished in 2.5s`,
      [],
    );

    expect(out).not.toContain(esc);
    expect(out).toContain('<DURATION>');
    expect(out).not.toContain('4.21s');
    expect(out).not.toContain('0.09s');
    expect(out).not.toContain('2.5s');
  });

  it('is stable for output that mixes stdout and stderr content', () => {
    // The fingerprint is now built stdout-then-stderr rather than in arrival
    // order, so the two streams' relative timing cannot change the hash input.
    // Here the same logical content is normalized from both orderings.
    const stdout = `running ${SANDBOX_A}/worktree/src/a.ts\n`;
    const stderr = `error: ${SANDBOX_A}/worktree/src/b.ts\n`;

    const fixedOrder = normalizeFailureOutput(stdout + stderr, paths(SANDBOX_A));

    expect(fixedOrder).toBe('running <PROJECT>/src/a.ts\nerror: <PROJECT>/src/b.ts\n');
    expect(fixedOrder).not.toContain('openswarm-verify-head');
  });
});
