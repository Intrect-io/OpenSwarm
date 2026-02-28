// ============================================
// OpenSwarm - Pipeline Result Formatting
// Discord message/embed formatting for pipeline results
// ============================================

import { EmbedBuilder } from 'discord.js';
import type { PipelineResult } from './pairPipeline.js';
import { formatCost } from '../support/costTracker.js';

/** Format epoch ms to HH:MM:SS local time string */
function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleTimeString('en-GB', { hour12: false }); // HH:MM:SS
}

/**
 * Format pipeline result as a Discord message
 */
export function formatPipelineResult(result: PipelineResult): string {
  const statusEmoji = {
    approved: '✅',
    rejected: '❌',
    failed: '💥',
    cancelled: '🚫',
    decomposed: '🔀',
  }[result.finalStatus];

  const lines: string[] = [];

  // Task context header
  if (result.taskContext) {
    const ctx = result.taskContext;
    const parts: string[] = [];
    // projectName fallback: extract from projectPath if not provided
    const displayName = ctx.projectName
      || (ctx.projectPath ? ctx.projectPath.split('/').pop() || '' : '');
    if (displayName) parts.push(`📁 ${displayName}`);
    if (ctx.issueIdentifier) parts.push(`🔖 ${ctx.issueIdentifier}`);
    if (ctx.projectPath) parts.push(`\`${ctx.projectPath.split('/').slice(-2).join('/')}\``);
    if (parts.length > 0) {
      lines.push(parts.join(' | '));
    }
    if (ctx.taskTitle) {
      lines.push(`📋 ${ctx.taskTitle}`);
    }
    lines.push('');
  }

  lines.push(`${statusEmoji} **Pipeline ${result.finalStatus.toUpperCase()}**`);
  lines.push('');
  lines.push(`**Session:** \`${result.sessionId}\``);
  lines.push(`**Iterations:** ${result.iterations}`);
  lines.push(`**Duration:** ${(result.totalDuration / 1000).toFixed(1)}s`);

  if (result.totalCost) {
    lines.push(`**Cost:** $${result.totalCost.costUsd.toFixed(4)} (${formatCost(result.totalCost)})`);
  }

  lines.push('');
  lines.push('**Stages:**');
  for (const stage of result.stages) {
    const emoji = stage.success ? '✅' : '❌';
    const duration = (stage.duration / 1000).toFixed(1);
    const time = formatTimestamp(stage.startedAt);
    lines.push(`  ${emoji} ${stage.stage} (${duration}s) @ ${time}`);
  }

  return lines.join('\n');
}

/**
 * Format pipeline result as a Discord Embed
 */
export function formatPipelineResultEmbed(result: PipelineResult): EmbedBuilder {
  const statusConfig = {
    approved: { emoji: '✅', color: 0x00FF00, label: 'SUCCESS' },
    rejected: { emoji: '❌', color: 0xFF0000, label: 'REJECTED' },
    failed: { emoji: '💥', color: 0xFF6B6B, label: 'FAILED' },
    cancelled: { emoji: '🚫', color: 0xFFAA00, label: 'CANCELLED' },
    decomposed: { emoji: '🔀', color: 0x00AAFF, label: 'DECOMPOSED' },
  }[result.finalStatus] || { emoji: '❓', color: 0x808080, label: 'UNKNOWN' };

  const embed = new EmbedBuilder()
    .setTitle(`${statusConfig.emoji} Pipeline ${statusConfig.label}`)
    .setColor(statusConfig.color)
    .setTimestamp();

  // Task context
  if (result.taskContext) {
    const ctx = result.taskContext;
    const displayName = ctx.projectName
      || (ctx.projectPath ? ctx.projectPath.split('/').pop() || '' : '');

    if (displayName && ctx.issueIdentifier) {
      embed.setDescription(`📁 **${displayName}** | 🔖 ${ctx.issueIdentifier}\n${ctx.taskTitle || ''}`);
    } else if (ctx.taskTitle) {
      embed.setDescription(ctx.taskTitle);
    }
  }

  // Summary stats
  const durationStr = (result.totalDuration / 1000).toFixed(1) + 's';
  const costStr = result.totalCost
    ? `$${result.totalCost.costUsd.toFixed(4)} (${formatCost(result.totalCost)})`
    : 'N/A';

  embed.addFields(
    { name: '🔄 Iterations', value: result.iterations.toString(), inline: true },
    { name: '⏱️ Duration', value: durationStr, inline: true },
    { name: '💰 Cost', value: costStr, inline: true },
  );

  // Stages
  const stagesStr = result.stages
    .map(s => {
      const emoji = s.success ? '✅' : '❌';
      const duration = (s.duration / 1000).toFixed(1);
      const time = formatTimestamp(s.startedAt);
      return `${emoji} **${s.stage}** (${duration}s) @ ${time}`;
    })
    .join('\n') || 'No stages';

  embed.addFields({ name: '📊 Stages', value: stagesStr, inline: false });

  // Worker result
  if (result.workerResult) {
    const worker = result.workerResult;
    let workerValue = '';

    if (worker.summary) {
      workerValue += `${worker.summary.slice(0, 200)}${worker.summary.length > 200 ? '...' : ''}\n\n`;
    }

    if (worker.filesChanged && worker.filesChanged.length > 0) {
      const filesStr = worker.filesChanged.slice(0, 5).map(f => `\`${f}\``).join(', ');
      workerValue += `**Files:** ${filesStr}`;
      if (worker.filesChanged.length > 5) {
        workerValue += ` +${worker.filesChanged.length - 5} more`;
      }
    }

    if (workerValue) {
      embed.addFields({ name: '🔨 Worker', value: workerValue, inline: false });
    }
  }

  // Reviewer result
  if (result.reviewResult) {
    const review = result.reviewResult;
    let reviewValue = `**Decision:** ${review.decision.toUpperCase()}\n\n`;

    if (review.feedback) {
      reviewValue += review.feedback.slice(0, 300);
      if (review.feedback.length > 300) reviewValue += '...';
    }

    if (review.issues && review.issues.length > 0) {
      reviewValue += `\n\n**Issues found:** ${review.issues.length}`;
    }

    embed.addFields({ name: '✅ Reviewer', value: reviewValue, inline: false });
  }

  // Tester result
  if (result.testerResult) {
    const test = result.testerResult;
    const total = test.testsPassed + test.testsFailed;
    const passRate = total > 0 ? ((test.testsPassed / total) * 100).toFixed(1) : '0';

    let testValue = `✅ Passed: ${test.testsPassed}/${total} (${passRate}%)`;

    if (test.coverage !== undefined) {
      testValue += `\n📊 Coverage: ${test.coverage.toFixed(1)}%`;
    }

    if (test.testsFailed > 0 && test.failedTests && test.failedTests.length > 0) {
      const failedStr = test.failedTests.slice(0, 2).map(t => `❌ ${t}`).join('\n');
      testValue += `\n\n${failedStr}`;
      if (test.failedTests.length > 2) {
        testValue += `\n... +${test.failedTests.length - 2} more`;
      }
    }

    embed.addFields({ name: '🧪 Tests', value: testValue, inline: false });
  }

  // PR URL
  if (result.prUrl) {
    embed.addFields({ name: '🔗 Pull Request', value: `[View PR](${result.prUrl})`, inline: false });
  }

  // Footer
  embed.setFooter({ text: `Session: ${result.sessionId.slice(0, 8)}...` });

  return embed;
}
