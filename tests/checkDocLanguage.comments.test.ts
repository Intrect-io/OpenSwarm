// Covers the --comments mode of scripts/check-doc-language.mjs: Hangul is
// flagged only inside comments of source files, never in strings or regexes.
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations
import { commentRanges, findHangulCommentLines } from '../scripts/docLanguageComments.mjs';

const allowlist = [{ file: 'src/a.ts', fragment: '"블로커:"', reason: 'program input' }];

describe('check-doc-language --comments', () => {
  it('flags a Korean line comment in a source file', () => {
    const hits = findHangulCommentLines('src/a.ts', 'const x = 1;\n// 이 값은 상수다\n', []);
    expect(hits).toEqual([{ line: 2, text: '// 이 값은 상수다' }]);
  });

  it('flags every Korean line of a block comment with its own line number', () => {
    const text = '/**\n * English line\n * 한국어 설명\n */\nexport const y = 2;\n';
    expect(findHangulCommentLines('src/a.ts', text, [])).toEqual([{ line: 3, text: '* 한국어 설명' }]);
  });

  it('flags a trailing comment after code', () => {
    expect(findHangulCommentLines('src/a.ts', 'const z = 3; // 임시값\n', [])).toHaveLength(1);
  });

  it('ignores Hangul in strings, template literals and regexes', () => {
    const text = [
      "const prompt = '한국어 프롬프트 // 주석 아님';",
      'const tpl = `결과: ${prompt} /* 이것도 문자열 */`;',
      'const re = /블로커:\\s*(\\S+)/;',
      '// English comment',
    ].join('\n');
    expect(findHangulCommentLines('src/a.ts', text, [])).toEqual([]);
  });

  it('passes an allowlisted quoted fragment and still flags new prose beside it', () => {
    expect(findHangulCommentLines('src/a.ts', '// parses the "블로커:" prefix\n', allowlist)).toEqual([]);
    expect(findHangulCommentLines('src/a.ts', '// parses the "블로커:" 접두어\n', allowlist)).toHaveLength(1);
  });

  it('reads TSX and comments at the end of a file', () => {
    expect(findHangulCommentLines('src/c.tsx', 'export const C = () => <div>안녕</div>;\n// 끝\n', [])).toEqual([{ line: 2, text: '// 끝' }]);
    expect(commentRanges('src/b.ts', 'export {};\n/* tail */').map((r: { text: string }) => r.text)).toEqual(['/* tail */']);
  });
});
