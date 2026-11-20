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
  const settle = () => new Promise((r) => setImmediate(r));

  it(`serves up to ${MAX_LINE_QUEUE} unasked lines in order`, async () => {
    const input = new PassThrough();
    const prompter = createPrompter(input, new PassThrough());
    for (let i = 0; i < MAX_LINE_QUEUE; i++) input.write(`line-${i}\n`);
    await settle();
    for (let i = 0; i < MAX_LINE_QUEUE; i++) expect(await prompter.ask('q')).toBe(`line-${i}`);
    prompter.close();
  });

  it('fails every question once more lines arrive than the bound, instead of shifting answers', async () => {
    const input = new PassThrough();
    const prompter = createPrompter(input, new PassThrough());
    for (let i = 0; i < MAX_LINE_QUEUE + 25; i++) input.write(`line-${i}\n`);
    await settle();
    await expect(prompter.ask('q')).rejects.toThrow(/more than 100 lines/);
    await expect(prompter.confirm('q')).rejects.toThrow(/more than 100 lines/);
  });

  it('does not count lines that answered a waiting question', async () => {
    const input = new PassThrough();
    const prompter = createPrompter(input, new PassThrough());
    for (let i = 0; i < MAX_LINE_QUEUE * 2; i++) {
      const answer = prompter.ask('q');
      input.write(`a-${i}\n`);
      expect(await answer).toBe(`a-${i}`);
    }
    prompter.close();
  });
});
