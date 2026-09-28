// ============================================
// OpenSwarm - `advisor` role resolution (review command layer)
// ============================================
//
// One place that answers "is the review advisor on, and on which model" so the
// three review entry points cannot drift: `runReviewAdvisor` receives the
// answer, and none of them reads config on its own.
//
// It lives at the CLI layer deliberately. `runReviewCommand` is documented not
// to read config it does not need — `loadConfig` flips process-wide toggles
// (human-surface read-only, the sandbox executor wiring) and logs to stdout, so
// resolving the advisor inside it changed behaviour for reviews that had
// nothing to do with the advisor, and broke that command's own test.
//
// `loadConfig` also writes to stdout, which lands in front of a `--json`
// document and makes `openswarm review --json | jq` fail to parse. Silenced
// around the call here, the same way `resolveConfiguredReviewAdapter` does it
// and for the same reason. That pattern is duplicated a third time by this
// module — AGT-4298 tracks collapsing all of them into `loadConfig` itself.

import type { RoleConfig } from '../core/types.js';

/** What the review paths need from the `advisor` role. */
export type AdvisorRole = Pick<RoleConfig, 'model' | 'timeoutMs'>;

/**
 * Resolve the `advisor` role, or `undefined` when it is disabled or unreadable.
 *
 * Every failure is a "disabled", never a throw: the advisor is an extra net
 * over the reviewer, so a net that cannot be configured must leave the review
 * exactly as it would have been. An absent role means the pass does not run at
 * all — no call, no latency, no cost.
 */
export async function resolveAdvisorRole(
  deps: { loadConfig?: () => { autonomous?: { defaultRoles?: { advisor?: RoleConfig } } } } = {},
): Promise<AdvisorRole | undefined> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  try {
    console.log = () => undefined;
    console.warn = () => undefined;
    const load = deps.loadConfig ?? (await import('../core/config.js')).loadConfig;
    const advisor = load().autonomous?.defaultRoles?.advisor;
    if (!advisor || advisor.enabled === false) return undefined;
    return { model: advisor.model, timeoutMs: advisor.timeoutMs };
  } catch {
    return undefined;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}
