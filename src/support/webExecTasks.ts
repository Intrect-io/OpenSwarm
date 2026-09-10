// ============================================
// OpenSwarm — in-memory exec task lifecycle
// ============================================
//
// Moved verbatim out of support/web.ts (AGT-4280). Nothing here changed: the
// file it came from was already 150 lines over the repository's size gate
// before this change, so any edit to it was blocked, and this block is
// self-contained — it touches no module state of the server it used to live in.

import { PairPipeline, type PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineStage, RoleConfig } from '../core/types.js';

// Exec task store (in-memory)

export interface ExecTaskEntry {
  taskId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  currentStage?: string;
  result?: {
    success: boolean;
    summary?: string;
    finalStatus?: string;
  };
  error?: string;
  createdAt: number;
}

/** Read by the GET /api/exec/:taskId route in web.ts. */
export const execTasks = new Map<string, ExecTaskEntry>();

export function cleanupExecTask(taskId: string): void {
  setTimeout(() => { execTasks.delete(taskId); }, 3600000); // 1 hour
}

/**
 * Create an in-memory exec task and run it through PairPipeline asynchronously.
 * Shared by `POST /api/exec` and the `/api/plan/dispatch` fallback (Path B) so a
 * fix to the exec lifecycle applies to both. Returns the taskId immediately;
 * status is pollable via GET /api/exec/:taskId.
 */
export function startExecTask(
  prompt: string,
  opts: { projectPath?: string; pipeline?: boolean; workerOnly?: boolean; model?: string } = {},
): string {
  const taskId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const resolvedPath = opts.projectPath ?? process.cwd();

  const entry: ExecTaskEntry = { taskId, status: 'queued', createdAt: Date.now() };
  execTasks.set(taskId, entry);

  // Run pipeline asynchronously
  (async () => {
    try {
      entry.status = 'running';

      let stages: PipelineStage[];
      if (opts.workerOnly) {
        stages = ['worker'];
      } else if (opts.pipeline) {
        stages = ['worker', 'reviewer', 'tester', 'documenter'];
      } else {
        stages = ['worker', 'reviewer'];
      }

      const roles: Record<string, RoleConfig> = {};
      if (opts.model) {
        roles.worker = { enabled: true, model: opts.model, timeoutMs: 0 };
      }

      const task: TaskItem = {
        id: taskId,
        source: 'local',
        title: prompt,
        description: prompt,
        priority: 3,
        projectPath: resolvedPath,
        createdAt: Date.now(),
      };

      const pipelineInstance = new PairPipeline({
        stages,
        maxIterations: 3,
        roles: Object.keys(roles).length > 0 ? roles as any : undefined,
      });

      pipelineInstance.on('stage:start', ({ stage }: { stage: string }) => {
        entry.currentStage = stage;
      });

      const result: PipelineResult = await pipelineInstance.run(task, resolvedPath);

      entry.status = 'completed';
      entry.result = {
        success: result.success,
        summary: result.workerResult?.summary,
        finalStatus: result.finalStatus,
      };
    } catch (err) {
      entry.status = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
    } finally {
      cleanupExecTask(taskId);
    }
  })();

  return taskId;
}
