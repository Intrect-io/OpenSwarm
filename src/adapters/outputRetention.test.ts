import { describe, expect, it } from 'vitest';
import { BoundedOutput } from './outputRetention.js';
import { extractStreamJsonError } from './base.js';

describe('BoundedOutput (AGT-3423)', () => {
  it('keeps everything under the cap', () => {
    const out = new BoundedOutput(100);
    out.append('a\n');
    out.append('b\n');
    expect(out.toString()).toBe('a\nb\n');
    expect(out.droppedChars).toBe(0);
  });

  it('never retains more than the cap plus the marker, however much is streamed', () => {
    const out = new BoundedOutput(1_000);
    for (let i = 0; i < 10_000; i++) out.append(`{"type":"assistant","n":${i}}\n`);
    const text = out.toString();
    const body = text.slice(text.indexOf('\n') + 1);
    expect(body.length).toBeLessThanOrEqual(1_000);
    expect(out.droppedChars).toBeGreaterThan(0);
    expect(text.startsWith('[openswarm: ')).toBe(true);
    // the newest line survives and the body starts on a whole line
    expect(body.trimEnd().endsWith('"n":9999}')).toBe(true);
    expect(body.startsWith('{"type":"assistant"')).toBe(true);
  });

  it('keeps the final stream-json result parseable after truncation', () => {
    const out = new BoundedOutput(4_096);
    for (let i = 0; i < 5_000; i++) out.append(`{"type":"assistant","message":"chunk ${i}"}\n`);
    out.append('{"type":"result","is_error":true,"result":"model quota exhausted"}\n');
    expect(extractStreamJsonError(out.toString())).toContain('model quota exhausted');
  });

  it('still bounds a single huge line with no newline', () => {
    const out = new BoundedOutput(1_000);
    out.append('x'.repeat(50_000));
    expect(out.toString().length).toBeLessThan(1_100);
  });

  it('rejects an invalid cap', () => {
    expect(() => new BoundedOutput(0)).toThrow();
    expect(() => new BoundedOutput(Number.NaN)).toThrow();
  });
});
