// ============================================
// OpenSwarm - Local Model Adapter
// Created: 2026-04-10
// Purpose: Support for local OpenAI-compatible servers such as Ollama, LMStudio, llama.cpp
// ============================================

import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
} from './types.js';
import { runAgenticLoop, loopResultToCliResult, type ChatMessage, type AgenticLoopOptions } from './agenticLoop.js';
import { resolveMcpTools } from '../mcp/mcpClient.js';
import { parseWorkerResult, parseReviewerResult, withExecutionEvidence } from './resultParsing.js';
import { consumeChatCompletionsStream } from './chatStream.js';
import type { ToolDefinition } from './tools.js';
import { RateLimitError } from './rateLimitError.js';
import { resolveLimitResponse, resolveTransientFailure, type ThrottleState } from './throttleRetry.js';
import { isInfraError } from './errorClassification.js';
import { approvedLocalModelEndpoint, prepareApprovedLocalModelRequest } from '../support/approvedEgress.js';

// Default base URL candidates for local providers (in priority order)
const DEFAULT_ENDPOINTS = [
  'http://localhost:11434',  // Ollama
  'http://localhost:1234',   // LMStudio
  'http://localhost:8080',   // llama.cpp server
];

export const DEFAULT_MODEL = 'gemma3:4b';
const HEALTH_CHECK_TIMEOUT_MS = 2000;

export interface LocalModelAdapterOptions {
  name?: string;
  endpoints?: string[];
  defaultModel?: string;
  apiKey?: string;
  logPrefix?: string;
  noServerMessage?: string;
  /** Per-request generation ceiling; unset leaves the server default (AGT-4534). */
  maxTokens?: number;
}

