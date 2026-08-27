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

  // Cleanup on close
  proc.on('close', (code, signal) => {
    const entry = registry.get(info.pid);
    const durationMs = entry ? Date.now() - entry.spawnedAt : 0;
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
 * Kill a tracked process. Sends SIGTERM first, then SIGKILL after 5s.
 */
export async function killProcess(pid: number, force = false): Promise<boolean> {
  const entry = registry.get(pid);
  if (!entry) return false;

  try {
    const proc = processHandles.get(pid);
    if (proc) {
      if (force) {
        terminateCliProcessTree(proc);
      } else {
        signalCliProcessTree(proc, 'SIGTERM');
        // Escalate the same process group. The npm wrapper may exit before its
        // native CLI/MCP descendants, so checking only proc.exitCode is unsafe.
        const escalation = setTimeout(() => terminateCliProcessTree(proc), 5000);
        escalation.unref();
      }
      return true;
    }
    // No handle means we cannot prove this PID is still the child we spawned.
    // Signalling it anyway is the ownership hazard this registry exists to
    // remove: PIDs are recycled, and a delayed escalation in particular would
    // land on whatever unrelated process inherited the number. Registration and
    // handle are written and cleared together, so this is a defensive branch —
    // report it rather than guessing.
    console.warn(`[ProcessRegistry] No process handle for pid ${pid}; refusing to signal by PID`);
    registry.delete(pid);
    activityThrottle.delete(pid);
    return false;
  } catch {
    // Process already gone
    registry.delete(pid);
    processHandles.delete(pid);
    activityThrottle.delete(pid);
    return false;
  }
}

/**
 * Start periodic health checker that verifies processes are still alive.
 * Removes stale entries from the registry.
 */
export function startHealthChecker(intervalMs = 30000): void {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(() => {
    for (const [pid, info] of registry) {
      try {
        process.kill(pid, 0); // No-op signal — just checks if alive
      } catch {
        // Process is dead but wasn't cleaned up
        const durationMs = Date.now() - info.spawnedAt;
        registry.delete(pid);
        processHandles.delete(pid);
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
