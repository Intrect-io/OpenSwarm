// ============================================
// OpenSwarm - Codex Responses-API Adapter
// Calls chatgpt.com/backend-api/codex/responses via ChatGPT OAuth — no codex CLI.
// Runs on OpenSwarm's OWN agentic loop so tools/verification stay under our control
// (unlike the codex `exec` CLI, which is a black box). INT-1586.
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
import { AuthProfileStore, ensureValidToken } from '../auth/index.js';
import { runAgenticLoop, loopResultToCliResult, type ChatMessage, type AgenticLoopOptions } from './agenticLoop.js';
import { parseWorkerResult, parseReviewerResult } from './resultParsing.js';
import { formatCost } from '../support/costTracker.js';
import type { ToolDefinition } from './tools.js';
import { RateLimitError, rateLimitFromCodexHeaders } from './rateLimitError.js';
import { recordQuotaObservation } from './quotaSnapshot.js';
import { resolveLimitResponse, type ThrottleState } from './throttleRetry.js';
import { isInfraError } from './errorClassification.js';

import { getCodexModelIds } from './codexModels.js';

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
// Balanced default for unpinned work. Role configs can select Sol for
// quality-first work and Luna for high-volume/light work.
export const DEFAULT_MODEL = 'gpt-5.6-terra';
const PROFILE_KEY = 'openai-gpt:default';
const SPARK_MODEL = 'gpt-5.3-codex-spark';

// ---- Responses API wire types (the subset we send/receive) ----

interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict: false;
}

type ResponsesInputItem =
  | { role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

/**
 * Resolve the reasoning effort for a Responses API request. An explicit effort
 * (from a jobProfile) always wins; otherwise the worker's disableReasoning flag
 * picks the cheap floor ('low'), and everything else uses 'medium'.
 */
export function resolveReasoningEffort(
  reasoningEffort?: 'low' | 'medium' | 'high',
  disableReasoning?: boolean,
): 'low' | 'medium' | 'high' {
  return reasoningEffort ?? (disableReasoning ? 'low' : 'medium');
}

export function selectDefaultCodexResponseModel(modelIds: string[]): string {
  return (
    modelIds.find((m) => m === DEFAULT_MODEL) ??
    modelIds.find((m) => m !== SPARK_MODEL) ??
    DEFAULT_MODEL
  );
}

/** The agenticLoop callApi return shape (structurally equals its ChatCompletionResponse). */
interface ChatLikeResponse {
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: ApiToolCallShape[] };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cached_tokens?: number };
}

interface ApiToolCallShape {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// ---- Transforms (exported for unit tests) ----

/** ChatMessage[] → Responses `{ instructions, input[] }`. system → instructions. */
export function chatToResponsesInput(messages: ChatMessage[]): {
  instructions: string;
  input: ResponsesInputItem[];
} {
  const systemParts: string[] = [];
  const input: ResponsesInputItem[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content);
    } else if (m.role === 'user') {
      input.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (m.content) input.push({ role: 'assistant', content: m.content });
      for (const tc of m.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
    }
  }

  return { instructions: systemParts.join('\n\n'), input };
}

/** OpenSwarm ToolDefinition (nested `function:{}`) → Responses flat tool. */
export function toolsToResponsesTools(tools: ToolDefinition[]): ResponsesTool[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    // OpenSwarm tools use permissive JSON schemas. Keep Responses in best-effort
    // mode instead of asking it to normalize these into strict Structured Outputs.
    strict: false,
  }));
}

interface SseEvent {
  type?: string;
  delta?: string;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
  item_id?: string;
  arguments?: string;
  response?: {
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
  };
}

/**
 * Reduce parsed Responses SSE events → a chat-completions-shaped response.
 * Exported so the SSE→chat mapping is unit-testable without a live stream.
 */
