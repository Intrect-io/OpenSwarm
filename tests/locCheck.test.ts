// Covers scripts/loc-check.mjs, the 1500 code-LOC hard limit run by CI's
// loc-gate job and by the versioned pre-commit hook.
import { describe, expect, it } from 'vitest';
import {
  countCodeLines,
  evaluate,
  isInScope,
  parseAllowlist,
  parseArgs,
  // @ts-expect-error -- plain ESM script without type declarations
} from '../scripts/loc-check.mjs';

const code = (n: number) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join('\n');
const entry = (path: string, expires: string) => ({ path, expires, reason: 'split tracked by AGT-4513' });

describe('loc-check', () => {
  it('fails a new file over the threshold', () => {
    const result = evaluate({ files: [{ path: 'src/big.ts', loc: 11 }], allowlist: [], today: '2026-11-21', limit: 10 });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([expect.objectContaining({ path: 'src/big.ts', kind: 'over-limit', loc: 11 })]);
  });

  it('passes a file at the threshold', () => {
    expect(evaluate({ files: [{ path: 'src/a.ts', loc: 10 }], allowlist: [], today: '2026-11-21', limit: 10 }).ok).toBe(true);
  });

  it('passes an allowlisted file before expiry', () => {
    const result = evaluate({
      files: [{ path: 'src/big.ts', loc: 50 }],
      allowlist: [entry('src/big.ts', '2027-03-31')],
      today: '2027-03-31',
      limit: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.allowed).toEqual([{ path: 'src/big.ts', loc: 50, expires: '2027-03-31' }]);
  });

  it('fails an allowlisted file after its expiry', () => {
    const result = evaluate({
      files: [{ path: 'src/big.ts', loc: 50 }],
      allowlist: [entry('src/big.ts', '2027-03-31')],
      today: '2027-04-01',
      limit: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([expect.objectContaining({ path: 'src/big.ts', kind: 'expired' })]);
    expect(result.failures[0].message).toContain('expired on 2027-03-31');
  });

  it('fails a stale entry for a file back within the limit or gone', () => {
    const shrunk = evaluate({
      files: [{ path: 'src/big.ts', loc: 9 }],
      allowlist: [entry('src/big.ts', '2027-03-31')],
      today: '2026-11-21',
      limit: 10,
    });
    expect(shrunk.failures).toEqual([expect.objectContaining({ path: 'src/big.ts', kind: 'stale' })]);

    const gone = evaluate({ files: [], allowlist: [entry('src/gone.ts', '2027-03-31')], today: '2026-11-21', limit: 10 });
    expect(gone.failures).toEqual([expect.objectContaining({ path: 'src/gone.ts', kind: 'stale' })]);
  });

  it('judges only the listed files in partial (--files) mode', () => {
    const result = evaluate({
      files: [{ path: 'src/small.ts', loc: 3 }],
      allowlist: [entry('src/other.ts', '2027-03-31')],
      today: '2026-11-21',
      limit: 10,
      partial: true,
    });
    expect(result.ok).toBe(true);
  });

  it('does not count comment and blank lines', () => {
    const text = [
      '#!/usr/bin/env node',
      '// line comment',
      '',
      '   ',
      '/**',
      ' * JSDoc block',
      ' */',
      'const a = 1; // trailing comment still counts as code',
      '/* one-line block */',
      '/* block */ const b = 2;',
      '/* multi',
      '   line */ const c = 3;',
      '  // indented comment',
    ].join('\n');
    expect(countCodeLines(text)).toBe(4);
  });

  it('does not treat a glob string containing /* and */ as a block comment', () => {
    const text = [
      "const include = ['src/**/*.test.ts'];",
      'const x = 1;',
      'const y = 2;',
      "const z = 'a /* b';",
      'const w = 3;',
    ].join('\n');
    expect(countCodeLines(text)).toBe(5);
    expect(countCodeLines(code(1500))).toBe(1500);
  });

  it('scopes tracked source files and excludes tests and fixtures', () => {
    expect(isInScope('src/automation/autonomousRunner.ts')).toBe(true);
    expect(isInScope('web/static/js/app.js')).toBe(true);
    expect(isInScope('scripts/loc-check.mjs')).toBe(true);
    expect(isInScope('src/tui/App.tsx')).toBe(true);
    expect(isInScope('src/core/config.test.ts')).toBe(false);
    expect(isInScope('src/fixtures/sample.ts')).toBe(false);
    expect(isInScope('tests/locCheck.test.ts')).toBe(false);
    expect(isInScope('src/data.json')).toBe(false);
    expect(isInScope('README.md')).toBe(false);
  });

  it('parses the allowlist and reports malformed or duplicate entries', () => {
    const { entries, errors } = parseAllowlist(
      [
        '# comment',
        '',
        'src/a.ts 2027-03-31 AGT-4867 split  # trailing comment',
        'src/b.ts tomorrow reason',
        'src/c.ts 2027-03-31',
        'src/a.ts 2027-03-31 again',
      ].join('\n'),
    );
    expect(entries).toEqual([{ path: 'src/a.ts', expires: '2027-03-31', reason: 'AGT-4867 split', line: 3 }]);
    expect(errors).toHaveLength(3);
  });

  it('parses --files lists and flags', () => {
    expect(parseArgs(['--staged', '--files', 'a.ts', 'b.mjs', '--json'])).toMatchObject({
      files: ['a.ts', 'b.mjs'],
      staged: true,
      json: true,
    });
    expect(parseArgs(['--files']).files).toEqual([]);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});
