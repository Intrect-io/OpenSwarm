// ============================================
// OpenSwarm - Linear Project Updater (PO Agent)
// Rich project status updates + overview auto-refresh
// Uses pipeline history, rejection state, knowledge graph
// ============================================

import { LinearClient } from '@linear/sdk';
import { getPipelineHistory, getAllRejectionEntries, type PipelineHistoryEntry, type RejectionEntry } from '../automation/runnerState.js';
import { getGraph, toProjectSlug, getProjectHealth, type ModuleHealth } from '../knowledge/index.js';
import type { ProjectSummary } from '../knowledge/index.js';
import { getDateLocale } from '../locale/index.js';

// Debounce: prevent duplicate calls within 60 seconds per project
const lastUpdateTime = new Map<string, number>();
const DEBOUNCE_MS = 60_000;

// LinearClient is initialized in linear.ts. Must be set separately here.
let client: LinearClient | null = null;

export function setLinearClient(c: LinearClient): void {
  client = c;
}

function getClient(): LinearClient {
  if (!client) throw new Error('projectUpdater: LinearClient not set');
  return client;
}

export interface CompletedTaskInfo {
  title: string;
  success: boolean;
  duration: number;
  issueIdentifier?: string;
  cost?: number;
  projectPath?: string;
}

// ============================================
// Metrics Collection
// ============================================

interface TodayActivity {
  completed: number;
  failed: number;
  cost: number;
  entries: PipelineHistoryEntry[];
}

interface RollingMetrics {
  totalTasks: number;
  successCount: number;
  failCount: number;
  successRate: number;
  avgDuration: number;
  totalCost: number;
  startDate: string;
  endDate: string;
  // 7-day trend (current 7d vs previous 7d)
  trend: {
    tasks: number;
    successRate: number;
    cost: number;
  };
}

interface KnowledgeMetrics {
  summary: ProjectSummary;
  riskModules: ModuleHealth[];
}

interface ProjectMetrics {
  today: TodayActivity;
  rolling: RollingMetrics;
  rejections: RejectionEntry[];
  knowledge: KnowledgeMetrics | null;
}

function collectProjectMetrics(projectName: string): ProjectMetrics {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  // Pipeline history for this project
  const allHistory = getPipelineHistory(100);
  const projectHistory = allHistory.filter(e => e.projectName === projectName);

  // Today's activity
  const todayEntries = projectHistory.filter(e => e.completedAt.startsWith(todayStr));
  const todayCompleted = todayEntries.filter(e => e.success);
  const todayFailed = todayEntries.filter(e => !e.success);
  const todayCost = todayEntries.reduce((sum, e) => sum + (e.cost?.costUsd ?? 0), 0);

  // 30-day rolling metrics
  const rollingEntries = projectHistory.filter(e => new Date(e.completedAt) >= thirtyDaysAgo);
  const rollingSuccess = rollingEntries.filter(e => e.success);
  const rollingFail = rollingEntries.filter(e => !e.success);
  const rollingCost = rollingEntries.reduce((sum, e) => sum + (e.cost?.costUsd ?? 0), 0);
  const rollingAvgDuration = rollingEntries.length > 0
    ? rollingEntries.reduce((sum, e) => sum + e.totalDuration, 0) / rollingEntries.length
    : 0;

  // 7-day trend: current 7d vs previous 7d
  const current7d = rollingEntries.filter(e => new Date(e.completedAt) >= sevenDaysAgo);
  const prev7d = rollingEntries.filter(e => {
    const d = new Date(e.completedAt);
    return d >= fourteenDaysAgo && d < sevenDaysAgo;
  });

  const current7dRate = current7d.length > 0
    ? current7d.filter(e => e.success).length / current7d.length * 100
    : 0;
  const prev7dRate = prev7d.length > 0
    ? prev7d.filter(e => e.success).length / prev7d.length * 100
    : 0;
  const current7dCost = current7d.reduce((sum, e) => sum + (e.cost?.costUsd ?? 0), 0);
  const prev7dCost = prev7d.reduce((sum, e) => sum + (e.cost?.costUsd ?? 0), 0);

  // Rolling date range
  const rollingDates = rollingEntries.map(e => e.completedAt.slice(0, 10));
  const startDate = rollingDates.length > 0 ? rollingDates[rollingDates.length - 1] : todayStr;
  const endDate = rollingDates.length > 0 ? rollingDates[0] : todayStr;

  // Rejection state
  let rejections: RejectionEntry[] = [];
  try {
    rejections = getAllRejectionEntries().filter(r => r.count > 0);
  } catch { /* graceful fallback */ }

  // Knowledge graph is async — collected separately by caller via collectKnowledgeMetrics()

  return {
    today: {
      completed: todayCompleted.length,
      failed: todayFailed.length,
      cost: todayCost,
      entries: todayEntries,
    },
    rolling: {
      totalTasks: rollingEntries.length,
      successCount: rollingSuccess.length,
      failCount: rollingFail.length,
      successRate: rollingEntries.length > 0
        ? Math.round(rollingSuccess.length / rollingEntries.length * 100)
        : 0,
      avgDuration: rollingAvgDuration,
      totalCost: rollingCost,
      startDate,
      endDate,
      trend: {
        tasks: current7d.length - prev7d.length,
        successRate: Math.round((current7dRate - prev7dRate) * 10) / 10,
        cost: Math.round((current7dCost - prev7dCost) * 100) / 100,
      },
    },
    rejections,
    knowledge: null,
  };
}