export class LocalModelAdapter implements CliAdapter {
  readonly name: string;

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: false,
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
    // The agentic loop honours CliRunOptions.readOnly (see agenticLoop/tools). (INT-3189)
    enforcesReadOnly: true,
    enforcesHumanSurfaceReadOnly: true,
  };

  // Active server URL (detected in isAvailable, used in run)
  private activeUrl: string | null = null;
  private configuredUrl: string | null = null;
  private readonly endpoints: string[];
  private readonly defaultModel: string;
  private readonly apiKey?: string;
  private readonly logPrefix: string;
  private readonly noServerMessage: string;
  private readonly maxTokens?: number;

  constructor(options: LocalModelAdapterOptions = {}) {
    this.name = options.name ?? 'local';
    this.endpoints = options.endpoints ?? DEFAULT_ENDPOINTS;
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.apiKey = options.apiKey;
    this.logPrefix = options.logPrefix ?? 'Local';
    this.noServerMessage = options.noServerMessage ?? 'No local model server found. Start Ollama, LMStudio, or llama.cpp server first.';
    this.maxTokens = options.maxTokens;
  }

  /** Used when baseUrl is injected from config.yaml */
  setBaseUrl(url: string): void {
    this.configuredUrl = url;
  }

  async isAvailable(): Promise<boolean> {
    this.activeUrl = null;
    const candidates = this.configuredUrl
      ? [this.configuredUrl, ...this.endpoints]
      : this.endpoints;

    for (const url of candidates) {
      try {
        const endpoint = approvedLocalModelEndpoint(url, '/v1/models');
        const res = await fetch(endpoint, {
          headers: this.buildHeaders(),
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        });
        if (res.ok) {
          this.activeUrl = url;
          return true;
        }
      } catch {
        // 서버 미실행 — 다음 후보로
      }
    }
    return false;
  }

  /** Return the currently active server URL (for debugging) */
  getActiveUrl(): string | null {
    return this.activeUrl;
  }

  /** List the available models */
  async listModels(): Promise<string[]> {
    if (!this.activeUrl) {
      const available = await this.isAvailable();
      if (!available) return [];
    }

    try {
      const endpoint = approvedLocalModelEndpoint(this.activeUrl!, '/v1/models');
      const res = await fetch(endpoint, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return [];

      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return data.data?.map(m => m.id) ?? [];
    } catch {
      return [];
    }
  }

  buildCommand(_options: CliRunOptions): { command: string; args: string[] } {
    return { command: 'echo', args: ['"Local adapter uses run() — not shell spawn"'] };
  }

  /** Default = first model the running server reports (live), else the constant. */
  async getDefaultModel(): Promise<string> {
    const [first] = await this.listModels();
    return first ?? this.defaultModel;
  }

  async run(options: CliRunOptions): Promise<CliRunResult> {
    const startTime = Date.now();

    // Re-probe on every run: a previously selected local server can disappear
    // while another configured endpoint remains healthy.
    const available = await this.isAvailable();
    if (!available) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `${this.noServerMessage}\n` +
          `Checked: ${(this.configuredUrl ? [this.configuredUrl, ...this.endpoints] : this.endpoints).join(', ')}`,
        durationMs: Date.now() - startTime,
      };
    }

    const model = options.model ?? await this.getDefaultModel();
    const baseUrl = this.activeUrl!;

    // Detect tool support (may vary by model)
    const supportsTools = await this.checkToolSupport(baseUrl, model);

    // Run as an agentic loop
    const callApi = this.createApiCaller(baseUrl, model, options.onToken, options.signal);

    // MCP tools: caller-provided, else self-source from the registry. (INT-1951)
    //
    // Skipped entirely in read-only mode, and the skip has to be here rather
    // than in the loop. Resolving means CONNECTING: the registry merges
    // `mcp.servers` from the config discovered in cwd, and the stdio transport
    // spawns each server's command with `${SECRETS}` already expanded into its
    // environment. When the cwd is a checkout under review, that config is
    // attacker-authored, so a read-only run that resolved first and filtered
    // afterwards would have executed the attacker's command and handed it the
    // provider credential before any tool list was consulted. (INT-3189)
    const mcpTools = options.readOnly ? undefined : await resolveMcpTools(options.mcpTools);

    const loopOptions: AgenticLoopOptions = {
      systemPrompt: options.systemPrompt,
      prompt: options.prompt,
      cwd: options.cwd ?? process.cwd(),
      model,
      callApi,
      maxTurns: options.maxTurns ?? 15,
      timeoutMs: options.timeoutMs ?? 300000,
      onLog: options.onLog,
      enableTools: (options.enableTools ?? true) && supportsTools,
      nudgeMaxOnNoEdit: options.nudgeMaxOnNoEdit,
      finishValidator: options.finishValidator,
      finishValidatorMaxRetries: options.finishValidatorMaxRetries,
      finalAnswerRepair: options.finalAnswerRepair,
      protectedFiles: options.protectedFiles,
      scratchpadRunId: options.scratchpadRunId,
      memoryContext: options.memoryContext,
      forbidPublication: options.forbidPublication,
      sandbox: options.sandbox,
      bashTimeoutMs: options.bashTimeoutMs,
      webTools: options.webTools,
      memoryTools: options.memoryTools,
      shellTools: options.shellTools,
      toolAllow: options.toolAllow,
      toolDeny: options.toolDeny,
      filesystemTools: options.filesystemTools,
      diagnosticsTool: options.diagnosticsTool,
      readOnly: options.readOnly,
      mcpTools,
      coordinationContext: options.coordinationContext,
      signal: options.signal,
      editFormat: options.editFormat,
      usageAttribution: { adapter: 'local', taskId: options.processContext?.taskId, stage: options.processContext?.stage },
    };

    try {
      const result = await runAgenticLoop(loopOptions);
      if (options.onLog) {
        const toolInfo = supportsTools ? `${result.toolCallCount} tool uses` : 'no tools';
        options.onLog(`[${this.logPrefix}] ${result.apiCallCount} API calls, ${toolInfo}, ${result.totalTokens} tokens`);
      }
      const cli = loopResultToCliResult(result);
      if (cli.costInfo) cli.costInfo.model = model;
      return cli;
    } catch (err) {
      // Rate-limit AND infra/capacity errors (connection refused, 5xx, model not
      // loaded, socket drop) must propagate so the pipeline classifies them
      // (pause / infra_error) instead of a fake empty success → STUCK. Local
      // servers produce these most often. (INT-1906, INT-2520)
      if (err instanceof RateLimitError) throw err;
      if (isInfraError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('abort') || message.includes('timeout');

      return {
        exitCode: 1,
        stdout: '',
        stderr: isTimeout
          ? `Local model timeout after ${options.timeoutMs ?? 300000}ms (model: ${model}). Local models can be slow — consider increasing timeout.`
          : `Local model request failed: ${message}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Check whether the model supports tool_use
   * Ollama supports it only for some models (gemma3, llama3.1+, mistral, etc.)
   */
  private async checkToolSupport(baseUrl: string, model: string): Promise<boolean> {
    // Known model patterns that support tool_use
    const toolCapablePatterns = [
      /^llama3\.[1-9]/,     // llama3.1+
      /^gemma/,             // gemma 계열
      /^mistral/,           // mistral
      /^qwen/,              // qwen
      /^command-r/,         // cohere command-r
      /^firefunction/,      // fireworks
      /^hermes/,            // hermes
    ];

    const modelLower = model.toLowerCase();
    const knownCapable = toolCapablePatterns.some(p => p.test(modelLower));

    if (knownCapable) return true;

    // Unknown model -> try a single probe
    try {
      const request = prepareApprovedLocalModelRequest(baseUrl, {
        model,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'test', description: 'test', parameters: { type: 'object', properties: {} } } }],
        max_tokens: 1,
      });
      const res = await fetch(request.url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: request.body,
        signal: AbortSignal.timeout(5000),
      });
      // 200 means tools are supported, an error means unsupported
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Create the local API call function (injected into the agentic loop)
   */
  private createApiCaller(baseUrl: string, model: string, onToken?: (delta: string) => void, signal?: AbortSignal) {
    return async (messages: ChatMessage[], tools: ToolDefinition[]) => {
      // Per-API-call throttle budget (INT-2907).
      const throttle: ThrottleState = { attempts: 0 };
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.2,
        stream: true,
        stream_options: { include_usage: true },
        ...(this.maxTokens ? { max_tokens: this.maxTokens } : {}),
      };
      if (tools.length > 0) {
        body.tools = tools;
      }

      const attempt = async (): Promise<ReturnType<typeof consumeChatCompletionsStream>> => {
        const request = prepareApprovedLocalModelRequest(baseUrl, body);
        let res: Response;
        try {
          res = await fetch(request.url, {
            method: 'POST',
            headers: this.buildHeaders(),
            body: request.body,
            signal,
          });
        } catch (err) {
          // ECONNREFUSED / reset while a local server restarts → bounded
          // in-place retry instead of failing the whole run. (AGT-4385)
          if (await resolveTransientFailure('local', { error: err }, throttle, { signal }) === 'retry') {
            return attempt();
          }
          throw err;
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => '');

          if (res.status === 404 || errText.includes('not found')) {
            const models = await this.listModels();
            const modelList = models.length > 0
              ? `Available: ${models.slice(0, 10).join(', ')}`
              : 'No models loaded';
            throw new Error(`Model "${model}" not found on ${baseUrl}. ${modelList}`);
          }

          // A local server has no quota — a 429 means it is busy (queue full,
          // model still loading). Waiting is exactly the right answer, whereas
          // the old `Local API error (429)` string was re-promoted to a rate
          // limit downstream and paused the scheduler. (INT-2907)
          if (await resolveLimitResponse('local', res.status, res.headers, errText, throttle, { signal }) === 'retry') {
            return attempt();
          }
          // 5xx: server hiccup, bounded retry before it becomes an infra error. (AGT-4385)
          if (await resolveTransientFailure('local', { status: res.status }, throttle, { signal }) === 'retry') {
            return attempt();
          }

          throw new Error(`Local API error (${res.status}): ${errText.slice(0, 500)}`);
        }

        return consumeChatCompletionsStream(res, onToken);
      };

      return attempt();
    };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    return withExecutionEvidence(parseWorkerResult(raw.stdout), raw);
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    return parseReviewerResult(raw.stdout);
  }
}

// Streamed chat/completions responses are parsed by consumeChatCompletionsStream.

// Worker/Reviewer output parsing lives in ./resultParsing.ts (shared with the
// gpt, openrouter, and codex adapters — INT-1441).
