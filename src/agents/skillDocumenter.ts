// ============================================
// OpenSwarm - Skill Documenter Agent
// /documents skill-based automatic documentation update agent
// ============================================

import type { WorkerResult } from './agentPair.js';
import type { AdapterName } from '../adapters/types.js';
import { getAdapter, spawnCli } from '../adapters/index.js';
import { type CostInfo, extractCostFromStreamJson, formatCost } from '../support/costTracker.js';
import { expandPath } from '../core/config.js';
import { RateLimitError } from '../adapters/rateLimitError.js';
import { boundedMessageContent, DISCORD_MESSAGE_CONTENT_LIMIT } from '../support/outputBudget.js';

// Types

export interface SkillDocumenterOptions {
  taskTitle: string;
  taskDescription: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;
  maxTurns?: number;
  adapterName?: AdapterName;
}

export interface SkillDocumenterResult {
  success: boolean;
  updatedFiles: string[];
  summary: string;
  error?: string;
  costInfo?: CostInfo;
}

// Prompts

function buildSkillDocumenterPrompt(options: SkillDocumenterOptions): string {
  const workerReport = `
- **Success:** ${options.workerResult.success}
- **Summary:** ${options.workerResult.summary}
- **Files Changed:** ${options.workerResult.filesChanged.join(', ') || '(none)'}
- **Commands:** ${options.workerResult.commands.join(', ') || '(none)'}
`;

  return `/documents

## Task

${options.taskTitle}

${options.taskDescription}

## Worker Report

${workerReport}

## Instructions

Review the worker's changes and update the project's documentation accordingly.

1. Check if any documentation files need updating based on the changes made.
2. Update relevant documentation files.
3. If no documentation changes are needed, report that.

## Output Format

Return a JSON object with the following structure:
\`\`\`json
{
  "success": true/false,
  "updatedFiles": ["path/to/file1.md", ...],
  "summary": "Brief summary of documentation changes"
}
\`\`\``;
}

// Execution

export async function runSkillDocumenter(options: SkillDocumenterOptions): Promise<SkillDocumenterResult> {
  const prompt = buildSkillDocumenterPrompt(options);
  const adapter = getAdapter(options.adapterName || 'cli');
  const result = await spawnCli(adapter, prompt, {
    timeoutMs: options.timeoutMs ?? 120_000,
    maxTurns: options.maxTurns ?? 5,
    model: options.model,
  });

  const output = result.output.trim();
  const parsed = parseSkillDocumenterOutput(output);

  return {
    ...parsed,
    costInfo: result.costInfo,
  };
}

// Parsing

function parseSkillDocumenterOutput(output: string): SkillDocumenterResult {
  // Try JSON extraction first
  const jsonResult = extractResultJson(output);
  if (jsonResult) return jsonResult;

  // Fallback to text extraction
  return extractFromText(output);
}

function extractResultJson(text: string): SkillDocumenterResult | null {
  const jsonMatch = text.match(/\{[\s\S]*"success"[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return normalizeResult(parsed);
  } catch {
    return null;
  }
}

function normalizeResult(parsed: any): SkillDocumenterResult {
  return {
    success: Boolean(parsed.success),
    updatedFiles: Array.isArray(parsed.updatedFiles) ? parsed.updatedFiles : [],
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    error: typeof parsed.error === 'string' ? parsed.error : undefined,
  };
}

function extractFromText(text: string): SkillDocumenterResult {
  return {
    success: text.includes('success') || text.includes('updated'),
    updatedFiles: extractSummary(text).split('\n').filter(l => l.includes('.md') || l.includes('.ts')),
    summary: extractSummary(text),
    error: extractErrorMessage(text),
  };
}

function extractSummary(text: string): string {
  const lines = text.split('\n').filter(l => l.length > 0);
  return lines.slice(0, 5).join('\n');
}

function extractErrorMessage(text: string): string | undefined {
  const errorMatch = text.match(/error:?\s*(.+)/i);
  return errorMatch ? errorMatch[1] : undefined;
}

// Formatting

/**
 * Format skill documenter report as a Discord message.
 * Enforces Discord message content limits to prevent payload rejection.
 */
export function formatSkillDocReport(result: SkillDocumenterResult): string {
  const statusEmoji = result.success ? '📄' : '❌';
  const lines: string[] = [];

  lines.push(`${statusEmoji} **Skill Documenter Result: ${result.success ? 'Complete' : 'Failed'}**`);
  lines.push('');
  lines.push(`**Summary:** ${result.summary}`);

  if (result.updatedFiles.length > 0) {
    lines.push(`**Updated Files:** ${result.updatedFiles.join(', ')}`);
  } else {
    lines.push('**Updated Files:** (none)');
  }

  if (result.error) {
    lines.push(`**Error:** ${result.error}`);
  }

  const full = lines.join('\n');
  // Ensure the entire message fits within Discord limits
  return full.length > DISCORD_MESSAGE_CONTENT_LIMIT
    ? full.slice(0, DISCORD_MESSAGE_CONTENT_LIMIT - 3) + '…'
    : full;
}