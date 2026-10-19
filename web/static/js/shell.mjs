// The dashboard shell: brand, navigation, theme switch and the status line,
// rendered from this one module into every page.
//
// Every page used to hand-copy its own <header>. By the 2026-10-19 design
// review they had drifted into three nav orders, a logo pointing at /app, a
// page-title label that repeated the active tab, and a Supervisor-only Issues
// tab. A page now carries only `<header class="topbar" data-shell>` plus its
// own controls; the shared parts come from here.
//
// Page-owned children survive the mount: `[data-shell-leading]` stays first
// (the cockpit's sidebar toggle) and `.topbar-actions` keeps its controls, with
// the theme switch appended.

import { installThemeToggle } from './theme.mjs';

/** Always visible, in this order on every page. */
export const PRIMARY_NAV = [
  { href: '/', label: 'Supervisor' },
  { href: '/app', label: 'Cockpit' },
  { href: '/chat', label: 'Chat' },
  { href: '/orchestration', label: 'Orchestration' },
  { href: '/threads', label: 'Threads' },
];

/** Behind "More": reference pages an operator visits rarely. */
export const MORE_NAV = [
  { href: '/usage', label: 'Usage' },
  { href: '/warehouse', label: 'Warehouse' },
  { href: '/settings', label: 'Settings' },
];

const POLL_MS = 15_000;

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** The nav entry a pathname belongs to; '/index.html' is the Supervisor. */
export function currentRoute(pathname) {
  const path = (pathname || '/').replace(/\/+$/, '') || '/';
  if (path === '/index.html') return '/';
  return [...PRIMARY_NAV, ...MORE_NAV].find((item) => item.href === path)?.href ?? null;
}

const MOON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" class="when-dark"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const SUN = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" class="when-light"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const CHEVRON = '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Brand + navigation markup for the page at `current`. */
export function navMarkup(current) {
  const link = ({ href, label }) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  const inMore = MORE_NAV.some((item) => item.href === current);
  // The links scroll on a phone; "More" sits outside that scroller so its menu
  // is not clipped by the overflow it would otherwise live in.
  return `<a class="brand" href="/">OpenSwarm</a>`
    + `<nav class="topbar-nav-group" aria-label="Pages"><div class="topbar-nav">${PRIMARY_NAV.map(link).join('')}</div>`
    + `<details class="nav-more"><summary${inMore ? ' class="is-current"' : ''}>More ${CHEVRON}</summary>`
    + `<div class="nav-more-menu">${MORE_NAV.map(link).join('')}</div></details></nav>`;
}

