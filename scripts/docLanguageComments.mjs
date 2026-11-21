// Comment scan for `check-doc-language.mjs --comments`.
//
// Source comments are English. Hangul may still appear in string literals,
// regexes, prompts and fixtures, because those are program input or output,
// not commentary. This module finds Hangul only inside comment ranges, using
// the TypeScript parser, so a Korean prompt string or a `/블로커:/` regex is
// never flagged.
//
// Scope: tracked src/**/*.ts(x), excluding src/locale/ (the locale catalogs
// and prompts are user-facing text by design).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HANGUL = /\p{Script=Hangul}/u;
const require = createRequire(import.meta.url);

/**
 * Comments that quote Korean program input or output on purpose. Each entry
 * names the file and the exact quoted fragment; new Korean prose in the same
 * comment or file still fails.
 * @type {Array<{ file: string; fragment: string; reason: string }>}
 */
export const COMMENT_ALLOWLIST = [];

let ts;
function typescript() {
  ts ??= require('typescript');
  return ts;
}

/**
 * Every comment range of one source text, deduplicated by position.
 * @returns {Array<{ pos: number; end: number; text: string }>}
 */
export function commentRanges(file, text) {
  const t = typescript();
  const kind = file.endsWith('.tsx') ? t.ScriptKind.TSX : t.ScriptKind.TS;
  const source = t.createSourceFile(file, text, t.ScriptTarget.Latest, false, kind);
  const seen = new Map();
  const collect = (ranges) => {
    for (const range of ranges ?? []) {
      if (!seen.has(range.pos)) seen.set(range.pos, { pos: range.pos, end: range.end, text: text.slice(range.pos, range.end) });
    }
  };
  const visit = (node) => {
    collect(t.getLeadingCommentRanges(text, node.getFullStart()));
    collect(t.getTrailingCommentRanges(text, node.getEnd()));
    t.forEachChild(node, visit);
  };
  visit(source);
  // Comments after the last token (end of file) hang off the EOF token.
  collect(t.getLeadingCommentRanges(text, source.endOfFileToken.getFullStart()));
  return [...seen.values()].sort((a, b) => a.pos - b.pos);
}

/**
 * Comment lines of one file that carry Hangul outside its allowlisted fragments.
 * @returns {Array<{ line: number; text: string }>}
 */
export function findHangulCommentLines(file, text, allowlist = COMMENT_ALLOWLIST) {
  const fragments = allowlist.filter((entry) => entry.file === file).map((entry) => entry.fragment);
  const offending = [];
  for (const range of commentRanges(file, text)) {
    if (!HANGUL.test(range.text)) continue;
    const firstLine = text.slice(0, range.pos).split('\n').length;
    range.text.split('\n').forEach((line, offset) => {
      let rest = line;
      for (const fragment of fragments) rest = rest.split(fragment).join('');
      if (HANGUL.test(rest)) offending.push({ line: firstLine + offset, text: line.trim() });
    });
  }
  return offending;
}

/** Tracked TypeScript sources the comment scan covers. */
export function trackedSources() {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'src/*.ts', 'src/*.tsx', 'src/**/*.ts', 'src/**/*.tsx'], { encoding: 'utf8' });
  return [...new Set(out.split('\0').filter(Boolean))].filter((file) => !file.startsWith('src/locale/'));
}
