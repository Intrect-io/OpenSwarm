// ============================================
// OpenSwarm - The runner's handle on the kill switch (AGT-4808, AGT-4809)
// ============================================
//
// What `AutonomousRunner` does with the pause table and the anomaly monitor,
// kept out of the runner (which sits at the repository's per-file line cap)
// so the runner only calls it at its gates.

import type { PipelineResult } from '../agents/pairPipeline.js';
import { isSameProjectOrDescendant, normalizeProjectPath } from '../orchestration/taskScheduler.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import {
  FactoryPauseStore,
  formatPauseLine,
  readPauseSnapshot,
  snapshotBlocks,
  type FactoryPause,
  type PauseSnapshot,
} from './factoryPause.js';
import {
  DEFAULT_ANOMALY_THRESHOLDS,
  checkAnomalies,
  formatAnomalyAlert,
  markAnomalyAlerted,
  pendingAnomalyAlerts,
  type AnomalyThresholds,
} from './anomalyPause.js';

export interface AnomalyHook {
  projects: readonly string[];
  alert: (message: string) => Promise<unknown>;
  /** Per-repository thresholds; defaults to openswarm.json `automation.anomaly` over the built-in defaults. */
  thresholds?: (projectPath: string) => Promise<AnomalyThresholds>;
  /** This heartbeat's low free-disk line (AGT-4785 measurement), when below the floor: pauses the factory (`auto:disk`). */
  diskLow?: string;
}

const warnedMetadata = new Map<string, string>();

/**
 * `automation.anomaly` in the repository's openswarm.json, over the defaults.
 * An unreadable or invalid file falls back to the defaults, with one warning
 * per distinct error per repository (not one per heartbeat).
 */
export async function defaultThresholdsFor(projectPath: string, warn: (line: string) => void = console.warn): Promise<AnomalyThresholds> {
  const metadata = await loadRepoMetadata(projectPath).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (warnedMetadata.get(projectPath) !== message) {
      warnedMetadata.set(projectPath, message);
      warn(`⚠ openswarm.json in ${projectPath} is invalid; anomaly thresholds use the defaults: ${message}`);
    }
    return null;
  });
  if (metadata !== null) warnedMetadata.delete(projectPath);
  return { ...DEFAULT_ANOMALY_THRESHOLDS, ...metadata?.automation?.anomaly };
}

/** How often a serial run polls for a `now` pause, since its heartbeat is blocked awaiting it. */
const SERIAL_PAUSE_POLL_MS = 15_000;

interface PausableScheduler {
  getRunningTasks(): Array<{ task: { id: string }; projectPath?: string }>;
  cancelTask(taskId: string): boolean;
  cancelProjectTasks(projectPath: string): number;
}

interface PausedTask {
  issueId?: string;
  issueIdentifier?: string;
  title: string;
}

/**
 * What `AutonomousRunner` does with the pause table, kept out of the runner so
 * the runner only calls it at its three gates: the heartbeat, the candidate
 * loop, and `executeDurably` (a queued task can start minutes after the
 * heartbeat that admitted it, so that gate re-reads the table).
 */
export class RunnerPauseControl {
  private handle: FactoryPauseStore | undefined;
  private snapshot: PauseSnapshot = { projects: new Map() };
  /** Tasks this control cancelled for a `now` pause; their cancellation is retried, not sent to the tracker. */
  private readonly pauseCancelled = new Set<string>();

  constructor(private readonly resolveDbPath: () => string) {}

  get store(): FactoryPauseStore {
    this.handle ??= new FactoryPauseStore(this.resolveDbPath());
    return this.handle;
  }

  /**
   * Read the table once per heartbeat and act on it. Returns false when nothing
   * may be dispatched this heartbeat (a global pause, or an unreadable table);
   * `blocks()` then answers true for every repository, so the caller can keep
   * its maintenance running and only skip dispatch.
   * `now` pauses cancel matching in-flight runs through the scheduler's abort
   * path, the same one disabling a project uses; `drain` pauses let them finish.
   */
  async apply(scheduler: PausableScheduler, log: (line: string) => void, anomaly?: AnomalyHook, now = Date.now()): Promise<boolean> {
    if (anomaly) await this.checkAnomalies(anomaly, log, now);
    // Task ids are reused on retry: forget pause cancels whose run is gone (its result already consumed the mark).
    const running = new Set(scheduler.getRunningTasks().map((r) => r.task.id));
    for (const id of this.pauseCancelled) if (!running.has(id)) this.pauseCancelled.delete(id);
    const snapshot = readPauseSnapshot(this.store);
    this.snapshot = snapshot;
    if (snapshot.unreadable) {
      log(`⏸ Pause table unreadable, holding dispatch: ${snapshot.unreadable}`);
      return false;
    }
    if (snapshot.global) {
      log(formatPauseLine(snapshot.global, now));
      if (snapshot.global.mode === 'now') {
        let cancelled = 0;
        for (const running of scheduler.getRunningTasks()) {
          this.pauseCancelled.add(running.task.id);
          if (scheduler.cancelTask(running.task.id)) cancelled++;
        }
        if (cancelled > 0) log(`⏹ Cancelled ${cancelled} in-flight task(s) (factory paused --now)`);
      }
      return false;
    }
    for (const [projectPath, pause] of snapshot.projects) {
      log(formatPauseLine(pause, now));
      if (pause.mode !== 'now') continue;
      for (const running of scheduler.getRunningTasks()) {
        // The scheduler's own predicate, so exactly the runs cancelProjectTasks aborts are marked.
        if (running.projectPath && isSameProjectOrDescendant(running.projectPath, projectPath)) this.pauseCancelled.add(running.task.id);
      }
      const cancelled = scheduler.cancelProjectTasks(projectPath);
      if (cancelled > 0) log(`⏹ Cancelled ${cancelled} in-flight task(s) for paused project ${projectPath.split('/').pop()}`);
    }
    return true;
  }

