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
  PIPELINE_EMBED_FIELD_VALUE_LIMIT,
  PIPELINE_FAILED_TESTS_PREVIEW,
  DISCORD_EMBED_FIELDS_PER_EMBED,
  DISCORD_EMBED_AGGREGATE_VALUE_LIMIT,
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
    if (ctx.taskTitle) parts.push(ctx.taskTitle);
    lines.push(`**${parts.join(' | ')}**`);
  }

  // Status line
  lines.push('');
  lines.push(`${statusEmoji} **Status:** ${result.finalStatus}`);

  // Duration
  if (result.totalDuration) {
    const mins = Math.floor(result.totalDuration / 60000);
    const secs = Math.round((result.totalDuration % 60000) / 1000);
    lines.push(`⏱ **Duration:** ${mins}m ${secs}s`);
  }

  // Cost
  if (result.totalCost) {
    lines.push(`💰 **Cost:** ${formatCost(result.totalCost)}`);
  }

  // Stage summary
  if (result.stages && result.stages.length > 0) {
    lines.push('');
    lines.push('**Stages:**');
    for (const stage of result.stages) {
      const stageEmoji = stage.status === 'success' ? '✅' : stage.status === 'failed' ? '❌' : '⏳';
      lines.push(`  ${stageEmoji} ${stage.name}${stage.durationMs ? ` (${Math.round(stage.durationMs / 1000)}s)` : ''}`);
    }
  }

  // Worker summary
  if (result.workerResult) {
    lines.push('');
    lines.push(`**🔨 Worker:** ${result.workerResult.summary || 'No summary'}`);
    if (result.workerResult.filesChanged && result.workerResult.filesChanged.length > 0) {
      const files = result.workerResult.filesChanged.slice(0, 10);
      lines.push(`  Files: ${files.join(', ')}`);
      if (result.workerResult.filesChanged.length > 10) {
        lines.push(`  ... +${result.workerResult.filesChanged.length - 10} more`);
      }
    }
  }

  // Reviewer feedback
  if (result.reviewResult) {
    lines.push('');
    const reviewEmoji = result.reviewResult.decision === 'approved' ? '✅' : '❌';
    lines.push(`${reviewEmoji} **Reviewer:** ${result.reviewResult.decision}`);
    if (result.reviewResult.feedback) {
      // Bound reviewer feedback to prevent oversized messages
      const feedback = result.reviewResult.feedback.length > 500
        ? result.reviewResult.feedback.slice(0, 500) + '…'
        : result.reviewResult.feedback;
      lines.push(`  ${feedback}`);
    }
  }

  // Test results
  if (result.testerResult) {
    lines.push('');
    const testEmoji = result.testerResult.success ? '✅' : '❌';
    lines.push(`${testEmoji} **Tests:** ${result.testerResult.testsPassed} passed, ${result.testerResult.testsFailed} failed`);
  }

  // PR URL
  if (result.prUrl) {
    lines.push('');
    lines.push(`🔗 **Pull Request:** ${result.prUrl}`);
  }

  return lines.join('\n');
}

/**
 * Format pipeline result as a Discord embed
 * Enforces per-field and aggregate embed budgets to prevent payload rejection.
 */
