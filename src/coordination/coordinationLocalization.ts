// ============================================
// OpenSwarm - Locale projection for retained coordination transcripts
// ============================================
//
// Coordination events are audit evidence, so localization never rewrites the
// event store or its append-only trace. Translations live in a sidecar cache
// keyed by event id + fingerprint and are applied only to read responses.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../support/atomicFile.js';
import { withFileLock } from '../support/fileLock.js';
import { coordinationStateDir } from './coordinationPaths.js';
import type { CoordinationEvent } from './coordinationStore.js';
import type { SupportedLocale } from '../locale/types.js';

interface TranslationEntry {
  fingerprint: string;
  locale: SupportedLocale;
  summary: string;
  detail?: string;
  translatedAt: number;
}

interface TranslationState {
  version: 1;
  entries: Record<string, TranslationEntry>;
}

export interface TranslationInput {
  id: string;
  summary: string;
  detail?: string;
}

export interface TranslationOutput {
  id: string;
  summary?: string;
  detail?: string;
}

export type CoordinationBatchTranslator = (
  items: TranslationInput[],
  locale: SupportedLocale,
) => Promise<TranslationOutput[]>;

const MAX_BATCH_ITEMS = 20;
const MAX_BATCH_CHARS = 12_000;
let memo: { path: string; ino: number; mtimeMs: number; size: number; state: TranslationState } | undefined;

function cachePath(): string {
  return process.env.OPENSWARM_COORDINATION_TRANSLATIONS_FILE
    ?? join(coordinationStateDir(), 'coordination-translations.json');
}

function emptyState(): TranslationState {
  return { version: 1, entries: {} };
}

function loadState(): TranslationState {
  const path = cachePath();
  if (!existsSync(path)) return emptyState();
  const stat = statSync(path);
  if (memo
    && memo.path === path
    && memo.ino === stat.ino
    && memo.mtimeMs === stat.mtimeMs
    && memo.size === stat.size) return memo.state;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<TranslationState>;
  if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
    throw new Error(`Coordination translation cache has an unsupported or corrupt shape: ${path}`);
  }
  const state: TranslationState = { version: 1, entries: parsed.entries };
  memo = { path, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, state };
  return state;
}

function key(eventId: string, locale: SupportedLocale): string {
  return `${locale}:${eventId}`;
}

/** Agent output already containing Korean should remain exactly as authored. */
export function needsCoordinationTranslation(text: string): boolean {
  // Uppercase issue IDs (`AGT-4100`) and similar identifiers are not prose.
  if (!/[A-Za-z]{3,}/.test(text) || !/[a-z]{2}/.test(text)) return false;
  // Any Hangul means the author already chose Korean. Long identifiers, paths,
  // or quoted errors must not make that authored message eligible again.
  return !/[가-힣]/.test(text);
}

export function projectCoordinationLocale(
  events: readonly CoordinationEvent[],
  locale: SupportedLocale,
): Array<CoordinationEvent & { originalText?: { summary: string; detail?: string }; localizedLocale?: SupportedLocale }> {
  if (locale === 'en') return events.map((event) => ({ ...event }));
  let state: TranslationState;
  try {
    state = loadState();
  } catch (error) {
    console.warn('[CoordinationLocalization] Translation cache unavailable:', error);
    return events.map((event) => ({ ...event }));
  }
  return events.map((event) => {
    const translated = state.entries[key(event.id, locale)];
    if (!translated || translated.fingerprint !== event.fingerprint) return { ...event };
    return {
      ...event,
      summary: translated.summary,
      detail: translated.detail ?? event.detail,
      originalText: { summary: event.summary, ...(event.detail ? { detail: event.detail } : {}) },
      localizedLocale: locale,
    };
  });
}

