// ============================================
// OpenSwarm - Documenter Agent
// Documentation agent (CLI adapter based)
// ============================================

import type { WorkerResult } from './agentPair.js';
import type { AdapterName } from '../adapters/types.js';
import { getAdapter, spawnCli } from '../adapters/index.js';
import { type CostInfo, extractCostFromStreamJson, formatCost } from '../support/costTracker.js';
import { expandPath } from '../core/config.js';
import { RateLimitError } from '../adapters/rateLimitError.js';

// Types

export interface DocumenterOptions {
  taskTitle: string;
  taskDescription: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;
  maxTurns?: number;
  adapterName?: AdapterName;
}

export interface DocumenterResult {
  success: boolean;
  updatedFiles: string[];
  changelogEntry?: string;
  apiDocsUpdated: boolean;
  summary: string;
  error?: string;
  costInfo?: CostInfo;
}

// Prompts

/**
 * Build Documenter prompt
 */
function buildDocumenterPrompt(options: DocumenterOptions): string {
  const workerReport = `
- **Success:** ${options.workerResult.success}
- **Summary:** ${options.workerResult.summary}
- **Files Changed:** ${options.workerResult.filesChanged.join(', ') || '(none)'}
- **Commands:** ${options.workerResult.commands.join(', ') || '(none)'}
`;

  return `# Documenter Agent

## Original Task
- **Title:** ${options.taskTitle}
- **Description:** ${options.taskDescription.slice(0, 200)}${options.taskDescription.length > 200 ? '...' : ''}

## Worker's Changes
${workerReport}

## Instructions
1. Document the changed code
2. Add a new entry to CHANGELOG.md if it exists
3. Add JSDoc/docstring to new functions/classes
4. Update README if needed
5. Update API docs if they exist

## Documentation Rules
- Follow the existing documentation style
- Describe changes clearly
- Include code examples (when necessary)
- Do not add unnecessary documentation

## Output Format (IMPORTANT - must output in this format at the end)
After documentation is complete, output the result in the following JSON format:

\`\`\`json
{
  "success": true,
  "updatedFiles": ["CHANGELOG.md", "src/module.ts"],
  "changelogEntry": "- feat: Add new feature",
  "apiDocsUpdated": false,
  "summary": "Documentation summary (1-2 sentences)"
}
\`\`\`

When there is nothing to document:
\`\`\`json
{
  "success": true,
  "updatedFiles": [],
  "apiDocsUpdated": false,
  "summary": "No documentation needed (minor change)"
}
\`\`\`

On failure:
\`\`\`json
{
  "success": false,
  "updatedFiles": [],
  "apiDocsUpdated": false,
  "summary": "Documentation failed",
  "error": "Detailed error message"
}
\`\`\`
`;
}

// Documenter Execution

/**
 * Run Documenter agent
 */
