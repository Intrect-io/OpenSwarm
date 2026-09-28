import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { executeTool, ToolCall } from './tools.js';

/** Helper to build a ToolCall object */
function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: 'tc-1', function: { name, arguments: JSON.stringify(args) } };
}

const TMP_DIR = await fs.mkdtemp('/tmp/openswarm-readbound-test-');

beforeAll(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

/**
 * AGT-3486 — read_file must not materialize a whole file to serve a window.
 *
 * It was `fs.readFile` + `split('\n')` + `slice(offset, offset + limit)`: the
 * file became one string before the window picked its lines out. `limit` counts
 * lines and a line has no upper bound, so the pathological sizes here — a
 * sparse 512 MiB file, or a single 8 MiB line — were read in full and mostly
 * discarded, and whatever the window turned out to be went to the model as-is.
 *
 * The proof is a sparse file: `ftruncate` makes it 512 MiB to the filesystem
 * while occupying no blocks, and reading it costs memory whether or not the
 * bytes exist. Node cannot even build a >512 MiB string (`RangeError: Invalid
 * string length`), so the old path fails outright here rather than merely being
 * slow — and the assertion that matters is that a small window still works.
 */
describe('read_file bounds the read by bytes as well as lines (AGT-3486)', () => {
  const sparsePath = path.join(TMP_DIR, 'huge-sparse.txt');

  beforeAll(async () => {
    await fs.writeFile(sparsePath, 'first line\nsecond line\n');
    const handle = await fs.open(sparsePath, 'r+');
    await handle.truncate(512 * 1024 * 1024);
    await handle.close();
  });

  it('serves a small window from a 512 MiB file without reading it whole', async () => {
    const heapBefore = process.memoryUsage().heapUsed;
    const result = await executeTool(makeCall('read_file', { path: sparsePath, offset: 0, limit: 5 }), TMP_DIR);
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;

    expect(result.is_error).toBe(false);
    expect(result.content).toContain('1\tfirst line');
    expect(result.content).toContain('2\tsecond line');
    // The whole file cannot be materialized (Node caps a string below 512 MiB),
    // so a completed small-window read proves the read was bounded.
    expect(Buffer.byteLength(result.content)).toBeLessThan(512 * 1024);
    expect(heapGrowth).toBeLessThan(64 * 1024 * 1024);
  }, 60_000);

  it('caps the returned text when one line alone exceeds the byte ceiling', async () => {
    const linePath = path.join(TMP_DIR, 'one-huge-line.txt');
    await fs.writeFile(linePath, 'x'.repeat(8 * 1024 * 1024) + '\ntail\n');

    const result = await executeTool(makeCall('read_file', { path: linePath, offset: 0, limit: 1 }), TMP_DIR);

    expect(result.is_error).toBe(false);
    expect(Buffer.byteLength(result.content)).toBeLessThan(300 * 1024);
    // The ceiling, not `limit`, ended this read, and the model is told so.
    expect(result.content).toContain('read cap');
  }, 60_000);

  it('keeps the exact "(N more lines)" trailer for a file the scan covers', async () => {
    const smallPath = path.join(TMP_DIR, 'small.txt');
    await fs.writeFile(smallPath, Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n') + '\n');

    const result = await executeTool(makeCall('read_file', { path: smallPath, offset: 0, limit: 5 }), TMP_DIR);

    expect(result.content).toContain('5\tline5');
    expect(result.content).not.toContain('6\tline6');
    expect(result.content).toContain('(25 more lines)');
  });

  it('returns the whole file, trailer-free, when it fits the window', async () => {
    const tinyPath = path.join(TMP_DIR, 'tiny.txt');
    await fs.writeFile(tinyPath, 'a\nb\nc\n');

    const result = await executeTool(makeCall('read_file', { path: tinyPath }), TMP_DIR);

    expect(result.content).toBe('1\ta\n2\tb\n3\tc');
  });

  it('still returns the last line of a file that has no trailing newline', async () => {
    const noNewlinePath = path.join(TMP_DIR, 'no-trailing-newline.txt');
    await fs.writeFile(noNewlinePath, 'a\nb\nc');

    const whole = await executeTool(makeCall('read_file', { path: noNewlinePath }), TMP_DIR);
    expect(whole.content).toBe('1\ta\n2\tb\n3\tc');

    // ...and it counts as a line in the trailer too.
    const windowed = await executeTool(makeCall('read_file', { path: noNewlinePath, limit: 2 }), TMP_DIR);
    expect(windowed.content).toContain('2\tb');
    expect(windowed.content).toContain('(1 more lines)');

    // ...and as a line an offset can land on.
    const tail = await executeTool(makeCall('read_file', { path: noNewlinePath, offset: 2 }), TMP_DIR);
    expect(tail.content).toBe('3\tc');
  });

  it('decodes multi-byte text split across the chunk boundary', async () => {
    const utfPath = path.join(TMP_DIR, 'utf8.txt');
    // 64 KiB chunks: this line straddles one, so a decoder that dropped the
    // partial sequence would corrupt the text.
    const text = '한'.repeat(22_000) + '\nend\n';
    await fs.writeFile(utfPath, text);

    const result = await executeTool(makeCall('read_file', { path: utfPath, offset: 0, limit: 1 }), TMP_DIR);

    // The line itself must decode intact; the trailer after it is the window's
    // own "(1 more lines)" notice, not part of the line.
    expect(result.content.split('\n')[0]).toBe(`1\t${'한'.repeat(22_000)}`);
  });
});
