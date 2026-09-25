// ============================================
// OpenSwarm - Ollama Cloud Adapter
// Purpose: Reach Ollama's cloud models over either transport the service offers.
//
// Ollama exposes two, and they do not agree on the model id (measured
// 2026-09-23, recorded on AGT-4512):
//
//   direct  https://ollama.com/v1   Bearer OLLAMA_API_KEY   id "gemma4:31b"
//   local   http://127.0.0.1:11434  no auth (sign-in)       id "gemma4:31b-cloud"
//
// The local server proxies cloud models under its own sign-in — verified by a
// real completion against `deepseek-v4.1-flash:cloud` on this machine — so a
// user who signed in to the Ollama app needs no API key at all. The same
// endpoint answers 404 for the plain spelling, which is why the id is
// normalized rather than passed through.
//
// Local discovery is also blind to cloud models by design: `/v1/models` returns
// `{"data":null}` and `/api/tags` returns `[]`. `LocalModelAdapter` reads its
// default from exactly that list, so it falls back to `gemma3:4b` — an id this
// transport rejects. Hence the curated list below.
// ============================================

import type { CliAdapter, CliRunOptions, CliRunResult } from './types.js';
import { LocalModelAdapter } from './local.js';
import { abortSignalWithDeadline } from './requestDeadline.js';
import {
  runAgenticLoop,
  loopResultToCliResult,
  type ChatMessage,
  type AgenticLoopOptions,
} from './agenticLoop.js';
import { resolveMcpTools } from '../mcp/mcpClient.js';
import type { ToolDefinition } from './tools.js';
import { consumeChatCompletionsStream, type ChatCompletionLike } from './chatStream.js';
import { RateLimitError } from './rateLimitError.js';
import { resolveLimitResponse, resolveTransientFailure, type ThrottleState } from './throttleRetry.js';
import { isInfraError } from './errorClassification.js';
import { prepareApprovedModelRequest } from '../support/approvedEgress.js';
import { adapterFetch } from './httpDispatcher.js';
import { StreamStallError, createStallGuard } from './stallGuard.js';
import { parseOpenAiModelList, writeCachedCatalog } from './modelCatalog.js';

export const OLLAMA_CLOUD_DIRECT_BASE_URL = 'https://ollama.com';
export const OLLAMA_CLOUD_LOCAL_BASE_URL = 'http://127.0.0.1:11434';

/** The direct cloud API's chat route; `ollama.com/api/chat` is the native one. */
export const OLLAMA_CLOUD_CHAT_ENDPOINT = `${OLLAMA_CLOUD_DIRECT_BASE_URL}/v1/chat/completions`;

/**
 * Canonical (plain) ids the cloud serves, as `GET https://ollama.com/v1/models`
 * reported on 2026-09-23: 20 ids, of which these are the ones worth defaulting
 * to. Kept short on purpose — offline fallback, not a mirror of the catalogue.
 */
export const OLLAMA_CLOUD_CURATED_MODELS = [
  'deepseek-v4.1-flash',
  'glm-5.3',
  'kimi-k2.6',
  'minimax-m3',
  'gemma4:31b',
];

export const OLLAMA_CLOUD_DEFAULT_MODEL = OLLAMA_CLOUD_CURATED_MODELS[0];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Availability and model listing are advisory metadata; neither may stall a run. */
const AVAILABILITY_TIMEOUT_MS = 10_000;

export type OllamaCloudTransport = 'direct' | 'local';

/**
 * Spell a canonical id the way the local server accepts it.
 *
 * Measured: `deepseek-v4.1-flash` → 404, `deepseek-v4.1-flash:cloud` → 200,
 * `gemma4:cloud` → 200. A tag before the suffix (`gemma4:31b-cloud`) is already
 * in this form and is left alone; `-cloud` and `:cloud` are equivalent to the
 * server, and the former is what its own `/api/tags` reports.
 */
export function toLocalTransportModel(id: string): string {
  const trimmed = id.trim();
  if (trimmed.endsWith('-cloud') || trimmed.endsWith(':cloud')) return trimmed;
  return `${trimmed}:cloud`;
}

/** Strip the cloud suffix the direct API does not accept. */
export function toDirectTransportModel(id: string): string {
  return id.trim().replace(/[-:]cloud$/, '');
}

