// ============================================
// OpenSwarm - Project supervisor lifecycle
// ============================================

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cron } from 'croner';
import type { InstructionCapsule } from '../agents/instructionCapsule.js';
import { getEventHub } from '../core/eventHub.js';
import { withFileLock } from '../support/fileLock.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { coordinationStateDir } from './coordinationPaths.js';
import { getCoordinationStore, type CoordinationEvent } from './coordinationStore.js';
import type { RoleMcpPolicy } from './mcpPolicy.js';
import { repositoryCell, type RepositoryCell } from './repositoryCell.js';
import { buildOrchestratorObjective, runOrchestrator, type OrchestratorRunOptions, type OrchestratorRunResult } from './orchestratorAgent.js';
import type { ResolvedOrchestratorConfig } from './orchestratorConfig.js';

export type OrchestratorTrigger = 'cron' | 'coordination-event' | 'manual';

export const ORCHESTRATOR_SUPERVISOR_TASK_ID = 'orchestrator:sweep';

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
  getPending?: (repository: string, repoKey: string) => readonly CoordinationEvent[];
  buildInstructionCapsule: (repository: string) => InstructionCapsule;
  run?: (options: OrchestratorRunOptions) => Promise<OrchestratorRunResult>;
  lockTimeoutMs?: number;
}

function isTerminalFollowUp(event: CoordinationEvent): boolean {
  if (!['completed', 'failed'].includes(event.status)) return false;
  if (event.kind === 'advice-response' || event.kind === 'delegation-result') return true;
  return event.kind === 'thread-update'
    && (event.metadata?.action === 'replied' || event.metadata?.action === 'resolved');
}

function isOneShotFollowUp(event: CoordinationEvent): boolean {
  return (event.kind === 'review-run' && event.status === 'failed') || isTerminalFollowUp(event);
}

function isSupervisorAuthoredEvent(event: CoordinationEvent): boolean {
  return event.actorRole === 'orchestrator'
    && (event.sourceTaskId ?? event.taskId) === ORCHESTRATOR_SUPERVISOR_TASK_ID;
}

/** Requests, findings, and late peer outcomes trigger an immediate paid run. */
export function isActionableOrchestratorEvent(event: CoordinationEvent): boolean {
  // Never recursively wake on the supervisor's own board mutations. A later
  // peer orchestrator response still has a different source task and wakes the
  // repository. Role alone is not ownership of this supervisor lifecycle.
  if (isSupervisorAuthoredEvent(event)) return false;
  if (event.kind === 'review-run' && event.status === 'failed') return true;
  if (isTerminalFollowUp(event)) return true;
  return event.status === 'open'
    && (event.kind === 'advice-request' || event.kind === 'delegation-request' || event.kind === 'thread-update');
}

/**
 * Select the latest item in each exchange that still needs supervision.
 *
 * CoordinationStore.snapshot().pending intentionally contains only non-terminal
 * states. A failed review is terminal for that review run but actionable for
 * the project supervisor, so derive the supervisor view from the full snapshot
 * rather than registering an event trigger that can never reach its objective.
 */
export function selectOrchestratorItems(
  events: readonly CoordinationEvent[],
  handledTerminalThroughSeq = 0,
): CoordinationEvent[] {
  const latest = new Map<string, CoordinationEvent>();
  for (const event of events) {
    const previous = latest.get(event.correlationId);
    if (!previous || event.seq > previous.seq) latest.set(event.correlationId, event);
  }
  return [...latest.values()].filter((event) => {
    if (isSupervisorAuthoredEvent(event)) return false;
    if (['open', 'waiting', 'running'].includes(event.status)) return true;
    return isOneShotFollowUp(event) && event.seq > handledTerminalThroughSeq;
  });
}

function actionableFingerprint(events: readonly CoordinationEvent[]): string {
  const actionable = events
    .filter((event) => event.kind !== 'human-question')
    .map((event) => `${event.fingerprint}:${event.status}`)
    .sort();
  return createHash('sha256').update(actionable.join('\0')).digest('hex');
}

function repositoryLockPath(repoKey: string): string {
  const key = createHash('sha256').update(repoKey).digest('hex').slice(0, 16);
  return join(coordinationStateDir(), 'locks', `orchestrator-${key}.lock`);
}

function repositoryStatePath(repoKey: string): string {
  const key = createHash('sha256').update(repoKey).digest('hex').slice(0, 32);
  return join(coordinationStateDir(), 'orchestrator', `${key}.json`);
}

interface HandledState {
  version: 1 | 2;
  fingerprint: string;
  terminalThroughSeq: number;
}

function readHandledState(repoKey: string): HandledState | undefined {
  const path = repositoryStatePath(repoKey);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    version?: unknown;
    repoKey?: unknown;
    fingerprint?: unknown;
    terminalThroughSeq?: unknown;
  };
  if ((parsed.version !== 1 && parsed.version !== 2)
    || parsed.repoKey !== repoKey
    || typeof parsed.fingerprint !== 'string'
    || (parsed.version === 2
      && (!Number.isSafeInteger(parsed.terminalThroughSeq) || Number(parsed.terminalThroughSeq) < 0))) {
    throw new Error(`Invalid orchestrator state: ${path}`);
  }
  return {
    version: parsed.version,
    fingerprint: parsed.fingerprint,
    // Version 1 proved only a whole-board fingerprint. Treat terminal events as
    // unconsumed until that fingerprint is migrated under the repository lock.
    terminalThroughSeq: parsed.version === 2 ? Number(parsed.terminalThroughSeq) : 0,
  };
}