export function formatUptime(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * What the status line says, from the last poll's outcome.
 * `outcome` is { status } on success, { locked: true } on an auth refusal,
 * or { unreachable: true } when the request failed.
 */
export function describeStatus(outcome) {
  if (outcome?.locked) {
    return {
      link: { value: 'locked', tone: 'warn', source: 'web token required' },
      daemon: null, provider: null,
      needs: { text: 'Add a web token to see status', href: '/settings', tone: 'warn' },
    };
  }
  if (!outcome?.status) {
    return {
      link: { value: 'unreachable', tone: 'bad', source: 'retrying' },
      daemon: null, provider: null, needs: null,
    };
  }
  const { daemon, provider, needsYou } = outcome.status;
  const daemonValue = daemon.state === 'running'
    ? `running${daemon.uptimeMs != null ? `, up ${formatUptime(daemon.uptimeMs)}` : ''}`
    : daemon.state === 'dashboard-only' ? 'dashboard only' : 'stopped';
  const parts = [];
  if (needsYou.questions) parts.push(`${needsYou.questions} question${needsYou.questions === 1 ? '' : 's'}`);
  if (needsYou.parked) parts.push(`${needsYou.parked} parked`);
  return {
    link: { value: 'connected', tone: 'ok', source: 'polled every 15s' },
    daemon: { value: daemonValue, tone: daemon.state === 'running' ? 'ok' : 'warn', source: daemon.reason || 'runner' },
    provider: provider
      ? { value: provider.model ? `${provider.adapter} · ${provider.model}` : provider.adapter, source: 'config' }
      : null,
    needs: needsYou.total > 0
      ? {
        text: `${needsYou.total} need${needsYou.total === 1 ? 's' : ''} you · ${parts.join(' · ')}`,
        // A question is answered in Chat; a parked run is resolved on the Supervisor.
        href: needsYou.questions > 0 ? '/chat' : '/',
        tone: 'needs',
      }
      : { text: 'Nothing needs you', href: null, tone: 'calm' },
  };
}

function itemMarkup(key, fact) {
  if (!fact) return '';
  const tone = fact.tone ? ` data-tone="${fact.tone}"` : '';
  return `<span class="status-item" data-key="${key.toLowerCase()}"${tone}><span class="status-key">${key}</span> `
    + `<span class="status-value">${escapeHtml(fact.value)}</span>`
    + (fact.source ? ` <span class="status-source">${escapeHtml(fact.source)}</span>` : '')
    + '</span>';
}

export function statusMarkup(view) {
  const needs = view.needs
    ? (view.needs.href
      ? `<a class="status-needs" data-tone="${view.needs.tone}" href="${view.needs.href}">${escapeHtml(view.needs.text)}</a>`
      : `<span class="status-needs" data-tone="${view.needs.tone}">${escapeHtml(view.needs.text)}</span>`)
    : '';
  return itemMarkup('Link', view.link) + itemMarkup('Daemon', view.daemon)
    + itemMarkup('Provider', view.provider) + needs;
}

/** Fade whichever edge of the nav still has links scrolled out of view. */
function syncNavFade(nav) {
  const max = nav.scrollWidth - nav.clientWidth;
  nav.classList.toggle('fade-start', nav.scrollLeft > 2);
  nav.classList.toggle('fade-end', max - nav.scrollLeft > 2);
}

export function mountShell(doc, { fetchImpl, pollMs = POLL_MS, location } = {}) {
  const header = doc.querySelector('header.topbar[data-shell]');
  if (!header) return { stop() {}, refresh: async () => {} };
  const fetcher = fetchImpl ?? ((url, init) => fetch(url, init));
  const current = currentRoute((location ?? doc.defaultView?.location)?.pathname);

  const leading = header.querySelector('[data-shell-leading]');
  let actions = header.querySelector('.topbar-actions');
  if (!actions) {
    actions = doc.createElement('div');
    actions.className = 'topbar-actions';
  }
  const shared = doc.createElement('template');
  shared.innerHTML = navMarkup(current) + '<div class="topbar-spacer"></div>';
  header.replaceChildren(...(leading ? [leading] : []), shared.content, actions);

  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.id = 'theme-toggle';
  toggle.className = 'btn btn-ghost btn-icon theme-toggle';
  toggle.setAttribute('aria-label', 'Switch theme');
  toggle.innerHTML = MOON + SUN;
  actions.appendChild(toggle);
  installThemeToggle(doc, toggle);

  // "More" closes on an outside click or Escape, like any menu.
  const more = header.querySelector('.nav-more');
  const closeMore = (event) => {
    if (!more?.open) return;
    if (event.type === 'keydown' && event.key !== 'Escape') return;
    if (event.type === 'click' && more.contains(event.target)) return;
    more.open = false;
  };
  doc.addEventListener('click', closeMore);
  doc.addEventListener('keydown', closeMore);

  const nav = header.querySelector('.topbar-nav');
  nav.addEventListener('scroll', () => syncNavFade(nav), { passive: true });
  const resize = () => syncNavFade(nav);
  doc.defaultView?.addEventListener('resize', resize);
  // On a phone the active page may sit past the fold of a scrolled nav.
  nav.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  syncNavFade(nav);

  // Page layouts reserve --topbar-h for the header. The band wraps to a
  // different number of rows per width (and per page's own controls), so the
  // reserved height follows the measured one instead of a guessed constant.
  const root = doc.documentElement;
  const syncHeight = () => {
    const height = Math.round(header.getBoundingClientRect().height);
    if (height > 0) root.style.setProperty('--topbar-h', `${height}px`);
  };
  const ResizeObserverImpl = doc.defaultView?.ResizeObserver;
  const observer = ResizeObserverImpl ? new ResizeObserverImpl(syncHeight) : null;

  const line = doc.createElement('div');
  line.className = 'shell-status';
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  line.setAttribute('aria-label', 'Swarm status');
  line.innerHTML = statusMarkup(describeStatus(null)).replace('unreachable', 'checking');
  // Inside the header, as its last row: the header is the one element every
  // page layout already reserves --topbar-h for.
  header.appendChild(line);
  observer?.observe(header);
  syncHeight();

  let last = '';
  const refresh = async () => {
    let outcome;
    try {
      const response = await fetcher('/api/shell-status');
      if (response.status === 401 || response.status === 403) outcome = { locked: true };
      else if (!response.ok) outcome = { unreachable: true };
      else outcome = { status: await response.json() };
    } catch {
      outcome = { unreachable: true };
    }
    const markup = statusMarkup(describeStatus(outcome));
    // Only touch the DOM when the sentence changed: the line is a live region.
    if (markup !== last) { line.innerHTML = markup; last = markup; }
    return outcome;
  };
  const timer = setInterval(refresh, pollMs);
  const first = refresh();

  return {
    refresh,
    ready: first,
    stop() {
      clearInterval(timer);
      observer?.disconnect();
      doc.removeEventListener('click', closeMore);
      doc.removeEventListener('keydown', closeMore);
      doc.defaultView?.removeEventListener('resize', resize);
    },
  };
}
