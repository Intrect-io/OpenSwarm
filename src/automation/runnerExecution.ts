// ============================================
// OpenSwarm - Runner Execution Helpers
// Execution/reporting/integration logic extracted from AutonomousRunner
// ============================================

import { EmbedBuilder } from 'discord.js';
import type { TaskItem, DecisionResult } from '../orchestration/decisionEngine.js';
import type { ExecutorResult } from '../orchestration/workflow.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { DefaultRolesConfig, PipelineStage } from '../core/types.js';
import { createPipelineFromConfig, buildTaskPrefix } from '../agents/pairPipeline.js';
import { formatParsedTaskSummary, loadParsedTask } from '../orchestration/taskParser.js';
import { saveCognitiveMemory } from '../memory/index.js';
import * as workerAgent from '../agents/worker.js';
import * as reviewerAgent from '../agents/reviewer.js';
import * as projectMapper from '../support/projectMapper.js';
import * as linear from '../linear/index.js';
import * as planner from '../support/planner.js';
import { t } from '../locale/index.js';
import { broadcastEvent } from '../core/eventHub.js';
import {
  buildBranchName,
  createWorktree,
  commitAndCreatePR,
  removeWorktree,
} from '../support/worktreeManager.js';
import type { WorktreeInfo } from '../support/worktreeManager.js';
import {
  getDecompositionDepth,
  getChildrenCount,
  getDailyCreationCount,
  canCreateMoreIssues,
  registerDecomposition,
} from './runnerState.js';

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
      // Convert plain text to Embed for consistent Discord UI
      const embed = new EmbedBuilder()
        .setDescription(message)
        .setColor(0x00ff41) // OpenSwarm green
        .setTimestamp();
      await discordSend({ embeds: [embed] });
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

// Track consecutive fetch failures for visibility
let fetchFailureCount = 0;

