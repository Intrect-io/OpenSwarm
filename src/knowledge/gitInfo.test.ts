import { describe, expect, it } from 'vitest';
import { parseNulDelimitedChurnOutput } from './gitInfo.js';

describe('parseNulDelimitedChurnOutput', () => {
  it('counts numeric filename 12345 as a file under a timestamp, not a new timestamp', () => {
    // timestamp\0\n12345\0  — "12345" must be a path, never a commit boundary
    const output = `1700000000\0\n12345\0`;
    const churns = parseNulDelimitedChurnOutput(output);
    expect(churns.size).toBe(1);
    expect(churns.get('12345')).toEqual({
      path: '12345',
      commitCount: 1,
      lastCommitDate: 1700000000 * 1000,
    });
  });

  it('handles multi-file commits', () => {
    const output = `1700000000\0\nsrc/a.ts\0\nsrc/b.ts\0`;
    const churns = parseNulDelimitedChurnOutput(output);
    expect(churns.size).toBe(2);
    expect(churns.get('src/a.ts')?.commitCount).toBe(1);
    expect(churns.get('src/b.ts')?.commitCount).toBe(1);
    expect(churns.get('src/a.ts')?.lastCommitDate).toBe(1700000000 * 1000);
  });

  it('treats empty tokens as commit boundaries', () => {
    // Two commits separated by an empty NUL record; second commit re-touches a.ts.
    // Build with an explicit empty segment — JS `\017` would be an octal escape.
    const nul = '\0';
    const output = ['1700000000', '\nsrc/a.ts', '', '1700001000', '\nsrc/a.ts', '\nsrc/c.ts', ''].join(nul);
    const churns = parseNulDelimitedChurnOutput(output);
    expect(churns.get('src/a.ts')).toEqual({
      path: 'src/a.ts',
      commitCount: 2,
      lastCommitDate: 1700001000 * 1000,
    });
    expect(churns.get('src/c.ts')?.commitCount).toBe(1);
  });
});