function writeHandledState(
  cell: RepositoryCell,
  fingerprint: string,
  terminalThroughSeq: number,
): void {
  atomicWriteFileSync(repositoryStatePath(cell.repoKey), `${JSON.stringify({
    version: 2,
    repoKey: cell.repoKey,
    repository: cell.repositoryPath,
    fingerprint,
    terminalThroughSeq,
    handledAt: new Date().toISOString(),
  }, null, 2)}\n`, 0o600);
}

function advancedTerminalCursor(events: readonly CoordinationEvent[], current: number): number {
  return events.reduce(
    (highest, event) => isOneShotFollowUp(event) ? Math.max(highest, event.seq) : highest,
    current,
  );
}

interface PendingSelection {
  events: readonly CoordinationEvent[];
  rawEvents?: readonly CoordinationEvent[];
  handledState?: HandledState;
}

/**
 * Owns cron/event subscriptions and at most one in-process sweep.
 *
 * Bursts are coalesced into the currently running drain loop. A per-repository
 * file lock fences a second daemon/standalone process, while an AbortController
 * lets service shutdown stop the native adapter and wait for its real exit.
 */
export class OrchestratorSupervisor {
  private readonly customGetPending?: (repository: string, repoKey: string) => readonly CoordinationEvent[];
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
    this.customGetPending = options.getPending;
    // The builder itself is cheap; invoking it remains lazy until the board has
    // an actionable generation and this process owns the repository lock.
    this.buildCapsule = options.buildInstructionCapsule;
    this.run = options.run ?? runOrchestrator;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 50;
  }

  private pendingFor(repository: string, repoKey: string): PendingSelection {
    if (this.customGetPending) return { events: this.customGetPending(repository, repoKey) };
    const handledState = readHandledState(repoKey);
    const rawEvents = getCoordinationStore().list({ repository, repoKey, limit: 500 });
    return {
      events: selectOrchestratorItems(rawEvents, handledState?.terminalThroughSeq ?? 0),
      rawEvents,
      handledState,
    };
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
    // Reconcile events committed before this process subscribed. Event-only
    // mode otherwise loses any request published immediately before a crash.
    void this.requestSweep('coordination-event').catch((error) =>
      console.error('[Orchestrator] startup reconciliation failed:', error));
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
    const cells = new Map<string, RepositoryCell>();
    for (const configuredPath of this.options.getRepositories()) {
      const cell = repositoryCell(configuredPath);
      if (!cells.has(cell.repoKey)) cells.set(cell.repoKey, cell);
    }
    for (const cell of cells.values()) {
      if (signal.aborted) break;
      stats.considered++;
      const { repoKey, repositoryPath: repository } = cell;
      const pending = this.pendingFor(repository, repoKey).events;
      const objective = buildOrchestratorObjective(pending);
      if (!objective) {
        stats.noAction++;
        this.lastActionable.delete(repoKey);
        continue;
      }
      const fingerprint = actionableFingerprint(pending);
      if (this.lastActionable.get(repoKey) === fingerprint) {
        stats.unchanged++;
        continue;
      }

      try {
        let result: OrchestratorRunResult | undefined;
        let handledByAnotherProcess = false;
        let lockedFingerprint = fingerprint;
        let handledFingerprint = fingerprint;
        await withFileLock(repositoryLockPath(repoKey), async () => {
          if (signal.aborted) return;
          // Another daemon may have handled or advanced the repository while
          // this process waited for the cross-process lock. Decide again under
          // the same lock that protects the durable handled cursor.
          const selection = this.pendingFor(repository, repoKey);
          const current = selection.events;
          const currentObjective = buildOrchestratorObjective(current);
          if (!currentObjective) return;
          lockedFingerprint = actionableFingerprint(current);
          const handledState = selection.handledState ?? readHandledState(repoKey);
          if (handledState?.fingerprint === lockedFingerprint) {
            if (selection.rawEvents && handledState.version === 1) {
              const terminalThroughSeq = advancedTerminalCursor(current, handledState.terminalThroughSeq);
              const settled = selectOrchestratorItems(selection.rawEvents, terminalThroughSeq);
              handledFingerprint = actionableFingerprint(settled);
              writeHandledState(cell, handledFingerprint, terminalThroughSeq);
            } else {
              handledFingerprint = lockedFingerprint;
            }
            handledByAnotherProcess = true;
            return;
          }
          result = await this.run({
            repository,
            taskId: ORCHESTRATOR_SUPERVISOR_TASK_ID,
            objective: currentObjective,
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
          if (result && !result.skippedReason) {
            const terminalThroughSeq = selection.rawEvents
              ? advancedTerminalCursor(current, handledState?.terminalThroughSeq ?? 0)
              : handledState?.terminalThroughSeq ?? 0;
            const settled = selection.rawEvents
              ? selectOrchestratorItems(selection.rawEvents, terminalThroughSeq)
              : current;
            handledFingerprint = actionableFingerprint(settled);
            writeHandledState(cell, handledFingerprint, terminalThroughSeq);
          }
        }, { timeoutMs: this.lockTimeoutMs });
        if (handledByAnotherProcess) {
          this.lastActionable.set(repoKey, handledFingerprint);
          stats.unchanged++;
          continue;
        }
        if (!result) continue;
        // A provider call that actually completed handled this board generation.
        // Environment skips remain retryable on a later cron/event.
        if (result.skippedReason) {
          stats.skipped++;
        } else {
          stats.ran++;
          this.lastActionable.set(repoKey, handledFingerprint);
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof Error && error.message.includes('Timed out waiting for file lock')) {
          stats.locked++;
          continue;
        }
        stats.failed++;
        // Keep the format string constant: a repository path may contain `%`
        // directives that Node's console formatter would otherwise interpret.
        console.error('[Orchestrator] repository failed:', repository, error);
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
