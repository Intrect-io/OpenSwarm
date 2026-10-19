// @vitest-environment jsdom
//
// One shell for every page (dashboard redesign, step 5). The 2026-10-19 review
// found three nav orders, a logo pointing at /app, a page-title label that
// repeated the active tab, and status facts that disagreed between pages.

import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { MORE_NAV, PRIMARY_NAV, currentRoute, describeStatus, formatUptime, mountShell } from '../../web/static/js/shell.mjs';

const status = (over: Record<string, unknown> = {}) => ({
  daemon: { state: 'running', reason: null, uptimeMs: 6 * 3_600_000 + 12 * 60_000 },
  provider: { adapter: 'codex-responses', model: 'gpt-5.6-terra' },
  needsYou: { questions: 1, parked: 2, total: 3 },
  generatedAt: 0,
  ...over,
});

const respond = (code: number, body: unknown = {}) => ({ ok: code >= 200 && code < 300, status: code, json: async () => body });

function page(inner = '') {
  document.body.innerHTML = `<header class="topbar" data-shell>${inner}</header><main></main>`;
  return document;
}

let mounted: { stop(): void } | null = null;
afterEach(() => { mounted?.stop(); mounted = null; });

describe('shell navigation', () => {
  it('has one order, Supervisor first, with the reference pages behind More', () => {
    expect(PRIMARY_NAV.map((item: { href: string }) => item.href)).toEqual(['/', '/app', '/chat', '/orchestration', '/threads']);
    expect(MORE_NAV.map((item: { href: string }) => item.href)).toEqual(['/usage', '/warehouse', '/settings']);
  });

  it('maps a pathname to its nav entry', () => {
    expect(currentRoute('/')).toBe('/');
    expect(currentRoute('/index.html')).toBe('/');
    expect(currentRoute('/chat/')).toBe('/chat');
    expect(currentRoute('/issues')).toBeNull();
  });

  it('renders brand → / with no page-title label, and marks the current page', async () => {
    const doc = page();
    mounted = mountShell(doc, { fetchImpl: vi.fn(async () => respond(200, status())), location: { pathname: '/chat' } });
    expect(doc.querySelector('.brand')!.getAttribute('href')).toBe('/');
    expect(doc.querySelector('.page-title')).toBeNull();
    expect([...doc.querySelectorAll('[aria-current="page"]')].map((a) => a.getAttribute('href'))).toEqual(['/chat']);
  });

  it('marks More as current when the page lives behind it', () => {
    const doc = page();
    mounted = mountShell(doc, { fetchImpl: vi.fn(async () => respond(200, status())), location: { pathname: '/usage' } });
    expect(doc.querySelector('.nav-more > summary')!.classList.contains('is-current')).toBe(true);
    expect(doc.querySelector('.nav-more-menu [aria-current="page"]')!.getAttribute('href')).toBe('/usage');
  });

  it('keeps the page\'s own controls and leading button, and adds the theme switch', () => {
    const doc = page('<button data-shell-leading id="sidebar-toggle" aria-label="Toggle sidebar"></button><div class="topbar-actions"><select id="repo"></select></div>');
    mounted = mountShell(doc, { fetchImpl: vi.fn(async () => respond(200, status())), location: { pathname: '/threads' } });
    const header = doc.querySelector('header')!;
    expect(header.firstElementChild!.id).toBe('sidebar-toggle');
    const actions = doc.querySelector('.topbar-actions')!;
    expect(actions.querySelector('#repo')).not.toBeNull();
    expect(actions.lastElementChild!.id).toBe('theme-toggle');
    expect(actions.lastElementChild!.getAttribute('aria-label')).toMatch(/Switch to (light|dark) theme/);
  });

  it('gives the page one h1 named after its tab, without replacing a page\'s own', () => {
    const doc = page();
    mounted = mountShell(doc, { fetchImpl: vi.fn(async () => respond(200, status())), location: { pathname: '/orchestration' } });
    const headings = doc.querySelectorAll('h1');
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe('Orchestration');
    expect(headings[0].className).toBe('sr-only');
    mounted.stop();

    document.body.innerHTML = '<header class="topbar" data-shell></header><main><h1>Settings</h1></main>';
    mounted = mountShell(document, { fetchImpl: vi.fn(async () => respond(200, status())), location: { pathname: '/settings' } });
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(document.querySelector('h1')!.className).toBe('');
  });

  it('closes More on Escape', () => {
    const doc = page();
    mounted = mountShell(doc, { fetchImpl: vi.fn(async () => respond(200, status())), location: { pathname: '/' } });
    const more = doc.querySelector('.nav-more') as HTMLDetailsElement;
    more.open = true;
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(more.open).toBe(false);
  });
});

