// ============================================
// OpenSwarm - Execution adapter routing policy
// ============================================
//
// The single place that decides which adapter a run may use and why. The worker
// gathers availability (which needs I/O) and this module makes the decision
// (which does not), so the policy stays testable and there is only one copy of
// it to keep in step with the config schema and the docs.

import type { AdapterName } from '../adapters/types.js';

export type AdapterRouteReason = 'primary' | 'quota' | 'infra' | 'capability' | 'explicit';

export interface AdapterRoutePolicy {
  primary: AdapterName;
  fallbacks?: AdapterName[];
  allowReasons?: AdapterRouteReason[];
}

/**
 * Whether the policy permits leaving the primary for this reason.
 *
 * Reasons are typed on purpose: a failing test or a reviewer verdict is a
 * result, not an infrastructure fault, and must never buy a second opinion
 * from another provider.
 */
export function isRouteReasonAllowed(
  policy: AdapterRoutePolicy | undefined,
  reason: AdapterRouteReason,
): boolean {
  return policy?.allowReasons?.includes(reason) === true;
}

export interface AdapterAttemptPlan {
  /** Adapters to try, in order. Never empty. */
  attempts: AdapterName[];
  /** Set when the primary was skipped before it ever ran. */
  skipped?: { adapter: AdapterName; reason: AdapterRouteReason };
}

/**
 * Order the adapters one run may attempt.
 *
 * `available` carries what the caller actually probed; an adapter left
 * `undefined` is treated as available, so an unprobed primary is never dropped
 * on a guess. A primary known to be missing is skipped outright when the policy
 * allows capability routing — every attempt on it would fail identically, and
 * discovering that costs a whole run.
 */
export function planAdapterAttempts(input: {
  policy?: AdapterRoutePolicy;
  primary: AdapterName;
  available: Partial<Record<AdapterName, boolean>>;
}): AdapterAttemptPlan {
  const { policy, primary, available } = input;
  // A policy written for a different primary than the one this run uses does
  // not apply: silently routing anyway would ignore the operator's `adapter:`.
  if (!policy || policy.primary !== primary) return { attempts: [primary] };

  const fallbacks = (policy.fallbacks ?? []).filter(
    (candidate) => candidate !== primary && available[candidate] === true,
  );
  const attempts = [...new Set<AdapterName>([primary, ...fallbacks])];
  if (attempts.length > 1 && available[primary] === false && isRouteReasonAllowed(policy, 'capability')) {
    return { attempts: attempts.slice(1), skipped: { adapter: primary, reason: 'capability' } };
  }
  return { attempts };
}