export function reduceResponsesEvents(events: SseEvent[]): ChatLikeResponse {
  let text = '';
  // Keyed by the streaming item id; the emitted tool-call id is the call_id so it
  // round-trips back as `function_call_output.call_id` on the next turn.
  const calls = new Map<string, { callId: string; name: string; args: string }>();
  let usage: ChatLikeResponse['usage'];
  const getOnlyCall = () => calls.size === 1 ? calls.values().next().value : undefined;

  for (const ev of events) {
    switch (ev.type) {
      case 'response.output_text.delta':
        if (ev.delta) text += ev.delta;
        break;
      case 'response.output_item.added':
      case 'response.output_item.done':
        if (ev.item?.type === 'function_call' && ev.item.id) {
          const existing = calls.get(ev.item.id);
          const itemArgs = ev.item.arguments;
          calls.set(ev.item.id, {
            callId: ev.item.call_id || existing?.callId || ev.item.id,
            name: ev.item.name ?? existing?.name ?? '',
            args: typeof itemArgs === 'string' && (itemArgs || !existing?.args)
              ? itemArgs
              : existing?.args ?? '',
          });
        }
        break;
      case 'response.function_call_arguments.delta': {
        const c = ev.item_id ? calls.get(ev.item_id) : getOnlyCall();
        if (c && ev.delta) c.args += ev.delta;
        break;
      }
      case 'response.function_call_arguments.done': {
        const c = ev.item_id ? calls.get(ev.item_id) : getOnlyCall();
        if (c && typeof ev.arguments === 'string') c.args = ev.arguments;
        break;
      }
      case 'response.completed': {
        const u = ev.response?.usage;
        if (u) {
          const pt = u.input_tokens ?? 0;
          const ct = u.output_tokens ?? 0;
          const cached = u.input_tokens_details?.cached_tokens ?? 0;
          usage = { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, cached_tokens: cached };
        }
        break;
      }
    }
  }

  const toolCalls: ApiToolCallShape[] = [...calls.values()].map((c) => ({
    id: c.callId,
    type: 'function',
    function: { name: c.name, arguments: c.args },
  }));

  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: text || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage,
  };
}

/** Parse a `data: {json}` SSE line into an event, or null for keep-alives/[DONE]. */
function parseSseLine(line: string): SseEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data) as SseEvent;
  } catch {
    return null;
  }
}

/**
 * Read the whole SSE body and reduce it to a chat-shaped response. When
 * `onToken` is provided, each `response.output_text.delta` is emitted live so
 * the chat TUI can stream tokens as they arrive.
 */
