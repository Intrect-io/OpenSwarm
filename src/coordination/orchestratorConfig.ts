// ============================================
// OpenSwarm - Supervisor configuration normalization
// ============================================

import type { AdapterName } from '../adapters/types.js';
import type { OrchestratorConfig } from '../core/types.js';

export interface ResolvedOrchestratorConfig {
  enabled: boolean;
  schedule?: string;
  eventDriven: boolean;
  eventDebounceMs: number;
  adapter?: AdapterName;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  timeoutMs: number;
  maxTurns: number;
  /** True when the deprecated schedule-only surface produced this config. */
  legacy: boolean;
}

/**
 * Resolve both configuration generations at the runner boundary.
 *
 * Config files parsed by Zod already carry the explicit defaults, but tests and
 * embedded users construct `AutonomousConfig` directly. Normalizing here keeps
 * those callers equivalent. A legacy `orchestratorSchedule` deliberately keeps
 * the old provider/default-model behavior and cron-only trigger semantics.
 */
export function resolveOrchestratorConfig(input: {
  orchestrator?: OrchestratorConfig;
  orchestratorSchedule?: string;
}): ResolvedOrchestratorConfig | undefined {
  if (input.orchestrator) {
    return {
      enabled: input.orchestrator.enabled ?? true,
      schedule: input.orchestrator.schedule,
      eventDriven: input.orchestrator.eventDriven ?? true,
      eventDebounceMs: input.orchestrator.eventDebounceMs ?? 1_000,
      adapter: input.orchestrator.adapter,
      model: input.orchestrator.model,
      reasoningEffort: input.orchestrator.reasoningEffort,
      timeoutMs: input.orchestrator.timeoutMs ?? 600_000,
      maxTurns: input.orchestrator.maxTurns ?? 12,
      legacy: false,
    };
  }
  if (!input.orchestratorSchedule) return undefined;
  return {
    enabled: true,
    schedule: input.orchestratorSchedule,
    eventDriven: false,
    eventDebounceMs: 1_000,
    // Undefined preserves the previous daemon-default adapter and model.
    adapter: undefined,
    model: undefined,
    reasoningEffort: undefined,
    timeoutMs: 300_000,
    maxTurns: 10,
    legacy: true,
  };
}
