// ============================================
// OpenSwarm - Project supervisor lifecycle
// ============================================

import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { Cron } from 'croner';
import type { InstructionCapsule } from '../agents/instructionCapsule.js';
import { getEventHub } from '../core/eventHub.js';
import { withFileLock } from '../support/fileLock.js';
import { coordinationStateDir } from './coordinationPaths.js';
import { getCoordinationStore, type CoordinationEvent } from './coordinationStore.js';
import type { RoleMcpPolicy } from './mcpPolicy.js';
import { buildOrchestratorObjective, runOrchestrator, type OrchestratorRunOptions, type OrchestratorRunResult } from './orchestratorAgent.js';
import type { ResolvedOrchestratorConfig } from './orchestratorConfig.js';

export type OrchestratorTrigger = 'cron' | 'coordination-event' | 'manual';

export interface OrchestratorSweepStats {
  trigger: string;
  considered: number;
  ran: number;
  skipped: number;
  noAction: number;
  unchanged: number;
  locked: number;
  failed: number;
}

export interface OrchestratorSupervisorOptions {
  config: ResolvedOrchestratorConfig;
  policy?: RoleMcpPolicy;
  getRepositories: () => string[];
  getPending?: (repository: string) => readonly CoordinationEvent[];
  buildInstructionCapsule: (repository: string) => InstructionCapsule;
  run?: (options: OrchestratorRunOptions) => Promise<OrchestratorRunResult>;
  lockTimeoutMs?: number;
}

/** Only events that represent a request/finding trigger an immediate paid run. */
export function isActionableOrchestratorEvent(event: CoordinationEvent): boolean {
  if (event.kind === 'review-run' && event.status === 'failed') return true;
  return event.status === 'open'
    && (event.kind === 'advice-request' || event.kind === 'delegation-request');
}

/**
 * Select the latest item in each exchange that still needs supervision.
 *
 * CoordinationStore.snapshot().pending intentionally contains only non-terminal
 * states. A failed review is terminal for that review run but actionable for
 * the project supervisor, so derive the supervisor view from the full snapshot
 * rather than registering an event trigger that can never reach its objective.
 */
export function selectOrchestratorItems(events: readonly CoordinationEvent[]): CoordinationEvent[] {
  const latest = new Map<string, CoordinationEvent>();
  for (const event of events) {
    const previous = latest.get(event.correlationId);
    if (!previous || event.seq > previous.seq) latest.set(event.correlationId, event);
  }
  return [...latest.values()].filter((event) =>
    ['open', 'waiting', 'running'].includes(event.status)
    || (event.kind === 'review-run' && event.status === 'failed'));
}

function actionableFingerprint(events: readonly CoordinationEvent[]): string {
  const actionable = events
    .filter((event) => event.kind !== 'human-question')
    .map((event) => `${event.fingerprint}:${event.status}`)
    .sort();
  return createHash('sha256').update(actionable.join('\0')).digest('hex');
}

function repositoryLockPath(repository: string): string {
  const key = createHash('sha256').update(resolve(repository)).digest('hex').slice(0, 16);
  return join(coordinationStateDir(), 'locks', `orchestrator-${key}.lock`);
}

/**
 * Owns cron/event subscriptions and at most one in-process sweep.
 *
 * Bursts are coalesced into the currently running drain loop. A per-repository
 * file lock fences a second daemon/standalone process, while an AbortController
 * lets service shutdown stop the native adapter and wait for its real exit.
 */
export class OrchestratorSupervisor {
  private readonly getPending: (repository: string) => readonly CoordinationEvent[];
  private readonly buildCapsule: (repository: string) => InstructionCapsule;
  private readonly run: (options: OrchestratorRunOptions) => Promise<OrchestratorRunResult>;
  private readonly lockTimeoutMs: number;
  private readonly pendingTriggers = new Set<OrchestratorTrigger>();
  private readonly lastActionable = new Map<string, string>();
  private cron: Cron | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSweep: Promise<void> | null = null;
  private activeAbort: AbortController | null = null;
  private started = false;
  private stopping = false;
  private lastSweep: OrchestratorSweepStats | null = null;

  constructor(private readonly options: OrchestratorSupervisorOptions) {
    this.getPending = options.getPending
      ?? ((repository) => selectOrchestratorItems(getCoordinationStore().snapshot(repository).events));
    // The builder itself is cheap; invoking it remains lazy until the board has
    // an actionable generation and this process owns the repository lock.
    this.buildCapsule = options.buildInstructionCapsule;
    this.run = options.run ?? runOrchestrator;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 50;
  }

