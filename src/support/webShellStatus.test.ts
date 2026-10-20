import { describe, expect, it } from 'vitest';
import { buildShellStatus, type ShellStatusRunner } from './webShellStatus.js';
import type { CoordinationEvent } from '../coordination/coordinationStore.js';

const event = (kind: string): CoordinationEvent => ({ kind } as unknown as CoordinationEvent);

function runner(over: Partial<{ isRunning: boolean; parked: number; startedAt: number | null; adapterFails: boolean }> = {}): ShellStatusRunner {
  return {
    getStats: () => ({ isRunning: over.isRunning ?? true, automationLedger: { byState: { NEEDS_HUMAN: over.parked ?? 0, RUNNING: 3 } } }),
    getState: () => ({ startedAt: over.startedAt === undefined ? 1_000 : over.startedAt }),
    getAdapterSummary: async () => {
      if (over.adapterFails) throw new Error('model catalog unreachable');
      return { defaultAdapter: 'codex-responses', worker: { model: 'gpt-5.6-terra' } };
    },
  };
}

describe('buildShellStatus', () => {
  it('says dashboard-only, with the reason, when no runner is attached', async () => {
    const status = await buildShellStatus({ pendingEvents: () => [event('human-question')], now: () => 5_000 });
    expect(status).toEqual({
      daemon: { state: 'dashboard-only', reason: 'No daemon runner is attached to this dashboard', uptimeMs: null },
      provider: null,
      needsYou: { questions: 1, parked: 0, total: 1 },
      tracker: 'local',
      generatedAt: 5_000,
    });
  });

  it('names the tracker the daemon reads issues from', async () => {
    expect((await buildShellStatus({ pendingEvents: () => [], linearConfigured: () => true })).tracker).toBe('linear');
    expect((await buildShellStatus({ runner: runner(), pendingEvents: () => [], linearConfigured: () => false })).tracker).toBe('local');
  });

  it('counts parked runs and open human questions, not other pending exchanges', async () => {
    const status = await buildShellStatus({
      runner: runner({ parked: 2 }),
      pendingEvents: () => [event('human-question'), event('advice-request'), event('delegation-request')],
      now: () => 61_000,
    });
    expect(status.needsYou).toEqual({ questions: 1, parked: 2, total: 3 });
    expect(status.daemon).toEqual({ state: 'running', reason: null, uptimeMs: 60_000 });
    expect(status.provider).toEqual({ adapter: 'codex-responses', model: 'gpt-5.6-terra' });
  });

  it('reports a stopped loop with its reason and no uptime', async () => {
    const status = await buildShellStatus({ runner: runner({ isRunning: false }), pendingEvents: () => [] });
    expect(status.daemon).toEqual({ state: 'stopped', reason: 'The autonomous loop is not running', uptimeMs: null });
  });

  it('still answers when the provider summary cannot be resolved', async () => {
    const status = await buildShellStatus({ runner: runner({ adapterFails: true }), pendingEvents: () => [] });
    expect(status.provider).toBeNull();
    expect(status.daemon.state).toBe('running');
  });
});
