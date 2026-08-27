// ============================================
// OpenSwarm - CLI Adapter Types
// Interface definitions for CLI tool adapters
// ============================================

import type { WorkerResult, ReviewResult } from '../agents/agentPair.js';
import type { ToolDefinition } from './tools.js';
import type { CostInfo } from '../support/costTracker.js';

// Re-export for convenience
export type { WorkerResult, ReviewResult };

export type AdapterName = 'codex' | 'codex-responses' | 'gpt' | 'local' | 'lmstudio' | 'openrouter' | 'atlascloud' | 'claude';

/**
 * Raw result from a CLI process execution
 */
export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /**
   * Shell commands the worker actually ran (OpenSwarm's own agentic loop executes
   * the `bash` tool, so it is ground truth — unlike the model's self-reported
   * `commands`, which is frequently empty). Adapters that run their own loop
   * populate this; parseWorkerOutput merges it into WorkerResult.commands so the
   * validation-evidence gate and reviewers see the real checks. (INT-2485)
   */
  executedCommands?: string[];
  /**
   * Token/duration usage measured by the adapter's own loop (codex-responses,
   * gpt, …). parseWorkerOutput/parseReviewerOutput attach it to the stage result
   * so the pipeline's per-stage cost logs and totals work on every provider,
   * not just the claude CLI. costUsd stays 0 for subscription-billed providers. (INT-2508)
   */
  costInfo?: CostInfo;
}

/**
 * Context for process registry tracking
 */
export interface ProcessContext {
  taskId: string;
  stage: string;
}

/**
 * Options for running a CLI adapter
 */
export interface CliRunOptions {
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  model?: string;
  maxTurns?: number;
  onLog?: (line: string) => void;
  processContext?: ProcessContext;
  /** 시스템 프롬프트 (GPT/Local 에이전틱 루프에서 사용) */
  systemPrompt?: string;
  /**
   * 추론(reasoning) 토큰 비활성화 요청 (OpenRouter). 기계적 실행 역할(worker 등)은
   * 추론이 불필요하므로 토큰 낭비를 막는다. 모델이 추론 강제(thinking 전용)면
   * OpenRouter가 거부할 수 있으나, 그런 모델은 경량 역할에 쓰지 않는다.
   */
  disableReasoning?: boolean;
  /**
   * Reasoning effort for the model's thinking (codex-responses: low|medium|high).
   * Set from a jobProfile's `effort` so heavy tasks reason harder. Overrides the
   * disableReasoning default when present. Adapters that don't support it ignore it.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * 수정 필수 작업의 no-edit 종료 가드 횟수 (agenticLoop). 모델이 edit/write 없이
   * 끝내려 하면 N회까지 되민다. 기본 0(비활성).
   */
  nudgeMaxOnNoEdit?: number;
  /**
   * Verification-harness file protection (agenticLoop → tools). Files in this
   * list reject edit_file/write_file — prevents the model from suspecting and
   * rewriting the verification script when tests fail.
   */
  protectedFiles?: string[];
  /** bash tool timeout in ms (default 30s). Raise for docker-based tests that take minutes. */
  bashTimeoutMs?: number;
  /** Expose web_fetch + web_search tools (default true). Set false for SWE-bench integrity. */
  webTools?: boolean;
  /** Expose repository memory search (default true). Set false for isolated/temp repo benchmarks. */
  memoryTools?: boolean;
  /** Expose the inline `diagnostics` tool (project tsc/ruff inside the loop). Spike opt-in (INT-3105). */
  diagnosticsTool?: boolean;
  /** Enforce read-only tool exposure/execution where the adapter supports OpenSwarm's tool layer. */
  readOnly?: boolean;
  /**
   * Expose the file/bash tool set to the agentic loop. Defaults to each adapter's
   * normal behavior (usually on). Set false for plain conversational completion
   * (the chat CLI) so the model answers directly instead of running tools.
   */
  enableTools?: boolean;
  /**
   * Streaming token callback. Adapters that stream (e.g. codex-responses over the
   * Responses API) invoke this with each text delta as it arrives, so the chat
   * TUI can render tokens live instead of waiting for the full reply. Adapters
   * that don't stream simply ignore it.
   */
  onToken?: (delta: string) => void;
  /** MCP tools (named `server__tool`) to expose to the agentic loop, from mcp.json. */
  mcpTools?: ToolDefinition[];
  /** Abort the run (and in-flight API/stream) — e.g. Esc/Ctrl+C in chat. */
  signal?: AbortSignal;
  /**
   * File-edit format matched to model capability (INT-1676). Only the in-process
   * adapters (gpt/local/openrouter/codex-responses) act on it via the agentic
   * loop; the external-CLI adapters (claude/codex) ignore it. Defaults to 'json'.
   * - 'json': edit_file / apply_patch tool calls.
   * - 'search-replace': Aider-style blocks in response text (weaker models).
   * - 'whole-file': write_file rewrites only.
   */
  editFormat?: 'json' | 'search-replace' | 'whole-file';
}

