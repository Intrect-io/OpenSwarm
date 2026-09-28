// ============================================
// OpenSwarm - vela autodeploy gate decisions (AGT-4182)
// ============================================
//
// Pure checklist used by host `vela-autodeploy.sh`. Kept as TypeScript so CI
// can lock the skip reasons without SSH to rtx; the shell script is the
// runtime. Keep reason strings in sync with the script's `SKIP` log lines.
// Must match `ACTIVE_LEASE_STATES` in `src/automation/runLedgerTypes.ts` (set equality).

export const AUTODEPLOY_ACTIVE_LEDGER_STATES = [
  'VERIFYING',
  'PUBLISHING',
  'EXECUTING',
  'CLAIMED',
] as const;

export const AUTODEPLOY_RATE_LIMIT_MIN_DEFAULT = 55;

export type AutodeployGateInput = {
  mainSha: string;
  lastBuiltSha: string | null;
  /** null = sqlite/DB unavailable (fail closed / skip). */
  ledgerActiveCount: number | null;
  /** Minutes since container StartedAt; null = not running / inspect failed. */
  containerAgeMinutes: number | null;
  rateLimitMin?: number;
};

export type AutodeployGateDecision =
  | { action: 'skip'; reason: string }
  | { action: 'deploy' };

/**
 * Decide whether the autodeploy lane should build+deploy this tick.
 * Order matches `vela-autodeploy.sh` steps 1→4 (CI trust is implicit).
 */
export function decideAutodeployGate(input: AutodeployGateInput): AutodeployGateDecision {
  const rateLimitMin = input.rateLimitMin ?? AUTODEPLOY_RATE_LIMIT_MIN_DEFAULT;

  if (input.lastBuiltSha !== null && input.lastBuiltSha === input.mainSha) {
    return {
      action: 'skip',
      reason: `running image already built from ${input.mainSha}`,
    };
  }

  if (input.ledgerActiveCount === null) {
    return {
      action: 'skip',
      reason: 'cannot query automation DB — daemon may be down or starting',
    };
  }

  if (input.ledgerActiveCount > 0) {
    return {
      action: 'skip',
      reason: `ledger has ${input.ledgerActiveCount} active run(s) in VERIFYING/PUBLISHING/EXECUTING/CLAIMED`,
    };
  }

  if (
    input.containerAgeMinutes !== null
    && input.containerAgeMinutes < rateLimitMin
  ) {
    return {
      action: 'skip',
      reason: `container started ${input.containerAgeMinutes}m ago (< ${rateLimitMin}m rate limit)`,
    };
  }

  return { action: 'deploy' };
}
