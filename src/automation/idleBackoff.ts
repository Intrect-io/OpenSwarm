// ============================================
// OpenSwarm - Idle heartbeat backoff + progress clock (AGT-4607)
// ============================================
//
// An idle daemon on vela burned 200% CPU for four days: every cron tick
// re-fetched the same Linear set and skipped every issue for the same reason,
// while the container reported healthy. This module turns that silent loop
// into a visible, cheaper one and gives the health endpoint a "last progress"
// clock to tell "running" apart from "working".
//
// Definitions:
//
// - A heartbeat REACHES SELECTION once its Linear fetch succeeded
//   (`beginSelection`). Heartbeats that return before that point - time
//   window, disk / rate-limit hold, factory pause, fetch error - neither count
//   toward a streak nor reset it: they are holds, not idleness.
// - An EMPTY SELECTION is a heartbeat that reached selection, saw no progress
//   event while it ran, and ended with nothing queued or running in the
//   scheduler. "All slots busy" therefore never counts: running work is not
//   idleness, and its completion re-fires the heartbeat anyway.
// - PROGRESS is a task being enqueued, started (claimed) or completed by the
//   scheduler, or picked by the serial-mode decision engine
//   (`markProgress`). Any progress resets the streak and the interval.
//
// Backoff: after `emptyThreshold` (default 3) consecutive empty selections the
// heartbeat interval doubles on each further empty selection - 2x, 4x, 8x the
// cron cadence - capped at `maxMultiplier` (default 8) and at `maxIntervalMs`
// (default 1 h) of wall time when the cron cadence is known. The stretch is
// applied by skipping cron ticks, so the configured schedule is untouched.
// Only cron ticks are gated: direct heartbeat() calls (startup, the dashboard
// button, completion re-fires) always run. One log line containing
// "consecutive empty selections" is emitted per streak, not per heartbeat.
// An explicit runNow() / operator dispatch resets to the base interval.

import { EventEmitter } from 'node:events';
import { Cron } from 'croner';

export const DEFAULT_EMPTY_SELECTION_THRESHOLD = 3;
export const DEFAULT_MAX_BACKOFF_MULTIPLIER = 8;
export const DEFAULT_MAX_BACKOFF_INTERVAL_MS = 60 * 60 * 1000;

export interface IdleBackoffOptions {
  emptyThreshold?: number;
  maxMultiplier?: number;
  maxIntervalMs?: number;
  /** Cron cadence in ms; when known, caps the stretch at `maxIntervalMs`. */
  baseIntervalMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

/** The `progress` block of GET /api/health. */
export interface ProgressHealth {
  /** True while the autonomous heartbeat cron is scheduled (not explicit-dispatch mode, not stopped). */
  active: boolean;
  /** ISO time of the last progress event; null when none happened since boot. */
  lastProgressAt: string | null;
  /** Age of the last progress event, measured from boot when none happened yet. */
  lastProgressAgeMs: number;
  lastHeartbeatAt: string | null;
  /** Age of the last heartbeat start, measured from boot when none ran yet. */
  lastHeartbeatAgeMs: number;
  consecutiveEmptySelections: number;
  /** Current heartbeat interval as a multiple of the cron cadence (1 = base). */
  heartbeatIntervalMultiplier: number;
}

export class IdleBackoff {
  private readonly emptyThreshold: number;
  private readonly maxMultiplier: number;
  private readonly maxIntervalMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private baseIntervalMs: number | undefined;
  private readonly createdAt: number;

  private consecutiveEmpty = 0;
  private multiplier = 1;
  private ticksSinceRun = 0;
  private streakLogged = false;
  private selecting = false;
  private progressThisHeartbeat = false;
  private lastProgressAt: number | null = null;
  private lastHeartbeatAt: number | null = null;

  constructor(options: IdleBackoffOptions = {}) {
    this.emptyThreshold = Math.max(1, options.emptyThreshold ?? DEFAULT_EMPTY_SELECTION_THRESHOLD);
    this.maxMultiplier = Math.max(1, options.maxMultiplier ?? DEFAULT_MAX_BACKOFF_MULTIPLIER);
    this.maxIntervalMs = options.maxIntervalMs ?? DEFAULT_MAX_BACKOFF_INTERVAL_MS;
    this.baseIntervalMs = options.baseIntervalMs;
    this.log = options.log ?? ((line) => console.log(line));
    this.now = options.now ?? Date.now;
    this.createdAt = this.now();
  }

  setBaseIntervalMs(ms: number | undefined): void {
    this.baseIntervalMs = ms && ms > 0 ? ms : undefined;
  }

  /** Effective cap: `maxMultiplier`, further bounded by `maxIntervalMs` when the cadence is known. */
  private cap(): number {
    if (!this.baseIntervalMs) return this.maxMultiplier;
    return Math.max(1, Math.min(this.maxMultiplier, Math.floor(this.maxIntervalMs / this.baseIntervalMs)));
  }

