// ============================================
// Claude Swarm - Runner Execution Helpers
// Execution/reporting/integration logic extracted from AutonomousRunner
// ============================================

import { EmbedBuilder } from 'discord.js';
import type { TaskItem, DecisionResult } from './decisionEngine.js';
import type { ExecutorResult } from './workflowExecutor.js';
import type { PipelineResult } from './pairPipeline.js';
import type { DefaultRolesConfig, PipelineStage } from './types.js';
import { createPipelineFromConfig } from './pairPipeline.js';
import { formatParsedTaskSummary, loadParsedTask } from './taskParser.js';
import { saveCognitiveMemory } from './memory.js';
import * as workerAgent from './worker.js';
import * as reviewerAgent from './reviewer.js';
import * as projectMapper from './projectMapper.js';
import * as linear from './linear.js';
import * as planner from './planner.js';
import { t } from './locale/index.js';

// ============================================
// Discord Reporter
// ============================================

type DiscordSendFn = (content: string | { embeds: EmbedBuilder[] }) => Promise<void>;

let discordSend: DiscordSendFn | null = null;

export function setDiscordReporter(sendFn: DiscordSendFn): void {
  discordSend = sendFn;
  console.log('[AutonomousRunner] Discord reporter registered');
}

export async function reportToDiscord(message: string | EmbedBuilder): Promise<void> {
  if (!discordSend) {
    console.log('[AutonomousRunner] No Discord reporter, logging instead:',
      typeof message === 'string' ? message : message.data.title);
    return;
  }

  try {
    if (typeof message === 'string') {
      await discordSend(message);
    } else {
      await discordSend({ embeds: [message] });
    }
  } catch (error) {
    console.error('[AutonomousRunner] Discord report failed:', error);
  }
}

// ============================================
// Linear Integration
// ============================================

type LinearFetchFn = () => Promise<TaskItem[]>;

let linearFetch: LinearFetchFn | null = null;

export function setLinearFetcher(fetchFn: LinearFetchFn): void {
  linearFetch = fetchFn;
  console.log('[AutonomousRunner] Linear fetcher registered');
}

export async function fetchLinearTasks(): Promise<TaskItem[]> {
  if (!linearFetch) {
    console.log('[AutonomousRunner] No Linear fetcher registered');
    return [];
  }

  try {
    return await linearFetch();
  } catch (error) {
    console.error('[AutonomousRunner] Linear fetch failed:', error);
    return [];
  }
}

// ============================================
// Execution Context
// ============================================

export interface ExecutionContext {
  allowedProjects: string[];
  plannerModel?: string;
  plannerTimeoutMs?: number;
  pairMaxAttempts?: number;
  enableDecomposition?: boolean;
  decompositionThresholdMinutes?: number;
  getRolesForProject: (projectPath: string) => DefaultRolesConfig | undefined;
  reportToDiscord: (message: string | EmbedBuilder) => Promise<void>;
}

// ============================================
// Project Path Resolution
// ============================================

export async function resolveProjectPath(
  ctx: ExecutionContext,
  task: TaskItem,
): Promise<string | null> {
  const projectName = task.linearProject?.name;
  const projectId = task.linearProject?.id;

  if (!projectId || !projectName) {
    console.error(`[AutonomousRunner] Task "${task.title}" has no Linear project info - SKIP`);
    return null;
  }

  const mappedPath = await projectMapper.mapLinearProject(
    projectId,
    projectName,
    ctx.allowedProjects
  );

  if (mappedPath) {
    console.log(`[AutonomousRunner] Mapped: ${projectName} → ${mappedPath}`);
    return mappedPath;
  }

  const directPath = `${process.env.HOME}/dev/${projectName}`;
  if (await isValidProjectPath(directPath)) {
    console.log(`[AutonomousRunner] Direct path found: ${projectName} → ${directPath}`);
    return directPath;
  }

  const lowerPath = `${process.env.HOME}/dev/${projectName.toLowerCase()}`;
  if (await isValidProjectPath(lowerPath)) {
    console.log(`[AutonomousRunner] Lowercase path found: ${projectName} → ${lowerPath}`);
    return lowerPath;
  }

  console.error(`[AutonomousRunner] Failed to resolve project path for "${projectName}" - SKIP`);
  console.error(`[AutonomousRunner] Tried: mapper, ${directPath}, ${lowerPath}`);
  return null;
}