/**
 * Describes what a CLI adapter can do
 */
export interface AdapterCapabilities {
  supportsStreaming: boolean;
  supportsJsonOutput: boolean;
  supportsModelSelection: boolean;
  managedGit: boolean;
  supportedSkills: string[];
  /**
   * This adapter actually denies mutating tools when `CliRunOptions.readOnly` is
   * set. Optional, and absent means "cannot enforce": `spawnCli` refuses a
   * read-only run on such an adapter rather than executing it with full tool
   * access. A caller asking for read-only is usually doing so because the input
   * is untrusted, and a flag that quietly does nothing there is worse than no
   * flag at all. (INT-3189)
   */
  enforcesReadOnly?: boolean;
}

export interface CliCommandSpec {
  command: string;
  args: string[];
  /** Feed this file to child stdin without involving a shell or argv. */
  stdinFile?: string;
  /** Adapter-owned temporary paths removed after the child settles. */
  cleanupPaths?: string[];
}

/**
 * CLI adapter interface — all adapters must implement this
 */
export interface CliAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;

  /** Check if the CLI tool is installed and available */
  isAvailable(): Promise<boolean>;

  /**
   * The provider's default model, resolved dynamically — from the provider's
   * live model list where one is exposed (codex backend, local /v1/models),
   * else the adapter's own provider-appropriate default. Used when no explicit
   * model is configured, so callers never hardcode a (possibly wrong-provider
   * or stale) model id.
   */
  getDefaultModel(): Promise<string>;

  /**
   * The provider's model catalog, when it can be discovered (a `/v1/models`
   * endpoint, a CLI cache, a local server). Omitted by adapters that cannot list
   * models — CLI-delegated ones such as `claude`, whose alias defaults are
   * resolved downstream and therefore never go stale, and providers whose
   * credentials lack the model-read scope.
   *
   * Declared here rather than duck-typed at the call site so a new adapter that
   * can list models is a visible omission instead of a silent one.
   */
  listModels?(): Promise<string[]>;

  /** Build an executable + argv. Shell interpretation is never applied. */
  buildCommand(options: CliRunOptions): CliCommandSpec | Promise<CliCommandSpec>;

  /**
   * Parse incremental stdout chunks for live log streaming.
   * Returns the trailing incomplete buffer to carry into the next chunk.
   */
  parseStreamingChunk?(
    chunk: string,
    onLog: (line: string) => void,
    buffer?: string,
  ): string;

  /**
   * Optional direct execution (bypasses spawnCli shell spawn).
   * Used by adapters that call APIs directly instead of spawning a CLI process.
   */
  run?(options: CliRunOptions): Promise<CliRunResult>;

  /** Parse raw CLI output into a WorkerResult */
  parseWorkerOutput(raw: CliRunResult): WorkerResult;

  /** Parse raw CLI output into a ReviewResult */
  parseReviewerOutput(raw: CliRunResult): ReviewResult;
}
