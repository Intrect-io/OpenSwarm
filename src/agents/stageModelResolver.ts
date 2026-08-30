// ============================================
// OpenSwarm - Stage model resolution (INT-2393)
// ============================================

import { getAdapter, resolveBoundarySafeDefaultModel } from '../adapters/index.js';

/**
 * Resolve (and cache) an adapter's default model. `getDefaultModel` is heavy
 * (OAuth + live catalog), so results are cached per adapter name; failures
 * degrade to undefined. Used to fill the display model when a role omits it and
 * relies on the adapter default, so the TUI/dashboard aren't left blank.
 */
export function resolveAdapterDefaultModel(
  adapterName: string | undefined,
  cache: Map<string, Promise<string | undefined>>,
): Promise<string | undefined> {
  const cacheKey = adapterName ?? '<default>';
  let pending = cache.get(cacheKey);
  if (!pending) {
    pending = Promise.resolve()
      .then(() => resolveBoundarySafeDefaultModel(getAdapter(adapterName)))
      .catch(() => {
        // Drop the failure from the cache so a later call tries again. Storing
        // it meant one transient lookup error — a provider blip during startup
        // — left this adapter's displayed model blank for the whole process,
        // with no way to recover short of a restart.
        cache.delete(cacheKey);
        return undefined;
      });
    cache.set(cacheKey, pending);
  }
  return pending;
}