export function formatPipelineResultEmbed(result: PipelineResult): EmbedBuilder {
  const statusColor = {
    approved: 0x00ff41,
    rejected: 0xff0044,
    failed: 0xff6600,
    cancelled: 0x888888,
    decomposed: 0x00aaff,
    superseded: 0xaa00ff,
    deferred: 0xffaa00,
    waiting_on_operator: 0xffff00,
    rate_limited: 0xff8800,
    infra_error: 0xff4444,
  }[result.finalStatus] || 0x888888;

  const embed = new EmbedBuilder()
    .setColor(statusColor)
    .setTimestamp();

  // Title (bounded)
  const title = result.taskContext?.taskTitle || 'Pipeline Result';
  embed.setTitle(title.length > 256 ? `${title.slice(0, 253)}…` : title);

  // Description (bounded)
  if (result.taskContext) {
    const ctx = result.taskContext;
    const displayName = ctx.projectName
      || (ctx.projectPath ? ctx.projectPath.split('/').pop() || '' : '');
    const descParts: string[] = [];
    if (displayName) descParts.push(`📁 ${displayName}`);
    if (ctx.issueIdentifier) descParts.push(`🔖 ${ctx.issueIdentifier}`);
    embed.setDescription(boundedDescription(descParts.join(' | ')));
  }

  // Track aggregate field value length to stay within embed budget
  let aggregateValueLength = 0;

  // Helper to add a field only if it fits within the aggregate budget
  const tryAddField = (name: string, value: string, inline = false): boolean => {
    const bounded = boundedFieldValue(value, PIPELINE_EMBED_FIELD_VALUE_LIMIT);
    const newTotal = aggregateValueLength + bounded.length;
    if (newTotal > DISCORD_EMBED_AGGREGATE_VALUE_LIMIT) return false;
    if (embed.data.fields && embed.data.fields.length >= DISCORD_EMBED_FIELDS_PER_EMBED) return false;
    embed.addFields({ name, value: bounded, inline });
    aggregateValueLength = newTotal;
    return true;
  };

  // Status field
  tryAddField('Status', result.finalStatus, true);

  // Duration
  if (result.totalDuration) {
    const mins = Math.floor(result.totalDuration / 60000);
    const secs = Math.round((result.totalDuration % 60000) / 1000);
    tryAddField('Duration', `${mins}m ${secs}s`, true);
  }

  // Cost
  if (result.totalCost) {
    tryAddField('Cost', formatCost(result.totalCost), true);
  }

  // Stages
  if (result.stages && result.stages.length > 0) {
    const stagesStr = result.stages.map((s) => {
      const emoji = s.status === 'success' ? '✅' : s.status === 'failed' ? '❌' : '⏳';
      return `${emoji} ${s.name}${s.durationMs ? ` (${Math.round(s.durationMs / 1000)}s)` : ''}`;
    }).join('\n');
    tryAddField('📊 Stages', stagesStr, false);
  }

  // Worker
  if (result.workerResult) {
    let workerValue = result.workerResult.summary
      ? boundedFieldValue(result.workerResult.summary, PIPELINE_EMBED_FIELD_VALUE_LIMIT)
      : 'No summary';
    if (result.workerResult.filesChanged && result.workerResult.filesChanged.length > 0) {
      const files = result.workerResult.filesChanged.slice(0, 10).join(', ');
      workerValue += `\n\n**Files:** ${files}`;
      if (result.workerResult.filesChanged.length > 10) {
        workerValue += `\n… +${result.workerResult.filesChanged.length - 10} more`;
      }
    }
    tryAddField('🔨 Worker', workerValue, false);
  }

  // Reviewer
  if (result.reviewResult) {
    const reviewEmoji = result.reviewResult.decision === 'approved' ? '✅' : '❌';
    let reviewValue = `${reviewEmoji} **${result.reviewResult.decision}**`;
    if (result.reviewResult.feedback) {
      const feedback = boundedFieldValue(result.reviewResult.feedback, PIPELINE_EMBED_FIELD_VALUE_LIMIT);
      reviewValue += `\n\n${feedback}`;
    }
    tryAddField('✅ Reviewer', reviewValue, false);
  }

  // Tests
  if (result.testerResult) {
    const test = result.testerResult;
    const testEmoji = test.success ? '✅' : '❌';
    let testValue = `${testEmoji} **${test.testsPassed} passed, ${test.testsFailed} failed**`;
    if (test.coverage != null) {
      testValue += ` | Coverage: ${(test.coverage * 100).toFixed(1)}%`;
    }
    if (!test.success && test.failedTests && test.failedTests.length > 0) {
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