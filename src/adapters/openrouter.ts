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
import { parseWorkerResult, parseReviewerResult } from './resultParsing.js';
import { RateLimitError } from './rateLimitError.js';
import { resolveLimitResponse, type ThrottleState } from './throttleRetry.js';
import { isInfraError } from './errorClassification.js';
import { consumeChatCompletionsStream } from './chatStream.js';
import type { ToolDefinition } from './tools.js';

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'openai/gpt-5';
const PROFILE_KEY = 'openrouter:default';

/** OPENROUTER_API_KEY env var (legacy: OPENROUTER_API) → immediate API key (no PKCE needed). */
function getEnvApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_API?.trim() || undefined;
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
    // 어댑터가 직접 fetch하므로 spawn 진입점은 미사용.
    return { command: 'echo', args: ['"OpenRouter adapter uses run() — not shell spawn"'] };
  }

  async getDefaultModel(): Promise<string> {
    return DEFAULT_MODEL;
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
      onToken: options.onToken,
      signal: options.signal,
    });

    // MCP tools: caller-provided, else self-source from the registry. (INT-1951)
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
        `[OpenRouter] ${result.apiCallCount} API calls, ${result.toolCallCount} tool uses, ${result.totalTokens} tokens`,
      );
      return loopResultToCliResult(result);
    } catch (err) {
      // Rate-limit AND infra/capacity errors must propagate (pause / infra_error),
      // not be buried in a fake failed result the worker reads as an empty success. (INT-1906, INT-2520)
      if (err instanceof RateLimitError) throw err;
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
    return parseWorkerResult(raw.stdout);
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    return parseReviewerResult(raw.stdout);
  }
}

// ----- API caller -----
// Streamed chat/completions responses are parsed by consumeChatCompletionsStream.

export interface ApiCallerOptions {
  /** worker 등 기계적 역할: 추론 토큰 비활성화 (지원 모델 한정) */
  disableReasoning?: boolean;
  /** 스트리밍 토큰 콜백 (chat TUI). 없으면 비스트리밍과 동일하게 동작. */
  onToken?: (delta: string) => void;
  /** 사용자 중단(Esc/Ctrl+C) — fetch에 전달. */
  signal?: AbortSignal;
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
      // ZDR(Zero Data Retention) — 데이터를 보존하지 않는 provider로만 라우팅.
      // 단, OpenAI provider는 data_collection:deny 플래그를 거부("Provider returned
      // error")하므로 제외한다. OpenAI는 API 데이터를 학습에 쓰지 않아(정책상) ZDR
      // 강제가 불필요하다. non-OpenAI 모델에만 적용한다.
      body.provider = { data_collection: 'deny' };
    }
    // 추론 불필요 역할은 reasoning 토큰을 끈다. glm-4.7-flash처럼 non-thinking
    // 모델엔 무영향, 추론형 모델(glm-5 등)을 worker로 바꿔도 토큰 낭비를 막는다.
    // 단, OpenAI 추론 모델(gpt-5 등)은 "Reasoning is mandatory"로 이 플래그를
    // 거부하므로 제외한다 — worker escalate 대상이 gpt-5라 이걸 안 빼면 escalation이
    // 항상 깨진다. OpenAI는 단순 작업엔 추론을 자동 최소화하므로 끌 필요도 없다.
    if (opts.disableReasoning && !/^openai\//i.test(model)) {
      body.reasoning = { enabled: false };
    }
    if (tools.length > 0) {
      body.tools = tools;
    }

    const attempt = async (): Promise<ReturnType<typeof consumeChatCompletionsStream>> => {
      const res = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...ATTRIBUTION_HEADERS,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        // OpenRouter signals out-of-credits with HTTP 402 "Insufficient credits"
        // (NOT 429) — money, so waiting never helps: that stays a TYPED
        // RateLimitError which pauses the scheduler instead of the loop
        // swallowing it into a fake empty success → false STUCK (INT-2520).
        // A 429 is pacing, so it is waited out and retried. (INT-2907)
        if (await resolveLimitResponse('openrouter', res.status, res.headers, errText, throttle, { signal: opts.signal }) === 'retry') {
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
 * Prompt caching breakpoint 삽입.
 *
 * OpenAI/Gemini 모델은 OpenRouter가 자동 캐싱하므로 메시지를 건드리지 않는다.
 * Anthropic 모델은 명시적 cache_control breakpoint가 필요하다 — 매 API 호출마다
 * 전체 히스토리가 재전송되는데, 시스템 프롬프트 + 직전 누적 히스토리는 턴마다
 * 거의 동일하므로 그 경계에 ephemeral 캐시 마커를 두면 입력 토큰이 ~90% 할인된다.
 *
 * breakpoint 2개: (1) 시스템 메시지 끝, (2) 마지막 user/tool 메시지 직전 경계.
 * Anthropic은 최대 4개 breakpoint를 허용하므로 2개는 안전하다.
 */
export function applyPromptCaching(messages: ChatMessage[], model: string): unknown[] {
  // OpenAI/Gemini 등은 자동 캐싱 — 변환 불필요 (cache_control을 넣으면 거부될 수 있음)
  if (!/anthropic\/|claude/i.test(model)) {
    return messages;
  }

  // 캐시 마커를 달 인덱스: 시스템 메시지(있으면) + 마지막 직전 메시지.
  // 마지막 메시지(가장 최근 tool 결과)는 매 턴 바뀌므로 캐시하지 않는다.
  const cacheable = new Set<number>();
  if (messages[0]?.role === 'system') cacheable.add(0);
  if (messages.length >= 2) cacheable.add(messages.length - 2);

  return messages.map((m, i) => {
    if (!cacheable.has(i) || typeof m.content !== 'string' || !m.content) {
      return m;
    }
    // string content → content-part 배열로 변환하며 마지막 파트에 cache_control 부착
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