  start(): void {
    if (this.started || !this.options.config.enabled) return;

    // Construct cron before subscribing: an invalid expression must leave no
    // half-started event listener behind.
    const cron = this.options.config.schedule
      ? new Cron(this.options.config.schedule, () => {
        void this.requestSweep('cron').catch((error) =>
          console.error('[Orchestrator] cron sweep failed:', error));
      })
      : null;

    this.cron = cron;
    if (this.options.config.eventDriven) {
      getEventHub().on('coordination:published', this.onCoordinationEvent);
    }
    this.started = true;
    this.stopping = false;
  }

  private readonly onCoordinationEvent = (value: unknown): void => {
    const event = value as CoordinationEvent;
    if (!event || !isActionableOrchestratorEvent(event)) return;
    if (this.options.config.eventDebounceMs <= 0) {
      void this.requestSweep('coordination-event').catch((error) =>
        console.error('[Orchestrator] event sweep failed:', error));
      return;
    }
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.requestSweep('coordination-event').catch((error) =>
        console.error('[Orchestrator] event sweep failed:', error));
    }, this.options.config.eventDebounceMs);
  };

  requestSweep(trigger: OrchestratorTrigger = 'manual'): Promise<void> {
    if (this.stopping || !this.options.config.enabled) return Promise.resolve();
    this.pendingTriggers.add(trigger);
    if (this.activeSweep) return this.activeSweep;

    const drain = this.drainSweeps();
    const active = drain.finally(() => {
      if (this.activeSweep === active) this.activeSweep = null;
    });
    this.activeSweep = active;
    return active;
  }

  private async drainSweeps(): Promise<void> {
    while (!this.stopping && this.pendingTriggers.size > 0) {
      const trigger = [...this.pendingTriggers].sort().join('+');
      this.pendingTriggers.clear();
      const controller = new AbortController();
      this.activeAbort = controller;
      try {
        this.lastSweep = await this.runSweep(trigger, controller.signal);
      } finally {
        if (this.activeAbort === controller) this.activeAbort = null;
      }
    }
  }

  private async runSweep(trigger: string, signal: AbortSignal): Promise<OrchestratorSweepStats> {
    const stats: OrchestratorSweepStats = {
      trigger,
      considered: 0,
      ran: 0,
      skipped: 0,
      noAction: 0,
      unchanged: 0,
      locked: 0,
      failed: 0,
    };
    if (!this.options.policy) {
      console.warn('[Orchestrator] no mcpPolicies.orchestrator configured — skipping sweep');
      return stats;
    }

    const repositories = [...new Set(this.options.getRepositories().map((repository) => resolve(repository)))];
    for (const repository of repositories) {
      if (signal.aborted) break;
      stats.considered++;
      const pending = this.getPending(repository);
      const objective = buildOrchestratorObjective(pending);
      if (!objective) {
        stats.noAction++;
        this.lastActionable.delete(repository);
        continue;
      }
      const fingerprint = actionableFingerprint(pending);
      if (this.lastActionable.get(repository) === fingerprint) {
        stats.unchanged++;
        continue;
      }

      try {
        let result: OrchestratorRunResult | undefined;
        await withFileLock(repositoryLockPath(repository), async () => {
          if (signal.aborted) return;
          result = await this.run({
            repository,
            taskId: 'orchestrator:sweep',
            objective,
            policy: this.options.policy,
            adapterName: this.options.config.adapter,
            model: this.options.config.model,
            reasoningEffort: this.options.config.reasoningEffort,
            timeoutMs: this.options.config.timeoutMs,
            maxTurns: this.options.config.maxTurns,
            instructionCapsule: this.buildCapsule(repository),
            trigger,
            signal,
          });
        }, { timeoutMs: this.lockTimeoutMs });
        if (!result) continue;
        // A provider call that actually completed handled this board generation.
        // Environment skips remain retryable on a later cron/event.
        if (result.skippedReason) {
          stats.skipped++;
        } else {
          stats.ran++;
          this.lastActionable.set(repository, fingerprint);
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof Error && error.message.includes('Timed out waiting for file lock')) {
          stats.locked++;
          continue;
        }
        stats.failed++;
        console.error(`[Orchestrator] ${repository} failed:`, error);
      }
    }
    return stats;
  }

  getLastSweep(): OrchestratorSweepStats | null {
    return this.lastSweep ? { ...this.lastSweep } : null;
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      await this.activeSweep?.catch(() => {});
      return;
    }
    this.stopping = true;
    this.cron?.stop();
    this.cron = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    getEventHub().off('coordination:published', this.onCoordinationEvent);
    this.pendingTriggers.clear();
    this.activeAbort?.abort(new Error('OpenSwarm supervisor is stopping'));
    await this.activeSweep?.catch(() => {});
    this.activeSweep = null;
    this.activeAbort = null;
  }
}
