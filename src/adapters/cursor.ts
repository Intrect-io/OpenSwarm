// ============================================
// OpenSwarm - Cursor Agent CLI adapter
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AdapterCapabilities,
  CliAdapter,
  CliCommandSpec,
  CliRunOptions,
  CliRunResult,
  ReviewResult,
  WorkerResult,
} from './types.js';
import { parseReviewerResult, parseWorkerResult } from './resultParsing.js';

const execFileAsync = promisify(execFile);

export class CursorCliAdapter implements CliAdapter {
  readonly name = 'cursor';
  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: true,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
    // buildCommand adds `--mode ask` for a read-only run, which cursor-agent's
    // own help documents as "Q&A style for explanations and questions
    // (read-only)", alongside `--sandbox enabled`. This claim gates the
    // fail-closed guard in spawnCli, so re-verify it against `cursor-agent
    // --help` before trusting a newer CLI.
    enforcesReadOnly: true,
  };

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('cursor-agent', ['status'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('cursor-agent', ['--list-models'], { timeout: 10_000 });
      return stdout.split('\n').map((line) => line.trim()).filter((line) => line && !/^available models/i.test(line));
    } catch {
      return [];
    }
  }

  async getDefaultModel(): Promise<string> {
    const [first] = await this.listModels();
    return first ?? 'auto';
  }

  buildCommand(options: CliRunOptions): CliCommandSpec {
    const args = ['--print', '--output-format', 'stream-json', '--stream-partial-output', '--workspace', options.cwd];
    if (options.readOnly) {
      args.push('--mode', 'ask', '--sandbox', 'enabled');
    } else {
      // The containing OpenSwarm worktree is already the filesystem boundary;
      // Cursor's sandbox is additive. Never pass --force/--yolo.
      args.push('--sandbox', 'enabled');
    }
    if (options.model) args.push('--model', options.model);
    return { command: 'cursor-agent', args, stdinFile: options.prompt };
  }

  parseStreamingChunk(chunk: string, onLog: (line: string) => void, buffer = ''): string {
    const lines = `${buffer}${chunk}`.split('\n');
    const remainder = lines.pop() ?? '';
    for (const line of lines) {
      const text = cursorEventText(line);
      if (text) onLog(text);
    }
    return remainder;
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    const result = parseWorkerResult(extractCursorFinalText(raw.stdout));
    if (raw.executedCommands?.length) result.commands = [...new Set([...result.commands, ...raw.executedCommands])];
    return result;
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    return parseReviewerResult(extractCursorFinalText(raw.stdout));
  }
}

export function extractCursorFinalText(output: string): string {
  let final = '';
  for (const line of output.split('\n')) {
    const text = cursorEventText(line);
    if (text) final = text;
  }
  return final || output;
}

function cursorEventText(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';
  try {
    const event = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['text', 'content', 'result', 'message'] as const) {
      const value = event[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (value && typeof value === 'object' && typeof (value as { content?: unknown }).content === 'string') {
        return (value as { content: string }).content.trim();
      }
    }
    return '';
  } catch {
    return trimmed;
  }
}
