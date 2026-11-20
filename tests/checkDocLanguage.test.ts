// Covers scripts/check-doc-language.mjs, the CI gate that keeps tracked
// Markdown in English with Hangul only in allowlisted quoted program I/O.
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations
import { findHangulLines, findStaleEntries } from '../scripts/check-doc-language.mjs';

const allowlist = [{ file: 'doc.md', fragment: '`결정`', reason: 'program input' }];

describe('check-doc-language', () => {
  it('flags a Korean prose line in a tracked document', () => {
    const hits = findHangulLines('doc.md', '# Title\n\n이 문서는 한국어다.\n', allowlist);
    expect(hits).toEqual([{ line: 3, text: '이 문서는 한국어다.' }]);
  });

  it('passes an allowlisted quoted fragment', () => {
    expect(findHangulLines('doc.md', 'Add `결정` to skip.titleTags.', allowlist)).toEqual([]);
  });

  it('still flags new Korean prose on a line that holds an allowlisted fragment', () => {
    expect(findHangulLines('doc.md', 'Add `결정` 태그를 추가한다.', allowlist)).toHaveLength(1);
  });

  it('does not apply one file\'s allowance to another file', () => {
    expect(findHangulLines('other.md', 'Add `결정` here.', allowlist)).toHaveLength(1);
  });

  it('reports an allowlist entry whose fragment left its file', () => {
    expect(findStaleEntries(() => 'translated now', allowlist)).toHaveLength(1);
    expect(findStaleEntries(() => null, allowlist)).toHaveLength(1);
    expect(findStaleEntries(() => 'Add `결정`.', allowlist)).toEqual([]);
  });
});
