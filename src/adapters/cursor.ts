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
import { isHumanSurfaceReadOnlyEnabled } from '../mcp/humanSurfacePolicy.js';

const execFileAsync = promisify(execFile);

export class CursorCliAdapter implements CliAdapter {
  readonly name = 'cursor';
  // Model table from `cursor-agent --list-models`, cached for the adapter
  // lifetime so buildCommand can reject unsupported ids without a subprocess.
  private cachedModels: string[] | null = null;
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
    if (isHumanSurfaceReadOnlyEnabled()) return false;
    try {
      await execFileAsync('cursor-agent', ['status'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    if (isHumanSurfaceReadOnlyEnabled()) return [];
    if (this.cachedModels) return this.cachedModels;
    try {
      const { stdout } = await execFileAsync('cursor-agent', ['--list-models'], { timeout: 10_000 });
      // Each line is "<id> - <display name>"; only the id is a valid --model
      // value. Feeding the whole line back made the CLI reject it
      // ("Cannot use this model: auto - Auto (current, default)").
      const models = stdout.split('\n').map((line) => line.trim())
        .filter((line) => line && !/^available models/i.test(line))
        .map((line) => line.split(/\s+-\s+/)[0]?.trim())
        .filter((id): id is string => !!id && /^[\w.\-:/@]+$/.test(id));
      this.cachedModels = models;
      return models;
    } catch {
      return [];
    }
  }

  async getDefaultModel(): Promise<string> {
    const [first] = await this.listModels();
    return first ?? 'auto';
  }

  /**
   * The config may carry provider-specific ids (e.g. plannerModel
   * z-ai/glm-5.2 for the OpenRouter/Atlas Cloud adapters). cursor-agent only
   * accepts ids it lists; passing anything else aborts with
   * "Cannot use this model: …". Route unsupported ids to the auto default.
   */
  private resolveModel(wanted: string): string {
    // Vendor-slug ids ("z-ai/…", "zai-org/…") never exist on cursor-agent.
    if (wanted.includes('/')) return 'auto';
    if (this.cachedModels) return this.cachedModels.includes(wanted) ? wanted : 'auto';
    return wanted;
  }

  buildCommand(options: CliRunOptions): CliCommandSpec {
    // stream-json without --stream-partial-output yields message-level events
    // (whole sentences per assistant turn) instead of per-token deltas, so the
    // live log does not fill with tiny fragments (observed on vela 2026-09-01).
    // --trust skips Cursor's interactive workspace-trust prompt; OpenSwarm's
    // own bwrap executor is the filesystem boundary.
    const args = ['--print', '--output-format', 'stream-json', '--trust', '--workspace', options.cwd];
    if (options.readOnly) {
      args.push('--mode', 'ask', '--sandbox', 'disabled');
    } else {
      // The containing OpenSwarm worktree is already the filesystem boundary;
      // Cursor's sandbox is additive and fails to start inside bwrap/AppArmor.
      // Never pass --force/--yolo.
      args.push('--sandbox', 'disabled');
    }
    if (options.model) args.push('--model', this.resolveModel(options.model));
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
    // Streaming "thinking" deltas arrive per token and would flood the live
    // log with fragments. Only whole assistant messages / results are events.
    if (event.type === 'thinking') return '';
    // The CLI echoes the full prompt (including any injected content from task
    // descriptions) back as a `user` message, and `system` events carry config
    // noise. Neither belongs in the live log; they also re-surface prompt
    // injections verbatim to the dashboard. Only model output should log.
    if (event.type === 'user' || event.type === 'system' || event.type === 'session') return '';
    for (const key of ['text', 'content', 'result', 'message'] as const) {
      const value = event[key];
      if (key === 'message' && value && typeof value === 'object') {
        const content = (value as { content?: unknown }).content;
        if (Array.isArray(content)) {
          const parts = content
            .filter((c): c is { type: string; text?: string } => !!c && typeof c === 'object')
            .map((c) => (typeof c.text === 'string' ? c.text : ''))
            .filter(Boolean);
          if (parts.length) return parts.join('').trim();
        } else if (typeof content === 'string' && content.trim()) {
          return content.trim();
        }
      }
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (value && typeof value === 'object' && typeof (value as { content?: string }).content === 'string') {
        return (value as { content: string }).content.trim();
      }
    }
    return '';
  } catch {
    return trimmed;
  }
}
