// Design-token contract for the web surface (AGT-4201).
//
// Before this refactor the six pages carried four divergent palettes: the
// cockpit's tokens.css, three inline `:root` blocks with their own values, and
// warehouse.css with 33 raw hex colours. Nothing failed — the pages just
// drifted apart. These assertions turn the guideline's rules (§0.2 "no
// hardcoded colour/spacing/font", §8.1 "semantic tokens only") into a gate.

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..', 'web', 'static');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const files = walk(ROOT);
const css = files.filter((f) => f.endsWith('.css'));
const js = files.filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
const html = files.filter((f) => f.endsWith('.html'));
const tokensPath = join(ROOT, 'css', 'tokens.css');
const tokens = readFileSync(tokensPath, 'utf8');

/** Every `--name:` declared anywhere in tokens.css. */
function definedTokens(): Set<string> {
  return new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

/** Every `var(--name)` referenced in a file. */
function referencedTokens(source: string): string[] {
  return [...source.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
}

describe('design tokens (AGT-4201)', () => {
  it('declares the semantic vocabulary the guideline requires (§8.1)', () => {
    const defined = definedTokens();
    for (const required of [
      '--bg-app', '--bg-surface', '--bg-elevated', '--bg-user-bubble', '--bg-code', '--bg-hover', '--bg-active',
      '--fg-primary', '--fg-secondary', '--fg-muted', '--fg-on-accent',
      '--accent', '--accent-hover', '--accent-subtle', '--danger', '--warning', '--success', '--info',
      '--border', '--border-strong', '--focus-ring',
      '--radius-sm', '--radius-md', '--radius-lg', '--radius-full',
      '--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--space-8', '--space-12',
      '--font-sans', '--font-mono', '--text-xs', '--text-sm', '--text-base', '--text-lg', '--text-xl',
      '--leading-body', '--leading-tight',
      '--dur-fast', '--dur-base', '--dur-slow', '--ease-out', '--ease-in-out',
      '--z-dropdown', '--z-pip', '--z-modal', '--z-toast',
      '--code-keyword', '--code-string', '--code-comment', '--code-number', '--code-function',
      '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6',
    ]) {
      expect(defined, `${required} missing from tokens.css`).toContain(required);
    }
  });

  it('swaps values under [data-theme="light"] rather than forking selectors', () => {
    expect(tokens).toMatch(/\[data-theme="light"\]\s*\{/);
    // The light block must re-declare the surfaces and foregrounds — a light
    // theme that inherits the dark ground is not a theme.
    const light = tokens.slice(tokens.indexOf('[data-theme="light"]'));
    for (const name of ['--bg-app', '--bg-surface', '--fg-primary', '--fg-muted', '--accent', '--border']) {
      expect(light, `${name} not redefined for light`).toMatch(new RegExp(`${name}\\s*:`));
    }
  });

  it('resolves every var(--x) used anywhere on the web surface', () => {
    const defined = definedTokens();
    const missing: string[] = [];
    for (const file of [...css, ...js, ...html]) {
      const source = readFileSync(file, 'utf8');
      for (const name of referencedTokens(source)) {
        // Per-element custom properties a script sets at render time.
        if (name === '--speaker-color' || name === '--thread-accent') continue;
        if (!defined.has(name)) missing.push(`${relative(ROOT, file)}: ${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps every hex colour literal inside tokens.css (§0.2)', () => {
    const offenders: string[] = [];
    // A colour literal is a hex in a value position: after `:` in CSS, or
    // quoted / after `:` in JS and HTML. `#feed` as an id selector does not
    // match because it is not preceded by `:` or a quote — once comments are
    // stripped, since prose in a comment may put a colon before a selector.
    const cssHex = /:\s*[^;{}]*?(#[0-9a-fA-F]{3,8})\b/g;
    const jsHex = /(?:['"`]|:\s*)(#[0-9a-fA-F]{3,8})\b/g;
    for (const file of css) {
      if (file === tokensPath) continue;
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of source.matchAll(cssHex)) offenders.push(`${relative(ROOT, file)}: ${m[1]}`);
    }
    for (const file of [...js, ...html]) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(jsHex)) offenders.push(`${relative(ROOT, file)}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('ships the brand font the @font-face points at (§8.1)', () => {
    const src = tokens.match(/src:\s*url\('([^']+)'\)/);
    expect(src, 'tokens.css must declare an @font-face src').not.toBeNull();
    const asset = join(ROOT, src![1].replace(/^\/static\//, ''));
    expect(existsSync(asset), `${src![1]} is not vendored under web/static`).toBe(true);
    expect(existsSync(join(ROOT, 'fonts', 'LICENSE.inter'))).toBe(true);
    expect(tokens).toMatch(/--font-sans:\s*'Inter Variable'/);
  });
});

describe('page shells (AGT-4201)', () => {
  it('carry no inline <style> — every rule comes from a shared stylesheet', () => {
    for (const file of html) {
      expect(readFileSync(file, 'utf8'), relative(ROOT, file)).not.toMatch(/<style[\s>]/i);
    }
  });

  it('each link tokens.css + shell.css and boot the theme before first paint', () => {
    for (const file of html) {
      const source = readFileSync(file, 'utf8');
      const name = relative(ROOT, file);
      expect(source, name).toContain('/static/css/tokens.css');
      expect(source, name).toContain('/static/css/shell.css');
      expect(source, name).toContain('/static/js/themeBoot.js');
      // The theme script must precede the stylesheets in <head> so the
      // attribute is set before the first style computation.
      expect(source.indexOf('themeBoot.js'), `${name}: themeBoot.js must load before tokens.css`)
        .toBeLessThan(source.indexOf('tokens.css'));
    }
  });

  it('share one navigation naming every page', () => {
    const routes = ['/app', '/chat', '/orchestration', '/threads', '/warehouse'];
    for (const file of html) {
      const source = readFileSync(file, 'utf8');
      const name = relative(ROOT, file);
      expect(source, name).toMatch(/class="topbar-nav"/);
      for (const route of routes) expect(source, `${name} is missing a nav link to ${route}`).toContain(`href="${route}"`);
      expect(source, `${name} has no theme toggle`).toContain('class="btn btn-ghost btn-icon theme-toggle"');
    }
  });

  it('give every icon-only button an accessible name (§2.1)', () => {
    for (const file of html) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/<button[^>]*class="[^"]*btn-icon[^"]*"[^>]*>/g)) {
        expect(m[0], `${relative(ROOT, file)}: ${m[0]}`).toMatch(/aria-label=/);
      }
    }
  });
});

// The two server-rendered pages (`/` supervisor, `/issues` board) keep their
// inline stylesheets — their scripts are asserted by name elsewhere — but
// they draw every colour from the shared tokens and follow the same theme.
describe('server-rendered legacy pages (AGT-4201)', () => {
  const pages = [
    join(__dirname, '..', '..', 'src', 'support', 'dashboardHtml.ts'),
    join(__dirname, '..', '..', 'src', 'issues', 'issueBoardHtml.ts'),
  ];

  it('link tokens.css, boot the theme first, and offer a toggle', () => {
    for (const file of pages) {
      const source = readFileSync(file, 'utf8');
      const name = relative(join(__dirname, '..', '..'), file);
      expect(source, name).toContain('/static/css/tokens.css');
      expect(source, name).toContain('/static/js/themeBoot.js');
      expect(source.indexOf('themeBoot.js'), `${name}: themeBoot.js must load before tokens.css`)
        .toBeLessThan(source.indexOf('tokens.css'));
      expect(source, name).toContain('id="theme-toggle"');
      expect(source, name).toContain("import { installThemeToggle } from '/static/js/theme.mjs'");
    }
  });

  it('carry no colour literal in their <style> or markup', () => {
    const hex = /(?:['"`]|:\s*)(#[0-9a-fA-F]{3,8})\b/g;
    for (const file of pages) {
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const offenders = [...source.matchAll(hex)].map((m) => `${relative(join(__dirname, '..', '..'), file)}: ${m[1]}`);
      expect(offenders).toEqual([]);
    }
  });

  it('alias every legacy variable name to a token that exists', () => {
    const shared = definedTokens();
    // A page's own `:root` (inline, or in the page stylesheet it links under
    // web/static/css) may declare legacy names (`--green`, `--dim`) as
    // indirections; what the page references must be declared somewhere.
    const declaredInCss = new Set(css.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])));
    for (const file of pages) {
      const source = readFileSync(file, 'utf8');
      const local = new Set([...source.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
      const missing = referencedTokens(source)
        .filter((name) => !shared.has(name) && !local.has(name) && !declaredInCss.has(name));
      expect(missing, relative(join(__dirname, '..', '..'), file)).toEqual([]);
    }
  });
});