  /**
   * AGT-4809: pause repositories whose signals crossed a threshold (and the
   * factory on low disk), then send each automatic pause's one alert. An alert
   * that throws is logged and left unmarked, so the next heartbeat retries it;
   * one failing alert does not stop the others. Fail-open: a monitor error is
   * logged and dispatch is left to the pause table as it stands.
   */
  private async checkAnomalies(hook: AnomalyHook, log: (line: string) => void, now: number): Promise<void> {
    try {
      const projects = await Promise.all(hook.projects.map(async (projectPath) => ({
        projectPath: normalizeProjectPath(projectPath),
        thresholds: await (hook.thresholds ?? ((p: string) => defaultThresholdsFor(p, log)))(projectPath),
      })));
      checkAnomalies(this.store.path, projects, now, hook.diskLow ? { line: hook.diskLow } : undefined);
      for (const pause of pendingAnomalyAlerts(this.store.path, now)) {
        const alert = formatAnomalyAlert(pause);
        log(alert);
        try {
          await hook.alert(alert);
          markAnomalyAlerted(this.store.path, pause, now);
        } catch (error) {
          log(`⚠ Anomaly alert not sent (retried next heartbeat): ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      log(`⚠ Anomaly check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Whether this task's cancellation came from a `now` pause (consumed once): it is retried, not cancelled on the tracker. */
  consumePauseCancel(taskId: string): boolean {
    return this.pauseCancelled.delete(taskId);
  }

  /**
   * Run a serial (non-scheduler) task with an abort signal a `now` pause can
   * fire. The scheduler cannot reach this run and the heartbeat is blocked
   * awaiting it, so poll the table while it runs.
   */
  async guardSerial<T>(taskId: string, projectPath: string, run: (signal: AbortSignal) => Promise<T>, pollMs = SERIAL_PAUSE_POLL_MS): Promise<T> {
    const controller = new AbortController();
    const timer = setInterval(() => {
      let pause: FactoryPause | undefined;
      try { pause = this.store.blocking(projectPath); } catch { return; /* unreadable: the claim path fails closed */ }
      if (pause?.mode !== 'now') return;
      this.pauseCancelled.add(taskId);
      controller.abort(new Error(`factory paused (now): ${pause.reason}`));
      clearInterval(timer);
    }, pollMs);
    timer.unref?.();
    try {
      return await run(controller.signal);
    } finally {
      clearInterval(timer);
    }
  }

  /** From the last heartbeat's snapshot: whether this repository is paused. An unreadable table blocks everything. */
  blocks(projectPath: string): boolean {
    return !!this.snapshot.unreadable || !!snapshotBlocks(this.snapshot, projectPath);
  }

  /**
   * A fresh read for a task about to execute. Returns the non-executing result
   * to hand back, or undefined to proceed. Fails closed.
   */
  pausedResult(task: PausedTask, projectPath: string): PipelineResult | undefined {
    let reason: string | undefined;
    try {
      reason = this.store.blocking(projectPath)?.reason;
    } catch (error) {
      reason = `pause table unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (reason === undefined) return undefined;
    return {
      success: false,
      sessionId: `factory-paused-${Date.now()}`,
      stages: [],
      finalStatus: 'superseded',
      totalDuration: 0,
      iterations: 0,
      taskContext: {
        issueIdentifier: task.issueIdentifier || task.issueId,
        projectPath,
        taskTitle: `${task.title} (factory paused: ${reason})`,
      },
    };
  }

  /** Dashboard read. */
  list(): { pauses: FactoryPause[]; error?: string } {
    try {
      return { pauses: this.store.list() };
    } catch (error) {
      return { pauses: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  close(): void {
    this.handle?.close();
    this.handle = undefined;
  }
}
