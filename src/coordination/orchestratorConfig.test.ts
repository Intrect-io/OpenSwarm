import { describe, expect, it } from 'vitest';
import { resolveOrchestratorConfig } from './orchestratorConfig.js';

describe('resolveOrchestratorConfig', () => {
  it('normalizes an explicit supervisor independently from the worker provider', () => {
    expect(resolveOrchestratorConfig({
      orchestrator: {
        adapter: 'codex-responses',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        eventDriven: true,
      },
      orchestratorSchedule: 'legacy-was-present',
    })).toMatchObject({
      enabled: true,
      adapter: 'codex-responses',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      eventDriven: true,
      legacy: false,
    });
  });

  it('keeps the deprecated schedule cron-only and provider-dynamic', () => {
    expect(resolveOrchestratorConfig({ orchestratorSchedule: '17 */2 * * *' })).toEqual({
      enabled: true,
      schedule: '17 */2 * * *',
      eventDriven: false,
      eventDebounceMs: 1_000,
      adapter: undefined,
      model: undefined,
      reasoningEffort: undefined,
      timeoutMs: 300_000,
      maxTurns: 10,
      legacy: true,
    });
  });

  it('lets the explicit kill switch win over a legacy schedule', () => {
    expect(resolveOrchestratorConfig({
      orchestrator: { enabled: false },
      orchestratorSchedule: '17 */2 * * *',
    })?.enabled).toBe(false);
  });
});
