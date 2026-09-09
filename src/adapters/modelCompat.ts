// ============================================
// OpenSwarm — provider/model compatibility
// ============================================
//
// One source of truth for "does this model id belong to that adapter?". Used
// by the provider switch (role/jobProfile/planner remapping) and the planner's
// model guard, so a config pinned for one provider never leaks an incompatible
// id into another provider's CLI/API. Observed failure without this:
// decomposition.plannerModel 'gpt-5.5' reaching `claude -p --model gpt-5.5`
// → API 404 on every decomposition attempt. (INT-2510)

import type { AdapterName } from './types.js';
import { ATLASCLOUD_CURATED_MODELS } from './atlascloud.js';
import { readCachedCatalog } from './modelCatalog.js';

/** Version-agnostic aliases the claude CLI resolves natively. */
const CLAUDE_ALIASES = new Set(['sonnet', 'opus', 'haiku']);

/**
 * Synchronous default-model lookup for the discard warning. The real default is
 * resolved async via the adapter's getDefaultModel() (which may consult a live
 * catalog), so this is only the static fallback constant each adapter ships
 * with — enough to tell the operator what a rejected model is being replaced
 * by. Kept in sync with the adapter modules' exported DEFAULT_MODEL constants.
 */
const ADAPTER_DEFAULT_MODEL: Partial<Record<AdapterName, string>> = {
  'codex-responses': 'gpt-5.6-terra',
  codex: 'gpt-5-codex',
  openrouter: 'openai/gpt-5',
  claude: 'sonnet',
  gpt: 'gpt-5',
  cursor: 'gpt-5',
  local: 'gpt-5',
  lmstudio: 'gpt-5',
  atlascloud: 'atlascloud/default',
};

function isAtlasCloudModel(id: string): boolean {
  // Fast path: atlascloud models always start with 'atlascloud/'
  if (id.startsWith('atlascloud/')) return true;
  // Fallback: check against the curated model list (may be stale if catalog
  // has been refreshed, but good enough for a compatibility guard).
  if (ATLASCLOUD_CURATED_MODELS.includes(id)) return true;
  // Expensive path: consult the live catalog if available.
  const catalog = readCachedCatalog('atlascloud');
  return catalog?.models?.some((m: { id: string }) => m.id === id) ?? false;
}

/**
 * Keep `model` only if it clearly belongs to `adapter`; otherwise return
 * undefined so the target adapter resolves its own default via
 * getDefaultModel(). No hardcoded per-provider model ids beyond stable
 * prefixes/aliases.
 *
 * When a model is rejected, logs a warning with the role (if provided),
 * the rejected model id, the adapter name, and the replacement default so the
 * operator can see what happened instead of discovering it silently at runtime.
 */
export function mapModelForProvider(
  adapter: AdapterName,
  model: string | undefined,
  role?: string,
): string | undefined {
  const current = (model || '').trim();
  if (!current) return undefined;

  const accepted = ((): string | undefined => {
    if (adapter === 'codex' || adapter === 'codex-responses' || adapter === 'cc-router') {
      // ChatGPT-account Codex only runs gpt-* slugs; anything else → adapter default.
      return current.startsWith('gpt-') ? current : undefined;
    }
    if (adapter === 'cursor') {
      return current;
    }
    if (adapter === 'claude') {
      // The claude CLI accepts claude-* ids and version-agnostic aliases.
      return current.startsWith('claude-') || CLAUDE_ALIASES.has(current) ? current : undefined;
    }
    if (adapter === 'atlascloud') {
      // Unlike gpt-*/claude-*, Atlas ids have no shared prefix — check membership
      // against its own catalog instead.
      return isAtlasCloudModel(current) ? current : undefined;
    }
    // openrouter/gpt/local/lmstudio: a namespaced id ("vendor/model") may carry
    // over; a bare id from another provider usually won't — drop to the default.
    // Exclude ids that are recognizably Atlas Cloud's own namespace so a switch
    // away from atlascloud doesn't leak its id into these instead.
    return current.includes('/') && !isAtlasCloudModel(current) ? current : undefined;
  })();

  if (accepted === undefined) {
    const tag = role ? `Role ${role} ` : '';
    const replacement = ADAPTER_DEFAULT_MODEL[adapter] ?? 'adapter default';
    console.log(
      `[modelCompat] ${tag}model ${current} rejected for ${adapter}, using default ${replacement}`,
    );
  }

  return accepted;
}