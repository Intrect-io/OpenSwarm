// ============================================
// Claude Swarm - Locale Module
// t() helper, initLocale(), getPrompts(), getDateLocale()
// ============================================

import type { LocaleMessages, PromptTemplates, SupportedLocale } from './types.js';
import { en } from './en.js';
import { ko } from './ko.js';
import { enPrompts } from './prompts/en.js';
import { koPrompts } from './prompts/ko.js';

export type { LocaleMessages, PromptTemplates, SupportedLocale } from './types.js';

// ── State ─────────────────────────────────

let currentLocale: SupportedLocale = 'en';
let currentMessages: LocaleMessages = en;
let currentPrompts: PromptTemplates = enPrompts;

const catalogs: Record<SupportedLocale, LocaleMessages> = { en, ko };
const promptCatalogs: Record<SupportedLocale, PromptTemplates> = {
  en: enPrompts,
  ko: koPrompts,
};

// ── Public API ────────────────────────────

/**
 * Initialize the locale module. Call once at startup.
 */
export function initLocale(locale: SupportedLocale = 'en'): void {
  if (!catalogs[locale]) {
    console.warn(`[Locale] Unknown locale "${locale}", falling back to "en"`);
    locale = 'en';
  }
  currentLocale = locale;
  currentMessages = catalogs[locale];
  currentPrompts = promptCatalogs[locale];
  console.log(`[Locale] Initialized: ${locale}`);
}

/**
 * Get the current locale identifier.
 */
export function getLocale(): SupportedLocale {
  return currentLocale;
}

/**
 * Dot-path lookup with {{param}} interpolation.
 *
 * Usage:
 *   t('common.timeAgo.justNow')              → "just now"
 *   t('common.timeAgo.minutesAgo', { n: 5 }) → "5 min ago"
 *   t('discord.errors.sessionNotFound', { name: 'main' })
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const value = resolvePath(currentMessages, key);
  if (value === undefined) {
    console.warn(`[Locale] Missing key: "${key}" for locale "${currentLocale}"`);
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
  return currentPrompts;
}

/**
 * Return the BCP 47 locale tag for Date.toLocaleString() etc.
 */
export function getDateLocale(): string {
  return currentLocale === 'ko' ? 'ko-KR' : 'en-US';
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
