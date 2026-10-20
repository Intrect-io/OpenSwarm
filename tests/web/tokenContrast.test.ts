// WCAG 2.2 AA contrast for the token palette, in both themes.
//
// The 2026-10-19 design review measured the active nav link at 4.3:1 and the
// success/danger badges at 4.1–4.4:1 in the light theme. Nothing caught it:
// tokens.test.ts checks where colours live, not whether they can be read.
// This computes the ratios from tokens.css itself, so a value swap that
// drops a pair below the floor fails here instead of in a reviewer's browser.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const tokens = readFileSync(join(__dirname, '..', '..', 'web', 'static', 'css', 'tokens.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function block(selector: string): Map<string, string> {
  const start = tokens.indexOf(`${selector} {`);
  const body = tokens.slice(start, tokens.indexOf('}', start));
  return new Map([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));
}

const dark = block(':root');
const light = new Map([...dark, ...block('[data-theme="light"]')]);

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = [
  '--fg-primary', '--fg-secondary', '--fg-muted', '--accent',
  '--danger', '--warning', '--success', '--info',
  '--role-worker', '--role-reviewer', '--role-orchestrator', '--role-review-agent',
  '--role-daemon', '--role-human',
];
const GROUNDS = ['--bg-app', '--bg-surface', '--bg-elevated'];

describe.each([['dark', dark], ['light', light]] as const)('token contrast (%s)', (_name, theme) => {
  const get = (name: string) => {
    const value = theme.get(name);
    expect(value, `${name} has no hex value`).toBeDefined();
    return value!;
  };
  const failures = (pairs: [string, string, number][]) => pairs
    .map(([fg, bg, floor]) => [fg, bg, floor, ratio(get(fg), get(bg))] as const)
    .filter(([, , floor, r]) => r < floor)
    .map(([fg, bg, floor, r]) => `${fg} on ${bg}: ${r.toFixed(2)} < ${floor}`);

  it('reads every text and status hue at 4.5:1 on every ground', () => {
    expect(failures(TEXT.flatMap((fg) => GROUNDS.map((bg) => [fg, bg, 4.5] as [string, string, number])))).toEqual([]);
  });

  it('keeps the shell band, the needs band and filled buttons legible', () => {
    expect(failures([
      ['--shell-fg', '--shell-bg', 4.5],
      ['--shell-muted', '--shell-bg', 4.5],
      ['--needs-ink', '--needs', 4.5],
      ['--fg-on-accent', '--accent', 4.5],
      // Armed destructive buttons set the ground colour on the danger fill.
      ['--bg-app', '--danger', 4.5],
    ])).toEqual([]);
  });

  it('outlines controls at 3:1 (WCAG 1.4.11)', () => {
    expect(failures([['--border-strong', '--bg-app', 3], ['--border-strong', '--bg-elevated', 3]])).toEqual([]);
  });

  it('keeps the operator role apart from the failure colour', () => {
    expect(get('--role-human')).not.toBe(get('--danger'));
  });
});
