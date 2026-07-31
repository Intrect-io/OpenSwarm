// ============================================
// OpenSwarm — Shared per-provider model catalog
// ============================================
//
// Generalizes the resolution pattern codexModels.ts established (see its header)
// for providers that expose a plain `/v1/models` endpoint. Every adapter used to
// carry a hardcoded default model id with nothing checking it against reality, so
// a renamed or retired model only surfaced as a request failure at run time —
// gpt.ts sat on `gpt-4o` long after the GPT-5 line shipped.
//
// Resolution order, chosen so the hot path (getDefaultModel) does not hit the
// network on every call:
//   1. on-disk cache, if younger than the TTL
//   2. live provider API — refreshes the cache on success
//   3. on-disk cache even when stale (better a known-real list than a guess)
//   4. curated fallback baked into the adapter
//
// A provider that cannot list models (CLI-delegated adapters, or auth without the
// model-read scope) simply has no CatalogSpec and keeps its curated default.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type CatalogOrigin = 'live' | 'cache' | 'stale-cache' | 'curated';

export interface ModelCatalog {
  provider: string;
  models: string[];
  origin: CatalogOrigin;
  /** ISO timestamp of the underlying fetch, when the list came from live/cache. */
  fetchedAt?: string;
}

export interface CatalogSpec {
  /** Adapter name — also the cache filename. */
  provider: string;
  /** Ids that are always acceptable when nothing authoritative is reachable. */
  curated: string[];
  /** Fetch ids from the provider. May throw or return [] when unavailable. */
  fetchLive: () => Promise<string[]>;
  /** How long a cached list is considered fresh. Default 6h. */
  ttlMs?: number;
}

export interface CatalogOptions {
  cacheDir?: string;
  /** Skip the cache and force a live refresh (used by `openswarm provider` refresh paths). */
  forceRefresh?: boolean;
  now?: number;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export function catalogCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OPENSWARM_MODEL_CATALOG_DIR?.trim();
  if (override) return resolve(override);
  return resolve(homedir(), '.openswarm/model-catalogs');
}

interface CachedCatalogFile {
  models: string[];
  fetchedAt: string;
}

function cachePath(provider: string, dir: string): string {
  // Provider names are internal identifiers, but keep the filename defensive:
  // a stray separator would otherwise escape the cache directory.
  const safe = provider.replace(/[^a-zA-Z0-9._-]/g, '_');
  return resolve(dir, `${safe}.json`);
}

export function readCachedCatalog(provider: string, dir = catalogCacheDir()): CachedCatalogFile | null {
  const path = cachePath(provider, dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CachedCatalogFile>;
    if (!Array.isArray(parsed?.models) || parsed.models.length === 0) return null;
    const models = parsed.models.filter((m): m is string => typeof m === 'string' && m.length > 0);
    if (models.length === 0) return null;
    return { models, fetchedAt: String(parsed.fetchedAt ?? '') };
  } catch {
    return null;
  }
}

/** Best-effort — a cache we cannot write degrades to "fetch every time", not to a failure. */
export function writeCachedCatalog(provider: string, models: string[], dir = catalogCacheDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    const payload: CachedCatalogFile = { models, fetchedAt: new Date().toISOString() };
    writeFileSync(cachePath(provider, dir), `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // ignore
  }
}

function isFresh(fetchedAt: string, ttlMs: number, now: number): boolean {
  const t = Date.parse(fetchedAt);
  return Number.isFinite(t) && now - t < ttlMs;
}

/** Order-preserving de-dupe of non-empty ids. */
function normalize(models: string[]): string[] {
  return Array.from(new Set(models.filter((m) => typeof m === 'string' && m.trim().length > 0)));
}

export async function loadModelCatalog(spec: CatalogSpec, options: CatalogOptions = {}): Promise<ModelCatalog> {
  const dir = options.cacheDir ?? catalogCacheDir();
  const ttlMs = spec.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now();
  const cached = readCachedCatalog(spec.provider, dir);

  if (!options.forceRefresh && cached && isFresh(cached.fetchedAt, ttlMs, now)) {
    return { provider: spec.provider, models: cached.models, origin: 'cache', fetchedAt: cached.fetchedAt };
  }

  try {
    const live = normalize(await spec.fetchLive());
    if (live.length > 0) {
      writeCachedCatalog(spec.provider, live, dir);
      return { provider: spec.provider, models: live, origin: 'live', fetchedAt: new Date().toISOString() };
    }
  } catch {
    // Network/auth failure — fall through to whatever we already know.
  }

  if (cached) {
    return { provider: spec.provider, models: cached.models, origin: 'stale-cache', fetchedAt: cached.fetchedAt };
  }
  return { provider: spec.provider, models: normalize(spec.curated), origin: 'curated' };
}

/**
 * Pick the default model, checked against the provider's real catalog.
 *
 * When the catalog is only the curated fallback there is nothing authoritative to
 * check against, so `preferred` is returned untouched — absence of evidence is not
 * evidence the model is gone, and refusing to run offline would be worse. Only a
 * list that actually came from the provider can retire a model id.
 */
export async function resolveDefaultModel(
  spec: CatalogSpec,
  preferred: string,
  options: CatalogOptions & { onWarn?: (message: string) => void } = {},
): Promise<string> {
  const catalog = await loadModelCatalog(spec, options);
  if (catalog.origin === 'curated') return preferred;
  if (catalog.models.includes(preferred)) return preferred;

  // Prefer another curated id the provider still serves over an arbitrary entry —
  // catalog[0] is whatever the API happened to list first, which is not a choice.
  const fallback = spec.curated.find((m) => m !== preferred && catalog.models.includes(m)) ?? catalog.models[0];
  const warn = options.onWarn ?? ((message: string) => console.warn(message));
  warn(
    `[Models] ${spec.provider}: default "${preferred}" is not in the provider's catalog ` +
      `(${catalog.origin}, ${catalog.models.length} models) — falling back to "${fallback}"`,
  );
  return fallback;
}

/**
 * Read model ids from an OpenAI-compatible `/v1/models` response. Shared by every
 * provider that speaks that shape (OpenRouter, Atlas Cloud, LM Studio, Ollama).
 */
export function parseOpenAiModelList(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return normalize(data.map((entry) => String((entry as { id?: unknown })?.id ?? '')));
}
