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
export const COMMENT_ALLOWLIST = [
  { file: "src/agents/completionReportEvidence.ts", fragment: "`412개 통과`", reason: "program input: a Korean test-count format the evidence parser accepts" },
  { file: "src/agents/completionReportEvidence.ts", fragment: "`통과 412`", reason: "program input: a Korean test-count format the evidence parser accepts" },
  { file: "src/agents/completionReportEvidence.ts", fragment: "\"기존 실패\"", reason: "program input: the Korean pre-existing-failure marker the parser reads" },
  { file: "src/agents/pipelineCoordination.ts", fragment: "`(요약 없음)`", reason: "program output: the ko locale placeholder the code publishes" },
  { file: "src/automation/agentEligibility.ts", fragment: "`[인수]`", reason: "program input: a tracker title tag" },
  { file: "src/core/config.ts", fragment: "`[인수]`", reason: "program input: a tracker title tag" },
  { file: "src/core/types.ts", fragment: "\"블로커:\"", reason: "program input: the description prefix linear.ts parses" },
  { file: "src/linear/linear.test.ts", fragment: "\"블로커: …\"", reason: "program input: the description prefix linear.ts parses" },
  { file: "src/linear/linear.test.ts", fragment: "\"블로커: KT-305/306/307\"", reason: "program input: a real description the parser reads" },
  { file: "src/linear/linear.ts", fragment: "\"블로커: KT-305/306/307\"", reason: "program input: a real description the parser reads" },
  { file: "src/linear/linear.ts", fragment: "\"블로커\"/\"의존성\"", reason: "program input: the Korean dependency keywords the parser matches" },
  { file: "src/support/httpBody.test.ts", fragment: "'한'", reason: "program input: the character whose UTF-8 bytes the test splits" },
  { file: "src/support/sensitiveDataFence.ts", fragment: "`비밀번호`", reason: "program input: a spreadsheet header the fence detects" },
  { file: "src/taskState/store.test.ts", fragment: "\"블로커:\"", reason: "program input: the description prefix linear.ts parses" },
  { file: "src/tui/chatModel.test.ts", fragment: "'이렇게'", reason: "program input: the doubled-echo text the model repairs" },
  { file: "src/tui/chatModel.ts", fragment: "'이' → '이이' or '이이이'", reason: "program output: the doubled-echo shapes the repair handles" },
  { file: "src/tui/chatModel.ts", fragment: "'이렇게' → '이이렇렇게게'", reason: "program output: the doubled-echo shapes the repair handles" },
  { file: "src/tui/inputDebug.ts", fragment: "'이이렇렇게'", reason: "program output: the doubled characters a mobile SSH client paints" },
];

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
