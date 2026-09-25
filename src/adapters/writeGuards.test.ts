import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { preserveTrailingNewline, pythonSyntaxError, wholeFileRewriteVerdict } from './writeGuards.js';
import { executeTool } from './tools.js';
import { applyEditBlock } from '../support/editParser.js';

const makeCall = (name: string, args: Record<string, unknown>) => ({
  id: 'call-1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) },
});
const lines = (n: number, prefix = 'field') => Array.from({ length: n }, (_, i) => `${prefix}_${i} = ${i}`).join('\n') + '\n';

describe('write guards (AGT-4406)', () => {
  it('preserves a trailing newline only when the original had one', () => {
    expect(preserveTrailingNewline('a\n', 'b')).toBe('b\n');
    expect(preserveTrailingNewline('a\n', 'b\n')).toBe('b\n');
    expect(preserveTrailingNewline('a', 'b')).toBe('b');
    expect(preserveTrailingNewline('', 'b')).toBe('b');
  });

  it('refuses a write that drops more than 30% of a 20+ line file, allows targeted rewrites and small files', () => {
    expect(wholeFileRewriteVerdict(lines(95), lines(68, 'other'))).toMatch(/REFUSED.*drop 95 of 95/);
    expect(wholeFileRewriteVerdict(lines(95), lines(95).replace('field_9 = 9', 'field_9 = 90'))).toBeNull();
    expect(wholeFileRewriteVerdict(lines(10), lines(3, 'other'))).toBeNull();
    // Reordering is not deletion.
    expect(wholeFileRewriteVerdict(lines(30), lines(30).split('\n').reverse().join('\n'))).toBeNull();
  });

  it('reports a Python syntax error and stays quiet for parsing code and non-Python files', async () => {
    expect(await pythonSyntaxError('x.py', 'def f(:\n  pass\n')).toMatch(/SyntaxError at line 1/);
    expect(await pythonSyntaxError('x.py', 'def f():\n    return 1\n')).toBeNull();
    expect(await pythonSyntaxError('x.ts', 'def f(:')).toBeNull();
  });
});

describe('write_file / edit_file / SEARCH-REPLACE with the guards', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'openswarm-writeguard-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('write_file refuses the #501-shaped rewrite and leaves the file untouched', async () => {
    const file = path.join(tmp, 'config.py');
    await fs.writeFile(file, lines(95));
    const result = await executeTool(makeCall('write_file', { path: file, content: lines(68, 'other') }), tmp);
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/REFUSED.*targeted edits/);
    expect(await fs.readFile(file, 'utf8')).toBe(lines(95));
  });

  it('write_file keeps the trailing newline and refuses Python that does not parse', async () => {
    const file = path.join(tmp, 'small.py');
    await fs.writeFile(file, 'x = 1\n');
    const ok = await executeTool(makeCall('write_file', { path: file, content: 'x = 2' }), tmp);
    expect(ok.is_error).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe('x = 2\n');

    const bad = await executeTool(makeCall('write_file', { path: file, content: 'x = (\n' }), tmp);
    expect(bad.is_error).toBe(true);
    expect(bad.content).toMatch(/would not parse/);
    expect(await fs.readFile(file, 'utf8')).toBe('x = 2\n');
  });

  it('edit_file applies but warns when the file no longer parses', async () => {
    const file = path.join(tmp, 'm.py');
    await fs.writeFile(file, 'def f():\n    return 1\n');
    const result = await executeTool(makeCall('edit_file', { path: file, old_string: 'return 1', new_string: 'return (' }), tmp);
    expect(result.is_error).toBe(false);
    expect(result.content).toMatch(/no longer parses/);
    expect(await fs.readFile(file, 'utf8')).toBe('def f():\n    return (\n');
  });

  it('an empty SEARCH cannot replace an existing file, and a created file ends with a newline', async () => {
    await fs.writeFile(path.join(tmp, 'exists.py'), lines(30));
    const refused = await applyEditBlock({ filePath: 'exists.py', search: '', replace: 'x = 1', isNewFile: true }, tmp);
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/already exists/);
    expect(await fs.readFile(path.join(tmp, 'exists.py'), 'utf8')).toBe(lines(30));

    const created = await applyEditBlock({ filePath: 'new/mod.py', search: '', replace: 'x = 1', isNewFile: true }, tmp);
    expect(created.success).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'new/mod.py'), 'utf8')).toBe('x = 1\n');
  });
});
