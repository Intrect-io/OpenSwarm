// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { THEME_KEY, applyTheme, installThemeToggle, resolveTheme } from '../../web/static/js/theme.mjs';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

function mediaQuery(matches: boolean) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  return {
    matches,
    addEventListener: (_type: string, fn: (event: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: (event: { matches: boolean }) => void) => listeners.delete(fn),
    fire(next: boolean) { for (const fn of listeners) fn({ matches: next }); },
  };
}

describe('theme (AGT-4201)', () => {
  it('prefers the stored choice, then the OS, then dark', () => {
    expect(resolveTheme({ stored: 'light', prefersLight: false })).toBe('light');
    expect(resolveTheme({ stored: 'dark', prefersLight: true })).toBe('dark');
    expect(resolveTheme({ stored: null, prefersLight: true })).toBe('light');
    expect(resolveTheme({ stored: 'sepia', prefersLight: false })).toBe('dark');
  });

  it('stamps data-theme on the root element', () => {
    applyTheme(document, 'light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    applyTheme(document, 'dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('toggles, persists, and names the mode it will switch to', () => {
    document.body.innerHTML = '<button id="t"></button>';
    const button = document.getElementById('t') as HTMLButtonElement;
    const storage = memoryStorage();
    const query = mediaQuery(false);
    const toggle = installThemeToggle(document, button, { storage, matchMedia: () => query });

    expect(toggle.theme).toBe('dark');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Switch to light theme');

    button.click();
    expect(toggle.theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(storage.getItem(THEME_KEY)).toBe('light');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Switch to dark theme');

    // An explicit choice is not overridden by the OS changing its mind.
    query.fire(false);
    expect(toggle.theme).toBe('light');
    toggle.stop();
  });

  it('follows the OS only while no choice is stored', () => {
    document.body.innerHTML = '<button id="t"></button>';
    const storage = memoryStorage();
    const query = mediaQuery(true);
    const toggle = installThemeToggle(document, document.getElementById('t'), { storage, matchMedia: () => query });
    expect(toggle.theme).toBe('light');
    query.fire(false);
    expect(toggle.theme).toBe('dark');
    toggle.stop();
    query.fire(true);
    expect(toggle.theme).toBe('dark');
  });

  it('survives a blocked storage and a missing button', () => {
    const storage = {
      getItem: vi.fn(() => { throw new Error('blocked'); }),
      setItem: vi.fn(() => { throw new Error('blocked'); }),
    };
    const toggle = installThemeToggle(document, null, { storage, matchMedia: undefined });
    expect(toggle.theme).toBe('dark');
    toggle.set('light');
    expect(toggle.theme).toBe('light');
  });
});
