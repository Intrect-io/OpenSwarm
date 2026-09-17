// ============================================
// OpenSwarm - editParser coverage top-up
// Direct unit tests for the parsing/matching/apply paths that the existing
// editFormat.test.ts (adapters/) only exercises indirectly through the
// agentic loop's happy path. Covers: fenced-block filtering + malformed
// blocks, direct (non-fenced) SEARCH/REPLACE blocks, fuzzyMatch's
// whitespace-normalized and line-by-line fuzzy branches, and applyEditBlock's
// new-file + error paths.
// ============================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSearchReplaceBlocks, fuzzyMatch, applyEditBlock, type EditBlock } from './editParser.js';

describe('parseSearchReplaceBlocks — fenced code blocks', () => {
  it('skips a fenced block with no SEARCH/REPLACE markers but still parses a valid one', () => {
    const content = [
      '```ts',
      'just some code, not an edit block',
      '```',
      '',
      'src/utils/math.ts',
      '```ts',
      '<<<<<<< SEARCH',
      'function add(a, b) { return a + b; }',
      '=======',
      'function add(a, b) { return a + b + 0; }',
      '>>>>>>> REPLACE',
      '```',
    ].join('\n');

    const result = parseSearchReplaceBlocks(content);
    expect(result.success).toBe(true);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].filePath).toBe('src/utils/math.ts');
    expect(result.blocks[0].search).toBe('function add(a, b) { return a + b; }');
    expect(result.blocks[0].replace).toBe('function add(a, b) { return a + b + 0; }');
  });

  it('drops a fenced block missing the DIVIDER/REPLACE markers (malformed) and reports no blocks', () => {
    const content = ['Some notes about the fix:', '', '```', '<<<<<<< SEARCH', 'old code here', '```'].join('\n');

    const result = parseSearchReplaceBlocks(content);
    expect(result.success).toBe(false);
    expect(result.blocks).toEqual([]);
    // No thrown error here — parseBlock returns null for an incomplete marker
    // set rather than throwing, and the direct-block fallback also finds no
    // usable file path, so it produces no blocks either.
    expect(result.errors).toEqual([]);
  });

  it('records an error when a well-formed fenced block has no determinable file path', () => {
    const content = [
      'Here is a fix, no filename given anywhere nearby:',
      '```typescript',
      '<<<<<<< SEARCH',
      'const a = 1;',
      '=======',
      'const a = 2;',
      '>>>>>>> REPLACE',
      '```',
    ].join('\n');

    const result = parseSearchReplaceBlocks(content);
    expect(result.success).toBe(false);
    expect(result.blocks).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Could not determine file path');
  });
});

describe('parseSearchReplaceBlocks — direct (non-fenced) blocks', () => {
  it('parses a direct SEARCH/REPLACE block with no code fence', () => {
    const content = [
      'src/direct/example.ts',
      '<<<<<<< SEARCH',
      'const flag = false;',
      '=======',
      'const flag = true;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = parseSearchReplaceBlocks(content);
    expect(result.success).toBe(true);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toEqual({
      filePath: 'src/direct/example.ts',
      search: 'const flag = false;',
      replace: 'const flag = true;',
      isNewFile: false,
    });
  });

  it('marks a direct block as a new file when SEARCH is empty', () => {
    const content = [
      'src/direct/newfile.ts',
      '<<<<<<< SEARCH',
      '=======',
      'export const NEW = 1;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = parseSearchReplaceBlocks(content);
    expect(result.success).toBe(true);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].isNewFile).toBe(true);
    expect(result.blocks[0].replace).toBe('export const NEW = 1;');
  });
});

describe('fuzzyMatch', () => {
  it('matches after whitespace normalization when the exact text differs only in indentation', () => {
    const content = 'function add(a, b) {\n  return a + b;\n}\n';
    const search = 'function add(a, b) {\nreturn a + b;\n}\n';

    // Exact substring match must fail first so the normalized path is exercised.
    expect(content.includes(search)).toBe(false);

    const result = fuzzyMatch(content, search);
    expect(result.found).toBe(true);
    expect(result.similarity).toBe(0.95);
    expect(result.start).toBeLessThan(result.end);
    expect(content.slice(result.start, result.end)).toBe('function add(a, b) {\n  return a + b;\n}\n');
  });

  it('falls back to line-by-line fuzzy matching for a near-identical multi-line search', () => {
    const content = 'const a = 1;\nconst value = 10;\nconst c = 3;\n';
    // Line 1 has a single-character typo (O for 0); line 2 matches exactly.
    const search = 'const value = 1O;\nconst c = 3;';

    const result = fuzzyMatch(content, search);
    expect(result.found).toBe(true);
    expect(result.similarity).toBeGreaterThanOrEqual(0.8);
    expect(result.similarity).toBeLessThan(1);
    expect(content.slice(result.start, result.end)).toBe('const value = 10;\nconst c = 3;');
  });
});

describe('applyEditBlock', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'editparser-apply-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('creates a new file (with intermediate dirs) for an isNewFile block', async () => {
    const block: EditBlock = { filePath: 'new/dir/file.txt', search: '', replace: 'hello world', isNewFile: true };
    const result = await applyEditBlock(block, tmp);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    const written = await fs.readFile(path.join(tmp, 'new/dir/file.txt'), 'utf-8');
    // A created file ends with a newline; the block's lines never carry the final one (AGT-4406).
    expect(written).toBe('hello world\n');
  });

  it('returns a failure result with the underlying error when the target file cannot be read', async () => {
    const block: EditBlock = { filePath: 'does-not-exist.ts', search: 'x', replace: 'y', isNewFile: false };
    const result = await applyEditBlock(block, tmp);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('ENOENT');
  });
});
