// ============================================
// OpenSwarm - Reviewer Agent
// Code review agent (CLI adapter based)
// ============================================

import type { WorkerResult, ReviewResult } from './agentPair.js';
import { t, getPrompts } from '../locale/index.js';
import type { AdapterName, ProcessContext } from '../adapters/types.js';
import type { ToolDefinition } from '../adapters/tools.js';
import { getAdapter, spawnCli } from '../adapters/index.js';
import { expandPath } from '../core/config.js';
import { RateLimitError } from '../adapters/rateLimitError.js';
import { isInfraError } from '../adapters/errorClassification.js';
import type { VerifyEvidence } from '../verify/runner.js';
import { renderVerifyEvidence } from './verificationEvidence.js';
import type { InstructionCapsule } from './instructionCapsule.js';
import { COORDINATION_GUIDANCE_PROMPT, type CoordinationToolContext } from '../coordination/coordinationTools.js';
import { boundedMessageContent, DISCORD_MESSAGE_CONTENT_LIMIT } from '../support/outputBudget.js';

// Types

export interface ReviewerOptions {
  taskTitle: string;
  taskDescription: string;
  authoritativeOperatorFeedback?: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;              // Model ID (default: adapter default)
  maxTurns?: number;           // Max agentic turns per CLI invocation
  adapterName?: AdapterName;
  processContext?: ProcessContext;
  /** Reasoning effort from a j
   * compatible adapter (e.g. openrouter). */
  reasoningEffort?: number;
  /** Coordination tools available to the reviewer agent */
  coordinationTools?: CoordinationToolContext;
  /** Verify evidence from the deterministic tester */
  verificationEvidence?: VerifyEvidence[];
  /** Instruction capsule for the reviewer */
  instructionCapsule?: InstructionCapsule;
}

export interface PreCheckResult {
  passed: boolean;
  reason: string;
}

// Prompts

function reviewerIdentityHeader(callSign: string | undefined): string {
  return callSign
    ? `You are a code reviewer (call sign: ${callSign}).`
    : 'You are a code reviewer.';
}

function reviewerCoordinationGuidance(): string {
  return [
    '',
    '## Coordination tools available',
    '',
    'You have access to coordination tools that let you communicate with other agents',
    'and read durable repository threads. Use them when you need to:',
    '',
    '• Ask a worker agent for clarification on their changes',
    '• Check if there are existing discussions about the code you are reviewing',
    '• Coordinate with other reviewers on shared files',
    '',
    COORDINATION_GUIDANCE_PROMPT,
    '',
    '**Important:** Only use coordination tools when you have a specific question or',
    'need to share information. Do not use them for routine status updates.',
  ].join('\n');
}

function buildPreCheckPrompt(options: ReviewerOptions): string {
  const prompts = getPrompts();
  return prompts.buildPreCheckPrompt({
    taskTitle: options.taskTitle,
    taskDescription: options.taskDescription,
    workerResult: options.workerResult,
  });
}

function buildReviewerPrompt(options: ReviewerOptions): string {
  const prompts = getPrompts();
  return prompts.buildReviewerPrompt({
    taskTitle: options.taskTitle,
    taskDescription: options.taskDescription,
    workerResult: options.workerResult,
    authoritativeOperatorFeedback: options.authoritativeOperatorFeedback,
    verificationEvidence: options.verificationEvidence,
    instructionCapsule: options.instructionCapsule,
  });
}

// Execution

async function runPreCheck(options: ReviewerOptions): Promise<PreCheckResult> {
  const prompt = buildPreCheckPrompt(options);
  const adapter = getAdapter(options.adapterName || 'cli');
  const result = await spawnCli(adapter, prompt, {
    processContext: options.processContext,
    timeoutMs: options.timeoutMs ?? 120_000,
    maxTurns: options.maxTurns ?? 5,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
  });

  const output = result.output.trim().toLowerCase();
  const passed = output.includes('yes') || output.includes('pass') || output.includes('approve');
  return { passed, reason: result.output.trim() };
}

export async function runReviewer(options: ReviewerOptions): Promise<ReviewResult> {
  const prompt = buildReviewerPrompt(options);
  const adapter = getAdapter(options.adapterName || 'cli');
  const result = await spawnCli(adapter, prompt, {
    processContext: options.processContext,
    timeoutMs: options.timeoutMs ?? 120_000,
    maxTurns: options.maxTurns ?? 10,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    coordinationTools: options.coordinationTools,
  });

  const output = result.output.trim();

  // Try to parse structured output
  try {
    const parsed = JSON.parse(output);
    if (parsed.decision && parsed.feedback !== undefined) {
      return {
        decision: parsed.decision,
        feedback: parsed.feedback,
        issues: parsed.issues || [],
        suggestions: parsed.suggestions || [],
        costInfo: result.costInfo,
      };
    }
  } catch {
    // Not JSON, use raw output
  }

  return {
    decision: output.includes('approve') ? 'approved' : 'rejected',
    feedback: output,
    issues: [],
    suggestions: [],
    costInfo: result.costInfo,
  };
}

/**
 * Format review feedback as a Discord message.
 * Enforces Discord message content limits to prevent payload rejection.
 */
export function formatReviewFeedback(result: ReviewResult): string {
  const decisionEmoji = result.decision === 'approved' ? '✅' : '❌';
  const lines: string[] = [];

  lines.push(`${decisionEmoji} **Review Decision: ${result.decision}**`);
  lines.push('');

  // Feedback (bounded per Discord message limit)
  if (result.feedback) {
    lines.push(boundedMessageContent(result.feedback));
  }

  // Issues
  if (result.issues && result.issues.length > 0) {
    lines.push('');
    lines.push(t('agents.reviewer.report.issues'));
    for (const issue of result.issues.slice(0, 10)) {
      lines.push(`  ⚠️ ${issue}`);
    }
    if (result.issues.length > 10) {
      lines.push(`  … +${result.issues.length - 10} more`);
    }
  }

  // Suggestions
  if (result.suggestions && result.suggestions.length > 0) {
    lines.push('');
    lines.push(t('agents.reviewer.report.suggestions'));
    for (const suggestion of result.suggestions.slice(0, 5)) {
      lines.push(`  • ${suggestion}`);
    }
  }

  const full = lines.join('\n');
  // Ensure the entire message fits within Discord limits
  return full.length > DISCORD_MESSAGE_CONTENT_LIMIT
    ? full.slice(0, DISCORD_MESSAGE_CONTENT_LIMIT - 3) + '…'
    : full;
}

/**
 * Convert Reviewer feedback into revision instructions for Worker
 */
export function buildRevisionPrompt(result: ReviewResult): string {
  return getPrompts().buildRevisionPromptFromReview({
    decision: result.decision,
    feedback: result.feedback,
    issues: result.issues || [],
    suggestions: result.suggestions || [],
  });
}