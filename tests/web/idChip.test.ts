// @vitest-environment jsdom
//
// Long ids are shown short with the full value behind Copy (redesign step 7).
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { idChip, repoName, shortId } from '../../web/static/js/idChip.mjs';

const UUID = 'bb4c009a-0e78-4547-a31c-045fe14e7e47';

describe('id chips', () => {
  it('shortens a long id and leaves a human label alone', () => {
    expect(shortId(UUID)).toBe('bb4c009a…');
    expect(shortId('AX-1801')).toBe('AX-1801');
  });

  it('names a repository by its last path segment, and shortens a cell key', () => {
    expect(repoName('/Users/me/dev/cgf-portal')).toBe('cgf-portal');
    expect(repoName('git:0123456789abcdef0123456789abcdef')).toBe('git:01234567…');
  });

  it('copies the full id and says so', async () => {
    const writeText = vi.fn(async () => {});
    const chip = idChip(document, UUID, { clipboard: { writeText } });
    expect(chip.querySelector('.id-chip-text')!.textContent).toBe('bb4c009a…');
    const copy = chip.querySelector('button')!;
    expect(copy.getAttribute('aria-label')).toBe(`Copy the full ID ${UUID}`);
    copy.click();
    await vi.waitFor(() => expect(copy.textContent).toBe('Copied'));
    expect(writeText).toHaveBeenCalledWith(UUID);
  });

  it('has no copy button when the id is already short', () => {
    expect(idChip(document, 'AX-1801').querySelector('button')).toBeNull();
  });

  it('reports a refused clipboard instead of claiming success', async () => {
    const chip = idChip(document, UUID, { clipboard: { writeText: async () => { throw new Error('denied'); } } });
    const copy = chip.querySelector('button')!;
    copy.click();
    await vi.waitFor(() => expect(copy.textContent).toBe('Copy failed'));
  });
});
