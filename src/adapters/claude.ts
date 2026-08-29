// ============================================
// OpenSwarm - Claude CLI Adapter
// Wraps `claude -p` for agent execution
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  CliCommandSpec,
  WorkerResult,
  ReviewResult,
} from './types.js';
import type { ReviewDecision } from '../agents/agentPair.js';
import { extractCostFromStreamJson, formatCost } from '../support/costTracker.js';
import { extractResultFromStreamJson } from '../agents/cliStreamParser.js';
import { t } from '../locale/index.js';
import { extractSummary } from './resultParsing.js';
import { writeClaudeMcpConfig } from './memoryMcp.js';

const execFileAsync = promisify(execFile);

/**
 * Version-agnostic model alias — the claude CLI resolves "sonnet" to the
 * current Sonnet, so it never goes stale the way a pinned model id would.
 * Single source for both getDefaultModel() and the buildCommand fallback. (INT-2509)
 * Exported so chatBackend.getDefaultChatModel stays in sync (INT-3284).
 */
export const CLAUDE_DEFAULT_MODEL = 'sonnet';

/**
 * The only tools a read-only run may use. Inspection and search, nothing that
 * writes and nothing that shells out.
 *
 * `Task` is absent deliberately: a subagent is a second agent whose toolset this
 * flag does not reach, which would turn the allowlist into a suggestion. Web
 * tools are absent for the same reason the sandbox exists — the diff under
 * review is attacker-authored, and a fetch is an outbound channel for whatever
 * the agent can read, including the provider credential.
 */
const READ_ONLY_CLAUDE_TOOLS = ['Read', 'Grep', 'Glob'];

// Claude CLI Adapter

export class ClaudeCliAdapter implements CliAdapter {
  readonly name = 'claude';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: true,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: ['/audit', '/documents', '/refactor'],
    enforcesReadOnly: true,
  };

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', ['claude']);
      return true;
    } catch {
      return false;
    }
  }

  buildCommand(options: CliRunOptions): CliCommandSpec {
    // options.prompt is the temp file path (set by spawnCli)
    const promptFile = options.prompt;
    // Always pin a model: omitting --model runs the user's PERSONAL default,
    // which can be the most expensive tier (observed: planner calls landing on
    // claude-fable-5 at ~$0.64 per trivial call). (INT-2509)
    const model = options.model ?? CLAUDE_DEFAULT_MODEL;
    if (!model.trim() || model.includes('\0')) throw new Error('Invalid Claude model');
    // Register OpenSwarm's memory MCP server unless the caller needs an isolated run.
    // bypassPermissions auto-allows its tool when present.
    //
    // Read-only runs must not use bypassPermissions — it is what grants Write and
    // Bash in the first place. `--permission-mode default` in `-p` has no one to
    // prompt, so anything outside the allowlist is denied outright (verified:
    // Write refused twice, no file created). An allowlist rather than a denylist,
    // so a tool added to the CLI later is denied by default. (INT-3189)
    const args = options.readOnly
      ? ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default',
         '--strict-mcp-config', '--allowedTools', ...READ_ONLY_CLAUDE_TOOLS]
      : ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
         '--strict-mcp-config'];
    // Not registered in a read-only run: the memory tools are outside the
    // allowlist, so every call would be denied anyway, and the server exposes
    // writes — memory is the one place a prompt-injected review could leave
    // something behind for the next run.
    const mcpConfig = options.memoryTools !== false && !options.readOnly ? writeClaudeMcpConfig() : undefined;
    if (mcpConfig) args.push('--mcp-config', mcpConfig);
    args.push('--model', model);
    if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
    return {
      command: 'claude',
      args,
      stdinFile: promptFile,
      cleanupPaths: mcpConfig ? [dirname(mcpConfig)] : [],
    };
  }

  async getDefaultModel(): Promise<string> {
    return CLAUDE_DEFAULT_MODEL;
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    try {
      const costInfo = extractCostFromStreamJson(raw.stdout);
      if (costInfo) {
        console.log(`[Worker] Cost: ${formatCost(costInfo)}`);
      }

      const resultText = extractResultFromStreamJson(raw.stdout);
      if (!resultText) {
        const result = extractWorkerFromText(raw.stdout);
        result.costInfo = costInfo;
        return result;
      }

      const result = extractWorkerResultJson(resultText) || extractWorkerFromText(resultText);
      result.costInfo = costInfo;
      return result;
    } catch (error) {
      console.error('[Worker] Parse error:', error);
      return extractWorkerFromText(raw.stdout);
    }
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    try {
      const costInfo = extractCostFromStreamJson(raw.stdout);
      if (costInfo) {
        console.log(`[Reviewer] Cost: ${formatCost(costInfo)}`);
      }

      let resultText = '';
      for (const line of raw.stdout.split('\n')) {
        try {
          const event = JSON.parse(line.trim());
          if (event.type === 'result' && event.result) {
            resultText = event.result;
            break;
          }
        } catch { /* skip non-JSON lines */ }
      }

      if (!resultText) {
        const result = extractReviewerFromText(raw.stdout);
        result.costInfo = costInfo;
        return result;
      }

      const result = extractReviewerResultJson(resultText) || extractReviewerFromText(resultText);
      result.costInfo = costInfo;
      return result;
    } catch (error) {
      console.error('[Reviewer] Parse error:', error);
      return extractReviewerFromText(raw.stdout);
    }
  }
}

// Worker Output Parsing (extracted from worker.ts)

