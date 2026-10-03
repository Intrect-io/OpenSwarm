// ============================================
// OpenSwarm - Codex model discovery
// ============================================
//
// Ports the hermes-agent `codex_models.py` pattern: discover the Codex models
// an account can actually use, via the OAuth-backed Codex backend, with offline
// fallbacks. Resolution order:
//   1. live API (chatgpt.com Codex backend) — when an access token is provided
//   2. ~/.codex/config.toml default `model`
//   3. ~/.codex/models_cache.json (the Codex CLI's own cache)
//   4. curated hardcoded fallback
// Clawdbot-style forward-compat synthetic slugs are layered on top so a newer
// model surfaces whenever an older compatible template is present.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { contextWindowFor, writeCachedCatalog } from './modelCatalog.js';

/** Provider key under which the live Codex model windows are cached (AGT-4660). */
const CODEX_CATALOG_PROVIDER = 'codex-responses';

const CODEX_MODELS_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0';
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Curated fallback, used only when live discovery is unavailable (offline first
 * run, transient API failure). `gpt-5-codex` is OpenSwarm's proven default and
 * stays first; the remaining GPT-5.x slugs mirror the Codex OAuth backend
 * catalog. Slugs the backend rejects with HTTP 400 on ChatGPT accounts
 * (gpt-5.2-codex / gpt-5.1-codex-max / gpt-5.1-codex-mini, verified dead in
 * hermes) are deliberately excluded so the picker never leaks a model selection
 * will reject. Live discovery (the primary path when authenticated) overrides
 * this list entirely.
 *
 * GPT-5.6 (sol/terra/luna) launched with a new naming scheme (no `-codex`
 * suffix), verified against a live account's ~/.codex/models_cache.json on
 * 2026-07-10 (priority 1/2/3, ahead of gpt-5.5). That live cache no longer
 * listed gpt-5-codex or gpt-5.3-codex, but this is a single account's
 * snapshot, not confirmation the backend rejects them fleet-wide (unlike the
 * gpt-5.2-codex/etc slugs above, which were verified dead) — both stay in the
 * fallback until that's independently confirmed.
 */
export const DEFAULT_CODEX_MODELS: string[] = [
  'gpt-5-codex',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  // Research-preview, exposed only via the Codex OAuth backend for ChatGPT Pro.
  // The backend reports supported_in_api:false for this slug — that flag is
  // about the public OpenAI API, not the Codex backend, so it is NOT filtered.
  'gpt-5.3-codex-spark',
];

/**
 * Surface a newer synthetic slug whenever a compatible older template model is
 * present (mirrors Clawdbot's forward-compat catalog for GPT-5 Codex variants).
 */
