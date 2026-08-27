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
 * Atlas Cloud and OpenRouter both name models "vendor/model", but the vendor
 * slugs are different catalogs (OpenRouter's `z-ai/glm-5.2` vs Atlas's own
 * `zai-org/GLM-4.6`) — so the generic "keep any namespaced id" rule below
 * silently let an OpenRouter-configured model through to Atlas's API, which
 * 400s on every call because the id doesn't exist there. Checked against the
 * curated list first (no I/O), then the on-disk catalog cache `openswarm
 * provider`/listModels() already populates from Atlas's live `/v1/models`.
 */
function isAtlasCloudModel(id: string): boolean {
  if (ATLASCLOUD_CURATED_MODELS.includes(id)) return true;
  return readCachedCatalog('atlascloud')?.models.includes(id) ?? false;
}

/**
 * Keep `model` only if it clearly belongs to `adapter`; otherwise return
 * undefined so the target adapter resolves its own default via
 * getDefaultModel(). No hardcoded per-provider model ids beyond stable
 * prefixes/aliases.
 */
export function mapModelForProvider(adapter: AdapterName, model: string | undefined): string | undefined {
  const current = (model || '').trim();
  if (!current) return undefined;
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
}