/** Cheap cache coverage check used to trigger one background backfill. */
export function missingCoordinationTranslations(
  events: readonly CoordinationEvent[],
  locale: SupportedLocale,
): number {
  if (locale === 'en') return 0;
  let state: TranslationState;
  try {
    state = loadState();
  } catch {
    // A corrupt cache must be repaired by an explicit operator action; do not
    // turn every dashboard poll into another failing model job.
    return 0;
  }
  return events.filter((event) => {
    const entry = state.entries[key(event.id, locale)];
    if (entry?.fingerprint === event.fingerprint) return false;
    return needsCoordinationTranslation(event.summary)
      || Boolean(event.detail && needsCoordinationTranslation(event.detail));
  }).length;
}

function batches(items: TranslationInput[]): TranslationInput[][] {
  const result: TranslationInput[][] = [];
  let current: TranslationInput[] = [];
  let chars = 0;
  for (const item of items) {
    const itemChars = item.summary.length + (item.detail?.length ?? 0);
    if (current.length > 0 && (current.length >= MAX_BATCH_ITEMS || chars + itemChars > MAX_BATCH_CHARS)) {
      result.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += itemChars;
  }
  if (current.length > 0) result.push(current);
  return result;
}

export async function backfillCoordinationLocale(
  events: readonly CoordinationEvent[],
  locale: SupportedLocale,
  translate: CoordinationBatchTranslator,
): Promise<{ translated: number; cached: number; skipped: number; failed: number; errors: string[] }> {
  if (locale === 'en') return { translated: 0, cached: events.length, skipped: 0, failed: 0, errors: [] };
  const initial = loadState();
  let cached = 0;
  let skipped = 0;
  const pending: Array<{ event: CoordinationEvent; input: TranslationInput }> = [];
  for (const event of events) {
    const existing = initial.entries[key(event.id, locale)];
    if (existing?.fingerprint === event.fingerprint) {
      cached += 1;
      continue;
    }
    const summaryNeeds = needsCoordinationTranslation(event.summary);
    const detailNeeds = Boolean(event.detail && needsCoordinationTranslation(event.detail));
    if (!summaryNeeds && !detailNeeds) {
      skipped += 1;
      continue;
    }
    pending.push({
      event,
      input: {
        id: event.id,
        summary: summaryNeeds ? event.summary : '',
        ...(detailNeeds ? { detail: event.detail } : {}),
      },
    });
  }

  let translated = 0;
  let failed = 0;
  const errors: string[] = [];
  const byId = new Map(pending.map((item) => [item.event.id, item.event]));
  for (const batch of batches(pending.map((item) => item.input))) {
    try {
      const output = await translate(batch, locale);
      const expected = new Map(batch.map((item) => [item.id, item]));
      const accepted = new Map(output
        .filter((item) => {
          const input = expected.get(item.id);
          if (!input || !byId.has(item.id)) return false;
          if (input.summary && !item.summary?.trim()) return false;
          if (input.detail && !item.detail?.trim()) return false;
          return true;
        })
        .map((item) => [item.id, item]));
      const batchTranslated = await withFileLock(`${cachePath()}.lock`, async () => {
        const state = loadState();
        let written = 0;
        for (const input of batch) {
          const event = byId.get(input.id)!;
          const item = accepted.get(input.id);
          if (!item) continue;
          state.entries[key(event.id, locale)] = {
            fingerprint: event.fingerprint,
            locale,
            summary: input.summary ? item.summary!.slice(0, 500) : event.summary,
            ...(input.detail && item.detail ? { detail: item.detail.slice(0, 4_000) } : {}),
            translatedAt: Date.now(),
          };
          written += 1;
        }
        await atomicWriteFile(cachePath(), `${JSON.stringify(state, null, 2)}\n`, 0o600);
        memo = undefined;
        return written;
      });
      translated += batchTranslated;
      failed += batch.length - accepted.size;
    } catch (error) {
      failed += batch.length;
      errors.push((error instanceof Error ? error.message : String(error)).slice(0, 300));
    }
  }
  return { translated, cached, skipped, failed, errors };
}

export function resetCoordinationLocalizationForTests(): void {
  memo = undefined;
}
