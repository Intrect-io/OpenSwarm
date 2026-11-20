// Created: 2026-11-20
// Purpose: Wire the daily factory digest (AGT-4810) from the autonomous config:
// its own UTC schedule, the budget's pricing of cost-less attempts, and the
// dashboard route's options. Kept out of service.ts so the wiring is testable
// without booting the service.
import type { AutonomousStartupConfig } from '../core/types.js';
import { setFactoryDigestOptions } from '../support/webFactoryDigest.js';
import { defaultAutomationDbPath } from './automationDbPath.js';
import { DEFAULT_FACTORY_DIGEST_SCHEDULE, startFactoryDigest } from './factoryDigest.js';

/**
 * Start the digest for the previous UTC day, evaluated in UTC so it fires after
 * that day has ended whatever the host timezone. Returns its stop function,
 * which the service must call on shutdown.
 */
export function startConfiguredFactoryDigest(
  autonomous: AutonomousStartupConfig,
  send: (text: string) => Promise<void>,
): () => void {
  const unknownAttemptCostUsd = () => autonomous.spend?.unknownAttemptCostUsd;
  setFactoryDigestOptions({ unknownAttemptCostUsd: unknownAttemptCostUsd() });
  return startFactoryDigest({
    schedule: autonomous.factoryDigest?.schedule || DEFAULT_FACTORY_DIGEST_SCHEDULE,
    timezone: 'UTC',
    dbPath: () => autonomous.automationDbPath ?? defaultAutomationDbPath(),
    send,
    unknownAttemptCostUsd,
  });
}
