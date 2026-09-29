// ============================================
// OpenSwarm - Locale Module
// t() helper, initLocale(), getPrompts(), getDateLocale()
// ============================================

import { AsyncLocalStorage } from 'node:async_hooks';
import type { LocaleMessages, PromptTemplates, SupportedLocale } from './types.js';
import { en } from './en.js';
import { ko } from './ko.js';
import { enPrompts } from './prompts/en.js';
import { koPrompts } from './prompts/ko.js';

export type { LocaleMessages, PromptTemplates, SupportedLocale } from './types.js';

/**
 * The untrusted-data block the prompt templates wrap untrusted text in. Its
 * escaping is locale-independent (both catalogs emit the same ASCII markers),
 * and it is exported here so agent modules whose prompts are not templates
 * share that one implementation instead of growing a weaker copy. (AGT-3466)
 */
export { promptDataBlock } from './prompts/en.js';

// ── State ─────────────────────────────────

// Process-global default locale. This is only the fallback for code that runs
// outside any `withLocale` scope (e.g. top-level CLI setup). Concurrent
// executions must not mutate it — they should use `withLocale` to scope their
// locale choice to the current async execution instead, so one runner's locale
// never leaks into another's. (AGT-3420)
let defaultLocale: SupportedLocale = 'en';

const catalogs: Record<SupportedLocale, LocaleMessages> = { en, ko };
const promptCatalogs: Record<SupportedLocale, PromptTemplates> = {
  en: enPrompts,
  ko: koPrompts,
};

// Execution-scoped locale. `withLocale` sets this for the duration of an async
// execution; `t`/`getPrompts`/`getDateLocale`/`getLocale` read it first and only
// fall back to `defaultLocale` when no scope is active. This removes the
// mutable process-global from concurrent execution paths.
const localeScope = new AsyncLocalStorage<SupportedLocale>();

type LocaleLeafKey<T, Prefix extends string = ''> = {
  [K in Extract<keyof T, string>]:
    T[K] extends string
      ? `${Prefix}${K}`
      : T[K] extends Record<string, unknown>
        ? LocaleLeafKey<T[K], `${Prefix}${K}.`>
        : never;
}[Extract<keyof T, string>];

type LocaleKey = LocaleLeafKey<LocaleMessages>;
type LocaleLookupKey<K extends string> = K extends LocaleKey ? K : string extends K ? string : never;

// ── Public API ────────────────────────────

/**
 * Initialize the default locale module. Call once at startup.
 *
 * This sets the process-global fallback locale. For concurrent executions that
 * need a specific locale, prefer `withLocale` so the choice is scoped to that
 * execution and does not leak into sibling runners.
 */
export function initLocale(locale: SupportedLocale = 'en'): void {
  if (!catalogs[locale]) {
    console.warn(`[Locale] Unknown locale "${locale}", falling back to "en"`);
    locale = 'en';
  }
  defaultLocale = locale;
  console.log(`[Locale] Initialized: ${locale}`);
}

/**
 * Run `fn` with `locale` scoped to the current async execution.
 *
 * Any `t`/`getPrompts`/`getDateLocale`/`getLocale` call made (synchronously or
 * through awaited work) inside `fn` resolves to `locale`, and the previous
 * scope is restored when `fn` returns — so concurrent executions each see their
 * own locale and never mutate a shared process-global.
 */
export async function withLocale<T>(
  locale: SupportedLocale,
  fn: () => Promise<T> | T,
): Promise<T> {
  return localeScope.run(locale, async () => fn());
}

/**
 * Get the current locale identifier.
 */
export function getLocale(): SupportedLocale {
  return localeScope.getStore() ?? defaultLocale;
}

/**
 * Dot-path lookup with {{param}} interpolation.
 *
 * Usage:
 *   t('common.timeAgo.justNow')              → "just now"
 *   t('common.timeAgo.minutesAgo', { n: 5 }) → "5 min ago"
 *   t('discord.errors.sessionNotFound', { name: 'main' })
 */
export function t<const K extends string>(key: LocaleLookupKey<K>, params?: Record<string, string | number>): string {
  const locale = getLocale();
  const messages = catalogs[locale];
  const value = resolvePath(messages, key);
  if (value === undefined) {
    console.warn(`[Locale] Missing key: "${key}" for locale "${locale}"`);
    return key;
  }
  if (typeof value !== 'string') {
    console.warn(`[Locale] Key "${key}" is not a string (got ${typeof value})`);
    return key;
  }
  if (!params) return value;
  return interpolate(value, params);
}

/**
 * Return the current locale's prompt templates.
 */
export function getPrompts(): PromptTemplates {
  return promptCatalogs[getLocale()];
}

/**
 * Return the BCP 47 locale tag for Date.toLocaleString() etc.
 */
export function getDateLocale(): string {
  return getLocale() === 'ko' ? 'ko-KR' : 'en-US';
}

// ── Internals ─────────────────────────────

function resolvePath(obj: any, path: string): unknown {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const val = params[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}
