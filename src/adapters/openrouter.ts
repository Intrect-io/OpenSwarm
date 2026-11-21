// ============================================
// OpenSwarm - OpenRouter CLI Adapter
// Calls the OpenRouter Chat Completions API (OpenAI-compatible schema)
// using a stored sk-or-* key from `openswarm auth login --provider openrouter`.
// ============================================

import type {
  CliAdapter,
  CliRunOptions,
  CliRunResult,
  AdapterCapabilities,
  WorkerResult,
  ReviewResult,
} from './types.js';
import { AuthProfileStore, ensureValidToken } from '../auth/index.js';
import {
  runAgenticLoop,
  loopResultToCliResult,
  type ChatMessage,
  type AgenticLoopOptions,
} from './agenticLoop.js';
import { resolveMcpTools } from '../mcp/mcpClient.js';
import { parseWorkerResult, parseReviewerResult, withExecutionEvidence } from './resultParsing.js';
import { RateLimitError } from './rateLimitError.js';
import { resolveLimitResponse, resolveTransientFailure, type ThrottleState } from './throttleRetry.js';
import { isInfraError } from './errorClassification.js';
import { consumeChatCompletionsStream } from './chatStream.js';
import { abortSignalWithDeadline } from './requestDeadline.js';
import type { ToolDefinition } from './tools.js';
import { prepareApprovedModelRequest } from '../support/approvedEgress.js';
import {
  loadModelCatalog,
  parseOpenAiModelListing,
  contextWindowFor,
  resolveDefaultModel,
  type CatalogSpec,
} from './modelCatalog.js';
import { adapterFetch } from './httpDispatcher.js';

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
// Picked from the Atlas pool benchmark (benchmarks/, INT-3106): v4-flash passed
// 100% of the L0–L5 ladder at the lowest cost per pass, and resolved 2/3 on the
// real L6 SWE tasks — the only worker-tier model that cleared both.
//
// It is reasoning-mandatory: completions spend tokens on reasoning before any
// content, so a very small max_tokens budget returns empty content rather than a
// short answer (measured: 20 tokens → content null, 500 tokens → "OK"). The
// reasoning-mandatory handling added for that lives further down in this file.
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
export const DEEPSEEK_FALLBACK_MODEL = 'z-ai/glm-5.3-flash';
const PROFILE_KEY = 'openrouter:default';

/** OPENROUTER_API_KEY env var (legacy: OPENROUTER_API) → immediate API key (no PKCE needed). */
function getEnvApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_API?.trim() || undefined;
}

/** Model listing must never block a run for long — it is advisory metadata. */
const MODEL_LIST_TIMEOUT_MS = 10_000;

/**
 * Fallbacks for an offline/unauthenticated run. OpenRouter serves hundreds of
 * models; this is deliberately just enough to start, since live discovery
 * replaces it whenever a key is present.
 */
const CURATED_MODELS = [DEFAULT_MODEL, DEEPSEEK_FALLBACK_MODEL, 'deepseek/deepseek-v4-pro', 'openai/gpt-5', 'anthropic/claude-sonnet-4'];