function isLoopback(baseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export interface OllamaCloudAdapterOptions {
  /** Overrides the environment, for tests and for callers that hold config. */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Abandon (and retry) a direct request that produces no bytes for this long. */
  streamIdleMs?: number;
}

/**
 * Silence after which a direct request is abandoned and retried. Long enough
 * for a slow first token, far shorter than a stage budget.
 */
export const OLLAMA_CLOUD_STREAM_IDLE_MS = 180_000;

/** Per-request generation ceiling, reasoning included. */
export const OLLAMA_CLOUD_MAX_TOKENS = 16_384;

/** How one call reaches Ollama Cloud, resolved from options and the environment. */
export type OllamaCloudRoute =
  | { transport: 'direct'; baseUrl: string; apiKey?: string }
  | { transport: 'local'; baseUrl: string }
  | { transport: 'refused'; baseUrl: string; reason: string };

/**
 * Pick the transport for one call.
 *
 * Read per call, not at construction: the adapter registry is built when its
 * module is imported, before the CLI loads `.env`, so a key kept only in `.env`
 * would otherwise never be seen.
 *
 * A base URL override may only name a loopback server (local transport) or
 * ollama.com itself. Anything else is refused outright: the key must never be
 * sent to a host the user did not mean as Ollama Cloud, and a chat request must
 * never silently go somewhere other than the URL the user configured.
 */
export function resolveOllamaCloudRoute(
  options: OllamaCloudAdapterOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): OllamaCloudRoute {
  const read = (name: string) => env[name]?.trim() || undefined;
  const override = options.baseUrl ?? read('OLLAMA_CLOUD_BASE_URL');
  const apiKey = options.apiKey ?? read('OLLAMA_API_KEY');
  if (!override) {
    return apiKey
      ? { transport: 'direct', baseUrl: OLLAMA_CLOUD_DIRECT_BASE_URL, apiKey }
      : { transport: 'local', baseUrl: OLLAMA_CLOUD_LOCAL_BASE_URL };
  }
  const baseUrl = override.replace(/\/+$/, '');
  if (isLoopback(baseUrl)) return { transport: 'local', baseUrl };
  let origin: string | undefined;
  try {
    origin = new URL(baseUrl).origin;
  } catch { // cxt-ignore: error_swallow — an unparsable URL is refused below
    origin = undefined;
  }
  if (origin === OLLAMA_CLOUD_DIRECT_BASE_URL) return { transport: 'direct', baseUrl: OLLAMA_CLOUD_DIRECT_BASE_URL, apiKey };
  return {
    transport: 'refused',
    baseUrl,
    reason: `OLLAMA_CLOUD_BASE_URL must be a loopback Ollama server or ${OLLAMA_CLOUD_DIRECT_BASE_URL}; refusing ${baseUrl}`,
  };
}

export class OllamaCloudAdapter extends LocalModelAdapter implements CliAdapter {
  private readonly options: OllamaCloudAdapterOptions;

  constructor(options: OllamaCloudAdapterOptions = {}) {
    super({
      name: 'ollama-cloud',
      // No fallback list: each call probes exactly the loopback server its route
      // names (useLocal), so a configured server that is down is reported down
      // instead of silently replaced by :11434.
      endpoints: [],
      // Curated ids are canonical; getDefaultModel() spells them per transport.
      defaultModel: OLLAMA_CLOUD_DEFAULT_MODEL,
      // Only the direct path authenticates, and it never goes through the base
      // class. The local server holds its own sign-in and gets no key.
      apiKey: undefined,
      logPrefix: 'Ollama Cloud',
      // The local route serves the same reasoning models (AGT-4534).
      maxTokens: OLLAMA_CLOUD_MAX_TOKENS,
      noServerMessage: 'No local Ollama server found. Start Ollama (or `ollama signin`) first, or set OLLAMA_API_KEY for direct cloud access.',
    });
    this.options = options;
  }

  private route(): OllamaCloudRoute {
    return resolveOllamaCloudRoute(this.options);
  }

  private explicitModel(): string | undefined {
    return this.options.model ?? (process.env.OLLAMA_CLOUD_MODEL?.trim() || undefined);
  }

  /** Point the base class at the loopback server this call should use. */
  private useLocal(route: Extract<OllamaCloudRoute, { transport: 'local' }>): void {
    this.setBaseUrl(route.baseUrl);
  }

  getTransport(): OllamaCloudTransport | 'refused' {
    return this.route().transport;
  }

  override getActiveUrl(): string | null {
    return this.route().baseUrl;
  }

  /**
   * The base class probes through `approvedLocalModelEndpoint`, which refuses
   * any non-loopback host by construction — correct for a local server, and
   * fatal here: the direct transport is exactly that refusal. So the direct
   * probe goes to the fixed ollama.com origin its chat calls use.
   */
  override async isAvailable(): Promise<boolean> {
    const route = this.route();
    if (route.transport === 'refused') return false;
    if (route.transport === 'local') {
      this.useLocal(route);
      return super.isAvailable();
    }
    if (!route.apiKey) return false;
    try {
      const res = await adapterFetch(`${OLLAMA_CLOUD_DIRECT_BASE_URL}/v1/models`, {
        headers: { Authorization: `Bearer ${route.apiKey}` },
        signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
      });
      return res.ok;
    } catch { // cxt-ignore: error_swallow — unreachable is exactly "not available"
      return false;
    }
  }

  /** Curated ids, plus whatever the active transport reports. */
  override async listModels(): Promise<string[]> {
    const route = this.route();
    let live: string[] = [];
    if (route.transport === 'local') {
      this.useLocal(route);
      live = await super.listModels();
    } else if (route.transport === 'direct') {
      live = await this.listDirectModels(route.apiKey);
    }
    // Local discovery returns [] for cloud models; the curated list carries them.
    return Array.from(new Set([...OLLAMA_CLOUD_CURATED_MODELS, ...live]));
  }

  /**
   * The live catalogue, cached so the provider-switch guard (modelCompat) can
   * accept every id the service actually serves, not only the curated five.
   */
  private async listDirectModels(apiKey: string | undefined): Promise<string[]> {
    if (!apiKey) return [];
    try {
      const res = await adapterFetch(`${OLLAMA_CLOUD_DIRECT_BASE_URL}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      const ids = parseOpenAiModelList(await res.json());
      if (ids.length > 0) writeCachedCatalog('ollama-cloud', ids);
      return ids;
    } catch { // cxt-ignore: error_swallow — listing is advisory metadata
      return [];
    }
  }

  /**
   * The explicit model, else the curated default — never "whichever cloud model
   * a server happens to list first", which would silently change the model.
   */
  override async getDefaultModel(): Promise<string> {
    const route = this.route();
    return this.spellFor(route, this.explicitModel() ?? OLLAMA_CLOUD_DEFAULT_MODEL);
  }

  override async run(options: CliRunOptions): Promise<CliRunResult> {
    const route = this.route();
    if (route.transport === 'refused') {
      return { exitCode: 1, stdout: '', stderr: `Config error: ${route.reason}`, durationMs: 0 };
    }
    if (route.transport === 'local') {
      this.useLocal(route);
      const requested = options.model ?? this.explicitModel() ?? OLLAMA_CLOUD_DEFAULT_MODEL;
      return super.run({ ...options, model: toLocalTransportModel(requested) });
    }
    return this.runDirect(options, route.apiKey);
  }

  /**
   * The direct transport authenticates and leaves loopback, so it cannot reuse
   * the base class's request builder — that one refuses any non-loopback host
   * by design (support/approvedEgress.ts).
   */
  private async runDirect(options: CliRunOptions, directApiKey: string | undefined): Promise<CliRunResult> {
    const startTime = Date.now();

    if (!directApiKey) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Auth error: set OLLAMA_API_KEY for direct Ollama Cloud access, or unset OLLAMA_CLOUD_BASE_URL to use a signed-in local server.',
        durationMs: Date.now() - startTime,
      };
    }

    const model = toDirectTransportModel(options.model ?? this.explicitModel() ?? OLLAMA_CLOUD_DEFAULT_MODEL);
    const apiKey = directApiKey;
    const timeoutMs = options.timeoutMs ?? 300000;

    const callApi = async (messages: ChatMessage[], tools: ToolDefinition[]) => {
      const throttle: ThrottleState = { attempts: 0 };
      // One deadline per call, shared by every retry: a retried request must
      // not restart the clock the caller set.
      const deadline = abortSignalWithDeadline(options.signal, timeoutMs);
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.2,
        // Same ceiling as atlascloud/openrouter. Reasoning models stream their
        // thinking as `reasoning` deltas, which keep the stall guard satisfied;
        // without a cap a runaway think never ends (AGT-4534, run base4).
        // Ollama counts reasoning against it (finish_reason=length).
        max_tokens: OLLAMA_CLOUD_MAX_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
      };
      if (tools.length > 0) body.tools = tools;

      const attempt = async (): Promise<ChatCompletionLike> => {
        const request = prepareApprovedModelRequest(OLLAMA_CLOUD_CHAT_ENDPOINT, body);
        // A request that goes silent is abandoned after the idle window and
        // retried, rather than holding the stage until its whole budget runs out.
        const idleMs = this.options.streamIdleMs ?? OLLAMA_CLOUD_STREAM_IDLE_MS;
        const guard = createStallGuard(idleMs);
        const signal = deadline ? AbortSignal.any([deadline, guard.signal]) : guard.signal;
        const retryStall = async (err: unknown): Promise<ChatCompletionLike | undefined> => {
          const failure = guard.stalled() ? new StreamStallError(idleMs) : err;
          if (await resolveTransientFailure('ollama-cloud', { error: failure }, throttle, { signal: options.signal }) === 'retry') {
            return attempt();
          }
          return undefined;
        };
        let res: Response;
        try {
          res = await adapterFetch(request.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: request.body,
            signal,
          });
          guard.touch();
        } catch (err) {
          guard.clear();
          // Dropped socket or silent request before any response: bounded retry.
          const retried = await retryStall(err);
          if (retried) return retried;
          throw guard.stalled() ? new StreamStallError(idleMs) : err;
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          guard.clear();
          if (await resolveLimitResponse('ollama-cloud', res.status, res.headers, errText, throttle, { signal: options.signal }) === 'retry') {
            return attempt();
          }
          // 5xx: upstream blip, bounded retry before it becomes a task failure.
          if (await resolveTransientFailure('ollama-cloud', { status: res.status }, throttle, { signal: options.signal }) === 'retry') {
            return attempt();
          }
          throw new Error(`Ollama Cloud API error (${res.status}): ${errText.slice(0, 500)}`);
        }

        try {
          return await consumeChatCompletionsStream(res, options.onToken, guard.touch);
        } catch (err) {
          if (!guard.stalled()) throw err;
          guard.clear();
          const retried = await retryStall(err);
          if (retried) return retried;
          throw new StreamStallError(idleMs);
        } finally {
          guard.clear();
        }
      };

      return attempt();
    };

    // Resolving MCP tools CONNECTS: in read-only mode the cwd may be a checkout
    // under review whose config is attacker-authored. (INT-3189)
    const mcpTools = options.readOnly ? undefined : await resolveMcpTools(options.mcpTools);

    const loopOptions: AgenticLoopOptions = {
      systemPrompt: options.systemPrompt,
      prompt: options.prompt,
      cwd: options.cwd ?? process.cwd(),
      model,
      callApi,
      maxTurns: options.maxTurns ?? 15,
      timeoutMs,
      onLog: options.onLog,
      enableTools: options.enableTools ?? true,
      nudgeMaxOnNoEdit: options.nudgeMaxOnNoEdit,
      finishValidator: options.finishValidator,
      finishValidatorMaxRetries: options.finishValidatorMaxRetries,
      protectedFiles: options.protectedFiles,
      bashTimeoutMs: options.bashTimeoutMs,
      webTools: options.webTools,
      memoryTools: options.memoryTools,
      shellTools: options.shellTools,
      filesystemTools: options.filesystemTools,
      diagnosticsTool: options.diagnosticsTool,
      readOnly: options.readOnly,
      mcpTools,
      coordinationContext: options.coordinationContext,
      signal: options.signal,
      editFormat: options.editFormat,
      usageAttribution: {
        adapter: 'ollama-cloud',
        taskId: options.processContext?.taskId,
        stage: options.processContext?.stage,
      },
    };

    try {
      const result = await runAgenticLoop(loopOptions);
      options.onLog?.(`[Ollama Cloud] ${result.apiCallCount} API calls, ${result.toolCallCount} tool uses, ${result.totalTokens} tokens`);
      const cli = loopResultToCliResult(result);
      if (cli.costInfo) cli.costInfo.model = model;
      return cli;
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      if (isInfraError(err)) throw err;
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Ollama Cloud request failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private spellFor(route: OllamaCloudRoute, id: string): string {
    return route.transport === 'local' ? toLocalTransportModel(id) : toDirectTransportModel(id);
  }
}