export async function runDocumenter(options: DocumenterOptions): Promise<DocumenterResult> {
  const prompt = buildDocumenterPrompt(options);
  const cwd = expandPath(options.projectPath);
  const adapter = getAdapter(options.adapterName);

  try {
    const raw = await spawnCli(adapter, {
      prompt,
      cwd,
      timeoutMs: options.timeoutMs,
      model: options.model,
      maxTurns: options.maxTurns,
    });

    return parseDocumenterOutput(raw.stdout);
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    return {
      success: false,
      updatedFiles: [],
      apiDocsUpdated: false,
      summary: 'Documenter execution failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Parse Documenter output
 */
export function parseDocumenterOutput(output: string): DocumenterResult {
  try {
    const costInfo = extractCostFromStreamJson(output);
    if (costInfo) {
      console.log(`[Documenter] Cost: ${formatCost(costInfo)}`);
    }

    if (typeof output !== 'string') {
      // A non-string payload is a transport-level defect, not documentation —
      // parse only string outputs so downstream JSON assumptions hold. (AGT-3487)
      return {
        success: false,
        updatedFiles: [],
        apiDocsUpdated: false,
        summary: 'Documenter output was not a string',
        error: `expected string output, got ${typeof output}`,
      };
    }
    // Extract result entry from NDJSON
    let resultText = '';
    for (const line of output.split('\n')) {
      try {
        const event = JSON.parse(line.trim());
        if (event.type === 'result' && event.result) {
          resultText = event.result;
          break;
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          resultText = event.item.text;
        }
      } catch { /* skip non-JSON lines */ }
    }

    if (!resultText) {
      const result = extractFromText(output);
      result.costInfo = costInfo;
      return result;
    }

    // Extract JSON block from result
    const result = extractResultJson(resultText) || extractFromText(resultText);
    result.costInfo = costInfo;
    return result;
  } catch (error) {
    console.error('[Documenter] Parse error:', error);
    return extractFromText(output);
  }
}

/**
 * Extract JSON block from result
 */
function extractResultJson(text: string): DocumenterResult | null {
  // Find ```json ... ``` block
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    // Find plain JSON object
    const objMatch = text.match(/\{\s*"success"\s*:/);
    if (!objMatch) return null;

    const startIdx = objMatch.index!;
    let depth = 0;
    let endIdx = startIdx;

    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }

    try {
      const parsed = JSON.parse(text.slice(startIdx, endIdx));
      return normalizeResult(parsed);
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return normalizeResult(parsed);
  } catch {
    return null;
  }
}

/**
 * Normalize result
 */
function normalizeResult(parsed: any): DocumenterResult { // eslint-disable-line @typescript-eslint/no-explicit-any -- JSON parse result
  return {
    success: Boolean(parsed.success),
    updatedFiles: Array.isArray(parsed.updatedFiles) ? parsed.updatedFiles : [],
    changelogEntry: parsed.changelogEntry,
    apiDocsUpdated: Boolean(parsed.apiDocsUpdated),
    summary: parsed.summary || '(no summary)',
    error: parsed.error,
  };
}

/**
 * Extract result from text (when JSON parsing fails)
 */
function extractFromText(text: string): DocumenterResult {
  // Estimate success
  const hasError = /error|fail|exception|cannot/i.test(text);
  const hasSuccess = /success|completed|updated|documented/i.test(text);

  // Extract updated files
  const updatedFiles: string[] = [];
  const filePatterns = [
    /(?:updated?|modified?|created?|wrote?):\s*(.+\.(?:md|rst|txt))/gi,
    /(?:CHANGELOG|README|docs?)\/[\w/\-.]+/gi,
  ];

  for (const pattern of filePatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const file = m[1] || m[0];
      if (!updatedFiles.includes(file)) {
        updatedFiles.push(file);
      }
    }
  }

  // Extract changelog entry
  let changelogEntry: string | undefined;
  const changelogMatch = text.match(/(?:changelog|change\s*log)[\s:]*([^\n]+)/i);
  if (changelogMatch) {
    changelogEntry = changelogMatch[1].trim();
  }

  return {
    success: !hasError || hasSuccess,
    updatedFiles: updatedFiles.slice(0, 10),
    changelogEntry,
    apiDocsUpdated: /api\s*doc/i.test(text),
    summary: extractSummary(text),
    error: hasError ? extractErrorMessage(text) : undefined,
  };
}

/**
 * Extract summary
 */
function extractSummary(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 10);
  if (lines.length === 0) return '(no summary)';

  const summary = lines[0].trim();
  return summary.length > 200 ? summary.slice(0, 200) + '...' : summary;
}

/**
 * Extract error message
 */
function extractErrorMessage(text: string): string {
  const errorMatch = text.match(/(?:error|exception|failed?):\s*(.+)/i);
  if (errorMatch) {
    return errorMatch[1].slice(0, 200);
  }

  const lines = text.split('\n').filter((l) => /error|fail/i.test(l));
  if (lines.length > 0) {
    return lines[0].slice(0, 200);
  }

  return 'Unknown error';
}

// Formatting

/**
 * Format Documenter result as Discord message
 */
export function formatDocReport(result: DocumenterResult): string {
  const statusEmoji = result.success ? '📝' : '❌';
  const lines: string[] = [];

  lines.push(`${statusEmoji} **Documenter Result: ${result.success ? 'Complete' : 'Failed'}**`);
  lines.push('');
  lines.push(`**Summary:** ${result.summary}`);

  if (result.updatedFiles.length > 0) {
    lines.push(`**Updated Files:** ${result.updatedFiles.join(', ')}`);
  } else {
    lines.push('**Updated Files:** (none)');
  }

  if (result.changelogEntry) {
    lines.push(`**Changelog:** ${result.changelogEntry}`);
  }

  if (result.apiDocsUpdated) {
    lines.push('**API Docs:** Updated');
  }

  if (result.error) {
    lines.push(`**Error:** ${result.error}`);
  }

  return lines.join('\n');
}
