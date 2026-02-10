// ============================================
// Claude Swarm - Runner Execution Helpers
// AutonomousRunner에서 추출된 실행/보고/통합 로직
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

  await ctx.reportToDiscord(`📋 **작업 분해 시작**\n` +
    `작업: ${task.title}\n` +
    `예상 시간: ${planner.estimateTaskDuration(task)}분 (>${targetMinutes}분)\n` +
    `Planner가 sub-tasks로 분해 중...`
  );

  const result = await planner.runPlanner({
    taskTitle: task.title,
    taskDescription: task.description || '',
    projectPath,
    projectName: task.linearProject?.name,
    targetMinutes,
    model: ctx.plannerModel ?? 'claude-sonnet-4-20250514',
    timeoutMs: 300000,
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
      ? `\n\n**선행 작업:** ${subTask.dependencies.join(', ')}`
      : '';

    const subDescription = `${subTask.description}\n\n` +
      `**예상 시간:** ${subTask.estimatedMinutes}분${depsStr}\n\n` +
      `---\n_Planner에 의해 "${task.title}"에서 자동 분해됨_`;

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

  await ctx.reportToDiscord(`✅ **작업 분해 완료**\n\n` +
    `원본: ${task.issueIdentifier || task.issueId}\n` +
    `생성된 sub-issues (${createdSubIssues.length}개):\n${subIssueList}\n\n` +
    `총 예상 시간: ${result.totalEstimatedMinutes}분`
  );

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
      console.log('[AutonomousRunner] Decomposition skipped, executing original task');
    }
  }

  const roles = ctx.getRolesForProject(projectPath);
  const pipeline = createPipelineFromConfig(roles, ctx.pairMaxAttempts ?? 3);

  pipeline.on('stage:start', ({ stage }) => {
    console.log(`[Pipeline] Stage started: ${stage}`);
  });

  pipeline.on('stage:complete', async ({ stage, result }) => {
    console.log(`[Pipeline] Stage completed: ${stage}, success=${result.success}`);
    await reportStageResult(stage, result, ctx.reportToDiscord);
  });

  pipeline.on('revision:start', ({ stage }) => {
    void ctx.reportToDiscord(`🔄 수정이 필요합니다. ${stage} 피드백으로 Worker가 재작업합니다...`);
  });

  const stages = getEnabledStages(roles);
  const startEmbed = new EmbedBuilder()
    .setTitle('🚀 파이프라인 시작')
    .setColor(0x00AE86)
    .addFields(
      { name: '작업', value: task.title, inline: false },
      { name: 'Project', value: projectPath.split('/').slice(-2).join('/'), inline: true },
      { name: 'Stages', value: stages.join(' → '), inline: true },
    )
    .setTimestamp();

  await ctx.reportToDiscord(startEmbed);

  if (task.issueId) {
    await linear.updateIssueState(task.issueId, 'In Progress');
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
): Promise<void> {
  switch (stage) {
    case 'worker':
      await reportFn(workerAgent.formatWorkReport(result.result));
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
    .setTitle('⏳ 승인 대기')
    .setColor(0xFFA500)
    .setDescription(`다음 작업을 실행할까요?\n\n${projectInfo}**${decision.task.title}**`)
    .addFields(
      { name: 'Issue', value: issueRef, inline: true },
      { name: 'Priority', value: `P${decision.task.priority}`, inline: true },
      { name: '사유', value: decision.reason, inline: false },
    )
    .setFooter({ text: '!approve 또는 !reject 로 응답' })
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
      .setTitle('✅ 작업 완료')
      .setColor(0x00FF00)
      .addFields(
        { name: '작업', value: taskDisplay, inline: false },
        { name: '소요 시간', value: `${duration}s`, inline: true },
        { name: '완료 Step', value: `${completedCount}/${stepCount}`, inline: true },
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
      .setTitle('❌ 작업 실패')
      .setColor(0xFF0000)
      .addFields(
        { name: '작업', value: taskDisplay, inline: false },
        { name: '실패 Step', value: result.failedStep || 'Unknown', inline: true },
        { name: 'Rollback', value: result.rollbackPerformed ? '✅' : '❌', inline: true },
      )
      .setTimestamp();

    await reportFn(embed);

    const failedStepResult = result.execution.stepResults[result.failedStep || ''];
    if (failedStepResult?.error) {
      await reportFn(`\`\`\`\n${failedStepResult.error.slice(0, 1500)}\n\`\`\``);
    }
  }
}
