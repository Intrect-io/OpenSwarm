import { describe, it, expect } from 'vitest';
import {
  truncate,
  truncateWithSuffix,
  capArray,
  boundedFieldValue,
  boundedMessageContent,
  flattenToSingleLine,
  sanitizeException,
  genericUserError,
  paginateEmbedFields,
  DISCORD_EMBED_FIELD_VALUE_LIMIT,
  DISCORD_MESSAGE_CONTENT_LIMIT,
  DISCORD_EMBED_AGGREGATE_VALUE_LIMIT,
  LINEAR_DESCRIPTION_LIMIT,
  boundedLinearText,
} from './outputBudget.js';

describe('outputBudget', () => {
  it('truncates with ellipsis without exceeding the limit', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('truncateWithSuffix keeps the final length at the limit', () => {
    const out = truncateWithSuffix('x'.repeat(100), 40);
    expect(out.length).toBe(40);
    expect(out.endsWith('(truncated)')).toBe(true);
  });

  it('truncateWithSuffix falls back when suffix is longer than the limit', () => {
    const out = truncateWithSuffix('abcdefghij', 4, '… (truncated)');
    expect(out.length).toBe(4);
    expect(out).toBe('abc…');
  });

  it('caps arrays and reports omitted count', () => {
    expect(capArray([1, 2, 3, 4], 2)).toEqual({ shown: [1, 2], omitted: 2 });
    expect(capArray([1], 5)).toEqual({ shown: [1], omitted: 0 });
  });

  it('bounds Discord field values to the per-field limit', () => {
    const value = boundedFieldValue('y'.repeat(DISCORD_EMBED_FIELD_VALUE_LIMIT + 500));
    expect(value.length).toBeLessThanOrEqual(DISCORD_EMBED_FIELD_VALUE_LIMIT);
  });

  it('bounds Discord message content', () => {
    const value = boundedMessageContent('z'.repeat(DISCORD_MESSAGE_CONTENT_LIMIT + 200));
    expect(value.length).toBeLessThanOrEqual(DISCORD_MESSAGE_CONTENT_LIMIT);
  });

  it('flattens multiline text to a single line', () => {
    expect(flattenToSingleLine('a\nb\r\nc')).toBe('a b c');
  });

  it('sanitizes exceptions to a single bounded line', () => {
    const err = new Error('boom\n    at foo.ts:1\n    at bar.ts:2');
    expect(sanitizeException(err)).toBe('boom');
    expect(sanitizeException(err).length).toBeLessThanOrEqual(200);
  });

  it('generic user errors never include raw exception text', () => {
    const msg = genericUserError(new Error('secret stack /tmp/evil.key'));
    expect(msg).not.toContain('secret');
    expect(msg).not.toContain('evil');
    expect(msg.length).toBeLessThan(80);
  });

  it('paginates embed fields by aggregate budget', () => {
    const fields = Array.from({ length: 20 }, (_, i) => ({
      name: `\u200b`,
      value: 'v'.repeat(800),
      inline: false,
    }));
    const pages = paginateEmbedFields(fields);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      const aggregate = page.reduce((sum, f) => sum + f.value.length, 0);
      expect(aggregate).toBeLessThanOrEqual(DISCORD_EMBED_AGGREGATE_VALUE_LIMIT);
      expect(page.length).toBeLessThanOrEqual(25);
      for (const f of page) {
        expect(f.value.length).toBeLessThanOrEqual(DISCORD_EMBED_FIELD_VALUE_LIMIT);
      }
    }
  });

  it('bounds Linear description payloads', () => {
    const out = boundedLinearText('L'.repeat(LINEAR_DESCRIPTION_LIMIT + 100));
    expect(out.length).toBeLessThanOrEqual(LINEAR_DESCRIPTION_LIMIT);
  });
});