export async function fetchLinearTasks(): Promise<{ tasks: TaskItem[]; error?: string }> {
  if (!linearFetch) {
    console.log('[AutonomousRunner] No Linear fetcher registered');
    return { tasks: [], error: 'No Linear fetcher registered' };
  }

  try {
    const tasks = await linearFetch();
    if (fetchFailureCount > 0) {
      console.log(`[AutonomousRunner] Linear fetch recovered after ${fetchFailureCount} failures`);
    }
    fetchFailureCount = 0;
    return { tasks };
  } catch (error) {
    fetchFailureCount++;
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[AutonomousRunner] Linear fetch failed (${fetchFailureCount}x consecutive): ${msg}`);
    return { tasks: [], error: msg };
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
  decompositionMaxDepth?: number;
  decompositionMaxChildren?: number;
  decompositionDailyLimit?: number;
  decompositionAutoBacklog?: boolean;
  getRolesForProject: (projectPath: string) => DefaultRolesConfig | undefined;
  reportToDiscord: (message: string | EmbedBuilder) => Promise<void>;
  /** Git worktree mode: work in an isolated worktree per issue, auto-create PR */
  worktreeMode?: boolean;
  /** Trigger immediate heartbeat (called after decomposition to pick up new sub-issues) */
  scheduleNextHeartbeat?: () => void;
  /** Pipeline guards configuration */
  guards?: Partial<import('../core/types.js').PipelineGuardsConfig>;
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

  // Check ~/dev/tools/ subdirectory
  const toolsPath = `${process.env.HOME}/dev/tools/${projectName}`;
  if (await isValidProjectPath(toolsPath)) {
    console.log(`[AutonomousRunner] Tools path found: ${projectName} → ${toolsPath}`);
    return toolsPath;
  }

  // Check allowedProjects for exact basename match
  for (const allowed of ctx.allowedProjects) {
    const expanded = allowed.replace('~', process.env.HOME || '');
    const dirName = expanded.split('/').pop();
    if (dirName === projectName || dirName?.toLowerCase() === projectName.toLowerCase()) {
      if (await isValidProjectPath(expanded)) {
        console.log(`[AutonomousRunner] AllowedProjects match: ${projectName} → ${expanded}`);
        return expanded;
      }
    }
  }

  console.error(`[AutonomousRunner] Failed to resolve project path for "${projectName}" - SKIP`);
  console.error(`[AutonomousRunner] Tried: mapper, ${directPath}, ${lowerPath}, ${toolsPath}, allowedProjects`);
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
): Promise<boolean | 'no-decomp'> {
  console.log(`[AutonomousRunner] Decomposing task: ${task.title}`);

  const taskId = task.issueId || task.id;
  const maxDepth = ctx.decompositionMaxDepth ?? 2;
  const maxChildren = ctx.decompositionMaxChildren ?? 5;
  const dailyLimit = ctx.decompositionDailyLimit ?? 20;
  const autoBacklog = ctx.decompositionAutoBacklog ?? true;

  // ============================================
  // Pre-checks: Depth, Children, Daily Limit
  // ============================================

  // Check decomposition depth limit
  if (task.issueId) {
    const currentDepth = getDecompositionDepth(task.issueId);
    if (currentDepth >= maxDepth) {
      console.log(`[AutonomousRunner] Decomposition depth limit reached: ${currentDepth}/${maxDepth}`);
      if (autoBacklog && task.issueId) {
        try {
          await linear.updateIssueState(task.issueId, 'Backlog');
          await linear.addComment(task.issueId,
            `⚠️ **Auto-moved to Backlog**\n\n` +
            `Reason: Decomposition depth limit reached (${currentDepth}/${maxDepth})\n\n` +
            `This task has been nested too deeply. Please review and simplify the task structure, ` +
            `or handle it manually.`
          );
          console.log(`[AutonomousRunner] Task moved to backlog (depth limit)`);
        } catch (err) {
          console.error(`[AutonomousRunner] Failed to move to backlog:`, err);
        }
      }
      return false;
    }

    // Check children count limit
    const childrenCount = getChildrenCount(task.issueId);
    if (childrenCount >= maxChildren) {
      console.log(`[AutonomousRunner] Children count limit reached: ${childrenCount}/${maxChildren}`);
      if (autoBacklog) {
        try {
          await linear.updateIssueState(task.issueId, 'Backlog');
          await linear.addComment(task.issueId,
            `⚠️ **Auto-moved to Backlog**\n\n` +
            `Reason: Too many sub-issues already created (${childrenCount}/${maxChildren})\n\n` +
            `This task has generated too many sub-issues. Please review the decomposition strategy, ` +
            `or handle it manually.`
          );
          console.log(`[AutonomousRunner] Task moved to backlog (children limit)`);
        } catch (err) {
          console.error(`[AutonomousRunner] Failed to move to backlog:`, err);
        }
      }
      return false;
    }
  }

  // Check daily creation limit
  // NOTE: Don't move to Backlog on daily limit — it resets tomorrow.
  // Moving to Backlog would permanently exclude the task from future heartbeats.
  // Instead, skip decomposition and fall through to direct execution.
  if (!canCreateMoreIssues(dailyLimit)) {
    const currentCount = getDailyCreationCount();
    console.log(`[AutonomousRunner] Daily issue creation limit reached: ${currentCount}/${dailyLimit} — skipping decomposition (will retry tomorrow)`);
    return false;
  }

  broadcastEvent({ type: 'pipeline:stage', data: { taskId, stage: 'decompose', status: 'start' } });

  await ctx.reportToDiscord(t('runner.decomposition.starting', {
    title: task.title,
    estimated: String(planner.estimateTaskDuration(task)),
    threshold: String(targetMinutes),
  }));

  // Periodic progress log while planner runs (fallback if stdout isn't streaming)
  let elapsed = 0;
  const progressTimer = setInterval(() => {
    elapsed += 30;
    broadcastEvent({ type: 'log', data: { taskId, stage: 'decompose', line: `⏱ Planner running... ${elapsed}s` } });
  }, 30000);

  let result: Awaited<ReturnType<typeof planner.runPlanner>>;
  try {
    result = await planner.runPlanner({
      taskTitle: task.title,
      taskDescription: task.description || '',
      projectPath,
      projectName: task.linearProject?.name,
      targetMinutes,
      model: ctx.plannerModel ?? 'claude-sonnet-4-5-20250929',
      timeoutMs: ctx.plannerTimeoutMs ?? 600000,
      onLog: (line: string) => broadcastEvent({ type: 'log', data: { taskId, stage: 'decompose', line } }),
    });
  } finally {
    clearInterval(progressTimer);
  }

  await ctx.reportToDiscord(planner.formatPlannerResult(result));

  if (!result.success) {
    console.error(`[AutonomousRunner] Planner failed: ${result.error}`);
    broadcastEvent({ type: 'pipeline:stage', data: { taskId, stage: 'decompose', status: 'fail' } });
    return false;
  }

  if (!result.needsDecomposition || result.subTasks.length === 0) {
    console.log('[AutonomousRunner] Planner determined no decomposition needed');
    return 'no-decomp';
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
    broadcastEvent({ type: 'pipeline:stage', data: { taskId, stage: 'decompose', status: 'fail' } });
    return false;
  }

  // Register decomposition in tracking (for limits)
  registerDecomposition(
    task.issueId,
    task.parentId, // Parent ID if this task is also a sub-issue
    createdSubIssues.map(s => s.id)
  );
  console.log(`[AutonomousRunner] Registered decomposition: parent=${task.issueId}, children=${createdSubIssues.length}, daily=${getDailyCreationCount()}/${dailyLimit}`);

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

  broadcastEvent({ type: 'pipeline:stage', data: { taskId, stage: 'decompose', status: 'complete' } });
  // Log each sub-issue as a log line for the dashboard
  for (const s of createdSubIssues) {
    broadcastEvent({ type: 'log', data: { taskId, stage: 'decompose', line: `↳ ${s.identifier}: ${s.title}` } });
  }
  console.log(`[AutonomousRunner] Decomposition complete: ${createdSubIssues.length} sub-issues created`);

  // Move all sub-issues to Todo state so they can be picked up immediately
  console.log('[AutonomousRunner] Moving sub-issues to Todo state...');
  for (const subIssue of createdSubIssues) {
    try {
      await linear.updateIssueState(subIssue.id, 'Todo');
      console.log(`[AutonomousRunner] Moved ${subIssue.identifier} to Todo`);
    } catch (err) {
      console.warn(`[AutonomousRunner] Failed to move ${subIssue.identifier} to Todo:`, err);
    }
  }

  // Trigger immediate heartbeat to pick up newly created sub-issues
  if (ctx.scheduleNextHeartbeat) {
    console.log('[AutonomousRunner] Scheduling immediate heartbeat to process sub-issues...');
    ctx.scheduleNextHeartbeat();
  }

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
      if (decomposed === true) {
        // Successfully decomposed into sub-issues
        return {
          success: true,
          sessionId: `decomposed-${Date.now()}`,
          iterations: 0,
          totalDuration: 0,
          finalStatus: 'decomposed',
          stages: [],
        };
      }
      if (decomposed === 'no-decomp') {
        // Planner says task is smaller than threshold — proceed with direct execution
        console.log('[AutonomousRunner] Planner says task fits in threshold, executing directly');
      } else {
        // Decomposition failed (limit reached, planner error, API error, etc.)
        // Fall through to direct execution instead of aborting entirely
        console.log('[AutonomousRunner] Decomposition failed, falling back to direct execution');
      }
    }
  }

  // ============================================
  // Git Worktree: work in an isolated branch per issue
  // ============================================
  let worktreeInfo: WorktreeInfo | null = null;
  let actualPath = projectPath;

  if (ctx.worktreeMode && task.issueId && task.issueIdentifier) {
    const branchName = buildBranchName(task.issueIdentifier, task.title);
    try {
      worktreeInfo = await createWorktree(projectPath, task.issueId, branchName);
      actualPath = worktreeInfo.worktreePath;
      broadcastEvent({
        type: 'log',
        data: {
          taskId: task.issueId,
          stage: 'worktree',
          line: `Worktree: ${actualPath} (branch: ${branchName})`,
        },
      });
    } catch (err) {
      console.warn('[Worktree] Failed to create worktree, falling back to main repo:', err);
    }
  }

  try {
    const roles = ctx.getRolesForProject(projectPath); // look up config using original path
    const pipeline = createPipelineFromConfig(roles, ctx.pairMaxAttempts ?? 3, ctx.guards);

    const taskPrefix = buildTaskPrefix(task, actualPath);

    pipeline.on('stage:start', ({ stage }) => {
      console.log(`[${taskPrefix}] Stage started: ${stage}`);
    });

    const taskReportCtx = {
      issueIdentifier: task.issueIdentifier || task.issueId,
      projectName: task.linearProject?.name,
      projectPath: actualPath,
    };

    pipeline.on('stage:complete', async ({ stage, result }) => {
      console.log(`[${taskPrefix}] Stage completed: ${stage}, success=${result.success}`);
      await reportStageResult(stage, result, ctx.reportToDiscord, taskReportCtx);
    });

    pipeline.on('revision:start', ({ stage }) => {
      void ctx.reportToDiscord(t('runner.pipeline.revisionNeeded', { stage }));
    });

    // HALT event: low confidence → report to Linear + Discord
    pipeline.on('halt', async ({ confidence, haltReason, sessionId, iteration }) => {
      console.warn(`[${taskPrefix}] HALT event: confidence=${confidence}%, reason=${haltReason}`);

      // Report to Linear
      if (task.issueId && ctx.guards?.haltToLinear) {
        try {
          await linear.logHalt(task.issueId, sessionId, confidence, iteration, haltReason);
        } catch (err) {
          console.error(`[${taskPrefix}] Linear logHalt failed:`, err);
        }
      }

      // Report to Discord
      const haltEmbed = new EmbedBuilder()
        .setTitle('⚠️ HALT - Low Confidence')
        .setColor(0xFFA500)
        .addFields(
          { name: 'Task', value: task.title, inline: false },
          { name: 'Confidence', value: `${confidence}%`, inline: true },
          { name: 'Iteration', value: `#${iteration}`, inline: true },
          { name: 'Reason', value: haltReason || 'Low confidence score', inline: false },
        )
        .setTimestamp();
      await ctx.reportToDiscord(haltEmbed);
    });

    const stages = getEnabledStages(roles);
    const issueRef = task.issueIdentifier || task.issueId || '';
    const projectDisplay = task.linearProject?.name
      ? `📁 ${task.linearProject.name} (${actualPath.split('/').slice(-2).join('/')})`
      : actualPath.split('/').slice(-2).join('/');

    const startEmbed = new EmbedBuilder()
      .setTitle(t('runner.pipeline.starting'))
      .setColor(0x00AE86)
      .addFields(
        { name: t('runner.result.taskLabel'), value: task.title, inline: false },
        { name: 'Project', value: projectDisplay, inline: true },
        ...(issueRef ? [{ name: 'Issue', value: issueRef, inline: true }] : []),
        { name: 'Stages', value: stages.join(' → '), inline: true },
        ...(worktreeInfo ? [{ name: 'Branch', value: worktreeInfo.branchName, inline: true }] : []),
      )
      .setTimestamp();

    await ctx.reportToDiscord(startEmbed);

    if (task.issueId) {
      try {
        await linear.logPairStart(task.issueId, `pipeline-${Date.now()}`, projectPath);
      } catch (err) {
        console.error(`[${taskPrefix}] Linear logPairStart failed:`, err);
        // Continue pipeline even if this fails
        await linear.updateIssueState(task.issueId, 'In Progress');
      }
    }

    // Run pipeline in worktree path
    const result = await pipeline.run(task, actualPath);

    // Create PR (worktree mode + pipeline success = finalStatus 'approved')
    if (worktreeInfo && result.success && result.finalStatus === 'approved') {
      try {
        const prUrl = await commitAndCreatePR(
          worktreeInfo,
          task.title,
          task.issueIdentifier || '',
          task.description || '',
        );
        result.prUrl = prUrl;
        broadcastEvent({
          type: 'log',
          data: {
            taskId: task.issueId || task.id,
            stage: 'pr',
            line: `PR created: ${prUrl}`,
          },
        });
        console.log(`[Runner] PR created for ${task.issueIdentifier}: ${prUrl}`);
      } catch (err) {
        console.error('[Worktree] PR creation failed:', err);
        broadcastEvent({
          type: 'log',
          data: {
            taskId: task.issueId || task.id,
            stage: 'pr',
            line: `PR creation failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
    } else if (worktreeInfo) {
      // Log why PR was not created
      const reason = !result.success
        ? `Pipeline failed (${result.finalStatus})`
        : `Unexpected state (success=${result.success}, finalStatus=${result.finalStatus})`;
      console.log(`[Runner] PR not created for ${task.issueIdentifier}: ${reason}`);
    }

    return result;
  } finally {
    // Clean up worktree regardless of success/failure
    if (worktreeInfo) {
      await removeWorktree(worktreeInfo).catch((err) =>
        console.warn('[Worktree] Cleanup failed:', err)
      );
    }
  }
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
      const { formatTestReport } = await import('../agents/tester.js');
      await reportFn(formatTestReport(result.result));
      break;
    }
    case 'documenter': {
      const { formatDocReport } = await import('../agents/documenter.js');
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
