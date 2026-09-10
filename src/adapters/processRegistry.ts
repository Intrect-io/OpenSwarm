// ============================================
// OpenSwarm - Process Registry
// Global singleton for tracking spawned CLI processes
// ============================================

import type { ChildProcess } from 'node:child_process';
import { broadcastEvent } from '../core/eventHub.js';
import { signalCliProcessTree, terminateCliProcessTree } from './processTree.js';

// Types

export interface ProcessInfo {
  pid: number;
  taskId: string;
  stage: string;
  model?: string;
  projectPath: string;
  spawnedAt: number;
  lastActivityAt: number;
}

// Registry (singleton)

const registry = new Map<number, ProcessInfo>();
const processHandles = new Map<number, ChildProcess>();
let healthCheckTimer: NodeJS.Timeout | null = null;

// Throttle activity broadcasts: PID → last broadcast timestamp
const activityThrottle = new Map<number, number>();
const ACTIVITY_THROTTLE_MS = 5000;

/**
 * Register a spawned CLI process for tracking.
 * Automatically hooks into stdout/stderr for activity tracking
 * and proc.close for cleanup.
 */
export function registerProcess(info: ProcessInfo, proc: ChildProcess): void {
  registry.set(info.pid, info);
  processHandles.set(info.pid, proc);

  // Broadcast spawn event
  broadcastEvent({
    type: 'process:spawn',
    data: {
      pid: info.pid,
      taskId: info.taskId,
      stage: info.stage,
      model: info.model,
      projectPath: info.projectPath,
    },
  });

  // Activity tracking
  const updateActivity = (): void => {
    const entry = registry.get(info.pid);
    // Ownership check: only update if this exact identity still owns the PID
    if (!entry || entry.taskId !== info.taskId || entry.spawnedAt !== info.spawnedAt) return;

    entry.lastActivityAt = Date.now();
    const lastBroadcast = activityThrottle.get(info.pid) ?? 0;
    if (Date.now() - lastBroadcast >= ACTIVITY_THROTTLE_MS) {
      activityThrottle.set(info.pid, Date.now());
      // Activity updates go through process:spawn (lightweight)
    }
  };

  proc.stdout?.on('data', updateActivity);
  proc.stderr?.on('data', updateActivity);

  // Cleanup on close — verify ownership before acting so a reused PID does not
  // cause this handler to clean up a newer process that happens to share the same
  // numeric PID (PID reuse is real on busy systems).
  proc.on('close', (code, signal) => {
    const entry = registry.get(info.pid);
    // Ownership check: the entry must match this exact process identity (taskId +
    // spawnedAt), not just the PID. A reused PID would have a different spawnedAt
    // or taskId.
    if (!entry || entry.taskId !== info.taskId || entry.spawnedAt !== info.spawnedAt) {
      return;
    }
    const durationMs = Date.now() - entry.spawnedAt;
    registry.delete(info.pid);
    processHandles.delete(info.pid);
    activityThrottle.delete(info.pid);

    broadcastEvent({
      type: 'process:exit',
      data: {
        pid: info.pid,
        taskId: info.taskId,
        stage: info.stage,
        model: info.model,
        projectPath: info.projectPath,
        exitCode: code,
        signal: signal,
        durationMs,
      },
    });
  });
}

/**
 * Get a single process by PID
 */
export function getProcess(pid: number): ProcessInfo | undefined {
  return registry.get(pid);
}

/**
 * Get all tracked processes
 */
export function getAllProcesses(): ProcessInfo[] {
  return Array.from(registry.values());
}

const KILL_ESCALATE_MS = 5_000;

/**
 * Kill a tracked process by PID.
 * Signals through the retained ChildProcess handle — never by raw PID — so a
 * recycled numeric PID cannot be escalated into after the original child exits.
 * Soft kill schedules SIGKILL escalation after {@link KILL_ESCALATE_MS} only
 * while this exact registry identity still owns the handle; the caller does not
 * wait for that timer (so a recycled PID in those seconds is never signalled).
 */
export async function killProcess(pid: number, force = false): Promise<boolean> {
  const info = registry.get(pid);
  const proc = processHandles.get(pid);
  if (!info || !proc) return false;

  const stillOurs = (): boolean => {
    const current = registry.get(pid);
    return (
      !!current
      && current.taskId === info.taskId
      && current.spawnedAt === info.spawnedAt
      && processHandles.get(pid) === proc
    );
  };

  if (!stillOurs()) return false;

  try {
    if (force) {
      if (!stillOurs()) return false;
      terminateCliProcessTree(proc);
      return true;
    }

    signalCliProcessTree(proc, 'SIGTERM');
    const timer = setTimeout(() => {
      if (stillOurs()) terminateCliProcessTree(proc);
    }, KILL_ESCALATE_MS);
    proc.once('close', () => {
      clearTimeout(timer);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Start periodic health checker that removes stale entries
 * where the process handle has already exited.
 *
 * Identity-safe: re-reads the registry entry before acting so a reused PID
 * does not cause this handler to clean up a newer process.
 */
export function startHealthChecker(intervalMs = 30000): void {
  if (healthCheckTimer) return;

  healthCheckTimer = setInterval(() => {
    const now = Date.now();
    for (const [pid, info] of registry) {
      const proc = processHandles.get(pid);
      if (!proc) {
        // Ownership check: re-read the entry to confirm it hasn't been replaced
        // by a reused PID with a different identity (taskId + spawnedAt).
        const current = registry.get(pid);
        if (!current || current.taskId !== info.taskId || current.spawnedAt !== info.spawnedAt) {
          continue;
        }
        const durationMs = now - info.spawnedAt;
        registry.delete(pid);
        activityThrottle.delete(pid);
        broadcastEvent({
          type: 'process:exit',
          data: {
            pid,
            taskId: info.taskId,
            stage: info.stage,
            model: info.model,
            projectPath: info.projectPath,
            exitCode: null,
            signal: null,
            durationMs,
          },
        });
        console.log(`[ProcessRegistry] Removed stale process PID=${pid} (${info.stage})`);
      }
    }
  }, intervalMs);
}

/**
 * Stop the health checker
 */
export function stopHealthChecker(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}