export async function isValidProjectPath(path: string): Promise<boolean> {
  try {
    const fs = await import('fs/promises');
    const stats = await fs.stat(path);
    if (!stats.isDirectory()) return false;

    const checks = ['.git', 'package.json', 'pyproject.toml'];
    for (const check of checks) {
      try {
        await fs.stat(`${path}/${check}`);
        return true;
      } catch {
        // continue
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ============================================
// Task Decomposition
// ============================================

export async function decomposeTask(
  ctx: ExecutionContext,
  task: TaskItem,
  projectPath: string,
  targetMinutes: number,
): Promise<boolean> {
  console.log(`[AutonomousRunner] Decomposing task: ${task.title}`);

  await ctx.reportToDiscord(t('runner.decomposition.starting', {
    title: task.title,
    estimated: String(planner.estimateTaskDuration(task)),
    threshold: String(targetMinutes),
  }));

  const result = await planner.runPlanner({
    taskTitle: task.title,
    taskDescription: task.description || '',
    projectPath,
    projectName: task.linearProject?.name,
    targetMinutes,
    model: ctx.plannerModel ?? 'claude-sonnet-4-20250514',
    timeoutMs: ctx.plannerTimeoutMs ?? 600000,
  });

  await ctx.reportToDiscord(planner.formatPlannerResult(result));

  if (!result.success) {
    console.error(`[AutonomousRunner] Planner failed: ${result.error}`);
    return false;
  }

  if (!result.needsDecomposition || result.subTasks.length === 0) {
    console.log('[AutonomousRunner] Planner determined no decomposition needed');
    return false;
  }

  if (!task.issueId) {
    console.error('[AutonomousRunner] Cannot create sub-issues: no parent issueId');
    return false;
  }

  const createdSubIssues: Array<{ id: string; identifier: string; title: string }> = [];

  for (const subTask of result.subTasks) {
    const depsStr = subTask.dependencies?.length
      ? `\n\n${t('runner.decomposition.prerequisite', { deps: subTask.dependencies.join(', ') })}`
      : '';

    const subDescription = `${subTask.description}\n\n` +
      `${t('runner.decomposition.estimatedTime', { n: String(subTask.estimatedMinutes) })}${depsStr}\n\n` +
      t('runner.decomposition.autoDecomposed', { parentTitle: task.title });

    const subResult = await linear.createSubIssue(
      task.issueId,
      subTask.title,
      subDescription,
      {
        priority: subTask.priority,
        projectId: task.linearProject?.id,
        estimatedMinutes: subTask.estimatedMinutes,
      }
    );

    if ('error' in subResult) {
      console.error(`[AutonomousRunner] Failed to create sub-issue: ${subResult.error}`);
      continue;
    }

    createdSubIssues.push({
      id: subResult.id,
      identifier: subResult.identifier,
      title: subResult.title,
    });

    console.log(`[AutonomousRunner] Created sub-issue: ${subResult.identifier}`);
  }

  if (createdSubIssues.length === 0) {
    console.error('[AutonomousRunner] No sub-issues created');
    return false;
  }

  await linear.markAsDecomposed(
    task.issueId,
    createdSubIssues.length,
    result.totalEstimatedMinutes
  );

  const subIssueList = createdSubIssues
    .map((s, i) => `${i + 1}. ${s.identifier}: ${s.title}`)
    .join('\n');

  await ctx.reportToDiscord(t('runner.decomposition.completed', {
    original: task.issueIdentifier || task.issueId || '',
    count: String(createdSubIssues.length),
    list: subIssueList,
    totalMinutes: String(result.totalEstimatedMinutes),
  }));

  console.log(`[AutonomousRunner] Decomposition complete: ${createdSubIssues.length} sub-issues created`);
  return true;
}

// ============================================
// Pipeline Execution
// ============================================

export async function executePipeline(
  ctx: ExecutionContext,
  task: TaskItem,
  projectPath: string,
): Promise<PipelineResult> {
  console.log(`[AutonomousRunner] executePipeline: ${task.title}`);

  if (ctx.enableDecomposition) {
    const threshold = ctx.decompositionThresholdMinutes ?? 30;
    const needsDecomp = planner.needsDecomposition(task, threshold);

    if (needsDecomp) {
      const estimated = planner.estimateTaskDuration(task);
      console.log(`[AutonomousRunner] Task "${task.title}" may need decomposition (estimated ${estimated}min > ${threshold}min)`);

      const decomposed = await decomposeTask(ctx, task, projectPath, threshold);
      if (decomposed) {
        return {
          success: true,
          sessionId: `decomposed-${Date.now()}`,
          iterations: 0,
          totalDuration: 0,
          finalStatus: 'decomposed' as any,
          stages: [],
        };
      }
      // Decomposition was needed but failed — do NOT attempt the oversized task directly
      console.log('[AutonomousRunner] Decomposition failed for oversized task, skipping execution');
      return {
        success: false,
        sessionId: `decomp-failed-${Date.now()}`,
        iterations: 0,
        totalDuration: 0,
        finalStatus: 'failed' as any,
        stages: [],
      };
    }
  }

  const roles = ctx.getRolesForProject(projectPath);
  const pipeline = createPipelineFromConfig(roles, ctx.pairMaxAttempts ?? 3);

  pipeline.on('stage:start', ({ stage }) => {
    console.log(`[Pipeline] Stage started: ${stage}`);
  });

  const taskReportCtx = {
    issueIdentifier: task.issueIdentifier || task.issueId,
    projectName: task.linearProject?.name,
    projectPath,
  };

  pipeline.on('stage:complete', async ({ stage, result }) => {
    console.log(`[Pipeline] Stage completed: ${stage}, success=${result.success}`);
    await reportStageResult(stage, result, ctx.reportToDiscord, taskReportCtx);
  });

  pipeline.on('revision:start', ({ stage }) => {
    void ctx.reportToDiscord(t('runner.pipeline.revisionNeeded', { stage }));
  });

  const stages = getEnabledStages(roles);
  const issueRef = task.issueIdentifier || task.issueId || '';
  const projectDisplay = task.linearProject?.name
    ? `📁 ${task.linearProject.name} (${projectPath.split('/').slice(-2).join('/')})`
    : projectPath.split('/').slice(-2).join('/');

  const startEmbed = new EmbedBuilder()
    .setTitle(t('runner.pipeline.starting'))
    .setColor(0x00AE86)
    .addFields(
      { name: t('runner.result.taskLabel'), value: task.title, inline: false },
      { name: 'Project', value: projectDisplay, inline: true },
      ...(issueRef ? [{ name: 'Issue', value: issueRef, inline: true }] : []),
      { name: 'Stages', value: stages.join(' → '), inline: true },
    )
    .setTimestamp();

  await ctx.reportToDiscord(startEmbed);

  if (task.issueId) {
    try {
      await linear.logPairStart(task.issueId, `pipeline-${Date.now()}`, projectPath);
    } catch (err) {
      console.error('[Pipeline] Linear logPairStart failed:', err);
      // Continue pipeline even if this fails
      await linear.updateIssueState(task.issueId, 'In Progress');
    }
  }

  return pipeline.run(task, projectPath);
}

function getEnabledStages(roles?: DefaultRolesConfig): PipelineStage[] {
  const stages: PipelineStage[] = [];
  if (roles?.worker?.enabled !== false) stages.push('worker');
  if (roles?.reviewer?.enabled !== false) stages.push('reviewer');
  if (roles?.tester?.enabled) stages.push('tester');
  if (roles?.documenter?.enabled) stages.push('documenter');
  return stages;
}

// ============================================
// Reporting
// ============================================

async function reportStageResult(
  stage: PipelineStage,
  result: any,
  reportFn: (message: string | EmbedBuilder) => Promise<void>,
  taskCtx?: { issueIdentifier?: string; projectName?: string; projectPath?: string },
): Promise<void> {
  switch (stage) {
    case 'worker':
      await reportFn(workerAgent.formatWorkReport(result.result, taskCtx));
      break;
    case 'reviewer':
      await reportFn(reviewerAgent.formatReviewFeedback(result.result));
      break;
    case 'tester': {
      const { formatTestReport } = await import('./tester.js');
      await reportFn(formatTestReport(result.result));
      break;
    }
    case 'documenter': {
      const { formatDocReport } = await import('./documenter.js');
      await reportFn(formatDocReport(result.result));
      break;
    }
  }
}

export async function requestApproval(
  decision: DecisionResult,
  reportFn: (message: string | EmbedBuilder) => Promise<void>,
): Promise<void> {
  if (!decision.task) return;

  const projectInfo = decision.task.linearProject?.name
    ? `📁 **${decision.task.linearProject.name}**\n`
    : '';
  const issueRef = decision.task.issueIdentifier || decision.task.issueId || 'N/A';

  const embed = new EmbedBuilder()
    .setTitle(t('runner.approval.title'))
    .setColor(0xFFA500)
    .setDescription(t('runner.approval.question', { project: projectInfo, title: decision.task.title }))
    .addFields(
      { name: 'Issue', value: issueRef, inline: true },
      { name: 'Priority', value: `P${decision.task.priority}`, inline: true },
      { name: t('runner.approval.reason'), value: decision.reason, inline: false },
    )
    .setFooter({ text: t('runner.approval.footer') })
    .setTimestamp();

  await reportFn(embed);

  if (decision.task.issueId) {
    const parsed = await loadParsedTask(decision.task.issueId);
    if (parsed) {
      const summary = formatParsedTaskSummary(parsed);
      await reportFn(`\`\`\`\n${summary.slice(0, 1800)}\n\`\`\``);
    }
  }
}

export async function reportExecutionResult(
  task: TaskItem,
  result: ExecutorResult,
  reportFn: (message: string | EmbedBuilder) => Promise<void>,
): Promise<void> {
  const duration = (result.duration / 1000).toFixed(1);
  const stepCount = Object.keys(result.execution.stepResults).length;
  const completedCount = Object.values(result.execution.stepResults)
    .filter(r => r.status === 'completed').length;

  const projectPrefix = task.linearProject?.name ? `[${task.linearProject.name}] ` : '';
  const taskDisplay = `${projectPrefix}${task.title}`;

  if (result.success) {
    const embed = new EmbedBuilder()
      .setTitle(t('runner.result.taskCompleted'))
      .setColor(0x00FF00)
      .addFields(
        { name: t('runner.result.taskLabel'), value: taskDisplay, inline: false },
        { name: t('runner.result.duration'), value: `${duration}s`, inline: true },
        { name: t('runner.result.completedSteps'), value: `${completedCount}/${stepCount}`, inline: true },
      )
      .setTimestamp();

    await reportFn(embed);

    try {
      await saveCognitiveMemory('strategy',
        `Autonomous execution succeeded: "${task.title}"`,
        { confidence: 0.8, derivedFrom: task.issueId }
      );
    } catch (memErr) {
      console.warn(`[AutonomousRunner] Memory save failed (non-critical):`, memErr);
    }
  } else {
    const embed = new EmbedBuilder()
      .setTitle(t('runner.result.taskFailed'))
      .setColor(0xFF0000)
      .addFields(
        { name: t('runner.result.taskLabel'), value: taskDisplay, inline: false },
        { name: t('runner.result.failedStep'), value: result.failedStep || 'Unknown', inline: true },
        { name: t('runner.result.rollback'), value: result.rollbackPerformed ? '✅' : '❌', inline: true },
      )
      .setTimestamp();

    await reportFn(embed);

    const failedStepResult = result.execution.stepResults[result.failedStep || ''];
    if (failedStepResult?.error) {
      await reportFn(`\`\`\`\n${failedStepResult.error.slice(0, 1500)}\n\`\`\``);
    }
  }
}
