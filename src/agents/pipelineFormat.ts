// ============================================
// OpenSwarm - Pipeline Result Formatting
// Discord message/embed formatting for pipeline results
// ============================================

import { EmbedBuilder } from 'discord.js';
import type { APIEmbedField } from 'discord.js';
import type { PipelineResult } from './pairPipeline.js';
import { formatCost } from '../support/costTracker.js';

/** Format epoch ms to HH:MM:SS local time string */
function formatTimestamp(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleTimeString('en-GB', { hour12: false }); // HH:MM:SS
}

/**
 * Discord ceilings for the composed pipeline notification.
 *
 * The per-field slices below bound each contribution but not their sum, and the
 * stage list had no bound at all — 34 stages already pushed that one value past
 * the 1024 the embed builder validates, which throws at the point of the set and
 * loses the whole report. Even with every field legal the embed is capped at
 * 6000 characters in total (title + description + fields + footer) and the API
 * rejects an over-budget embed outright rather than trimming it. These are the
 * ceilings on the composed output; the per-field slices stay. (AGT-3422)
 */
export const PIPELINE_MESSAGE_CHAR_BUDGET = 2000;
export const PIPELINE_EMBED_CHAR_BUDGET = 6000;
export const EMBED_FIELD_VALUE_BUDGET = 1024;
export const EMBED_DESCRIPTION_BUDGET = 4096;
/** Room for the elision marker plus its count, so a clip stays under its ceiling. */
const ELISION_MARKER_RESERVE = 40;
/** The summary stats are pinned: short, and the first thing a report is read for. */
const PIPELINE_STAT_FIELDS: Record<string, true> = {
  '🔄 Iterations': true,
  '⏱️ Duration': true,
  '💰 Cost': true,
};

/** The phrasing the Discord completion path already uses for a clipped result. */
function elisionMarker(dropped: number): string {
  return `...(${dropped} chars omitted)`;
}

const ELISION_MARKER_PATTERN = /\.\.\.\((\d+) chars omitted\)$/;

/**
 * Clip `value` to `limit`, dropping the tail and saying how much went. The
 * marker's count is the real remainder, so kept + dropped is the value that came
 * in and a reader can tell a clipped report from a short one. The composed embed
 * clamps some fields twice (once per field, once against the total), so a count
 * already in the value is folded into the new one rather than reset — otherwise
 * the second trim would report only its own step and the arithmetic would no
 * longer reach the original.
 */
function clipToLimit(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const budget = limit - ELISION_MARKER_RESERVE;
  // Only reachable when the limit is smaller than the marker itself.
  if (budget < 1) return value.slice(0, limit);
  const prior = ELISION_MARKER_PATTERN.exec(value);
  const body = prior ? value.slice(0, prior.index) : value;
  const head = body.slice(0, budget);
  const dropped = (prior ? Number(prior[1]) : 0) + (body.length - head.length);
  return head + elisionMarker(dropped);
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

  // The assembled message has a ceiling of its own; the stage loop above is the
  // only unbounded input. (AGT-3422)
  return clipToLimit(lines.join('\n'), PIPELINE_MESSAGE_CHAR_BUDGET);
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

  // Task context
  if (result.taskContext) {
    const ctx = result.taskContext;
    const displayName = ctx.projectName
      || (ctx.projectPath ? ctx.projectPath.split('/').pop() || '' : '');

    if (displayName && ctx.issueIdentifier) {
      const line = `📁 **${displayName}** | 🔖 ${ctx.issueIdentifier}\n${ctx.taskTitle || ''}`;
      embed.setDescription(clipToLimit(line, EMBED_DESCRIPTION_BUDGET));
    } else if (ctx.taskTitle) {
      embed.setDescription(clipToLimit(ctx.taskTitle, EMBED_DESCRIPTION_BUDGET));
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

  // Stages. One value for every stage a run recorded, and a long run records
  // one per stage per iteration — the per-field budget (not just the embed
  // total) is what a run of ~34 stages breaches. (AGT-3422)
  const stagesStr = result.stages
    .map(s => {
      const emoji = s.success ? '✅' : '❌';
      const duration = (s.duration / 1000).toFixed(1);
      const time = formatTimestamp(s.startedAt);
      return `${emoji} **${s.stage}** (${duration}s) @ ${time}`;
    })
    .join('\n') || 'No stages';

  embed.addFields({ name: '📊 Stages', value: clipToLimit(stagesStr, EMBED_FIELD_VALUE_BUDGET), inline: false });

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
      embed.addFields({ name: '🔨 Worker', value: clipToLimit(workerValue, EMBED_FIELD_VALUE_BUDGET), inline: false });
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

    embed.addFields({ name: '✅ Reviewer', value: clipToLimit(reviewValue, EMBED_FIELD_VALUE_BUDGET), inline: false });
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
      const failedStr = test.failedTests.slice(0, 2).map(t => `❌ ${t}`).join('\n');
      testValue += `\n\n${failedStr}`;
      if (test.failedTests.length > 2) {
        testValue += `\n... +${test.failedTests.length - 2} more`;
      }
    }

    embed.addFields({ name: '🧪 Tests', value: clipToLimit(testValue, EMBED_FIELD_VALUE_BUDGET), inline: false });
  }

  // PR URL
  if (result.prUrl) {
    embed.addFields({ name: '🔗 Pull Request', value: `[View PR](${result.prUrl})`, inline: false });
  }

  // Footer
  embed.setFooter({ text: `Session: ${result.sessionId.slice(0, 8)}...` });

  return clampEmbedToBudget(embed);
}

/**
 * Final pass: an embed is accepted only if its parts sum to <= 6000, and the API
 * rejects the whole embed rather than trimming it. Per-field slices cannot see
 * the total, so trim the largest non-pinned field last, keeping the summary
 * stats (iterations/duration/cost) and re-clamping until the sum fits. Trimming
 * the largest field means fewer fields lose their content, and the elision
 * marker says which ones did. (AGT-3422)
 */
function clampEmbedToBudget(embed: EmbedBuilder): EmbedBuilder {
  for (let guard = 0; embed.length > PIPELINE_EMBED_CHAR_BUDGET && guard < 16; guard++) {
    const fields: APIEmbedField[] = embed.data.fields ? [...embed.data.fields] : [];
    let largest = -1;
    let largestLength = -1;
    for (let j = 0; j < fields.length; j++) {
      if (PIPELINE_STAT_FIELDS[fields[j].name]) continue;
      if (fields[j].value.length > largestLength) {
        largest = j;
        largestLength = fields[j].value.length;
      }
    }
    if (largest < 0 || largestLength <= 0) break;

    const over = embed.length - PIPELINE_EMBED_CHAR_BUDGET;
    const target = Math.max(1, largestLength - over - ELISION_MARKER_RESERVE);
    const trimmed = clipToLimit(fields[largest].value, target);
    // clipToLimit must keep making progress; stop rather than loop forever.
    if (trimmed.length >= largestLength) break;
    fields[largest] = { ...fields[largest], value: trimmed };
    embed.setFields(fields);
  }
  return embed;
}
