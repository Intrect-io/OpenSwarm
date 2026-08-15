import { analyzeIssue } from '../knowledge/index.js';
import { recallRepoKnowledge } from '../memory/repoKnowledge.js';
import { getRegistryStore } from '../registry/sqliteStore.js';
import type { WorkerContext } from '../locale/types.js';
import { safeConsole } from '../support/safeLog.js';
import type { PipelineContext } from './pairPipelineTypes.js';

export async function collectWorkerContext(
  context: PipelineContext,
  draft: PipelineContext['config']['draftAnalysis'],
): Promise<WorkerContext | undefined> {
  try {
    const wc: WorkerContext = {};
    if (draft) {
      wc.draftAnalysis = { taskType: draft.taskType, intentSummary: draft.intentSummary, relevantFiles: draft.relevantFiles,
        suggestedApproach: draft.suggestedApproach, projectStats: draft.projectStats, completionCriteria: draft.completionCriteria, sufficient: draft.sufficient };
      if (draft.impactAnalysis) wc.impactAnalysis = draft.impactAnalysis;
      if (draft.registrySnapshot?.length) wc.registryBriefs = draft.registrySnapshot;
    }
    if (!wc.impactAnalysis) {
      const impact = await analyzeIssue(context.projectPath, context.task.title, context.task.description || '');
      if (impact && (impact.directModules.length || impact.dependentModules.length)) wc.impactAnalysis = impact;
    }
    if (!wc.registryBriefs && wc.impactAnalysis) {
      const affected = new Set([...wc.impactAnalysis.directModules, ...wc.impactAnalysis.dependentModules.slice(0, 5)]);
      try {
        const briefs: NonNullable<WorkerContext['registryBriefs']> = [];
        for (const filePath of affected) {
          const brief = getRegistryStore().fileBrief(filePath);
          if (!brief.entities.length) continue;
          const highlights = brief.entities.flatMap((entity) => {
            const critical = entity.warnings.filter((warning) => !warning.resolved && warning.severity === 'critical').length;
            return [entity.status === 'deprecated' ? `${entity.name} (deprecated)` : entity.status === 'broken' ? `${entity.name} (broken)` : '', critical ? `${entity.name} (${critical} critical)` : ''].filter(Boolean);
          });
          briefs.push({ filePath: brief.filePath, summary: brief.summary, highlights, entities: brief.entities.slice(0, 15).map((entity) => ({ kind: entity.kind, name: entity.name, signature: entity.signature?.slice(0, 80), status: entity.status, hasTests: entity.hasTests })) });
        }
        if (briefs.length) wc.registryBriefs = briefs;
      } catch { /* Registry not initialized. */ }
    }
    const memories = await recallRepoKnowledge(context.projectPath, context.task.title, context.task.description || '');
    if (memories.length) { wc.repoMemories = memories; safeConsole.log(`[Pipeline] Recalled ${memories.length} repo memories for context`); }
    return wc.impactAnalysis || wc.registryBriefs || wc.draftAnalysis || wc.repoMemories ? wc : undefined;
  } catch (error) { safeConsole.warn('[Pipeline] Worker context collection failed (non-blocking):', error); return undefined; }
}