async function collectKnowledgeMetrics(projectPath: string): Promise<KnowledgeMetrics | null> {
  try {
    const slug = toProjectSlug(projectPath);
    const graph = await getGraph(slug);
    if (!graph) return null;
    const { summary, riskModules } = getProjectHealth(graph);
    return { summary, riskModules };
  } catch {
    return null;
  }
}

// ============================================
// Health Determination
// ============================================

type HealthStatus = 'onTrack' | 'atRisk' | 'offTrack';

function determineHealth(metrics: ProjectMetrics): { health: HealthStatus; score: number } {
  let score = 100;

  // Success rate signal
  if (metrics.rolling.totalTasks > 0) {
    if (metrics.rolling.successRate < 50) score -= 40;
    else if (metrics.rolling.successRate < 70) score -= 20;
    else if (metrics.rolling.successRate < 85) score -= 10;
  }

  // Active rejections
  if (metrics.rejections.length >= 3) score -= 20;
  else if (metrics.rejections.length >= 1) score -= 10;

  // Declining trend
  if (metrics.rolling.trend.successRate < -15) score -= 15;
  else if (metrics.rolling.trend.successRate < -5) score -= 5;

  // No activity in 30 days
  if (metrics.rolling.totalTasks === 0) score -= 10;

  // Today's failures exceed completions
  if (metrics.today.failed > metrics.today.completed && metrics.today.failed > 0) score -= 15;

  // Knowledge graph risk modules
  if (metrics.knowledge) {
    const highRisk = metrics.knowledge.riskModules.filter(m => m.risk === 'high');
    if (highRisk.length >= 5) score -= 10;
    else if (highRisk.length >= 2) score -= 5;
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));

  let health: HealthStatus;
  if (score >= 70) health = 'onTrack';
  else if (score >= 40) health = 'atRisk';
  else health = 'offTrack';

  return { health, score };
}

// ============================================
// Status Update Body Builder
// ============================================