function extractWorkerResultJson(text: string): WorkerResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
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
      return {
        success: Boolean(parsed.success),
        summary: parsed.summary || t('common.fallback.noSummary'),
        filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
        commands: Array.isArray(parsed.commands) ? parsed.commands : [],
        output: text,
        error: parsed.error,
        confidencePercent: typeof parsed.confidencePercent === 'number'
          ? parsed.confidencePercent : undefined,
        haltReason: parsed.haltReason || undefined,
        noChangesReason: typeof parsed.noChangesReason === 'string' ? parsed.noChangesReason : undefined,
      };
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return {
      success: Boolean(parsed.success),
      summary: parsed.summary || '(no summary)',
      filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      output: text,
      error: parsed.error,
      confidencePercent: typeof parsed.confidencePercent === 'number'
        ? parsed.confidencePercent : undefined,
      haltReason: parsed.haltReason || undefined,
      noChangesReason: typeof parsed.noChangesReason === 'string' ? parsed.noChangesReason : undefined,
    };
  } catch {
    return null;
  }
}

function extractWorkerFromText(text: string): WorkerResult {
  // Only flag as error if the text is very short (likely a CLI error message, not normal output)
  // Normal worker output often contains words like "error" in code comments or descriptions
  const isShortOutput = text.length < 500;
  const hasError = isShortOutput && /\b(?:error|fail(?:ed)?|exception|cannot)\b/i.test(text);
  const hasSuccess = /success|completed|done|finished/i.test(text);

  const filePatterns = [
    /(?:changed?|modified?|created?|updated?):\s*(.+\.(?:ts|js|py|json|yaml|yml|md))/gi,
    /(?:src|lib|test|tests)\/[\w/\-.]+\.(?:ts|js|py)/gi,
  ];

  const filesChanged: string[] = [];
  for (const pattern of filePatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const file = m[1] || m[0];
      if (!filesChanged.includes(file)) {
        filesChanged.push(file);
      }
    }
  }

  const cmdPattern = /(?:`|\$)\s*((?:npm|pnpm|yarn|git|python|pytest|tsc|eslint)\s+[^\n`]+)/gi;
  const commands: string[] = [];
  const cmdMatches = text.matchAll(cmdPattern);
  for (const m of cmdMatches) {
    if (!commands.includes(m[1])) {
      commands.push(m[1].trim());
    }
  }

  return {
    success: !hasError || hasSuccess,
    summary: extractSummary(text),
    filesChanged: filesChanged.slice(0, 10),
    commands: commands.slice(0, 10),
    output: text,
    error: hasError ? extractErrorMessage(text) : undefined,
  };
}


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

// Reviewer Output Parsing (extracted from reviewer.ts)

function extractReviewerResultJson(text: string): ReviewResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    const objMatch = text.match(/\{\s*"decision"\s*:/);
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
      return normalizeReviewResult(parsed);
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return normalizeReviewResult(parsed);
  } catch {
    return null;
  }
}

function normalizeReviewResult(parsed: any): ReviewResult { // eslint-disable-line @typescript-eslint/no-explicit-any -- JSON parse result
  let decision: ReviewDecision = 'revise';
  if (['approve', 'revise', 'reject'].includes(parsed.decision)) {
    decision = parsed.decision as ReviewDecision;
  } else if (parsed.decision) {
    const normalized = parsed.decision.toLowerCase();
    if (normalized.includes('approv') || normalized.includes('pass')) {
      decision = 'approve';
    } else if (normalized.includes('reject') || normalized.includes('fail')) {
      decision = 'reject';
    }
  }

  return {
    decision,
    feedback: parsed.feedback || t('common.fallback.noFeedback'),
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
  };
}

function extractReviewerFromText(text: string): ReviewResult {
  let decision: ReviewDecision = 'revise';
  const lowerText = text.toLowerCase();

  if (lowerText.includes('approve') || lowerText.includes('lgtm')) {
    decision = 'approve';
  } else if (lowerText.includes('reject')) {
    decision = 'reject';
  } else if (lowerText.includes('revise') || lowerText.includes('improve')) {
    decision = 'revise';
  }

  const issues: string[] = [];
  const issuePatterns = [
    /(?:issue|problem|error):\s*(.+)/gi,
    /(?:missing):\s*(.+)/gi,
    /- (?:fix|resolve):\s*(.+)/gi,
  ];

  for (const pattern of issuePatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      if (m[1] && !issues.includes(m[1].trim())) {
        issues.push(m[1].trim().slice(0, 200));
      }
    }
  }

  const suggestions: string[] = [];
  const suggestionPatterns = [
    /(?:suggest|recommend):\s*(.+)/gi,
    /(?:consider):\s*(.+)/gi,
    /(?:should):\s*(.+)/gi,
  ];

  for (const pattern of suggestionPatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      if (m[1] && !suggestions.includes(m[1].trim())) {
        suggestions.push(m[1].trim().slice(0, 200));
      }
    }
  }

  return {
    decision,
    feedback: extractFeedback(text),
    issues: issues.slice(0, 5),
    suggestions: suggestions.slice(0, 5),
  };
}

function extractFeedback(text: string): string {
  const lines = text.split('\n').filter((l) => {
    const trimmed = l.trim();
    return trimmed.length > 20 && !trimmed.startsWith('#') && !trimmed.startsWith('```');
  });

  if (lines.length === 0) return t('common.fallback.noFeedback');
  const feedback = lines[0].trim();
  return feedback.length > 300 ? feedback.slice(0, 300) + '...' : feedback;
}
