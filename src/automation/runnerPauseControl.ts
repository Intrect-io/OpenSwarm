// ============================================
// OpenSwarm - The runner's handle on the kill switch (AGT-4808, AGT-4809)
// ============================================
//
// What `AutonomousRunner` does with the pause table and the anomaly monitor,
// kept out of the runner (which sits at the repository's per-file line cap)
// so the runner only calls it at its gates.

import type { PipelineResult } from '../agents/pairPipeline.js';
import { normalizeProjectPath } from '../orchestration/taskScheduler.js';
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
  recordFactorySignal,
  type AnomalyThresholds,
} from './anomalyPause.js';

export interface AnomalyHook {
  projects: readonly string[];
  alert: (message: string) => Promise<unknown>;
  /** Per-repository thresholds; defaults to openswarm.json `automation.anomaly` over the built-in defaults. */
  thresholds?: (projectPath: string) => Promise<AnomalyThresholds>;
}

/** `automation.anomaly` in the repository's openswarm.json, over the defaults. */
export async function defaultThresholdsFor(projectPath: string): Promise<AnomalyThresholds> {
  const metadata = await loadRepoMetadata(projectPath).catch(() => null);
  return { ...DEFAULT_ANOMALY_THRESHOLDS, ...metadata?.automation?.anomaly };
}

interface PausableScheduler {
  getRunningTasks(): Array<{ task: { id: string } }>;
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

  constructor(private readonly resolveDbPath: () => string) {}

  get store(): FactoryPauseStore {
    this.handle ??= new FactoryPauseStore(this.resolveDbPath());
    return this.handle;
  }

  /**
   * Read the table once per heartbeat and act on it. Returns false when nothing
   * may be dispatched this heartbeat (a global pause, or an unreadable table).
   * `now` pauses cancel matching in-flight runs through the scheduler's abort
   * path, the same one disabling a project uses; `drain` pauses let them finish.
   */
  async apply(scheduler: PausableScheduler, log: (line: string) => void, anomaly?: AnomalyHook, now = Date.now()): Promise<boolean> {
    if (anomaly) await this.checkAnomalies(anomaly, log, now);
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
          if (scheduler.cancelTask(running.task.id)) cancelled++;
        }
        if (cancelled > 0) log(`⏹ Cancelled ${cancelled} in-flight task(s) (factory paused --now)`);
      }
      return false;
    }
    for (const [projectPath, pause] of snapshot.projects) {
      log(formatPauseLine(pause, now));
      if (pause.mode !== 'now') continue;
      const cancelled = scheduler.cancelProjectTasks(projectPath);
      if (cancelled > 0) log(`⏹ Cancelled ${cancelled} in-flight task(s) for paused project ${projectPath.split('/').pop()}`);
    }
    return true;
  }

  /**
   * AGT-4809: pause repositories whose signals crossed a threshold, one alert
   * per new pause. Fail-open: a monitor error is logged and dispatch is left to
   * the pause table as it stands.
   */
  private async checkAnomalies(hook: AnomalyHook, log: (line: string) => void, now: number): Promise<void> {
    try {
      const projects = await Promise.all(hook.projects.map(async (projectPath) => ({
        projectPath: normalizeProjectPath(projectPath),
        thresholds: await (hook.thresholds ?? defaultThresholdsFor)(projectPath),
      })));
      for (const result of checkAnomalies(this.store.path, projects, now)) {
        if (!result.paused) continue;
        const alert = formatAnomalyAlert(result);
        log(alert);
        await hook.alert(alert);
      }
    } catch (error) {
      log(`⚠ Anomaly check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** From the last heartbeat's snapshot: whether this repository is paused. */
  blocks(projectPath: string): boolean {
    return !!snapshotBlocks(this.snapshot, projectPath);
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

  /** Record a PR the runner just opened, for the PR-rate signal. Never throws. */
  recordPrOpened(projectPath: string, prUrl: string, issueId?: string): void {
    recordFactorySignal({ projectPath: normalizeProjectPath(projectPath), kind: 'pr_opened', issueId, detail: prUrl }, this.store.path);
  }

  close(): void {
    this.handle?.close();
    this.handle = undefined;
  }
}