function buildStatusUpdateBody(
  projectName: string,
  metrics: ProjectMetrics,
): string {
  const today = new Date().toLocaleDateString(getDateLocale(), {
    year: 'numeric', month: '2-digit', day: '2-digit',
  });

  const lines: string[] = [];
  lines.push(`## ${projectName} -- Status Update (${today})`);
  lines.push('');

  // Today's Activity
  lines.push('### Today\'s Activity');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Completed | ${metrics.today.completed} |`);
  lines.push(`| Failed | ${metrics.today.failed} |`);
  lines.push(`| Cost | $${metrics.today.cost.toFixed(2)} |`);
  lines.push('');

  // 30-Day Metrics
  if (metrics.rolling.totalTasks > 0) {
    const trendTasks = formatTrend(metrics.rolling.trend.tasks, '');
    const trendRate = formatTrend(metrics.rolling.trend.successRate, '%');
    const trendCost = formatTrend(metrics.rolling.trend.cost, '', '$');

    lines.push(`### 30-Day Metrics (${metrics.rolling.startDate} ~ ${metrics.rolling.endDate})`);
    lines.push('| Metric | Value | Trend (7d) |');
    lines.push('|--------|-------|------------|');
    lines.push(`| Tasks | ${metrics.rolling.totalTasks} | ${trendTasks} |`);
    lines.push(`| Success Rate | ${metrics.rolling.successRate}% | ${trendRate} |`);
    lines.push(`| Avg Duration | ${formatDuration(metrics.rolling.avgDuration)} | - |`);
    lines.push(`| Total Cost | $${metrics.rolling.totalCost.toFixed(2)} | ${trendCost} |`);
    lines.push('');
  }

  // Recent Tasks (up to 10)
  const recentEntries = metrics.today.entries.length > 0
    ? metrics.today.entries.slice(0, 10)
    : getPipelineHistory(10).filter(e => e.projectName === projectName).slice(0, 5);

  if (recentEntries.length > 0) {
    lines.push('### Recent Tasks');
    lines.push('| | ID | Task | Duration/Cost | PR |');
    lines.push('|-|----|------|---------------|----|');
    for (const e of recentEntries) {
      const icon = e.success ? '\u2713' : '\u2717';
      const id = e.issueIdentifier || '-';
      const title = e.taskTitle.length > 40 ? e.taskTitle.slice(0, 37) + '...' : e.taskTitle;
      const dur = formatDuration(e.totalDuration);
      const cost = e.cost?.costUsd ? `$${e.cost.costUsd.toFixed(2)}` : '-';
      const pr = e.prUrl ? `[PR](${e.prUrl})` : '-';
      lines.push(`| ${icon} | ${id} | ${title} | ${dur} ${cost} | ${pr} |`);
    }
    lines.push('');
  }

  // Failed Tasks (grouped by issue with failure count and latest reason)
  const failedEntries = metrics.today.entries.filter(e => !e.success);
  if (failedEntries.length > 0) {
    // Group by issueIdentifier
    const failedByIssue = new Map<string, { count: number; latestReason: string; taskTitle: string }>();

    for (const e of failedEntries) {
      const id = e.issueIdentifier || e.taskTitle.slice(0, 20);
      const reason = e.reviewerFeedback || e.finalStatus || 'Unknown failure';

      if (!failedByIssue.has(id)) {
        failedByIssue.set(id, { count: 0, latestReason: reason, taskTitle: e.taskTitle });
      }

      const entry = failedByIssue.get(id)!;
      entry.count++;
      entry.latestReason = reason; // Keep latest reason (entries are newest first)
    }

    lines.push('### Failed Tasks');
    for (const [id, { count, latestReason }] of failedByIssue) {
      const countStr = count > 1 ? ` (${count}회 실패)` : '';
      const reasonStr = latestReason.length > 150 ? latestReason.slice(0, 147) + '...' : latestReason;
      lines.push(`- **${id}**${countStr}: ${reasonStr}`);
    }
    lines.push('');
  }

  // Blocked / Rejected Items
  if (metrics.rejections.length > 0) {
    lines.push('### Blocked / Rejected Items');
    for (const r of metrics.rejections.slice(0, 10)) {
      const latestReason = r.reasons.length > 0 ? r.reasons[r.reasons.length - 1] : 'unknown';
      const shortId = r.issueId.slice(0, 8);
      lines.push(`- Issue ${shortId}...: ${r.count} rejection(s) -- ${latestReason.slice(0, 80)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================
// Overview Section Builder
// ============================================

function buildOverviewSection(
  stateCounts: Map<string, number>,
  priorityCounts: Map<number, number>,
  metrics: ProjectMetrics,
): string {
  const now = new Date().toLocaleString(getDateLocale());

  const lines: string[] = [];
  lines.push(AUTOMATION_SECTION_MARKER);
  lines.push(`> Last updated: ${now}`);
  lines.push('');

  // Issue Distribution - By State
  lines.push('### Issue Distribution');
  lines.push('**By State:**');
  lines.push('| State | Count |');
  lines.push('|-------|-------|');
  const stateOrder = ['Done', 'In Progress', 'In Review', 'Todo', 'Backlog', 'Cancelled', 'Triage'];
  for (const state of stateOrder) {
    if (stateCounts.has(state)) {
      lines.push(`| ${state} | ${stateCounts.get(state)} |`);
    }
  }
  // Include any states not in the predefined order
  for (const [state, count] of stateCounts) {
    if (!stateOrder.includes(state)) {
      lines.push(`| ${state} | ${count} |`);
    }
  }
  lines.push('');

  // Issue Distribution - By Priority
  if (priorityCounts.size > 0) {
    const priorityLabels: Record<number, string> = { 0: 'No Priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
    lines.push('**By Priority:**');
    lines.push('| Priority | Count |');
    lines.push('|----------|-------|');
    for (const p of [1, 2, 3, 4, 0]) {
      if (priorityCounts.has(p)) {
        lines.push(`| ${priorityLabels[p] ?? `P${p}`} | ${priorityCounts.get(p)} |`);
      }
    }
    lines.push('');
  }

  // Automation Performance (30d)
  lines.push('### Automation Performance (30d)');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Tasks Completed | ${metrics.rolling.successCount} / ${metrics.rolling.totalTasks} |`);
  lines.push(`| Success Rate | ${metrics.rolling.successRate}% |`);
  lines.push(`| Avg Duration | ${formatDuration(metrics.rolling.avgDuration)} |`);
  lines.push(`| Total Cost | $${metrics.rolling.totalCost.toFixed(2)} |`);
  lines.push(`| Active Rejections | ${metrics.rejections.length} |`);
  lines.push('');

  // Code Health (if knowledge graph available)
  if (metrics.knowledge) {
    const s = metrics.knowledge.summary;
    const testCoverage = s.totalModules > 0
      ? Math.round((1 - s.untestedModules.length / s.totalModules) * 100)
      : 0;
    const highRisk = metrics.knowledge.riskModules.filter(m => m.risk === 'high');
    const highDebt = s.highTechDebtModules ?? [];

    lines.push('### Code Health');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Modules | ${s.totalModules} |`);
    lines.push(`| Test Files | ${s.totalTestFiles} |`);
    lines.push(`| Test Coverage | ${testCoverage}% |`);
    lines.push(`| High-Risk Modules | ${highRisk.length} |`);
    lines.push(`| High Tech Debt | ${highDebt.length} |`);
    lines.push('');

    if (s.hotModules.length > 0) {
      lines.push(`**Hot Modules**: ${s.hotModules.slice(0, 5).map(m => `\`${m}\``).join(', ')}`);
    }
    if (highDebt.length > 0) {
      lines.push(`**Tech Debt Watch**: ${highDebt.slice(0, 5).map(m => `\`${m}\``).join(', ')}`);
    }
    if (s.hotModules.length > 0 || highDebt.length > 0) {
      lines.push('');
    }
  }

  // Risk Areas
  const riskLines: string[] = [];
  if (metrics.rejections.length > 0) {
    riskLines.push(`- ${metrics.rejections.length} task(s) blocked by reviewer rejection`);
  }
  if (metrics.knowledge) {
    const untested = metrics.knowledge.summary.untestedModules.length;
    if (untested > 0) {
      riskLines.push(`- ${untested} modules without tests`);
    }
  }
  if (metrics.rolling.totalTasks > 0 && metrics.rolling.successRate < 70) {
    riskLines.push(`- Low automation success rate: ${metrics.rolling.successRate}%`);
  }

  if (riskLines.length > 0) {
    lines.push('### Risk Areas');
    lines.push(riskLines.join('\n'));
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================
// Public API
// ============================================

/**
 * Update Linear project Overview after task completion
 * NOTE: Status Updates are now handled by dailyReporter (scheduled once daily)
 */
export async function updateProjectAfterTask(
  projectId: string,
  projectName: string,
  task: CompletedTaskInfo,
): Promise<void> {
  // Debounce
  const last = lastUpdateTime.get(projectId) ?? 0;
  if (Date.now() - last < DEBOUNCE_MS) return;
  lastUpdateTime.set(projectId, Date.now());

  // Only refresh overview (Status Updates now handled by dailyReporter)
  await refreshProjectOverview(projectId, task.projectPath);
}

// ============================================
// B-1. Create Status Update
// ============================================

/**
 * Post Status Update for a project (called by dailyReporter)
 * @param projectId - Linear project ID
 * @param projectName - Project name
 * @param projectPath - Optional project path for knowledge graph metrics
 */
export async function postStatusUpdate(
  projectId: string,
  projectName: string,
  projectPath?: string,
): Promise<void> {
  const linear = getClient();

  // Collect metrics
  const metrics = collectProjectMetrics(projectName);

  // Async knowledge graph collection
  if (projectPath) {
    metrics.knowledge = await collectKnowledgeMetrics(projectPath);
  }

  // Build body
  const body = buildStatusUpdateBody(projectName, metrics);

  // Determine health
  const { health } = determineHealth(metrics);

  try {
    await linear.createProjectUpdate({
      projectId,
      body,
      health: health as any,
    });
    console.log(`[ProjectUpdater] Status update posted for "${projectName}" (health=${health})`);
  } catch (err) {
    console.warn(`[ProjectUpdater] Failed to post status update:`, err);
  }
}

// ============================================
// B-2. Project Overview refresh
// ============================================

const AUTOMATION_SECTION_MARKER = '## Automation Status';

async function refreshProjectOverview(projectId: string, projectPath?: string): Promise<void> {
  const linear = getClient();

  try {
    const project = await linear.project(projectId);
    if (!project) return;

    // Issue stats: count issues by state and priority
    const issues = await project.issues({ first: 250 });
    const stateCounts = new Map<string, number>();
    const priorityCounts = new Map<number, number>();

    for (const issue of issues.nodes) {
      const state = (await issue.state)?.name ?? 'Unknown';
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
      priorityCounts.set(issue.priority, (priorityCounts.get(issue.priority) ?? 0) + 1);
    }

    // Collect metrics
    const metrics = collectProjectMetrics(project.name);

    // Async knowledge graph
    if (projectPath) {
      metrics.knowledge = await collectKnowledgeMetrics(projectPath);
    }

    // Build overview section
    const section = buildOverviewSection(stateCounts, priorityCounts, metrics);

    // Replace automation section in existing description, or append
    const currentDesc = project.description ?? '';
    const markerIdx = currentDesc.indexOf(AUTOMATION_SECTION_MARKER);

    let newDesc: string;
    if (markerIdx >= 0) {
      newDesc = currentDesc.slice(0, markerIdx) + section;
    } else {
      newDesc = currentDesc + '\n\n' + section;
    }

    await linear.updateProject(projectId, { description: newDesc });
    console.log(`[ProjectUpdater] Project overview updated for "${project.name}"`);
  } catch (err) {
    console.warn(`[ProjectUpdater] Failed to update project overview:`, err);
  }
}

// ============================================
// Helpers
// ============================================

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function formatTrend(value: number, suffix: string, prefix = ''): string {
  if (value === 0) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${prefix}${value}${suffix}`;
}
