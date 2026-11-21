// @vitest-environment jsdom
//
// Created: 2026-11-22
// Purpose: The Terminal nav entry appears only while shell-status says the web terminal is attached (AGT-4002).
// Dependencies: vitest (jsdom), web/static/js/shell.mjs
// Test Status: passing

import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { TERMINAL_NAV, currentRoute, mountShell, navMarkup, terminalNavVisible } from '../../web/static/js/shell.mjs';

const status = (over: Record<string, unknown> = {}) => ({
  daemon: { state: 'running', reason: null, uptimeMs: 60_000 },
  provider: { adapter: 'codex-responses', model: null },
  needsYou: { questions: 0, parked: 0, total: 0 },
  tracker: 'local',
  generatedAt: 0,
  ...over,
});

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> };
const respond = (code: number, body: unknown = {}): Reply => ({ ok: code >= 200 && code < 300, status: code, json: async () => body });

function page() {
  document.body.innerHTML = '<header class="topbar" data-shell></header><main></main>';
  return document;
}

const terminalLinks = (doc: Document) => [...doc.querySelectorAll('.nav-more-menu a[href="/terminal"]')];

let mounted: { stop(): void } | null = null;
afterEach(() => { mounted?.stop(); mounted = null; });

describe('Terminal nav entry (AGT-4002)', () => {
  it('shows the Terminal nav entry only when webTerminal is true', async () => {
    // One fetcher whose next answer the test sets, so one mounted shell sees every outcome in turn.
    let next: () => Promise<Reply> = async () => respond(200, status({ webTerminal: true }));
    const doc = page();
    const shell = mountShell(doc, { fetchImpl: vi.fn(() => next()), location: { pathname: '/' }, pollMs: 1_000_000 });
    mounted = shell;
    await shell.ready;
    expect(terminalLinks(doc)).toHaveLength(1);
    expect(terminalLinks(doc)[0]!.textContent).toBe('Terminal');

    const hiddenBy: Array<[string, () => Promise<Reply>]> = [
      ['webTerminal false', async () => respond(200, status({ webTerminal: false }))],
      ['a missing field', async () => respond(200, status())],
      ['a truthy non-boolean', async () => respond(200, status({ webTerminal: 'true' }))],
      ['401', async () => respond(401)],
      ['403', async () => respond(403)],
      ['a server error', async () => respond(500)],
      ['a network failure', async () => { throw new Error('offline'); }],
    ];
    for (const [why, reply] of hiddenBy) {
      // Turn it back on first, so each case proves it hides a visible entry.
      next = async () => respond(200, status({ webTerminal: true }));
      await shell.refresh();
      expect(terminalLinks(doc), `visible before ${why}`).toHaveLength(1);
      next = reply;
      await shell.refresh();
      expect(terminalLinks(doc), `hidden on ${why}`).toHaveLength(0);
    }

    // Repeated true answers never duplicate the entry.
    next = async () => respond(200, status({ webTerminal: true }));
    await shell.refresh();
    await shell.refresh();
    expect(terminalLinks(doc)).toHaveLength(1);
  });

  it('starts hidden until a poll says the terminal is attached', () => {
    const doc = page();
    mounted = mountShell(doc, { fetchImpl: vi.fn(() => new Promise<Reply>(() => {})), location: { pathname: '/' } });
    expect(terminalLinks(doc)).toHaveLength(0);
  });

  it('decides visibility from a strict true only', () => {
    expect(terminalNavVisible({ status: status({ webTerminal: true }) })).toBe(true);
    for (const outcome of [null, undefined, { locked: true }, { unreachable: true }, { status: status() },
      { status: status({ webTerminal: 1 }) }, { status: status({ webTerminal: 'true' }) }, { status: status({ webTerminal: false }) }]) {
      expect(terminalNavVisible(outcome)).toBe(false);
    }
  });

  it('marks /terminal as the current route, under More, when the entry is shown', async () => {
    expect(currentRoute('/terminal')).toBe(TERMINAL_NAV.href);
    expect(currentRoute('/terminal/')).toBe('/terminal');
    expect(navMarkup('/terminal')).not.toContain('href="/terminal"');
    expect(navMarkup('/terminal', { terminal: true })).toContain('<a href="/terminal" aria-current="page">Terminal</a>');

    const doc = page();
    const shell = mountShell(doc, { fetchImpl: vi.fn(async () => respond(200, status({ webTerminal: true }))), location: { pathname: '/terminal' }, pollMs: 1_000_000 });
    mounted = shell;
    await shell.ready;
    expect(doc.querySelector('.nav-more-menu [aria-current="page"]')!.getAttribute('href')).toBe('/terminal');
    expect(doc.querySelector('.nav-more > summary')!.classList.contains('is-current')).toBe(true);
    expect(doc.querySelector('h1')!.textContent).toBe('Terminal');
  });
});
