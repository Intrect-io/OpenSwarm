import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createPrompter, MAX_LINE_QUEUE, resolveChoice, resolveConfirm, type ChoiceOption } from './promptHelper.js';

const opts: ChoiceOption<string>[] = [
  { label: 'local', value: 'L' },
  { label: 'linear', value: 'N' },
];

describe('resolveChoice', () => {
  it('matches a 1-based index', () => {
    expect(resolveChoice('1', opts)?.value).toBe('L');
    expect(resolveChoice('2', opts)?.value).toBe('N');
  });
  it('matches an exact label case-insensitively', () => {
    expect(resolveChoice('LINEAR', opts)?.value).toBe('N');
    expect(resolveChoice(' local ', opts)?.value).toBe('L');
  });
  it('returns null for out-of-range index, unknown label, or blank', () => {
    expect(resolveChoice('0', opts)).toBeNull();
    expect(resolveChoice('3', opts)).toBeNull();
    expect(resolveChoice('nope', opts)).toBeNull();
    expect(resolveChoice('', opts)).toBeNull();
  });
});

describe('resolveConfirm', () => {
  it('takes the default on blank', () => {
    expect(resolveConfirm('', true)).toBe(true);
    expect(resolveConfirm('  ', false)).toBe(false);
  });
  it('parses yes/no variants', () => {
    for (const y of ['y', 'Y', 'yes', 'true']) expect(resolveConfirm(y, false)).toBe(true);
    for (const n of ['n', 'N', 'no', 'false']) expect(resolveConfirm(n, true)).toBe(false);
  });
  it('falls back to default on unrecognized input', () => {
    expect(resolveConfirm('maybe', true)).toBe(true);
    expect(resolveConfirm('maybe', false)).toBe(false);
  });
});

describe('createPrompter stdin queue bound', () => {
  it(`retains at most ${MAX_LINE_QUEUE} queued lines and drops the oldest`, async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompter = createPrompter(input, output);

    const total = MAX_LINE_QUEUE + 25;
    for (let i = 0; i < total; i++) {
      input.write(`line-${i}\n`);
    }

    // Let readline drain line events into the bounded queue before asking.
    await new Promise((r) => setImmediate(r));

    const first = await prompter.ask('q');
    // Oldest 25 were shifted out; first retained is line-25.
    expect(first).toBe('line-25');

    for (let i = 26; i < total; i++) {
      expect(await prompter.ask('q')).toBe(`line-${i}`);
    }

    prompter.close();
    input.end();
  });
});
