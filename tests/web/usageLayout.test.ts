// Two properties this page needs that jsdom cannot see, so they are asserted
// against the stylesheet text instead (AGT-4289).
//
// Both were shipped wrong once. The cache-rate colour was scoped to `td` while
// the headline stat is a `<strong>`, so the one number the page is built
// around rendered in the neutral colour — and the jsdom test passed, because
// it asserted the class name and jsdom computes no colours. The grid floor was
// set to 38rem, which looked right and was not: `auto-fit` answers a higher
// floor with MORE tracks, so the panel stayed narrower than its table and the
// 비용 column stayed off-screen.
//
// A real-browser check belongs in a rendering run, not the unit suite. These
// are the tripwires that fire when someone edits the two declarations that
// were wrong before.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RAW = readFileSync(resolve(__dirname, '../../web/static/css/usage.css'), 'utf8');
/**
 * Rules only.
 *
 * These assertions are about what the stylesheet declares, and this file
 * explains its own history in prose — the first version of the `td.rate-low`
 * check matched the sentence describing the bug it was guarding against.
 */
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, '');

const TOKENS_CSS = readFileSync(resolve(__dirname, '../../web/static/css/tokens.css'), 'utf8');

describe('usage.css invariants', () => {
  it('references only custom properties tokens.css actually defines', () => {
    // Written after three `var(--…)` names that do not exist were shipped into
    // this file (`--surface-2`, `--text-1`, `--text-2`; the real names are
    // `--surface2`, `--fg-primary`, `--fg-secondary`). An undefined custom
    // property is not an error — the declaration is dropped and the rule
    // renders with an inherited colour, so it looks plausible. Neither the
    // build, nor oxlint, nor jsdom sees it.
    const defined = new Set(
      [...TOKENS_CSS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(m => m[1]),
    );
    const used = new Set([...CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));

    expect([...used].filter(name => !defined.has(name))).toEqual([]);
    // Guard the guard: if either file stopped being read, both sets would be
    // empty and the assertion above would pass while checking nothing.
    expect(used.size).toBeGreaterThan(10);
    expect(defined.size).toBeGreaterThan(50);
  });

  it('does not scope the rate colours to table cells', () => {
    // `td.rate-low` would leave #sum-cache uncoloured.
    expect(CSS).toMatch(/^\.rate-low\s/m);
    expect(CSS).not.toMatch(/\btd\.rate-(low|mid|high)\b/);
  });

  it('defines all three rate buckets against palette tokens', () => {
    for (const [cls, token] of [['low', 'danger'], ['mid', 'warning'], ['high', 'success']]) {
      expect(CSS).toMatch(new RegExp(`\\.rate-${cls}\\s*\\{[^}]*var\\(--${token}\\)`));
    }
  });

  it('keeps the grid floor wide enough for the table it holds', () => {
    // Measured in Chromium against the real ledger: the widest table needs
    // 774px, and auto-fit pins a track at its floor. Below ~48rem the 비용 and
    // 점유 columns clip at every desktop width.
    // Anchored to `.grid`: `.summary` uses auto-fit too and comes first in the
    // file, so an unanchored match would report the wrong rule.
    const m = /\.grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\((\d+)rem/.exec(CSS);
    expect(m, 'grid floor declaration not found — was .grid rewritten?').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(50);
  });

  it('keeps the floor collapsible so a phone gets one column instead of overflow', () => {
    expect(CSS).toMatch(/\.grid\s*\{[^}]*minmax\(min\(\d+rem,\s*100%\)/);
  });

  it('scrolls wide content inside its own box', () => {
    expect(CSS).toMatch(/\.table-wrap\s*\{[^}]*overflow-x:\s*auto/);
  });
});
