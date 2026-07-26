// ============================================
// OpenSwarm - session filename uniqueness tests
// ============================================
//
// Session records are written to `<DD-HHMM>-<title-slug>-<suffix>.md`. The
// suffix is the only part that separates two sessions started in the same
// minute with the same title, and it used to be the first 12 characters of
// `session-<ms>` — which is `session-` plus four digits of the timestamp. Those
// four digits stay the same for 10^9 ms (~11.6 days), so the suffix was
// effectively a constant and same-minute sessions silently overwrote each
// other.

import { describe, expect, it } from 'vitest';
import { sessionFilenameSuffix } from './codex.js';

/** What the old implementation produced, kept here to pin what changed. */
const legacySuffix = (id: string) =>
  id.toLowerCase().replace(/[^\w\s가-힣-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 50).slice(0, 12);

const AT = 1_785_050_644_884; // an ordinary ms timestamp

describe('sessionFilenameSuffix', () => {
  it('differs for two sessions started a millisecond apart', () => {
    expect(sessionFilenameSuffix(`session-${AT}`)).not.toBe(sessionFilenameSuffix(`session-${AT + 1}`));
  });

  // The exact scenario that lost data: same title, same minute, distinct
  // sessions. Anything inside one minute has to stay distinguishable.
  it.each([1, 100, 1_000, 30_000, 59_999])('differs for ids %i ms apart', (deltaMs) => {
    expect(sessionFilenameSuffix(`session-${AT}`)).not.toBe(sessionFilenameSuffix(`session-${AT + deltaMs}`));
  });

  // Demonstrates the defect rather than asserting the fix, so the reason for
  // the change stays legible. The window is 10^9 ms (~11.6 days), but where it
  // starts depends on the timestamp: from AT the four leading digits hold for
  // ~10.99 more days, so a week is comfortably inside it and the assertion does
  // not sit on the boundary.
  it('replaces a suffix that was constant for more than a week', () => {
    const aWeek = 7 * 24 * 60 * 60 * 1000;
    expect(legacySuffix(`session-${AT}`)).toBe(legacySuffix(`session-${AT + aWeek}`));
    expect(sessionFilenameSuffix(`session-${AT}`)).not.toBe(sessionFilenameSuffix(`session-${AT + aWeek}`));
  });

  // Ids are not guaranteed to vary at the front — a hash does not care where
  // the differing part is, which a leading slice did.
  it('discriminates ids that share a long prefix', () => {
    expect(sessionFilenameSuffix('a'.repeat(64) + '1')).not.toBe(sessionFilenameSuffix('a'.repeat(64) + '2'));
  });

  it('discriminates ids that share a long suffix', () => {
    expect(sessionFilenameSuffix('1' + 'z'.repeat(64))).not.toBe(sessionFilenameSuffix('2' + 'z'.repeat(64)));
  });

  it('is stable for the same id', () => {
    expect(sessionFilenameSuffix(`session-${AT}`)).toBe(sessionFilenameSuffix(`session-${AT}`));
  });

  it('is filename-safe and fixed length', () => {
    for (const id of [`session-${AT}`, 'with spaces and/slashes', '한글 제목', '']) {
      const suffix = sessionFilenameSuffix(id);
      expect(suffix).toMatch(/^[0-9a-f]{12}$/);
    }
  });
});
