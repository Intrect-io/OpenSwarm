// ============================================
// OpenSwarm - Pipeline Result Formatting
// Discord message/embed formatting for pipeline results
// ============================================

import { EmbedBuilder } from 'discord.js';
import type { PipelineResult } from './pairPipeline.js';
import { formatCost } from '../support/costTracker.js';
import {
  boundedFieldValue,
  boundedDescription,
  boundedMessageContent,
  PIPELINE_EMBED_FIELD_VALUE_LIMIT,
  PIPELINE_FAILED_TESTS_PREVIEW,
  DISCORD_EMBED_FIELDS_PER_EMBED,
  DISCORD_EMBED_AGGREGATE_VALUE_LIMIT,
  truncate,
} from '../support/outputBudget.js';

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
    superseded: '♻️',
    deferred: '⏳',
    waiting_on_operator: '🙋',
    rate_limited: '⏸',
    infra_error: '🔌',
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
      lines.push(`📋 ${truncate(ctx.taskTitle, 200)}`);
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

  return boundedMessageContent(lines.join('\n'));
}

/**
 * Format pipeline result as a Discord Embed.
 * Enforces per-field and aggregate embed budgets to prevent payload rejection.
 */
export function formatPipelineResultEmbed(result: PipelineResult): EmbedBuilder {
  const statusConfig = {
    approved: { emoji: '✅', color: 0x00FF00, label: 'SUCCESS' },
    rejected: { emoji: '❌', color: 0xFF0000, label: 'REJECTED' },
    failed: { emoji: '💥', color: 0xFF6B6B, label: 'FAILED' },
    cancelled: { emoji: '🚫', color: 0xFFAA00, label: 'CANCELLED' },
    decomposed: { emoji: '🔀', color: 0x00AAFF, label: 'DECOMPOSED' },
    superseded: { emoji: '♻️', color: 0x00AAFF, label: 'SUPERSEDED' },
    deferred: { emoji: '⏳', color: 0xFFAA00, label: 'DEFERRED' },
    waiting_on_operator: { emoji: '🙋', color: 0xFFC300, label: 'WAITING ON OPERATOR' },
    rate_limited: { emoji: '⏸', color: 0xFFAA00, label: 'RATE LIMITED' },
    infra_error: { emoji: '🔌', color: 0xFFAA00, label: 'INFRA ERROR' },
  }[result.finalStatus] || { emoji: '❓', color: 0x808080, label: 'UNKNOWN' };

  const embed = new EmbedBuilder()
    .setTitle(`${statusConfig.emoji} Pipeline ${statusConfig.label}`)
    .setColor(statusConfig.color)
    .setTimestamp();

  // Task context (bounded description)
  if (result.taskContext) {
    const ctx = result.taskContext;
    const displayName = ctx.projectName
      || (ctx.projectPath ? ctx.projectPath.split('/').pop() || '' : '');

    if (displayName && ctx.issueIdentifier) {
      embed.setDescription(
        boundedDescription(`📁 **${displayName}** | 🔖 ${ctx.issueIdentifier}\n${ctx.taskTitle || ''}`),
      );
    } else if (ctx.taskTitle) {
      embed.setDescription(boundedDescription(ctx.taskTitle));
    }
  }

  // Track aggregate field value length to stay within embed budget
  let aggregateValueLength = 0;

  const tryAddField = (name: string, value: string, inline = false): boolean => {
    const bounded = boundedFieldValue(value, PIPELINE_EMBED_FIELD_VALUE_LIMIT);
    const newTotal = aggregateValueLength + bounded.length;
    if (newTotal > DISCORD_EMBED_AGGREGATE_VALUE_LIMIT) return false;
    if (embed.data.fields && embed.data.fields.length >= DISCORD_EMBED_FIELDS_PER_EMBED) return false;
    embed.addFields({ name, value: bounded, inline });
    aggregateValueLength = newTotal;
    return true;
  };

  // Summary stats
  const durationStr = (result.totalDuration / 1000).toFixed(1) + 's';
  const costStr = result.totalCost
    ? `$${result.totalCost.costUsd.toFixed(4)} (${formatCost(result.totalCost)})`
    : 'N/A';

  tryAddField('🔄 Iterations', result.iterations.toString(), true);
  tryAddField('⏱️ Duration', durationStr, true);
  tryAddField('💰 Cost', costStr, true);

  // Stages
  const stagesStr = result.stages
    .map(s => {
      const emoji = s.success ? '✅' : '❌';
      const duration = (s.duration / 1000).toFixed(1);
      const time = formatTimestamp(s.startedAt);
      return `${emoji} **${s.stage}** (${duration}s) @ ${time}`;
    })
    .join('\n') || 'No stages';

  tryAddField('📊 Stages', stagesStr, false);

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
      tryAddField('🔨 Worker', workerValue, false);
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

    tryAddField('✅ Reviewer', reviewValue, false);
  }

  // Tester result
  if (result.testerResult) {
    const test = result.testerResult;
    const total = test.testsPassed + test.testsFailed;
    const passRate = total > 0 ? ((test.testsPassed / total) * 100).toFixed(1) : '0';

    let testValue = `✅ Passed: ${test.testsPassed}/${total} (${passRate}%)${test.deterministic ? ' · deterministic' : ''}`;

    if (test.coverage !== undefined) {
      testValue += `\n📊 Coverage: ${test.coverage.toFixed(1)}%`;
    }

    if (test.testsFailed > 0 && test.failedTests && test.failedTests.length > 0) {
      const failedStr = test.failedTests.slice(0, PIPELINE_FAILED_TESTS_PREVIEW).map(t => `❌ ${t}`).join('\n');
      testValue += `\n\n${failedStr}`;
      if (test.failedTests.length > PIPELINE_FAILED_TESTS_PREVIEW) {
        testValue += `\n... +${test.failedTests.length - PIPELINE_FAILED_TESTS_PREVIEW} more`;
      }
    }

    tryAddField('🧪 Tests', testValue, false);
  }

  // PR URL
  if (result.prUrl) {
    tryAddField('🔗 Pull Request', `[View PR](${result.prUrl})`, false);
  }

  // Footer
  embed.setFooter({ text: `Session: ${result.sessionId.slice(0, 8)}...` });

  return embed;
}