const FORWARD_COMPAT_TEMPLATES: Array<[synthetic: string, templates: string[]]> = [
  ['gpt-5.6-sol', ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex']],
  ['gpt-5.6-terra', ['gpt-5.5', 'gpt-5.4']],
  ['gpt-5.6-luna', ['gpt-5.4-mini']],
  ['gpt-5.5', ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex']],
  ['gpt-5.4-mini', ['gpt-5.3-codex']],
  ['gpt-5.4', ['gpt-5.3-codex']],
  ['gpt-5.3-codex-spark', ['gpt-5.3-codex']],
];

/** De-dupe (order-preserving) then append synthetic forward-compat slugs. */
export function addForwardCompatModels(modelIds: string[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of modelIds) {
    if (!seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }

  for (const [synthetic, templates] of FORWARD_COMPAT_TEMPLATES) {
    if (seen.has(synthetic)) continue;
    if (templates.some((tpl) => seen.has(tpl))) {
      ordered.push(synthetic);
      seen.add(synthetic);
    }
  }

  return ordered;
}

interface CodexModelEntry {
  slug?: unknown;
  visibility?: unknown;
  priority?: unknown;
  context_window?: unknown;
  effective_context_window_percent?: unknown;
}

/**
 * Parse the Codex backend `models` array → `slug → usable context window`.
 *
 * The backend reports `context_window` (272k for the gpt-5.6 family) and
 * `effective_context_window_percent` (95), the share of that window its own
 * client treats as usable. The loop sizes compaction from this number, so the
 * effective share is applied when present. Entries with a missing or invalid
 * window are skipped: an unknown window must stay unknown rather than become 0.
 * Hidden models are kept — a pinned model can be hidden from the list and still
 * be the one a worker runs. (AGT-4660)
 */
export function parseCodexModelWindows(entries: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(entries)) return out;
  for (const item of entries as CodexModelEntry[]) {
    if (!item || typeof item !== 'object') continue;
    const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
    const raw = item.context_window;
    if (!slug || typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) continue;
    const pct = item.effective_context_window_percent;
    const share = typeof pct === 'number' && Number.isFinite(pct) && pct > 0 && pct <= 100 ? pct / 100 : 1;
    out[slug] = Math.floor(raw * share);
  }
  return out;
}

/** Parse the Codex backend `models` array → slugs sorted by priority. */
function parseModelEntries(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];

  const sortable: Array<[rank: number, slug: string]> = [];
  for (const item of entries as CodexModelEntry[]) {
    if (!item || typeof item !== 'object') continue;
    const slug = typeof item.slug === 'string' ? item.slug.trim() : '';
    if (!slug) continue;
    // Do NOT filter on `supported_in_api`: it describes the public OpenAI API,
    // while this provider talks to the same OAuth-backed Codex backend as the
    // Codex CLI (valid slugs like gpt-5.3-codex-spark are marked false there).
    const visibility = typeof item.visibility === 'string' ? item.visibility.trim().toLowerCase() : '';
    if (visibility === 'hide' || visibility === 'hidden') continue;
    const rank = typeof item.priority === 'number' ? item.priority : 10_000;
    sortable.push([rank, slug]);
  }

  sortable.sort((a, b) => (a[0] - b[0]) || a[1].localeCompare(b[1]));
  const deduped: string[] = [];
  for (const [, slug] of sortable) {
    if (!deduped.includes(slug)) deduped.push(slug);
  }
  return deduped;
}

/** Live fetch from the Codex backend. Returns [] on any failure (offline-safe). */
async function fetchModelsFromApi(accessToken: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CODEX_MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: unknown };
    const models = data && typeof data === 'object' ? data.models : undefined;
    const ids = addForwardCompatModels(parseModelEntries(models));
    // Persist the windows for hosts that have no Codex CLI cache (a container):
    // the adapter reads them synchronously per run and must not wait on the
    // network. Best-effort, like every catalog write. (AGT-4660)
    const windows = parseCodexModelWindows(models);
    if (ids.length > 0 && Object.keys(windows).length > 0) {
      writeCachedCatalog(CODEX_CATALOG_PROVIDER, ids, undefined, windows);
    }
    return ids;
  } catch {
    // Network error, abort/timeout, or malformed JSON — fall back to local sources.
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function codexHome(): string {
  const fromEnv = (process.env.CODEX_HOME ?? '').trim();
  return fromEnv || join(homedir(), '.codex');
}

/**
 * Read the top-level default `model` from ~/.codex/config.toml. Minimal TOML
 * scan (no dependency): matches `model = "..."` before the first `[section]`
 * header, mirroring tomllib's top-level `payload["model"]`.
 */
function readDefaultModel(home: string): string | null {
  const configPath = join(home, 'config.toml');
  if (!existsSync(configPath)) return null;
  let text: string;
  try {
    text = readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) break; // entered a section — stop scanning top-level keys
    const match = line.match(/^model\s*=\s*["']([^"']+)["']/);
    if (match) {
      const value = match[1].trim();
      return value || null;
    }
  }
  return null;
}

/** Read the Codex CLI's own model cache (~/.codex/models_cache.json). */
function readCacheModels(home: string): string[] {
  const cachePath = join(home, 'models_cache.json');
  if (!existsSync(cachePath)) return [];
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as { models?: unknown };
    const models = raw && typeof raw === 'object' ? raw.models : undefined;
    return parseModelEntries(models);
  } catch {
    return [];
  }
}

/**
 * The context window the agentic loop should size compaction against for a
 * Codex model, or undefined when no source reports one.
 *
 * Synchronous on purpose, like `contextWindowFor`: the loop reads it once per
 * run. Sources, in order: the catalog cache a live fetch wrote, then the Codex
 * CLI's own `models_cache.json`, which the CLI keeps fresh on any host that
 * runs it. Without this the loop falls back to a fixed 60k and compacts a
 * 272k-window model at under a quarter of its window. (AGT-4660)
 */
export function codexContextWindowFor(
  model: string,
  opts: { home?: string; catalogDir?: string } = {},
): number | undefined {
  const cached = opts.catalogDir === undefined
    ? contextWindowFor(CODEX_CATALOG_PROVIDER, model)
    : contextWindowFor(CODEX_CATALOG_PROVIDER, model, opts.catalogDir);
  if (cached !== undefined) return cached;

  const cachePath = join(opts.home ?? codexHome(), 'models_cache.json');
  if (!existsSync(cachePath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as { models?: unknown };
    const models = raw && typeof raw === 'object' ? raw.models : undefined;
    return parseCodexModelWindows(models)[model];
  } catch {
    return undefined;
  }
}

/**
 * Return available Codex model IDs. Tries the live OAuth backend first (when a
 * token is supplied), then local Codex sources, then the curated fallback.
 * Forward-compat synthetic slugs are applied to whichever source wins.
 */
export async function getCodexModelIds(accessToken?: string): Promise<string[]> {
  if (accessToken) {
    const apiModels = await fetchModelsFromApi(accessToken);
    if (apiModels.length > 0) return apiModels;
  }

  const home = codexHome();
  const ordered: string[] = [];

  const defaultModel = readDefaultModel(home);
  if (defaultModel) ordered.push(defaultModel);

  for (const id of readCacheModels(home)) {
    if (!ordered.includes(id)) ordered.push(id);
  }

  for (const id of DEFAULT_CODEX_MODELS) {
    if (!ordered.includes(id)) ordered.push(id);
  }

  return addForwardCompatModels(ordered);
}