async function consumeResponsesStream(
  res: Response,
  onToken?: (delta: string) => void,
  onReasoning?: (line: string) => void,
): Promise<ChatLikeResponse> {
  const events: SseEvent[] = [];
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Codex responses: empty stream body');

  const decoder = new TextDecoder();
  let buffer = '';
  // Reasoning summary streams token-by-token; buffer and emit whole lines so the
  // live log shows readable thoughts instead of one-word-per-line spam.
  let reasoningBuf = '';
  const flushReasoning = (force: boolean) => {
    if (!onReasoning) { reasoningBuf = ''; return; }
    let idx;
    while ((idx = reasoningBuf.indexOf('\n')) >= 0) {
      const line = reasoningBuf.slice(0, idx).trim();
      reasoningBuf = reasoningBuf.slice(idx + 1);
      if (line) onReasoning(line);
    }
    if (force && reasoningBuf.trim()) { onReasoning(reasoningBuf.trim()); reasoningBuf = ''; }
  };
  const handle = (ev: SseEvent | null) => {
    if (!ev) return;
    events.push(ev);
    if (onToken && ev.type === 'response.output_text.delta' && ev.delta) onToken(ev.delta);
    if (onReasoning && ev.type === 'response.reasoning_summary_text.delta' && ev.delta) {
      reasoningBuf += ev.delta;
      flushReasoning(false);
    }
    // End of a summary part → flush whatever partial line remains.
    if (ev.type === 'response.reasoning_summary_text.done' || ev.type === 'response.reasoning_summary_part.added') {
      flushReasoning(true);
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handle(parseSseLine(line));
  }
  handle(parseSseLine(buffer));
  flushReasoning(true);

  return reduceResponsesEvents(events);
}

// ---- Adapter ----

export class CodexResponsesAdapter implements CliAdapter {
  readonly name = 'codex-responses';

  readonly capabilities: AdapterCapabilities = {
    supportsStreaming: false, // the loop sees a single aggregated response per call
    supportsJsonOutput: true,
    supportsModelSelection: true,
    managedGit: false,
    supportedSkills: [],
    // The agentic loop honours CliRunOptions.readOnly (see agenticLoop/tools). (INT-3189)
    enforcesReadOnly: true,
  };

  async isAvailable(): Promise<boolean> {
    try {
      const store = new AuthProfileStore();
      const profile = store.getProfile(PROFILE_KEY);
      // Needs a ChatGPT OAuth profile carrying the codex account_id.
      return profile !== null && Boolean(profile.accountId);
    } catch {
      return false;
    }
  }

  buildCommand(_options: CliRunOptions): { command: string; args: string[] } {
    return { command: 'echo', args: ['"codex-responses adapter uses run() — not shell spawn"'] };
  }

  /** Default = top model from the Codex OAuth catalog (live/local), else constant. */
  async getDefaultModel(): Promise<string> {
    // Resolve the LIVE catalog with the account's OAuth token (INT-1872): the
    // curated offline list is account-stale (e.g. gpt-5-codex 400s
    // "model is not supported … with a ChatGPT account"). With a token,
    // getCodexModelIds returns what this account actually supports.
    let token: string | undefined;
    try {
      token = await ensureValidToken(new AuthProfileStore(), PROFILE_KEY);
    } catch {
      // no/expired auth → getCodexModelIds falls back to the offline curated list
    }
    const ids = await getCodexModelIds(token);
    return selectDefaultCodexResponseModel(ids);
  }

  async run(options: CliRunOptions): Promise<CliRunResult> {
    const store = new AuthProfileStore();
    const startTime = Date.now();

    let accessToken: string;
    let accountId: string;
    try {
      accessToken = await ensureValidToken(store, PROFILE_KEY);
      accountId = store.getProfile(PROFILE_KEY)?.accountId ?? '';
      if (!accountId) {
        throw new Error(
          'No chatgpt-account-id on the OAuth profile. Re-run: openswarm auth login --provider gpt',
        );
      }
    } catch (err) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Auth error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }

    // Honor explicit model requests. In particular, gpt-5.3-codex-spark must
    // exercise the same PKCE/tool loop as every other Codex Responses model.
    // Counter-evidence for the old read-paralysis guard is codified in
    // codexResponses.test.ts: a non-live Spark-shaped SSE loop executes
    // apply_patch, and the opt-in live smoke verifies PKCE + Spark edit tools.
    const model = options.model ?? await this.getDefaultModel();
    // Stream the model's reasoning summary to the live log as 💭 thoughts.
    const onReasoning = options.onLog ? (line: string) => options.onLog!(`💭 ${line}`) : undefined;
    // Stable prompt_cache_key so every turn of THIS run routes to the same cache
    // node — the static prefix (systemPrompt + worker prompt with File Map /
    // repoMemories / completionCriteria) then reuses the cache across tool turns.
    // Keyed by task+stage+model so concurrent tasks don't collide on one node.
    const cacheKey = `osw-${options.processContext?.taskId ?? 'cli'}-${options.processContext?.stage ?? 'run'}-${model}`;
    const callApi = this.createApiCaller(
      accessToken, accountId, store, model, options.onToken, options.signal, onReasoning, options.disableReasoning, options.reasoningEffort, cacheKey,
      options.timeoutMs ?? 300000,
    );

    const loopOptions: AgenticLoopOptions = {
      systemPrompt: options.systemPrompt,
      prompt: options.prompt,
      cwd: options.cwd ?? process.cwd(),
      model,
      callApi,
      maxTurns: options.maxTurns ?? 15,
      timeoutMs: options.timeoutMs ?? 300000,
      onLog: options.onLog,
      enableTools: options.enableTools ?? true,
      nudgeMaxOnNoEdit: options.nudgeMaxOnNoEdit,
      protectedFiles: options.protectedFiles,
      bashTimeoutMs: options.bashTimeoutMs,
      webTools: options.webTools,
      memoryTools: options.memoryTools,
      diagnosticsTool: options.diagnosticsTool,
      mcpTools: options.mcpTools,
      readOnly: options.readOnly,
      // codex models are RLHF-trained on the V4A apply_patch format — expose it as
      // the primary edit tool (edit_file stays as fallback). Verified: gpt-5.3-codex-spark
      // emits clean V4A here, whereas non-codex adapters keep edit_file only.
      applyPatch: true,
      signal: options.signal,
      editFormat: options.editFormat,
    };

    try {
      const result = await runAgenticLoop(loopOptions);
      if (options.onLog) {
        const pct = result.totalTokens > 0 ? Math.round((result.cachedTokens / result.totalTokens) * 100) : 0;
        options.onLog(`[Codex ${model}] ${result.apiCallCount} API calls, ${result.toolCallCount} tool uses, ${result.totalTokens} tokens (${result.cachedTokens} cached, ${pct}%)`);
      }
      const cli = loopResultToCliResult(result);
      if (cli.costInfo) cli.costInfo.model = model;
      return cli;
    } catch (err) {
      // Rate-limit AND infra/capacity errors must propagate (pause / infra_error),
      // not be buried in a fake failed result the worker reads as an empty success. (INT-1906, INT-2520)
      if (err instanceof RateLimitError) throw err;
      if (isInfraError(err)) throw err;
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Codex responses loop failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /** Build the agentic-loop callApi: POST /responses + chat↔Responses conversion. */
  private createApiCaller(
    initialToken: string,
    accountId: string,
    store: AuthProfileStore,
    model: string,
    onToken?: (delta: string) => void,
    signal?: AbortSignal,
    onReasoning?: (line: string) => void,
    disableReasoning?: boolean,
    reasoningEffort?: 'low' | 'medium' | 'high',
    cacheKey?: string,
    /**
     * Ceiling for one API call, including the streamed body. Without it the
     * request was bounded only by the caller's signal, and the agentic loop
     * checks its deadline between turns — so a connection that accepted the
     * request and then went silent hung with nothing to interrupt it.
     */
    timeoutMs?: number,
  ) {
    let token = initialToken;
    let modelRetried = false;
    let effectiveModel = model;

    return async (messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatLikeResponse> => {
      // Per-API-call throttle budget (a fresh one each turn — a wait that cleared
      // one turn's throttle must not count against the next). (INT-2907)
      const throttle: ThrottleState = { attempts: 0 };
      // Per-API-call too, for the same reason. Held in the createApiCaller
      // closure this was set once per run, so the first 401 refresh consumed
      // the only retry the whole run had: a second token expiry — ordinary in a
      // run measured in hours — then failed every remaining call with 401 and
      // never attempted the refresh that would have fixed it.
      let retried = false;
      const { instructions, input } = chatToResponsesInput(messages);
      const body: Record<string, unknown> = {
        model: effectiveModel,
        input,
        store: false,
        stream: true,
      };
      if (instructions) body.instructions = instructions;
      if (tools.length > 0) body.tools = toolsToResponsesTools(tools);
      // Route every turn of this run to the same prompt cache so the stable prefix
      // (instructions + worker prompt) reuses cached tokens across tool turns.
      if (cacheKey) body.prompt_cache_key = cacheKey;
      // Surface the model's thinking: request a reasoning summary so the live log
      // shows 💭 thoughts (codex-responses keeps thinking in the reasoning channel
      // and emits little output_text on tool-call turns). Worker (disableReasoning)
      // uses low effort to stay cheap; other roles use medium. effort ∈ low|medium|high.
      body.reasoning = { effort: resolveReasoningEffort(reasoningEffort, disableReasoning), summary: 'auto' };
      // NOTE: never set max_output_tokens — the Codex backend rejects it with HTTP 400.

      const doCall = async (accessToken: string): Promise<ChatLikeResponse> => {
        const res = await fetch(CODEX_RESPONSES_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': `Bearer ${accessToken}`,
            'chatgpt-account-id': accountId,
            'originator': 'openswarm',
            'OpenAI-Beta': 'responses=experimental',
          },
          body: JSON.stringify(body),
          // The caller's signal AND this call's own deadline. Either aborts.
          signal: abortSignalWithDeadline(signal, timeoutMs),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          // 429 → a SPENT QUOTA gets the typed RateLimitError carrying reset/usage
          // from the rich x-codex-* headers (used %, reset-at, window) (INT-2192);
          // a short-window THROTTLE is waited out and retried instead, because
          // pausing/aborting on it reported "usage limit hit" on accounts with
          // quota to spare (review --max runs 4-16 subagents at once). (INT-2907)
          if (res.status === 429) {
            const outcome = await resolveLimitResponse('codex', res.status, res.headers, errText, throttle, {
              signal,
              onLog: onReasoning,
              // Codex's headers carry used %, window length and reset-at — a far
              // richer quota error than the generic HTTP one. (INT-2192)
              quotaError: (headers, body) => rateLimitFromCodexHeaders(headers ?? new Headers(), body),
            });
            if (outcome === 'retry') return doCall(token);
          }
          // 401 → refresh once and retry.
          if (res.status === 401 && !retried) {
            retried = true;
            token = await refreshAndRetry(store);
            return doCall(token);
          }
          // 400 "model is not supported" — this account can't use body.model.
          // Fall forward to the next live-catalog model once (INT-1872): account
          // model availability varies, so adapt instead of failing the task.
          if (res.status === 400 && /not supported/i.test(errText) && !modelRetried) {
            modelRetried = true;
            const candidates = (await getCodexModelIds(token)).filter((m) => m !== body.model);
            const alt =
              candidates.find((m) => m === DEFAULT_MODEL) ??
              candidates.find((m) => m !== SPARK_MODEL);
            if (alt) {
              onReasoning?.(`model ${String(body.model)} not supported on this account — retrying with ${alt}`);
              effectiveModel = alt;
              body.model = alt;
              return doCall(token);
            }
          }
          throw new Error(`Codex responses error (${res.status}): ${errText.slice(0, 500)}`);
        }

        // Successful responses carry the same x-codex-* usage headers as 429s
        // (when the account exposes them) — the only place a HEALTHY quota
        // percentage can be observed for the cockpit gauge. (INT-3402)
        const usedPercent = parseInt(res.headers.get('x-codex-primary-used-percent') ?? '', 10);
        if (Number.isFinite(usedPercent)) {
          const windowMinutes = parseInt(res.headers.get('x-codex-primary-window-minutes') ?? '', 10);
          const resetsAt = parseInt(res.headers.get('x-codex-primary-reset-at') ?? '', 10);
          recordQuotaObservation({
            provider: 'codex',
            usedPercent,
            windowMinutes: Number.isFinite(windowMinutes) ? windowMinutes : undefined,
            resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
            source: 'success-headers',
          });
        }

        return consumeResponsesStream(res, onToken, onReasoning);
      };

      return doCall(token);
    };
  }

  parseWorkerOutput(raw: CliRunResult): WorkerResult {
    const result = parseWorkerResult(raw.stdout);
    // Backfill the model's frequently-empty self-reported `commands` with the
    // shell commands the agentic loop actually ran, so the validation-evidence
    // gate and reviewers see the real checks. (INT-2485)
    if (raw.executedCommands && raw.executedCommands.length > 0) {
      result.commands = [...new Set([...result.commands, ...raw.executedCommands])].slice(0, 20);
    }
    // Same tokens/duration visibility as the claude adapter (INT-2508).
    if (raw.costInfo) {
      console.log(`[Worker] Cost: ${formatCost(raw.costInfo)}`);
      result.costInfo = raw.costInfo;
    }
    return result;
  }

  parseReviewerOutput(raw: CliRunResult): ReviewResult {
    const result = parseReviewerResult(raw.stdout);
    if (raw.costInfo) {
      console.log(`[Reviewer] Cost: ${formatCost(raw.costInfo)}`);
      result.costInfo = raw.costInfo;
    }
    return result;
  }
}

async function refreshAndRetry(store: AuthProfileStore): Promise<string> {
  // expireProfile, not getProfile + setProfile. `store` was built when run()
  // started and this 401 can arrive hours later, so writing its snapshot back
  // would restore whatever the refresh token was then — dead, if another
  // process rotated it in between. Only `expires` is ours to change.
  if (!store.expireProfile(PROFILE_KEY)) throw new Error('No auth profile found');
  return ensureValidToken(store, PROFILE_KEY);
}