function catalogSpec(): CatalogSpec {
  return {
    provider: 'openrouter',
    curated: CURATED_MODELS,
    fetchLive: async () => {
      // Listing accepts the env key or a stored profile, same precedence as run().
      let apiKey = getEnvApiKey();
      if (!apiKey) {
        try {
          apiKey = await ensureValidToken(new AuthProfileStore(), PROFILE_KEY);
        } catch {
          return [];
        }
      }
      if (!apiKey) return [];
      const res = await adapterFetch(`${OPENROUTER_API_BASE}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      return parseOpenAiModelListing(await res.json()); // ids + context windows (AGT-4386)
    },
  };
}

// Attribution headers — OpenRouter surfaces these in its analytics UI so
// model providers can see traffic originating from OpenSwarm.
const ATTRIBUTION_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://github.com/unohee/openswarm',
  'X-Title': 'OpenSwarm',
};

export class OpenRouterCliAdapter implements CliAdapter {
  readonly name = 'openrouter';

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

  async isAvailable(): Promise<boolean> {
    if (getEnvApiKey()) return true;
    try {
      const store = new AuthProfileStore();
      return store.getProfile(PROFILE_KEY) !== null;
    } catch {
      return false;
    }
  }

  buildCommand(_options: CliRunOptions): { command: string; args: string[] } {
    // The adapter calls fetch directly, so the spawn entry point is unused.
    return { command: 'echo', args: ['"OpenRouter adapter uses run() — not shell spawn"'] };
  }

  async listModels(): Promise<string[]> {
    return (await loadModelCatalog(catalogSpec())).models;
  }

  async getDefaultModel(): Promise<string> {
    return resolveDefaultModel(catalogSpec(), DEFAULT_MODEL);
  }

  async run(options: CliRunOptions): Promise<CliRunResult> {
    const startTime = Date.now();

    // Prefer OPENROUTER_API_KEY env var (auto-loaded from .env by the CLI entrypoint)
    let apiKey: string | undefined = getEnvApiKey();
    if (!apiKey) {
      const store = new AuthProfileStore();
      try {
        apiKey = await ensureValidToken(store, PROFILE_KEY);
      } catch (err) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: `Auth error: ${err instanceof Error ? err.message : String(err)}. Set OPENROUTER_API_KEY env var or run: openswarm auth login --provider openrouter`,
          durationMs: Date.now() - startTime,
        };
      }
    }

    const model = options.model ?? await this.getDefaultModel();
    const callApi = createApiCaller(apiKey, model, {
      disableReasoning: options.disableReasoning,
      reasoningEffort: options.reasoningEffort,
      onToken: options.onToken,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 300000,
    });

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
      maxTurns: options.maxTurns ?? 20,
      // Size compaction to the advertised window when the catalog has it. (AGT-4386)
      contextWindowTokens: contextWindowFor('openrouter', model),
      timeoutMs: options.timeoutMs ?? 300000,
      onLog: options.onLog,
      enableTools: options.enableTools ?? true,
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
      usageAttribution: { adapter: 'openrouter', taskId: options.processContext?.taskId, stage: options.processContext?.stage },
    };

    try {
      const result = await runAgenticLoop(loopOptions);
      options.onLog?.(
        `[OpenRouter] ${result.apiCallCount} API calls, ${result.toolCallCount} tool uses, ${result.totalTokens} tokens`,
      );
      const cli = loopResultToCliResult(result);
      if (cli.costInfo) cli.costInfo.model = model;
      return cli;
    } catch (err) {
      // A model-family fallback is stronger than retrying the same endpoint:
      // OpenRouter already exhausted transient retries inside createApiCaller,
      // so a remaining v4-flash failure gets one clean GLM run with the exact
      // same tool/sandbox/reasoning policy. Account quota errors and operator
      // cancellation cannot be repaired by changing models and must propagate.
      if (err instanceof RateLimitError) throw err;
      if (options.signal?.aborted) throw err;
      if (model === DEFAULT_MODEL) {
        options.onLog?.(`[OpenRouter] ${DEFAULT_MODEL} failed; escalating to ${DEEPSEEK_FALLBACK_MODEL}: ${err instanceof Error ? err.message : String(err)}`);
        return this.run({ ...options, model: DEEPSEEK_FALLBACK_MODEL });
      }
      // Infra/capacity errors on the fallback still propagate so the scheduler
      // classifies them as infrastructure instead of fake task failure.
      if (isInfraError(err)) throw err;
      return {
        exitCode: 1,
        stdout: '',
        stderr: `OpenRouter agentic loop failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    return withExecutionEvidence(parseWorkerResult(raw.stdout), raw);
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    return parseReviewerResult(raw.stdout);
  }
}

// ----- API caller -----
// Streamed chat/completions responses are parsed by consumeChatCompletionsStream.

export interface ApiCallerOptions {
  /** Mechanical roles such as worker: disable reasoning tokens (supported models only) */
  disableReasoning?: boolean;
  /**
   * OpenRouter's unified `reasoning.effort`. Wins over disableReasoning when
   * both are set. Before AGT-4402 this adapter dropped it, so a jobProfile's
   * `effort` and the escalation ladder's `effort→high` never reached the
   * request — on openrouter they degraded to "not disabled".
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Streaming token callback (chat TUI). Without it, behaves the same as non-streaming. */
  onToken?: (delta: string) => void;
  /** User abort (Esc/Ctrl+C) - passed to fetch. */
  signal?: AbortSignal;
  /** Per-call ceiling covering the streamed body (see requestDeadline.ts) —
   * #345 wired this into atlascloud/codexResponses but missed this adapter,
   * leaving a silent OpenRouter connection able to hang a worker. */
  timeoutMs?: number;
}

export function createApiCaller(apiKey: string, model: string, opts: ApiCallerOptions = {}) {
  return async (messages: ChatMessage[], tools: ToolDefinition[]) => {
    // Per-API-call throttle budget (INT-2907).
    const throttle: ThrottleState = { attempts: 0 };
    const body: Record<string, unknown> = {
      model,
      messages: applyPromptCaching(messages, model),
      temperature: 0.2,
      max_tokens: 16384,
      stream: true,
      stream_options: { include_usage: true },
    };
    // Explicit provider pin (INT-3105): OPENROUTER_PROVIDER_ONLY routes every
    // request to the named provider slug(s) with no fallback — e.g.
    // `atlas-cloud` to burn sponsorship credits deterministically in tests.
    // The pin is the caller's explicit intent, so it replaces the ZDR default
    // below (combining them could leave zero eligible providers).
    const pinnedProviders = (process.env.OPENROUTER_PROVIDER_ONLY ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (pinnedProviders.length > 0) {
      body.provider = { only: pinnedProviders, allow_fallbacks: false };
    } else if (!/^openai\//i.test(model)) {
      // ZDR (Zero Data Retention) - route only to providers that do not retain data.
      // OpenAI providers are excluded because they reject the data_collection:deny flag
      // ("Provider returned error"). OpenAI does not train on API data (per policy), so
      // forcing ZDR is unnecessary there. Applies to non-OpenAI models only.
      //
      // sort: 'throughput' picks the fastest ZDR-eligible endpoint instead of
      // OpenRouter's default (load-balanced / cheapest-first) order. The
      // 2026-06-09 worker benchmark found the same model 5x slower on one
      // provider than another (qwen3-coder: 2759 tok/s on DeepInfra vs 160 on
      // Novita) — provider, not model choice, was the dominant speed factor.
      // A slow provider burns a stage's turn/timeout budget for no quality
      // gain, so throughput is worth more here than shaving cents off price.
      body.provider = { data_collection: 'deny', sort: 'throughput' };
    }
    // Turn reasoning tokens off for roles that do not need reasoning. No effect on non-thinking
    // models such as glm-4.7-flash; avoids token waste if a reasoning model (glm-5, etc.) becomes
    // worker. OpenAI reasoning models (gpt-5, etc.) are excluded: they reject this flag
    // ("Reasoning is mandatory"), and the worker escalation target is gpt-5, so escalation would
    // always break. OpenAI minimizes reasoning on simple tasks anyway, so there is nothing to turn off.
    if (opts.reasoningEffort) {
      // A model that does not take the parameter answers 400; the fallback
      // below drops `reasoning` and retries, same as for `enabled: false`.
      body.reasoning = { effort: opts.reasoningEffort };
    } else if (opts.disableReasoning && !/^openai\//i.test(model)) {
      body.reasoning = { enabled: false };
    }
    if (tools.length > 0) {
      body.tools = tools;
    }
    const attempt = async (): Promise<ReturnType<typeof consumeChatCompletionsStream>> => {
      const request = prepareApprovedModelRequest(`${OPENROUTER_API_BASE}/chat/completions`, body);
      let res: Response;
      try {
        res = await adapterFetch(request.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...ATTRIBUTION_HEADERS,
          },
          body: request.body,
          // The caller's signal AND this call's own deadline. Either one aborts.
          signal: abortSignalWithDeadline(opts.signal, opts.timeoutMs),
        });
      } catch (err) {
        // A dropped socket before any response (undici `fetch failed`) is a
        // blip, not a verdict — retry the step in place. (AGT-4385)
        if (await resolveTransientFailure('openrouter', { error: err }, throttle, { signal: opts.signal }) === 'retry') {
          return attempt();
        }
        throw err;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        // Reasoning-mandatory models (minimax-m3, thinking-only variants)
        // reject `reasoning: {enabled: false}` with a 400 — the static openai/*
        // exclusion above cannot enumerate them, and the failure killed every
        // minimax benchmark run instantly (INT-3106: 400 "invalid request
        // params" from AtlasCloud). Drop the flag and retry once: worse to
        // waste the whole call than to pay some reasoning tokens.
        if (res.status === 400 && body.reasoning) {
          delete body.reasoning;
          return attempt();
        }
        // OpenRouter signals out-of-credits with HTTP 402 "Insufficient credits"
        // (NOT 429) — money, so waiting never helps: that stays a TYPED
        // RateLimitError which pauses the scheduler instead of the loop
        // swallowing it into a fake empty success → false STUCK (INT-2520).
        // A 429 is pacing, so it is waited out and retried. (INT-2907)
        if (await resolveLimitResponse('openrouter', res.status, res.headers, errText, throttle, { signal: opts.signal }) === 'retry') {
          return attempt();
        }
        // 5xx / 529: upstream blip, bounded retry before it becomes an infra error. (AGT-4385)
        if (await resolveTransientFailure('openrouter', { status: res.status }, throttle, { signal: opts.signal }) === 'retry') {
          return attempt();
        }
        throw new Error(`OpenRouter API error (${res.status}): ${errText.slice(0, 500)}`);
      }

      return consumeChatCompletionsStream(res, opts.onToken);
    };

    return attempt();
  };
}

/**
 * Insert prompt caching breakpoints.
 *
 * OpenRouter caches OpenAI/Gemini models automatically, so messages are left untouched.
 * Anthropic models need explicit cache_control breakpoints - the full history is
 * resent on every API call, and the system prompt plus the preceding accumulated
 * history is nearly identical from turn to turn, so an ephemeral cache marker at that boundary gives ~90% off input tokens.
 *
 * Two breakpoints: (1) end of the system message, (2) boundary just before the last user/tool message.
 * Anthropic allows up to 4 breakpoints, so 2 is safe.
 */
export function applyPromptCaching(messages: ChatMessage[], model: string): unknown[] {
  // OpenAI/Gemini etc. cache automatically - no conversion needed (cache_control may be rejected)
  if (!/anthropic\/|claude/i.test(model)) {
    return messages;
  }

  // Indexes to mark for caching: the system message (if any) + the message just before the last.
  // The last message (the newest tool result) changes every turn, so it is not cached.
  const cacheable = new Set<number>();
  if (messages[0]?.role === 'system') cacheable.add(0);
  if (messages.length >= 2) cacheable.add(messages.length - 2);

  return messages.map((m, i) => {
    if (!cacheable.has(i) || typeof m.content !== 'string' || !m.content) {
      return m;
    }
    // Convert string content to a content-part array and attach cache_control to the last part
    return {
      ...m,
      content: [
        { type: 'text', text: m.content, cache_control: { type: 'ephemeral' } },
      ],
    };
  });
}

// ----- Worker/Reviewer output parsing (mirrors gpt.ts) -----

// Worker/Reviewer output parsing lives in ./resultParsing.ts (shared with the
// gpt, local, and codex adapters — INT-1441).
