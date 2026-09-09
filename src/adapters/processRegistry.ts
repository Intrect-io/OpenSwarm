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

  // Track activity from stdout/stderr
  const updateActivity = () => {
    const entry = registry.get(info.pid);
    if (!entry) return;
    entry.lastActivityAt = Date.now();

    // Throttled broadcast
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

/**
 * Kill a tracked process.
 * Returns true if the process was found and signalled.
 * When force=true, uses SIGKILL instead of SIGTERM.
 */
export async function killProcess(pid: number, force = false): Promise<boolean> {
  const proc = processHandles.get(pid);
  if (!proc) return false;

  try {
    if (force) {
      await terminateCliProcessTree(proc, pid);
    } else {
      await signalCliProcessTree(proc, pid);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Start periodic health checker that removes stale entries
 * where the process handle has already exited.
 */
export function startHealthChecker(intervalMs = 30000): void {
  if (healthCheckTimer) return;

  healthCheckTimer = setInterval(() => {
    const now = Date.now();
    for (const [pid, info] of registry) {
      const proc = processHandles.get(pid);
      if (!proc) {
        // Handle missing but no process — treat as stale
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