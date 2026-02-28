// ============================================
// OpenSwarm - Claude CLI Adapter
// Wraps `claude -p` for agent execution
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
} from './types.js';
import type { ReviewDecision } from '../agents/agentPair.js';
import { extractCostFromStreamJson, formatCost } from '../support/costTracker.js';
import { extractResultFromStreamJson } from '../agents/cliStreamParser.js';
import { t } from '../locale/index.js';

const execFileAsync = promisify(execFile);

// ============================================
// Claude CLI Adapter
// ============================================

export class ClaudeCliAdapter implements CliAdapter {
  readonly name = 'claude';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: true,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: ['/audit', '/documents', '/refactor'],
  };

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', ['claude']);
      return true;
    } catch {
      return false;
    }
  }

  buildCommand(options: CliRunOptions): { command: string; args: string[] } {
    // options.prompt is the temp file path (set by spawnCli)
    const promptFile = options.prompt;
    const modelFlag = options.model ? ` --model ${options.model}` : '';
    const cmd = `echo "" | claude -p "$(cat ${promptFile})" --output-format stream-json --permission-mode bypassPermissions${modelFlag}`;
    return { command: cmd, args: [] };
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

// ============================================
// Worker Output Parsing (extracted from worker.ts)
// ============================================

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
    };
  } catch {
    return null;
  }
}

function extractWorkerFromText(text: string): WorkerResult {
  const hasError = /error|fail|exception|cannot/i.test(text);
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

function extractSummary(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 10);
  if (lines.length === 0) return t('common.fallback.noSummary');
  const summary = lines[0].trim();
  return summary.length > 200 ? summary.slice(0, 200) + '...' : summary;
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

// ============================================
// Reviewer Output Parsing (extracted from reviewer.ts)
// ============================================

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

function normalizeReviewResult(parsed: any): ReviewResult {
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
