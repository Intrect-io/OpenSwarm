#!/usr/bin/env node
// Fails when a tracked Markdown document carries Hangul outside the allowlist.
//
// Project documentation is English. The only Korean allowed in tracked
// Markdown is quoted program input or output: text a parser reads, a config
// value an operator types, or what a terminal prints. Each allowance names
// the file and the exact quoted fragment, never a line number or a whole
// file, so new Korean prose on the same line or in the same file still fails.
//
// Usage: node scripts/check-doc-language.mjs   (run by CI's Lint job)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HANGUL = /\p{Script=Hangul}/u;

/** @type {Array<{ file: string; fragment: string; reason: string }>} */
export const ALLOWLIST = [
  {
    file: 'README.md',
    fragment: '`이이렇렇게 쓰쓰이는것`',
    reason: 'program output: the doubled characters a mobile SSH client paints',
  },
  {
    file: 'docs/AUTONOMY_PROTOCOL.md',
    fragment: '`[하네스이식 8]`',
    reason: 'program input: a tracker title tag the dependency ordering reads',
  },
  {
    file: 'docs/AUTONOMY_PROTOCOL.md',
    fragment: '"블로커:"',
    reason: 'program input: the description prefix src/linear/linear.ts parses',
  },
  {
    file: 'CHANGELOG.md',
    fragment: '`추가 유지보수`',
    reason: 'program input: a tracker label value for autonomous.skip.labels',
  },
  {
    file: 'CHANGELOG.md',
    fragment: '`결정`, `설계 결정`, `배포`, `운영`',
    reason: 'program input: tracker title tags for autonomous.skip.titleTags',
  },
];

/**
 * Returns the offending lines of one document.
 * @param {string} file repository-relative path
 * @param {string} text file contents
 * @param {typeof ALLOWLIST} allowlist
 */
export function findHangulLines(file, text, allowlist = ALLOWLIST) {
  const fragments = allowlist.filter((entry) => entry.file === file).map((entry) => entry.fragment);
  const offending = [];
  text.split('\n').forEach((line, index) => {
    if (!HANGUL.test(line)) return;
    let rest = line;
    for (const fragment of fragments) rest = rest.split(fragment).join('');
    if (HANGUL.test(rest)) offending.push({ line: index + 1, text: line.trim() });
  });
  return offending;
}

/** Allowlist entries whose fragment no longer appears in their file. */
export function findStaleEntries(readText, allowlist = ALLOWLIST) {
  return allowlist.filter((entry) => {
    const text = readText(entry.file);
    return text === null || !text.includes(entry.fragment);
  });
}

function trackedMarkdown() {
  const out = execFileSync('git', ['ls-files', '-z', '--', '*.md', '*.mdx'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function main() {
  let failed = false;
  for (const file of trackedMarkdown()) {
    const text = readOrNull(file);
    if (text === null) continue;
    for (const hit of findHangulLines(file, text)) {
      failed = true;
      const shown = hit.text.length > 160 ? `${hit.text.slice(0, 157)}...` : hit.text;
      console.error(`${file}:${hit.line}: Hangul outside the allowlist: ${shown}`);
    }
  }
  for (const entry of findStaleEntries(readOrNull)) {
    failed = true;
    console.error(`allowlist entry no longer matches ${entry.file}: ${entry.fragment}`);
  }
  if (failed) {
    console.error('Tracked Markdown must be English. Translate the text, or allowlist quoted program input/output in scripts/check-doc-language.mjs.');
    process.exit(1);
  }
  console.log('check-doc-language: tracked Markdown carries no Hangul outside the allowlist');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
