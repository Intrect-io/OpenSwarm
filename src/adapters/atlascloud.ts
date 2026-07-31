// ============================================
// OpenSwarm - Atlas Cloud CLI Adapter
// Calls the Atlas Cloud OpenAI-compatible Chat Completions API.
// ============================================

import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
} from './types.js';
import { abortSignalWithDeadline } from './requestDeadline.js';
import {
  runAgenticLoop,
  loopResultToCliResult,
  type ChatMessage,
  type AgenticLoopOptions,
} from './agenticLoop.js';
import { resolveMcpTools } from '../mcp/mcpClient.js';
import { parseWorkerResult, parseReviewerResult } from './resultParsing.js';
import { RateLimitError } from './rateLimitError.js';
import { resolveLimitResponse, type ThrottleState } from './throttleRetry.js';
import { isInfraError } from './errorClassification.js';
import { consumeChatCompletionsStream } from './chatStream.js';
import type { ToolDefinition } from './tools.js';
import {
  loadModelCatalog,
  parseOpenAiModelList,
  resolveDefaultModel,
  type CatalogSpec,
} from './modelCatalog.js';

/** Model listing must never block a run for long — it is advisory metadata. */
const MODEL_LIST_TIMEOUT_MS = 10_000;

export const ATLASCLOUD_API_BASE = 'https://api.atlascloud.ai/v1';
export const ATLASCLOUD_DEFAULT_MODEL = 'deepseek-ai/deepseek-v4-pro';

/**
 * Ids to fall back on when the catalog is unreachable. Kept short on purpose —
 * this list exists to keep an offline run working, not to mirror the ~120 models
 * Atlas serves. Live discovery replaces it entirely.
 */
const CURATED_MODELS = [
  ATLASCLOUD_DEFAULT_MODEL,
  'deepseek-ai/deepseek-v4-flash',
  'deepseek-ai/deepseek-v3.2',
  'zai-org/GLM-4.6',
];

function getEnvApiKey(): string | undefined {
  return process.env.ATLASCLOUD_API_KEY?.trim() || process.env.ATLAS_CLOUD_API_KEY?.trim() || undefined;
}

function catalogSpec(): CatalogSpec {
  return {
    provider: 'atlascloud',
    curated: CURATED_MODELS,
    fetchLive: async () => {
      const apiKey = getEnvApiKey();
      if (!apiKey) return [];
      const res = await fetch(`${ATLASCLOUD_API_BASE}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      return parseOpenAiModelList(await res.json());
    },
  };
}

export class AtlasCloudCliAdapter implements CliAdapter {
  readonly name = 'atlascloud';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: false,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
  };

  async isAvailable(): Promise<boolean> {
    return Boolean(getEnvApiKey());
  }

  buildCommand(_options: CliRunOptions): { command: string; args: string[] } {
    return { command: 'echo', args: ['"Atlas Cloud adapter uses run() — not shell spawn"'] };
  }

  async listModels(): Promise<string[]> {
    return (await loadModelCatalog(catalogSpec())).models;
  }

  async getDefaultModel(): Promise<string> {
    return resolveDefaultModel(catalogSpec(), ATLASCLOUD_DEFAULT_MODEL);
  }

  async run(options: CliRunOptions): Promise<CliRunResult> {
    const startTime = Date.now();
    const apiKey = getEnvApiKey();

    if (!apiKey) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Auth error: Set ATLASCLOUD_API_KEY to use the Atlas Cloud adapter.',
        durationMs: Date.now() - startTime,
      };
    }

    const model = options.model ?? await this.getDefaultModel();
    const callApi = createApiCaller(apiKey, model, {
      onToken: options.onToken,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 300000,
    });

    const mcpTools = await resolveMcpTools(options.mcpTools);

    const loopOptions: AgenticLoopOptions = {
      systemPrompt: options.systemPrompt,
      prompt: options.prompt,
      cwd: options.cwd ?? process.cwd(),
      model,
      callApi,
      maxTurns: options.maxTurns ?? 20,
      timeoutMs: options.timeoutMs ?? 300000,
      onLog: options.onLog,
      enableTools: options.enableTools ?? true,
      nudgeMaxOnNoEdit: options.nudgeMaxOnNoEdit,
      protectedFiles: options.protectedFiles,
      bashTimeoutMs: options.bashTimeoutMs,
      webTools: options.webTools,
      memoryTools: options.memoryTools,
      diagnosticsTool: options.diagnosticsTool,
      readOnly: options.readOnly,
      mcpTools,
      signal: options.signal,
      editFormat: options.editFormat,
    };

    try {
      const result = await runAgenticLoop(loopOptions);
      options.onLog?.(
        `[Atlas Cloud] ${result.apiCallCount} API calls, ${result.toolCallCount} tool uses, ${result.totalTokens} tokens`,
      );
      return loopResultToCliResult(result);
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      if (isInfraError(err)) throw err;
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Atlas Cloud agentic loop failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    return parseWorkerResult(raw.stdout);
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    return parseReviewerResult(raw.stdout);
  }
}

export interface AtlasCloudApiCallerOptions {
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
  /**
   * Ceiling for one API call, including the streamed body.
   *
   * Without it the request was bounded only by the caller's signal, and the
   * agentic loop checks its deadline between turns — so a connection that
   * accepted the request and then went silent hung until something else
   * intervened, which for a background worker is never.
   */
  timeoutMs?: number;
}

export function createApiCaller(apiKey: string, model: string, opts: AtlasCloudApiCallerOptions = {}) {
  return async (messages: ChatMessage[], tools: ToolDefinition[]) => {
    // Per-API-call throttle budget (INT-2907).
    const throttle: ThrottleState = { attempts: 0 };
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: 0.2,
      max_tokens: 16384,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) {
      body.tools = tools;
    }

    const attempt = async (): Promise<ReturnType<typeof consumeChatCompletionsStream>> => {
      const res = await fetch(`${ATLASCLOUD_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        // The caller's signal AND this call's own deadline. Either one aborts.
        signal: abortSignalWithDeadline(opts.signal, opts.timeoutMs),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        // Spent quota → typed RateLimitError (scheduler pauses); a throttle is
        // waited out and retried instead of masquerading as one. (INT-2907)
        if (await resolveLimitResponse('atlascloud', res.status, res.headers, errText, throttle, { signal: opts.signal }) === 'retry') {
          return attempt();
        }
        throw new Error(`Atlas Cloud API error (${res.status}): ${errText.slice(0, 500)}`);
      }

      return consumeChatCompletionsStream(res, opts.onToken);
    };

    return attempt();
  };
}

// Worker/Reviewer output parsing lives in ./resultParsing.ts (shared with the
// gpt, local, and openrouter adapters).