describe('shell status line', () => {
  it('states link, daemon, provider and what needs the operator, each with a source', async () => {
    const doc = page();
    mounted = mountShell(doc, { fetchImpl: vi.fn(async () => respond(200, status())), location: { pathname: '/' } });
    await (mounted as unknown as { ready: Promise<unknown> }).ready;
    const line = doc.querySelector('.shell-status')!;
    expect(line.parentElement!.tagName).toBe('HEADER');
    expect(line.textContent).toContain('Link connected');
    expect(line.textContent).toContain('Daemon running, up 6h 12m');
    expect(line.textContent).toContain('codex-responses · gpt-5.6-terra');
    const needs = line.querySelector('.status-needs')!;
    expect(needs.textContent).toBe('3 need you · 1 question · 2 parked');
    // A question is answered in Chat.
    expect(needs.getAttribute('href')).toBe('/chat');
    expect(needs.getAttribute('data-tone')).toBe('needs');
  });

  it('is calm when nothing needs the operator', () => {
    const view = describeStatus({ status: status({ needsYou: { questions: 0, parked: 0, total: 0 } }) });
    expect(view.needs).toEqual({ text: 'Nothing needs you', href: null, tone: 'calm' });
  });

  it('sends a parked-only state to the Supervisor, where parks are resolved', () => {
    expect(describeStatus({ status: status({ needsYou: { questions: 0, parked: 1, total: 1 } }) }).needs.href).toBe('/');
  });

  it('says dashboard-only with its reason instead of pretending the daemon is down', () => {
    const view = describeStatus({ status: status({ daemon: { state: 'dashboard-only', reason: 'No daemon runner is attached to this dashboard', uptimeMs: null }, provider: null }) });
    expect(view.daemon).toEqual({ value: 'dashboard only', tone: 'warn', source: 'No daemon runner is attached to this dashboard' });
    expect(view.provider).toBeNull();
  });

  it('turns an auth refusal into a pointer to Settings', async () => {
    const doc = page();
    mounted = mountShell(doc, { fetchImpl: vi.fn(async () => respond(403)), location: { pathname: '/' } });
    await (mounted as unknown as { ready: Promise<unknown> }).ready;
    const needs = doc.querySelector('.status-needs')!;
    expect(needs.getAttribute('href')).toBe('/settings');
    expect(doc.querySelector('.shell-status')!.textContent).toContain('Link locked');
  });

  it('says unreachable when the poll fails', async () => {
    const doc = page();
    mounted = mountShell(doc, { fetchImpl: vi.fn(async () => { throw new Error('down'); }), location: { pathname: '/' } });
    await (mounted as unknown as { ready: Promise<unknown> }).ready;
    expect(doc.querySelector('.shell-status')!.textContent).toContain('Link unreachable');
  });

  it('formats uptime for minutes, hours and days', () => {
    expect(formatUptime(5 * 60_000)).toBe('5m');
    expect(formatUptime(3 * 3_600_000 + 60_000)).toBe('3h 1m');
    expect(formatUptime(50 * 3_600_000)).toBe('2d 2h');
  });
});