  /** Cron tick gate: true when this tick should run a heartbeat. */
  shouldRunTick(): boolean {
    this.ticksSinceRun++;
    if (this.ticksSinceRun < this.multiplier) return false;
    this.ticksSinceRun = 0;
    return true;
  }

  beginHeartbeat(): void {
    this.lastHeartbeatAt = this.now();
    this.ticksSinceRun = 0;
    this.selecting = false;
    this.progressThisHeartbeat = false;
  }

  /** The heartbeat fetched its candidates; from here an empty result counts. */
  beginSelection(): void {
    this.selecting = true;
  }

  /** A task was enqueued, claimed, completed, or picked by the serial engine. */
  markProgress(): void {
    this.lastProgressAt = this.now();
    this.progressThisHeartbeat = true;
    this.reset('task selected');
  }

  /** Back to the base interval (progress, runNow, operator dispatch). */
  reset(reason: string): void {
    if (this.streakLogged) this.log(`[IdleBackoff] ${reason} — heartbeat back to the base interval after ${this.consecutiveEmpty} empty heartbeats`);
    this.consecutiveEmpty = 0;
    this.multiplier = 1;
    this.ticksSinceRun = 0;
    this.streakLogged = false;
  }

  /**
   * Close a heartbeat. `schedulerLoad` reports queued/running work; work in
   * the scheduler means busy, not idle. An unreadable load also counts as busy
   * (fail toward the base interval, never toward backing off).
   */
  endHeartbeat(schedulerLoad: () => { queued: number; running: number }): void {
    const reachedSelection = this.selecting;
    this.selecting = false;
    if (!reachedSelection || this.progressThisHeartbeat) return;
    try {
      const load = schedulerLoad();
      if (load.queued > 0 || load.running > 0) return;
    } catch {
      return;
    }
    this.consecutiveEmpty++;
    if (this.consecutiveEmpty < this.emptyThreshold) return;
    this.multiplier = Math.min(this.cap(), this.multiplier * 2);
    if (this.streakLogged) return;
    this.streakLogged = true;
    const every = this.baseIntervalMs ? ` (~${Math.round((this.multiplier * this.baseIntervalMs) / 60_000)}min)` : '';
    this.log(`[IdleBackoff] ${this.consecutiveEmpty} consecutive empty selections — heartbeat interval stretched to ${this.multiplier}x${every}, doubling per further empty selection up to ${this.cap()}x; resets when a task is selected`);
  }

  getMultiplier(): number {
    return this.multiplier;
  }

  getConsecutiveEmpty(): number {
    return this.consecutiveEmpty;
  }

  snapshot(active: boolean): ProgressHealth {
    const now = this.now();
    return {
      active,
      lastProgressAt: this.lastProgressAt === null ? null : new Date(this.lastProgressAt).toISOString(),
      lastProgressAgeMs: now - (this.lastProgressAt ?? this.createdAt),
      lastHeartbeatAt: this.lastHeartbeatAt === null ? null : new Date(this.lastHeartbeatAt).toISOString(),
      lastHeartbeatAgeMs: now - (this.lastHeartbeatAt ?? this.createdAt),
      consecutiveEmptySelections: this.consecutiveEmpty,
      heartbeatIntervalMultiplier: this.multiplier,
    };
  }

  /** Scheduler events that count as progress. */
  attach(scheduler: EventEmitter): void {
    for (const event of ['enqueued', 'started', 'completed']) scheduler.on(event, () => this.markProgress());
  }
}

// ---- health registry ----

let progressSource: { idle: IdleBackoff; active: () => boolean } | null = null;

/** Register the runner whose progress GET /api/health reports. */
export function registerProgressSource(idle: IdleBackoff, active: () => boolean): void {
  progressSource = { idle, active };
}

export function clearProgressSource(): void {
  progressSource = null;
}

/** Null until a runner registered, so the health contract is unchanged without one. */
export function progressHealthSnapshot(): ProgressHealth | null {
  return progressSource ? progressSource.idle.snapshot(progressSource.active()) : null;
}

function cronCadenceMs(cron: Cron): number | undefined {
  try {
    const [a, b] = cron.nextRuns(2);
    return a && b ? b.getTime() - a.getTime() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The heartbeat cron, gated by the idle backoff and registered as the health
 * progress source. Only ticks are gated; `run` itself is the plain heartbeat.
 */
export function createHeartbeatCron(schedule: string, idle: IdleBackoff, run: () => Promise<void>): Cron {
  const cron = new Cron(schedule, async () => {
    if (idle.shouldRunTick()) await run();
  });
  idle.setBaseIntervalMs(cronCadenceMs(cron));
  registerProgressSource(idle, () => !cron.isStopped());
  return cron;
}
