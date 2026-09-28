import { describe, expect, it } from 'vitest';
import { parseNulDelimitedChurnOutput } from './gitInfo.js';

/**
 * Real `git log -z --format=%x1e%ct --name-only` output: commits are
 * NUL-separated, each commit's first filename is prefixed with the newline
 * that terminates the format, and there is NO empty token between commits.
 */
const RS = '\x1e';
const commit = (ts: number, files: string[]) => [`${RS}${ts}`, ...files.map((f) => `\n${f}`)].join('\0');

describe('parseNulDelimitedChurnOutput', () => {
  it('counts a numeric filename as a file, never as a commit boundary', () => {
    const churns = parseNulDelimitedChurnOutput(`${commit(1700000000, ['12345'])}\0`);
    expect([...churns.keys()]).toEqual(['12345']);
    expect(churns.get('12345')).toEqual({
      path: '12345',
      commitCount: 1,
      lastCommitDate: 1700000000 * 1000,
    });
  });

  it('attributes a multi-file commit to its own timestamp', () => {
    const churns = parseNulDelimitedChurnOutput(`${commit(1700000000, ['src/a.ts', 'src/b.ts'])}\0`);
    expect(churns.size).toBe(2);
    expect(churns.get('src/a.ts')?.lastCommitDate).toBe(1700000000 * 1000);
    expect(churns.get('src/b.ts')?.lastCommitDate).toBe(1700000000 * 1000);
  });

  it('keeps each commit separate — a later timestamp is not read as a filename', () => {
    // Regression: a state machine that expects an empty token between commits
    // treats 1700001000 as a path, inventing a file and dropping src/c.ts.
    const churns = parseNulDelimitedChurnOutput([
      commit(1700000000, ['src/a.ts']),
      commit(1700001000, ['src/a.ts', 'src/c.ts']),
      '',
    ].join('\0'));

    expect([...churns.keys()].sort()).toEqual(['src/a.ts', 'src/c.ts']);
    expect(churns.get('src/a.ts')).toEqual({
      path: 'src/a.ts',
      commitCount: 2,
      lastCommitDate: 1700001000 * 1000,
    });
    expect(churns.get('src/c.ts')?.commitCount).toBe(1);
  });

  it('ignores git output with no churn (empty and whitespace-only)', () => {
    expect(parseNulDelimitedChurnOutput('').size).toBe(0);
    expect(parseNulDelimitedChurnOutput('\0\0').size).toBe(0);
  });
});
