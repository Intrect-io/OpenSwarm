// ============================================
// Claude Swarm - Runner State Utilities
// Task state persistence + project info query
// ============================================

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TaskItem } from '../orchestration/decisionEngine.js';

export const TASK_STATE_FILE = join(homedir(), '.claude', 'claude-swarm-task-state.json');

export interface TaskState {
  completedTaskIds: Set<string>;
  failedTaskCounts: Map<string, number>;
}

export function loadTaskState(state: TaskState): void {
  try {
    if (!existsSync(TASK_STATE_FILE)) return;
    const raw = readFileSync(TASK_STATE_FILE, 'utf8');
    const data = JSON.parse(raw) as { completed?: string[]; failed?: Record<string, number> };
    if (Array.isArray(data.completed)) {
      for (const id of data.completed) state.completedTaskIds.add(id);
    }
    if (data.failed && typeof data.failed === 'object') {
      for (const [id, count] of Object.entries(data.failed)) {
        state.failedTaskCounts.set(id, count as number);
      }
    }
    console.log(`[AutonomousRunner] Loaded task state: ${state.completedTaskIds.size} completed, ${state.failedTaskCounts.size} failed`);
  } catch (err) {
    console.warn('[AutonomousRunner] Failed to load task state:', err);
  }
}

export function saveTaskState(state: TaskState): void {
  try {
    const data = {
      completed: Array.from(state.completedTaskIds),
      failed: Object.fromEntries(state.failedTaskCounts),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(TASK_STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[AutonomousRunner] Failed to save task state:', err);
  }
}

// ============================================
// Project Info Query (for dashboard)
// ============================================

export interface ProjectInfo {
  path: string;
  name: string;
  enabled: boolean;
  running: { id: string; title: string; priority: number }[];
  queued: { id: string; title: string; priority: number }[];
  pending: { id: string; title: string; priority: number; issueIdentifier?: string }[];
}

type RunningEntry = { task: TaskItem; projectPath: string };
type QueuedEntry = { task: TaskItem; projectPath: string };

export function buildProjectsInfo(
  fetchedTasks: TaskItem[],
  running: RunningEntry[],
  queued: QueuedEntry[],
  pathCache: Map<string, string>,
  enabledProjects: Set<string>,
): ProjectInfo[] {
  const projectMap = new Map<string, { name: string; path: string | null; tasks: TaskItem[] }>();

  for (const task of fetchedTasks) {
    const projName = task.linearProject?.name || '(unknown)';
    if (!projectMap.has(projName)) {
      projectMap.set(projName, { name: projName, path: pathCache.get(projName) ?? null, tasks: [] });
    }
    projectMap.get(projName)!.tasks.push(task);
  }

  for (const r of running) {
    const projName = r.task.linearProject?.name || '(unknown)';
    if (!projectMap.has(projName)) {
      projectMap.set(projName, { name: projName, path: r.projectPath, tasks: [] });
    } else if (!projectMap.get(projName)!.path) {
      projectMap.get(projName)!.path = r.projectPath;
    }
  }
  for (const q of queued) {
    const projName = q.task.linearProject?.name || '(unknown)';
    if (!projectMap.has(projName)) {
      projectMap.set(projName, { name: projName, path: q.projectPath, tasks: [] });
    } else if (!projectMap.get(projName)!.path) {
      projectMap.get(projName)!.path = q.projectPath;
    }
  }

  const activeIds = new Set([
    ...running.map(r => r.task.issueId || r.task.id),
    ...queued.map(q => q.task.issueId || q.task.id),
  ]);

  return Array.from(projectMap.values()).map(proj => {
    const projectPath = proj.path ?? '';
    return {
      path: projectPath,
      name: proj.name,
      enabled: Boolean(projectPath) && enabledProjects.has(projectPath),
      running: running.filter(r => r.task.linearProject?.name === proj.name)
        .map(r => ({ id: r.task.id, title: r.task.title, priority: r.task.priority })),
      queued: queued.filter(q => q.task.linearProject?.name === proj.name)
        .map(q => ({ id: q.task.id, title: q.task.title, priority: q.task.priority })),
      pending: proj.tasks.filter(t => !activeIds.has(t.issueId || t.id))
        .map(t => ({ id: t.id, title: t.title, priority: t.priority, issueIdentifier: t.issueIdentifier || t.issueId })),
    };
  });
}
