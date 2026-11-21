import { summarizeToolArgs } from './toolArgsSummary.js';
import { createHash } from 'node:crypto';
// ============================================
// OpenSwarm - Agentic Tool Loop
// Created: 2026-04-11
// Purpose: General-purpose agentic loop engine for the Codex/OpenRouter/Local adapters.
//          Based on the OpenAI function calling format.
//          Ported from the VEGA token_count.py pattern — token-based history compaction.
// ============================================

import { TOOL_DEFINITIONS, APPLY_PATCH_TOOL, executeToolCalls, createReadCache, isProtectedPath, validatePath, type ToolCall, type ToolResult, type ToolDefinition } from './tools.js';
import { DIAGNOSTICS_TOOL } from './diagnosticsTool.js';
import { WEB_TOOL_DEFINITIONS, webToolsBlockedByNetwork } from './webTools.js';
import { detectRateLimit, RateLimitError } from './rateLimitError.js';
import { isInfraError } from './errorClassification.js';
import { salvageFinalAnswer, repairFinalAnswerFormat, type FinalTurnContext } from './finalAnswerTurns.js';
import { parseSearchReplaceBlocks, applyEditBlock, type EditFormat } from '../support/editParser.js';
import type { CliRunResult, FinalAnswerRepair, FinishValidation } from './types.js';
import type { ChatUsage } from './chatStream.js';
import { recordUsage, type UsageAttribution } from '../support/usageLedger.js';
import { createSessionRecorder, type SessionRecorder } from '../support/sessionLog.js';
import { coordinationToolDefinitionsFor, type CoordinationToolContext } from '../coordination/coordinationTools.js';
import { filterHumanSurfaceMcpTools, isHumanSurfaceReadOnlyEnabled } from '../mcp/humanSurfacePolicy.js';
import { localDataNote } from './localDataNote.js';
import { SandboxExecutorClient } from '../sandboxExecutor/client.js';
import { getSandboxExecutorConfig } from '../sandboxExecutor/runtime.js';
import type { SandboxExecutorSession } from '../sandboxExecutor/protocol.js';
import { withMcpSessionScope } from '../mcp/mcpClient.js';

// ============ Token counting (ported from VEGA token_count.py) ============

// cl100k_base approximation: Korean 0.78t/char, English 0.27t/char
function countTokensApprox(text: string): number {
  if (!text) return 0;
  const hangul = [...text].filter(c => c >= '가' && c <= '힣').length;
  const korRatio = hangul / Math.max(1, text.length);
  const rate = 0.78 * korRatio + 0.27 * (1 - korRatio);
  return Math.ceil(text.length * rate);
}

function countMessageTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : '';
    total += countTokensApprox(content);
    total += 4; // role overhead
    if ('tool_calls' in m && m.tool_calls) {
      for (const tc of m.tool_calls) {
        total += countTokensApprox(tc.function.arguments) + countTokensApprox(tc.function.name) + 8;
      }
    }
  }
  return total;
}

// Tool result length limit: truncating too hard makes the model see only half a file and edit it wrongly.
// Keep generously for coding tasks (2500 chars); when exceeded, keep the first 1500 + last 700 chars.
function truncateToolResult(content: string, maxLen = 2500): string {
  if (content.length <= maxLen) return content;
  const head = content.slice(0, 1500);
  const tail = content.slice(-700);
  return `${head}\n...[${content.length - 2200} chars truncated]...\n${tail}`;
}

/**
 * One LIVE LOG line for a failed tool call. The previous `slice(0, 100)` cut an
 * ENOENT path off inside `/work/.../worktree/<uuid-prefix>`, which read as a
 * missing worktree rather than a missing file. Keep the error kind (head) and
 * the path/filename that identifies it (tail).
 */
export function formatToolErrorLog(content: string, maxLen = 240): string {
  if (content.length <= maxLen) return content;
  const head = 90;
  const tail = Math.max(40, maxLen - head - 1);
  return `${content.slice(0, head)}…${content.slice(-tail)}`;
}

// ============ Types ============

/** OpenAI Chat Completions API message format */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ApiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ApiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ApiToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: ChatUsage;
  /** Model id the provider reports serving (kept as runtime evidence). */
  model?: string;
}

/**
 * What a tool call executed, as validation evidence, or undefined. The tool
 * itself says what ran (`ToolResult.executed`): a bash command that ran to an
 * exit code — failing runs included, they are still evidence that validation
 * happened — or the checkers a diagnostics call used. Refused, blocked,
 * timed-out or empty calls ran nothing. (AGT-4534)
 */
export function observedCommandFor(
  _call: { function: { name: string; arguments: string } },
  result: { is_error?: boolean; executed?: string } | undefined,
): string | undefined {
  const executed = result?.executed?.trim();
  return executed || undefined;
}

/** Most recent observed commands kept per run. */
const OBSERVED_COMMAND_LIMIT = 20;

/**
 * Record an observed command, keeping the most recent ones: the check a worker
 * runs last must survive a long exploration that came before it.
 */
export function recordObservedCommand(list: string[], command: string): void {
  const existing = list.indexOf(command);
  if (existing !== -1) list.splice(existing, 1);
  list.push(command);
  if (list.length > OBSERVED_COMMAND_LIMIT) list.splice(0, list.length - OBSERVED_COMMAND_LIMIT);
}

/** Agentic loop configuration */
export interface AgenticLoopOptions {
  /** System prompt */
  systemPrompt?: string;
  /** User prompt (task instructions) */
  prompt: string;
  /** Project working directory (cwd for tool execution) */
  cwd: string;
  /** Model name */
  model: string;
  /** API call function (injected per adapter) */
  callApi: (messages: ChatMessage[], tools: ToolDefinition[]) => Promise<ChatCompletionResponse>;
  /**
   * Max tool-use turns (default: 20). `0` = no cap (UNBOUNDED_TURNS) — coding
   * phases end on wall-clock (timeoutMs), the repeated-call guard (NO_PROGRESS_LIMIT),
   * or the pipeline iteration cap, not on a turn count. (AGT-4388)
   */
  maxTurns?: number;
  /** Overall timeout (ms, default: 300000) */
  timeoutMs?: number;
  /** Real-time log callback */
  onLog?: (line: string) => void;
  /** Whether tool use is allowed (default: true) */
  enableTools?: boolean;
  /** Token-based compaction trigger threshold — fallback when the model window is unknown (default: 60000) */
  compactTokenThreshold?: number;
  /**
   * Advertised context window of `model`, when the adapter knows it (catalog
   * `context_length`). With it the compaction threshold is derived from the
   * window instead of the fixed fallback — see resolveCompactionThreshold. (AGT-4386)
   */
  contextWindowTokens?: number;
  /** Tokens the request must leave for the model's own output (adapter max_tokens; default 16384). */
  reservedOutputTokens?: number;
  /** A message count above this makes compaction a candidate (VEGA compact_threshold, default: 24) */
  compactAfterMessages?: number;
  /** Number of recent messages always kept verbatim on compaction (VEGA keep_recent, default: 8) */
  keepRecentMessages?: number;
  /**
   * No-edit termination guard for tasks that require edits. If the model tries to finish
   * with final text without ever using an edit/write tool, push back "you have not edited yet, continue" up to N times.
   * Blocks the pattern where lightweight models (gemini etc.) explore only and conclude early (found in the SWE hybrid).
   * Default 0 (disabled) — tasks without edits (diagnosis/analysis) are legitimate, so this is opt-in.
   */
  nudgeMaxOnNoEdit?: number;
  /**
   * Gate on the loop's finish itself, not just on whether it edited a file.
   * Called with the model's would-be final answer before the loop returns;
   * `{ ok: false, nudge }` appends the nudge as a new user turn and
   * `continue`s the SAME conversation instead of returning. This is what
   * lets a caller reject an insufficient answer (e.g. draftAnalyzer's hard
   * gate) without restarting a fresh `spawnCli` call, which used to throw
   * away the provider's warm KV-cache prefix on every retry — measured on
   * vela: the retry's first call landed at 0.3% cache against 95%+ for the
   * calls around it (AGT-4300). Bounded by `finishValidatorMaxRetries`.
   */
  finishValidator?: (finalText: string, attempt: number) => FinishValidation | Promise<FinishValidation>;
  /** Max times `finishValidator` may reject an answer before the loop gives up and returns it anyway. Default 0. */
  finishValidatorMaxRetries?: number;
  /** One tool-less same-conversation format repair of the final answer (AGT-4313). See FinalAnswerRepair. */
  finalAnswerRepair?: FinalAnswerRepair;
  /** Verification-harness files for which edit/write are refused (see tools.ts ToolExecOptions) */
  protectedFiles?: string[];
  /** OS fence for the bash tool — see ToolExecOptions.sandbox (AGT-4387). */
  sandbox?: 'on' | 'off';
  /** Refuse publication commands in bash — the pipeline publishes. (AGT-4418) */
  forbidPublication?: boolean;
  /** bash tool timeout — docker-based tests need minutes (default 30s) */
  bashTimeoutMs?: number;
  /** Expose web_fetch + web_search tools (default true). Disabled e.g. for SWE-bench integrity. */
  webTools?: boolean;
  /** Expose search_memory (default true). Disabled for isolated/temp repo benchmarks. */
  memoryTools?: boolean;
  /**
   * Declarative per-role tool scope (RoleConfig.tools), naming BUILT-IN tools.
   * `toolAllow` keeps only the names it lists; `toolDeny` then removes names from
   * what remains, a trailing `*` standing for a prefix (`scratch_*`). Both run over
   * the built-ins left by the readOnly/shell/web rules, so they only ever NARROW —
   * `allow` cannot resurrect `bash` on a readOnly run. MCP and coordination tools
   * keep their own flags; the narrowed set is also the dispatch allow-list.
   */
  toolAllow?: string[];
  toolDeny?: string[];
  /**
   * Run whose scratchpad `scratch_write`/`scratch_read` address (AGT-4459).
   * Absent means no scratchpad: the two tools are withheld from the model and
   * refused if it emits them anyway. Notes are the only thing an agent writes
   * to itself that survives an iteration boundary, so this is threaded from the
   * pipeline rather than derived here — a loop cannot know which run it serves.
   */
  scratchpadRunId?: string;
  memoryContext?: { taskId: string; iteration: number };
  /**
   * Expose the `bash` tool. Default true.
   *
   * `bash` is not path-confined the way the file tools are, so an agent that
   * must stay out of the working tree needs this off — an isolated `cwd` alone
   * does not stop `cd /repo && ...`.
   */
  shellTools?: boolean;
  /** Test/embedding seam; production resolves the attested configured client. */
  sandboxExecutorSessionFactory?: (cwd: string) => Promise<SandboxExecutorSession>;
  /** Expose built-in filesystem tools independently from MCP/coordination. */
  filesystemTools?: boolean;
  /** Read-only mode: hide mutation/shell tools and refuse response-text edits. */
  readOnly?: boolean;
  /** Expose the apply_patch (V4A) tool — codex adapters only (codex models are
   * RLHF-trained on V4A; non-codex models emit malformed V4A). Default false. */
  applyPatch?: boolean;
  /** Expose the inline `diagnostics` tool (project tsc/ruff inside the loop).
   * Spike opt-in while the uplift is being measured (INT-3105). Default false. */
  diagnosticsTool?: boolean;
  /** MCP tools (named `server__tool`) discovered from mcp.json, exposed alongside the native tools. */
  mcpTools?: ToolDefinition[];
  coordinationContext?: CoordinationToolContext;
  /** Abort the loop (checked each turn) — Esc/Ctrl+C in chat. */
  signal?: AbortSignal;
  /**
   * File-edit format matched to model capability (INT-1676). Default 'json'.
   * - 'json': keep the edit_file / apply_patch tools (frontier models).
   * - 'search-replace': hide those tools; parse Aider-style SEARCH/REPLACE blocks
   *   from the response text and apply them (much better for weaker models).
   * - 'whole-file': hide edit_file / apply_patch; the model rewrites via write_file.
   */
  editFormat?: EditFormat;
  /**
   * Who is spending: stamped on the usage-ledger record written for EVERY
   * API response, before any of the loop's throw paths. Adapter name is the
   * minimum; task/stage come from CliRunOptions.processContext. (AGT-4178)
   */
  usageAttribution?: UsageAttribution;
}

/** Loop execution result */
export interface AgenticLoopResult {
  /** Final text response */
  text: string;
  /** Number of tool calls used */
  toolCallCount: number;
  /** Total API calls */
  apiCallCount: number;
  /** Total token usage (when trackable) */
  totalTokens: number;
  /** Cumulative input (prompt) tokens — for separate in/out display in costInfo/logs (INT-2508) */
  inputTokens: number;
  /** Cumulative output (completion) tokens */
  outputTokens: number;
  /** Cumulative cache-hit input tokens (subset of totalTokens) — for measuring prompt-cache efficiency */
  cachedTokens: number;
  /** Sum of the provider's metered charges (USD) across calls that reported one. */
  costUsd: number;
  /** Calls that carried a metered price; 0 means the provider is unmetered. */
  meteredCalls: number;
  /** A blocking ask_human ended the run; the operator now owns the next step. */
  terminationCause?: 'no_progress';
  servedModels?: string[];
  blockedOnOperator?: boolean;
  /** Exact correlation IDs returned by the blocking ask_human tool call. */
  operatorQuestionCorrelationIds?: string[];
  /** A side-effecting sandbox RPC lost its authoritative result; quarantine. */
  executionOutcomeUnknown?: boolean;
  /** Elapsed time (ms) */
  durationMs: number;
  /** Shell commands the worker actually ran via the `bash` tool — ground truth
   *  for the validation-evidence gate (self-reported `commands` is often empty). */
  executedCommands: string[];
}

// ============ Agentic loop ============

/**
 * Apply a role's declarative `tools.allow` / `tools.deny` (RoleConfig) to the
 * built-in tools the readOnly / scratch / shell / web filters have already shaped.
 *
 * It runs LAST and only removes entries — an allow-list cannot resurrect a tool an
 * earlier rule withheld (a `bash` in `allow` stays hidden on a readOnly run), and
 * `deny` follows `allow`, so the two cannot contradict each other. A `deny` entry
 * ending in `*` matches by prefix (`scratch_*`), how the scratch tools are
 * addressed as a family.
 */
function applyRoleToolScope(
  tools: ToolDefinition[],
  toolAllow?: string[],
  toolDeny?: string[],
): ToolDefinition[] {
  let scoped = tools;
  if (toolAllow && toolAllow.length > 0) {
    const allowed = new Set(toolAllow);
    scoped = scoped.filter((tool) => allowed.has(tool.function.name));
  }
  return toolDeny && toolDeny.length > 0
    ? scoped.filter((tool) => !toolDeny.some((denied) => denied.endsWith('*')
        ? tool.function.name.startsWith(denied.slice(0, -1))
        : tool.function.name === denied))
    : scoped;
}

/**
 * Run the agentic tool loop
 *
 * Flow:
 * 1. Call the API with the prompt (including tool definitions)
 * 2. If the response has tool_calls → run the tools → append results to messages → back to 2
 * 3. If the response has no tool_calls (finish_reason = 'stop') → return the final text
 */
/**
 * Run one agent invocation, recording what it did.
 *
 * The record is opened here rather than inside the loop so that a thrown rate
 * limit, infra error or timeout still closes it. A loop that ends by throwing
 * is exactly the one whose transcript is worth reading (AGT-4442).
 */
export async function runAgenticLoop(options: AgenticLoopOptions): Promise<AgenticLoopResult> {
  const session = createSessionRecorder({
    taskId: options.usageAttribution?.taskId,
    stage: options.usageAttribution?.stage,
    adapter: options.usageAttribution?.adapter,
    model: options.model,
    cwd: options.cwd,
  });
  try {
    const result = await withMcpSessionScope(() => runAgenticLoopInner({ ...options, session }));
    session?.close({
      outcome: 'returned',
      toolCallCount: result.toolCallCount,
      apiCallCount: result.apiCallCount,
      totalTokens: result.totalTokens,
      costUsd: result.costUsd,
      text: result.text,
    });
    return result;
  } catch (error) {
    session?.close({
      outcome: 'threw',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    throw error;
  }
}

async function runAgenticLoopInner(
  options: AgenticLoopOptions & { session?: SessionRecorder },
): Promise<AgenticLoopResult> {
  const {
    systemPrompt,
    prompt,
    cwd,
    callApi,
    maxTurns = 20,
    timeoutMs = 300000,
    onLog,
    enableTools = true,
    // On long tasks (SWE-bench-grade real repos), if compaction fires too early/often the model loses the read
    // file context and keeps re-reading the same file without ever reaching an edit (endless exploration).
    // Set the threshold generously for modern model contexts (128k+) and widen the recent-keep block too.
    compactTokenThreshold = 60000,
    compactAfterMessages = 60,
    keepRecentMessages = 16,
    contextWindowTokens,
    reservedOutputTokens = DEFAULT_RESERVED_OUTPUT_TOKENS,
    nudgeMaxOnNoEdit = 0,
    finishValidator,
    finishValidatorMaxRetries = 0,
    finalAnswerRepair,
    protectedFiles,
    sandbox,
    forbidPublication,
    bashTimeoutMs,
    webTools = true,
    memoryTools = true,
    toolAllow,
    toolDeny,
    scratchpadRunId,
    shellTools: requestedShellTools = true,
    sandboxExecutorSessionFactory,
    filesystemTools = true,
    readOnly = false,
    applyPatch = false,
    diagnosticsTool: requestedDiagnosticsTool = false,
    mcpTools,
    coordinationContext,
    signal,
    editFormat = 'json',
    usageAttribution,
  } = options;

  // Strict mode exposes bash only after a separate companion has attested its
  // boot generation, loopback-only network, per-workspace mount namespace and
  // PID namespace. Missing socket or any mismatch leaves bash hidden.
  const strictHumanSurfaceBoundary = isHumanSurfaceReadOnlyEnabled();
  let sandboxExecutorSession: SandboxExecutorSession | undefined;
  if (strictHumanSurfaceBoundary && requestedShellTools && enableTools && filesystemTools && !readOnly) {
    try {
      if (sandboxExecutorSessionFactory) {
        sandboxExecutorSession = await sandboxExecutorSessionFactory(cwd);
      } else {
        const sandboxConfig = getSandboxExecutorConfig();
        if (sandboxConfig) sandboxExecutorSession = await new SandboxExecutorClient(sandboxConfig).createSession(cwd);
      }
    } catch (error) {
      onLog?.(`[Sandbox executor] shell unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const shellTools = requestedShellTools && (!strictHumanSurfaceBoundary || sandboxExecutorSession !== undefined);
  const diagnosticsTool = requestedDiagnosticsTool && !strictHumanSurfaceBoundary;

  const humanSurfaceFilteredMcp = filterHumanSurfaceMcpTools(mcpTools ?? []);
  for (const entry of humanSurfaceFilteredMcp.denied) {
    onLog?.(`[MCP policy] ${entry.name}: ${entry.reason}`);
  }

  const startTime = Date.now();
  const { wrapUpAt, softDeadline: deadline } = loopDeadlines(startTime, timeoutMs);
  let wrapUpNudged = false;

  // Build the message history
  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  // State the working root (cwd) explicitly — if the model does not know it, it guesses absolute paths like '/' or the repo name
  // and is blocked by path validation (access outside the project). This was the defect where search_files was
  // entirely blocked on real repos (pylint etc.; found in SWE-bench). Tools are told to use paths relative to this root.
  const cwdNote =
    `# Working directory\n` +
    `Your project root is: ${cwd}\n` +
    `All file tools operate within this root. Use paths relative to it (e.g. "src/foo.ts" or ".") ` +
    `or absolute paths under this root. Do NOT use "/" or a bare repo name — those are outside the project and will be rejected.\n` +
    (localDataNote(cwd, readOnly) || '\n');
  messages.push({ role: 'user', content: cwdNote + prompt });

  // Owned by the wrapper so every exit path — including a thrown rate limit
  // or infra error — still closes the record (AGT-4442).
  const session = options.session;
  session?.record({ type: 'notice', note: 'prompt', systemPrompt, prompt: cwdNote + prompt });

  // In search-replace / whole-file mode the model edits via response-text blocks
  // (S/R) or whole write_file calls, so the structured edit_file tool is hidden to
  // force that path; apply_patch is likewise suppressed (it's a structured edit). (INT-1676)
  const baseTools = !filesystemTools
    ? []
    : editFormat === 'json'
      ? TOOL_DEFINITIONS
      : TOOL_DEFINITIONS.filter(t => t.function.name !== 'edit_file');
  const memoryFilteredTools = memoryTools
    ? baseTools
    : baseTools.filter((t) => t.function.name !== 'search_memory');
  const scratchFilteredTools = scratchpadRunId
    ? memoryFilteredTools
    : memoryFilteredTools.filter((t) => !t.function.name.startsWith('scratch_') && t.function.name !== 'remember');
  const shellFilteredTools = shellTools
    ? scratchFilteredTools
    : scratchFilteredTools.filter((t) => t.function.name !== 'bash');
  const visibleBaseTools = readOnly
    ? shellFilteredTools.filter((t) => !['write_file', 'edit_file', 'bash', 'remember'].includes(t.function.name))
    : shellFilteredTools;
  const builtinTools = enableTools
    ? [
        ...visibleBaseTools,
        ...(filesystemTools && applyPatch && editFormat === 'json' && !readOnly ? [APPLY_PATCH_TOOL] : []),
        // Not in readOnly: it spawns compiler subprocesses, matching bash's exclusion.
        ...(filesystemTools && diagnosticsTool && !readOnly && shellTools ? [DIAGNOSTICS_TOOL] : []),
        // Also withheld in readOnly: the material under inspection is untrusted, and a fetch is an
        // outbound channel for anything the agent can read, the provider credential included (INT-3189).
        // Withheld under the loopback worker network too, which tools.ts also enforces (AGT-4815).
        ...(webTools && !readOnly && !webToolsBlockedByNetwork(sandbox) ? WEB_TOOL_DEFINITIONS : []),
      ]
    : [];
  // MCP and coordination tools keep their own flags; the role list names built-ins.
  // MCP is withheld in readOnly for the mirror reason: our memory server exposes
  // writes, so injected content could leave something behind. (INT-3189)
  const externalTools = enableTools
    ? [
        ...(readOnly ? [] : humanSurfaceFilteredMcp.tools),
        ...(readOnly || !coordinationContext ? [] : coordinationToolDefinitionsFor(coordinationContext)),
      ]
    : [];
  // The role's declared scope goes LAST, over the built-ins every rule above has
  // already shaped, so it intersects with them instead of overriding one — see
  // applyRoleToolScope. `allowedToolNames` below is built from the same result.
  const tools = [...applyRoleToolScope(builtinTools, toolAllow, toolDeny), ...externalTools];
  // The provider-visible schema is not an enforcement boundary. Carry the
  // exact same set into dispatch so a hidden tool call cannot reach a globally
  // registered MCP route (or another built-in withheld for this run).
  const allowedToolNames = new Set(tools.map((tool) => tool.function.name));
  const readCache = createReadCache(); // Per-loop read cache (blocks duplicate reads)
  const compaction = resolveCompactionThreshold(contextWindowTokens, {
    fallback: compactTokenThreshold,
    reservedOutputTokens,
  });
  const headerCount = systemPrompt ? 2 : 1; // system + first user, or just the first user
  onLog?.(
    compaction.source === 'window'
      ? `📐 Context window ${contextWindowTokens} tokens → compact at ${compaction.compactAt} (0.75 × usable)`
      : `📐 Context window unknown → compact at ${compaction.compactAt} (fallback)`,
  );
  let toolCallCount = 0;
  let editToolCount = 0; // Number of edit_file/write_file calls (for the no-edit guard)
  const executedCommands: string[] = []; // Commands actually run via the `bash` tool (ground truth for verification evidence)
  // Stall detection: if this turn's tool calls are all identical to before (name+args), it is a repeat with no new information or change.
  // N consecutive such turns are treated as a loop and end early — progress-based stopping, not a fixed turn limit
  // (a task cap). maxTurns remains only as an emergency ceiling.
  const servedModels = new Set<string>();
  let modelIdentityMissing = false;
  let blockedOnOperator = false;
  let terminationCause: 'no_progress' | undefined;
  const seenToolResults = new Set<string>();
  let executionOutcomeUnknown = false;
  const operatorQuestionCorrelationIds: string[] = [];
  let noProgressTurns = 0;
  const NO_PROGRESS_LIMIT = 3;
  // Two independent nudge budgets — they fire for different reasons and must NOT
  // share a counter. read-loop nudges (mid-loop, "stop reading and edit") used to
  // drain the same budget as the finish-turn no-edit guard, so a read-heavy run
  // could exhaust it and then slip past the guard, ending analysis-only. (INT-1925)
  let noEditNudgesUsed = 0;
  let readLoopNudgesUsed = 0;
  let finishValidatorRetriesUsed = 0;
  // AGT-4054: an operator or another agent can reach out mid-task without this
  // agent asking first — nothing else in the loop surfaces that unprompted, so
  // track how long it has been since coordination_read last actually consumed
  // the live inbox (turn 0 = "as if checked at the start") and nudge
  // periodically. coordination_history does NOT count — it searches the
  // permanent trace and consumes nothing (its own tool description says so),
  // so an agent could call it repeatedly and never see a newly addressed
  // message; only a real coordination_read proves the inbox was checked.
  let lastCoordinationCheckTurn = 0;
  // search-replace stall guard: consecutive finish-turns where S/R blocks were
  // present but ALL failed to apply. A model can re-emit the same non-matching
  // block forever, burning turns at full API cost — bail after a couple. (INT-1676)
  let srFailedTurns = 0;
  const SR_FAILED_LIMIT = 2;
  let apiCallCount = 0;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let meteredCalls = 0;
  let finalText = '';

  // Account for one response: accumulate the run totals AND write the ledger
  // line immediately. The ledger write comes first because everything after a
  // response — rate-limit re-throw, infra re-throw, the empty-final-answer
  // throw, or the process being killed — would otherwise erase the spend of
  // every call that already completed. (AGT-4178)
  const accountUsage = (usage: ChatUsage | undefined, callStartedAt: number, servedModel?: string): void => {
    if (servedModel) servedModels.add(servedModel); else modelIdentityMissing = true;
    if (!usage) return;
    const metered = typeof usage.cost === 'number';
    recordUsage({
      ts: new Date().toISOString(),
      adapter: usageAttribution?.adapter ?? 'unknown',
      model: options.model,
      ...(servedModel ? { servedModel } : {}),
      taskId: usageAttribution?.taskId,
      stage: usageAttribution?.stage,
      cwd,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      cachedTokens: usage.cached_tokens ?? 0,
      reasoningTokens: usage.reasoning_tokens ?? 0,
      costUsd: metered ? usage.cost! : null,
      ...(typeof usage.upstream_cost === 'number' ? { upstreamCostUsd: usage.upstream_cost } : {}),
      durationMs: Date.now() - callStartedAt,
    });
    totalTokens += usage.prompt_tokens + usage.completion_tokens;
    inputTokens += usage.prompt_tokens;
    outputTokens += usage.completion_tokens;
    cachedTokens += usage.cached_tokens ?? 0;
    if (metered) {
      costUsd += usage.cost!;
      meteredCalls += 1;
    }
  };

  // AGT-4388: a turn count is not a property of the task. With the cap the
  // workers on cgf-portal ended in "Step limit reached" after their analysis,
  // retried from a fresh context and did the analysis again — five times,
  // zero edits. `0` lifts the ceiling; the wall-clock deadline above, the
  // repeated-call guard and the pipeline's iteration cap remain.
  const turnCap = maxTurns > 0 ? maxTurns : Number.POSITIVE_INFINITY;
  for (let turn = 0; turn < turnCap + 1; turn++) {
    // User abort (Esc/Ctrl+C) — keep the current text if there is any, otherwise just mark it.
    if (signal?.aborted) {
      onLog?.('■ Stopped by user');
      finalText = finalText || '(stopped)';
      break;
    }

    // Timeout check
    if (Date.now() > deadline) {
      onLog?.(`⏰ Agentic loop timeout after ${turn} turns`);
      break;
    }
    // Wrap-up notice: the model learns the budget is nearly spent while it can
    // still act on it — commit the edits it has and answer — instead of being
    // cut mid-exploration and retried from scratch. Once per run. (AGT-4415)
    if (!wrapUpNudged && Date.now() > wrapUpAt) {
      wrapUpNudged = true;
      const minutesLeft = Math.max(1, Math.round((deadline - Date.now()) / 60_000));
      onLog?.(`⏳ Wrap-up notice: about ${minutesLeft} minute(s) of wall-clock budget left`);
      messages.push({ role: 'user', content: wrapUpNotice(minutesLeft) });
    }

    // History compaction — ported from the VEGA compaction.py pattern.
    // Trigger: only when the message count exceeds compactAfterMessages AND tokens exceed the threshold.
    // It used to compact unconditionally every turn from turn>=2, so the model immediately lost the files it had just read
    // and the task context and spun in place (loop recurrence). Now it compacts only when the history is really long, and even then
    // the most recent keepRecentMessages block stays verbatim.
    //
    // AGT-4386: the threshold is sized to the model's window when the adapter
    // knows it (0.75 × what the request can carry), and oversized old tool
    // outputs are trimmed first — cheaper than a whole-history summary and
    // it keeps the conversation shape, so the model does not re-read what
    // the summary would have flattened to "→ok".
    if (countMessageTokens(messages) > compaction.compactAt * TRIM_AT_FRACTION) {
      const trimmed = trimOversizedToolOutputs(messages, { maxTokens: TOOL_OUTPUT_TRIM_TOKENS, keepRecent: keepRecentMessages });
      if (trimmed > 0) {
        onLog?.(`✂ Trimmed ${trimmed} oversized tool output(s) older than the last ${keepRecentMessages} messages`);
        // Same premise as after compaction: a trimmed read_file body is no
        // longer "already in the conversation", so the stub cache must not
        // answer the re-read the trim marker invites. (INT-1929)
        readCache.store.clear();
      }
    }
    // A window-derived threshold is already the size signal; the message-count
    // gate only made sense for the fixed fallback (it stopped a 24-message
    // conversation with one huge file from compacting at once).
    const compactMessageGate = compaction.source === 'window' ? headerCount + keepRecentMessages : compactAfterMessages;
    if (messages.length > compactMessageGate) {
      const msgTokens = countMessageTokens(messages);
      if (msgTokens > compaction.compactAt) {
        onLog?.(`📦 Compacting history (${messages.length} msgs, ${msgTokens} tokens > ${compaction.compactAt})`);
        compactPriorTurns(messages, keepRecentMessages);
        // Compaction drops prior read content from the model's view, so the read
        // cache's premise ("content is already earlier in the conversation") no
        // longer holds — a stub re-read would leave the model without the file
        // contents it needs for edit_file's old_string. Clear it so the next
        // read returns full content again. (INT-1929)
        readCache.store.clear();
      }
    }

    // API call
    apiCallCount++;
    onLog?.(`▸ API call #${apiCallCount}${turn > 0 ? ` (tool turn ${turn})` : ''}`);

    let response: ChatCompletionResponse;
    const callStartedAt = Date.now();
    try {
      response = await callApi(messages, tools);
    } catch (err) {
      // User abort (Esc/Ctrl+C) surfaces as the fetch being aborted.
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        onLog?.('■ Stopped by user');
        finalText = finalText || '(stopped)';
        break;
      }
      // A 429/usage-limit raised by the in-process API caller (gpt/local/
      // openrouter/codex-responses) would otherwise be swallowed into finalText
      // here and returned as a normal result — the scheduler never learns it was
      // rate-limited. Re-throw it so it propagates up to the pipeline, which
      // pauses instead of failing/spamming. (INT-1906)
      //
      // The caller already throws a TYPED RateLimitError (codexResponses 429 →
      // rateLimitFromCodexHeaders). Preserve the type FIRST: its human-readable
      // message ("Codex 100% used of 300min window — resets at …") does NOT
      // contain the raw tokens detectRateLimit scans for, so stringifying it
      // silently downgraded a rate limit into a 2s empty "success" → 55%
      // confidence HALT → false STUCK. (INT-2519)
      if (err instanceof RateLimitError) {
        onLog?.(`■ ${err.message}`);
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const rl = detectRateLimit('', msg);
      if (rl) {
        onLog?.(`■ ${rl.message}`);
        throw rl;
      }
      // An infra/capacity failure (connection refused, 5xx, model not loaded,
      // socket drop) must ALSO propagate — the CLI path re-throws these via
      // worker.ts/reviewer.ts's isInfraError gate, but in-process adapters never
      // reach that gate because this catch used to swallow everything into a fake
      // exitCode:0 "success" → reviewer rejects the empty diff → false STUCK.
      // Re-throw here so it is classified as infra_error (backoff, not STUCK). (INT-2520)
      if (isInfraError(err)) {
        onLog?.(`✖ Infra error: ${msg}`);
        throw err;
      }
      onLog?.(`✖ API error: ${msg}`);
      // Swallowing an API error hands the caller a "result" whose entire body is an
      // error string. Downstream, parseReviewerResult finds no verdict in it and
      // reports "no parseable verdict", so the CLI blames the adapter and tells the
      // operator to check `codex exec`. The case that surfaced this was a 402
      // billing failure from an upstream BYOK provider: a payment problem presented
      // as a parser bug, across 14/14 audit areas.
      //
      // Swallow ONLY when this run has already caused a side effect worth keeping.
      // That is the property INT-2520 protects — a worker may have edited files or
      // run commands that throwing would discard — and `editToolCount` /
      // `executedCommands` state it directly. A turn counter does not: a read-only
      // run (reviewer, auditor, `openswarm review`) has no edit or bash tool at all,
      // so it can never acquire progress, yet a turn-based test would start
      // swallowing from its second call and reproduce the very misdiagnosis above
      // one turn later.
      //
      // The 'agentic-loop:' prefix is what makes propagation work. Returning a
      // plain error here would be re-swallowed by each in-process adapter's own
      // catch into `{exitCode: 1, stdout: ''}`, and spawnCli does not inspect
      // exitCode for adapters that implement run() — the empty stdout would reach
      // the parser and produce the same wrong message. The prefix matches
      // INFRA_ERROR_PATTERNS, so isInfraError re-throws it at every layer and the
      // real cause reaches the operator. (AGT-4215)
      if (editToolCount === 0 && executedCommands.length === 0) {
        throw new Error(`agentic-loop: API call failed with no work to preserve: ${msg}`, { cause: err });
      }
      finalText = `API error: ${msg}`;
      break;
    }

    accountUsage(response.usage, callStartedAt, response.model);

    const choice = response.choices?.[0];
    if (!choice) {
      onLog?.('✖ Empty response from API');
      finalText = 'Empty API response';
      break;
    }

    const assistantMsg = choice.message;
    // Recorded here, not in the tool-call branch below: a response that ends
    // the loop — or one the finish gate rejects and replays — is exactly what
    // an operator needs to read back, and that path never reaches the branch.
    session?.record({
      type: 'assistant',
      turn,
      content: assistantMsg.content ?? '',
      toolCalls: (assistantMsg.tool_calls ?? []).map((tc) => `${tc.function.name} ${tc.function.arguments}`),
    });

    // No tool calls means the final response
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      // SEARCH/REPLACE mode — edits come from S/R blocks in the response body, not from tool calls.
      // If blocks are present, apply them directly (protected files are rejected) and feed the result back to continue the loop. (INT-1676)
      if (!readOnly && editFormat === 'search-replace' && assistantMsg.content) {
        const parsed = parseSearchReplaceBlocks(assistantMsg.content);
        if (parsed.blocks.length > 0) {
          const resultLines = await Promise.all(parsed.blocks.map(async (block) => {
            // Containment + protection. applyEditBlock bypasses tools.ts guards, so
            // run the same cwd-containment check (rejects ../ escapes) and the
            // protectedFiles check here before touching disk.
            let resolved: string;
            try {
              resolved = validatePath(block.filePath, cwd);
            } catch {
              return `✗ ${block.filePath} — outside project root, rejected`;
            }
            if (isProtectedPath(resolved, protectedFiles)) {
              return `✗ ${block.filePath} — PROTECTED harness file, cannot modify`;
            }
            const r = await applyEditBlock(block, cwd);
            if (r.success) editToolCount++;
            return r.success ? `✓ Applied: ${block.filePath}` : `✗ Failed: ${block.filePath} — ${r.error}`;
          }));
          const failed = resultLines.filter(l => l.startsWith('✗')).length;
          const allFailed = failed === parsed.blocks.length;
          onLog?.(`📝 SEARCH/REPLACE: applied ${parsed.blocks.length - failed}/${parsed.blocks.length} block(s)`);

          // Stall guard: if every block failed for SR_FAILED_LIMIT turns running,
          // the model is stuck re-emitting non-matching blocks — stop. (INT-1676)
          srFailedTurns = allFailed ? srFailedTurns + 1 : 0;
          if (srFailedTurns >= SR_FAILED_LIMIT) {
            onLog?.(`■ SEARCH/REPLACE stalled: ${srFailedTurns} turns with no block applied — stopping`);
            finalText = assistantMsg.content;
            break;
          }

          messages.push({ role: 'assistant', content: assistantMsg.content });
          messages.push({
            role: 'user',
            content: `Edit results:\n${resultLines.join('\n')}\n\n${
              failed > 0
                ? 'Some edits failed — copy the SEARCH text VERBATIM from the file (exact whitespace) and retry.'
                : 'All edits applied. Verify the changes and finish when done.'
            }`,
          });
          continue;
        }
      }

      // No-edit termination guard — if the task requires edits but the model tries to finish without ever using edit/write,
      // push it back to continue (blocks the early-conclusion pattern of lightweight models).
      if (editToolCount === 0 && noEditNudgesUsed < nudgeMaxOnNoEdit) {
        noEditNudgesUsed++;
        onLog?.(`↩ No-edit guard: model tried to finish without editing (nudge ${noEditNudgesUsed}/${nudgeMaxOnNoEdit})`);
        const howToEdit = editFormat === 'search-replace'
          ? 'Apply the fix now using SEARCH/REPLACE blocks, then verify.'
          : editFormat === 'whole-file'
          ? 'Apply the fix now by rewriting the file with write_file, then verify.'
          : 'Apply the fix now with edit_file, then verify.';
        messages.push({ role: 'assistant', content: assistantMsg.content ?? '' });
        messages.push({
          role: 'user',
          content:
            'You have not modified any files yet, but this task REQUIRES code changes. ' +
            `Do not conclude with analysis only. ${howToEdit} ` +
            'Continue working.',
        });
        continue;
      }
      // A whitespace-only no-tools response is not a user-visible final answer.
      // Normalize it to empty so the final-answer recovery below retries instead
      // of returning an effectively blank success. (INT-2879)
      const content = assistantMsg.content;
      const candidateFinalText = typeof content === 'string' && content.trim() ? content : '';

      // Caller-side finish gate (AGT-4300). A rejected answer used to mean the
      // CALLER started a brand-new spawnCli conversation for the retry — cold
      // start, none of this session's warm cache. Rejecting HERE instead keeps
      // the same messages array and just appends another turn, the same way the
      // no-edit guard above does. Called on EVERY candidate, including the final
      // one after retries are exhausted, so a caller logging inside the
      // validator sees every attempt, not just the ones that got a retry.
      if (finishValidator) {
        const verdict = await finishValidator(candidateFinalText, finishValidatorRetriesUsed + 1);
        if (!verdict.ok && finishValidatorRetriesUsed < finishValidatorMaxRetries) {
          finishValidatorRetriesUsed++;
          onLog?.(
            `↩ Finish gate: answer rejected (retry ${finishValidatorRetriesUsed}/${finishValidatorMaxRetries})`,
          );
          messages.push({ role: 'assistant', content: assistantMsg.content ?? '' });
          messages.push({ role: 'user', content: verdict.nudge ?? 'That answer was not accepted. Try again.' });
          continue;
        }
        // Either accepted, or retries are exhausted — fall through and return
        // this candidate as-is rather than looping forever on a model that
        // never satisfies the gate.
      }
      finalText = candidateFinalText;
      break;
    }

    // Append the assistant message to the history (including tool_calls)
    messages.push({
      role: 'assistant',
      content: assistantMsg.content,
      tool_calls: assistantMsg.tool_calls,
    });
    // Run tools
    const toolCalls: ToolCall[] = assistantMsg.tool_calls.map(tc => ({
      id: tc.id,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    for (const tc of toolCalls) {
      try {
        const args = JSON.parse(tc.function.arguments);
        const argSummary = summarizeToolArgs(tc.function.name, args);
        onLog?.(`  🔧 ${tc.function.name}${argSummary ? ': ' + argSummary : ''}`);
      } catch {
        onLog?.(`  🔧 ${tc.function.name}`);
      }
    }

    const results: ToolResult[] = await executeToolCalls(toolCalls, cwd, readCache, {
      protectedFiles,
      sandbox,
      forbidPublication,
      bashTimeoutMs,
      readOnly,
      filesystemTools,
      allowedToolNames,
      coordinationContext,
      sandboxExecutorSession,
      loopDeadlineAt: Number.isFinite(deadline) ? deadline : undefined,
      scratchpadRunId,
      memoryContext: options.memoryContext,
    });
    toolCalls.forEach((tc, i) => {
      const result = results[i];
      session?.record({
        type: 'tool',
        turn,
        name: tc.function.name,
        arguments: tc.function.arguments,
        isError: result?.is_error ?? false,
        output: result?.content ?? '',
      });
    });
    toolCallCount += toolCalls.length;
    // Count only SUCCESSFUL edits — a model whose edit_file calls all fail
    // (old_string not found, protected file) has not modified anything, and
    // counting attempts would let it slip past the no-edit guard.
    editToolCount += toolCalls.filter((tc, i) =>
      (tc.function.name === 'edit_file' || tc.function.name === 'write_file' || tc.function.name === 'apply_patch') && !results[i]?.is_error,
    ).length;

    // AGT-4054: only a successful coordination_read resets the nudge clock —
    // coordination_history consumes nothing (it searches the permanent trace,
    // not the live inbox), so it must NOT count as "checked" or an agent could
    // satisfy the nudge forever without ever consuming a newly addressed
    // message. A reset here is otherwise indistinguishable from one caused by
    // the nudge firing itself (set below) — a check the model does on its own
    // looks the same either way.
    if (toolCalls.some((tc, i) => tc.function.name === 'coordination_read' && !results[i]?.is_error)) {
      lastCoordinationCheckTurn = turn;
    }

    // Capture the commands the worker actually ran (ground truth for the
    // validation-evidence gate — the model's self-reported `commands` is often
    // empty). Deduped, capped. (INT-2485, AGT-4534)
    toolCalls.forEach((tc, i) => {
      const cmd = observedCommandFor(tc, results[i]);
      if (cmd) recordObservedCommand(executedCommands, cmd);
    });

    // Progress-based stop: if every tool call this turn repeats a prior one
    // (same name+args → no new info or change), count it as a stalled turn.
    // N consecutive stalled turns → wrap up via the final-answer turn.
    const observed = toolCalls.map((call, index) => toolCallKey(call) + ':' + createHash('sha256')
      .update(JSON.stringify([results[index]?.content, results[index]?.is_error])).digest('hex'));
    // Preserve the inbox exemption for the whole turn: a repeated file read
    // must not hide newly received peer evidence in the same batch.
    const checkedInbox = toolCalls.some((call, index) => EXTERNALLY_CHANGING_TOOLS.has(call.function.name) && results[index] && !results[index].is_error);
    if (!checkedInbox && observed.length > 0 && observed.every((key) => seenToolResults.has(key))) {
      noProgressTurns++;
      if (noProgressTurns >= NO_PROGRESS_LIMIT) {
        terminationCause = 'no_progress';
        onLog?.(`⚠ No new progress for ${NO_PROGRESS_LIMIT} turns (repeated tool calls) — wrapping up`);
        break;
      }
    } else {
      noProgressTurns = 0;
    }
    for (const key of observed) seenToolResults.add(key);

    // Append the tool result to the messages (auto-truncated when too long)
    for (const result of results) {
      const content = truncateToolResult(result.content);
      messages.push({
        role: 'tool',
        tool_call_id: result.tool_call_id,
        content,
      });
      if (result.is_error) {
        onLog?.(`  ✖ ${formatToolErrorLog(content)}`);
      }
    }

    if (results.some((result) => result.fatal === 'execution_outcome_unknown')) {
      executionOutcomeUnknown = true;
      finalText = 'OUTCOME_UNKNOWN_DO_NOT_RETRY: sandbox command outcome requires operator inspection before this worktree can continue.';
      onLog?.('⛔ Sandbox command outcome unknown — quarantining this run without another model/tool turn');
      break;
    }

    // A blocking decision belongs to the operator, so end the run here rather
    // than trusting the model to honour the tool's instruction. Nothing after
    // this point can be decided without the answer, and continuing is how an
    // agent invents one.
    let blockingQuestion = -1;
    for (let i = 0; i < toolCalls.length; i += 1) {
      const tc = toolCalls[i];
      if (tc.function.name !== 'ask_human' || results[i]?.is_error) continue;
      try {
        const payload = JSON.parse(results[i].content) as { blocked?: boolean; correlationId?: unknown };
        if (payload.blocked !== true) continue;
        if (blockingQuestion < 0) blockingQuestion = i;
        if (typeof payload.correlationId === 'string' && payload.correlationId.trim()) {
          operatorQuestionCorrelationIds.push(payload.correlationId.trim());
        }
      } catch {
        // A malformed tool result cannot establish a durable blocking question.
      }
    }
    if (blockingQuestion >= 0) {
      blockedOnOperator = true;
      onLog?.('⏸ Blocking decision sent to the operator — stopping this run');
      messages.push({
        role: 'user',
        content:
          'That decision is the operator\'s to make and they have been asked. Stop now and '
          + 'report what you completed, the exact question you raised, and what stays blocked '
          + 'until it is answered. Do not answer it yourself and do not continue past it.',
      });
      break;
    }

    // Early read-loop nudge (ported from stranded feat/v0.7.0 8a1420f): a read-heavy
    // model can burn its whole budget reading/searching and never edit — the
    // finish-turn no-edit guard above never engages because it never tries to finish.
    // Fire DURING the loop at a fixed early turn so the model still has budget to edit.
    if (shouldNudgeReadLoop(editToolCount, readLoopNudgesUsed, nudgeMaxOnNoEdit, turn)) {
      readLoopNudgesUsed++;
      onLog?.(`↩ Read-loop nudge: turn ${turn}, no edits yet (nudge ${readLoopNudgesUsed}/${nudgeMaxOnNoEdit})`);
      messages.push({
        role: 'user',
        content:
          'You have spent several turns reading/searching with ZERO edits. You have enough ' +
          'context now — STOP reading and apply the fix with edit_file immediately, then verify. ' +
          'Do not read more files unless an edit actually fails.',
      });
    }

    // AGT-4054: an operator or another agent can message this agent mid-task
    // without it asking first (unlike ask_human, which the agent itself
    // initiates) — nothing else here surfaces that, so nudge periodically.
    // Not readOnly-gated here: coordination tools are already withheld from
    // `tools` when readOnly or !coordinationContext, so a nudge in that case
    // would just get ignored — but skip it anyway to avoid a pointless turn.
    const turnsSinceCoordinationCheck = turn - lastCoordinationCheckTurn;
    if (!readOnly && shouldNudgeCoordinationCheck(Boolean(coordinationContext), turnsSinceCoordinationCheck)) {
      onLog?.(`↩ Coordination-inbox nudge: turn ${turn}, ${turnsSinceCoordinationCheck} turns since last check`);
      // Treat the nudge itself as a check for spacing purposes — the model
      // gets a fresh window either way, whether it heeds this one or not.
      lastCoordinationCheckTurn = turn;
      messages.push({
        role: 'user',
        content: COORDINATION_CHECK_NUDGE_PROMPT,
      });
    }
  }

  // Post-loop tool-less turns: salvage a missing final answer (INT-1442,
  // INT-2879, AGT-4450), then one format repair if the caller cannot read it
  // (AGT-4313). Both live in finalAnswerTurns.ts.
  const finalTurns: FinalTurnContext = {
    messages, callApi, session, onLog,
    onCall: (usage, startedAt, model) => { accountUsage(usage, startedAt, model); apiCallCount++; },
  };
  if (!finalText && apiCallCount > 0) finalText = await salvageFinalAnswer(finalTurns, finalAnswerRepair);
  finalText = await repairFinalAnswerFormat(finalTurns, finalText, signal?.aborted ? undefined : finalAnswerRepair);

  return {
    text: finalText,
    toolCallCount,
    apiCallCount,
    totalTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    costUsd,
    meteredCalls,
    durationMs: Date.now() - startTime,
    executedCommands,
    terminationCause,
    servedModels: !modelIdentityMissing && servedModels.size ? [...servedModels] : undefined,
    blockedOnOperator,
    executionOutcomeUnknown,
    operatorQuestionCorrelationIds: operatorQuestionCorrelationIds.length > 0
      ? [...new Set(operatorQuestionCorrelationIds)]
      : undefined,
  };
}

/**
 * AgenticLoopResult → CliRunResult conversion
 *
 * costUsd is the provider's own metered charge summed over the run (OpenRouter
 * prices every response); it stays 0 for unmetered providers — codex-responses
 * bills through a ChatGPT subscription and local models have no marginal cost —
 * because the loop keeps no price table (it would go stale). Tokens and
 * duration are real measurements either way. (INT-2508, AGT-4178)
 */
/** `maxTurns` value that means "no turn ceiling" (AGT-4388). */
export const UNBOUNDED_TURNS = 0;

/**
 * Wall-clock shaping for a run of `timeoutMs` (AGT-4415).
 *
 * The adapter wrapper (base.ts) aborts the whole run at `start + timeoutMs`,
 * hard. The loop used to check the SAME instant, so its own timeout path — the
 * final-answer turn that turns a cut-off run into a result with a summary —
 * could never execute: whichever turn was in flight at T was killed, and the
 * attempt failed as `openrouter timeout after 1200000ms`. Measured on the run
 * ledger: 37 such attempts in 24 h, 17 issues, up to attempt #176.
 *
 * - `softDeadline`: where the loop stops calling tools, `headroom` before the
 *   hard abort so the salvage turn has time to run.
 * - `wrapUpAt`: where the model is told how much budget is left, `notice`
 *   before the soft deadline, so it can commit and answer on its own.
 *
 * Both scale with the budget and are clamped so a short review run is not
 * eaten by its own margins.
 */
export function loopDeadlines(startTime: number, timeoutMs: number): { wrapUpAt: number; softDeadline: number } {
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
    return { wrapUpAt: Number.POSITIVE_INFINITY, softDeadline: Number.POSITIVE_INFINITY };
  }
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  const headroom = Math.min(clamp(timeoutMs * 0.1, 30_000, 120_000), timeoutMs / 2);
  const notice = Math.min(clamp(timeoutMs * 0.15, 60_000, 180_000), timeoutMs / 4);
  const softDeadline = startTime + timeoutMs - headroom;
  return { wrapUpAt: softDeadline - notice, softDeadline };
}

/** The message injected at `wrapUpAt` (AGT-4415). */
export function wrapUpNotice(minutesLeft: number): string {
  return `About ${minutesLeft} minute(s) of wall-clock budget remain for this run. Stop exploring now: `
    + 'apply the edits you already know you need, run the single quickest relevant check, and then write '
    + 'your final answer in the format the task asked for. Unfinished parts go in the answer as an explicit list, '
    + 'not into more tool calls.';
}

export function loopResultToCliResult(result: AgenticLoopResult): CliRunResult {
  return {
    exitCode: 0,
    stdout: result.text,
    stderr: '',
    durationMs: result.durationMs,
    executedCommands: result.executedCommands,
    terminationCause: result.terminationCause,
    blockedOnOperator: result.blockedOnOperator,
    executionOutcomeUnknown: result.executionOutcomeUnknown,
    operatorQuestionCorrelationIds: result.operatorQuestionCorrelationIds,
    costInfo: {
      costUsd: result.costUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cachedTokens,
      cacheCreationTokens: 0,
      durationMs: result.durationMs,
      servedModels: result.servedModels,
    },
  };
}

/** Stable key for a tool call (name + args) — used to detect repeated calls. */
export function toolCallKey(tc: ToolCall): string {
  return `${tc.function.name}:${tc.function.arguments}`;
}

/**
 * Tools whose answer changes without this agent doing anything.
 *
 * `same name+args` is a good stall signal for a tool that reads the agent's own
 * workspace, and a bad one for a tool that reads an inbox: `coordination_read`
 * takes no parameters at all, so every check produces an identical key and
 * three checks of a quiet inbox looked exactly like a stalled model. An agent
 * that waited for a reply was killed for waiting. (AGT-4065)
 *
 * The loop is still bounded — `maxTurns` and the wall-clock deadline both
 * still apply — so exempting these cannot produce an unbounded run.
 */
const EXTERNALLY_CHANGING_TOOLS: ReadonlySet<string> = new Set([
  'coordination_read',
  'coordination_wait',
]);

/**
 * True when every tool call this turn was already seen (same name+args), i.e.
 * pure repetition with no new info or change — a stalled turn. Empty turns are
 * not stalls (the model produced no tool calls, which ends the loop normally),
 * and neither is a turn that checked something only the outside world can
 * change.
 */
export function allToolCallsSeen(toolCalls: ToolCall[], seen: Set<string>): boolean {
  if (toolCalls.length === 0) return false;
  if (toolCalls.some((tc) => EXTERNALLY_CHANGING_TOOLS.has(tc.function.name))) return false;
  return toolCalls.every((tc) => seen.has(toolCallKey(tc)));
}

/**
 * Fixed early turn after which a read-heavy worker with zero edits gets nudged to
 * act. Ported from stranded feat/v0.7.0 (8a1420f): the old guard fired at
 * maxTurns-2 (too late). Fire EARLY so the model still has budget to apply edits.
 */
export const READ_LOOP_NUDGE_AT = 6;

/** True when a worker has read/searched past the early budget with no edits yet. */
export function shouldNudgeReadLoop(
  editToolCount: number,
  nudgesUsed: number,
  nudgeMax: number,
  turn: number,
): boolean {
  return editToolCount === 0 && nudgesUsed < nudgeMax && turn >= READ_LOOP_NUDGE_AT;
}

/**
 * How often a coordination-enabled agent gets nudged to check its inbox when
 * it hasn't checked on its own. Matches READ_LOOP_NUDGE_AT's cadence — the
 * same turn budget this loop is already tuned around. Unlike the read-loop
 * nudge, this repeats (not capped by a nudge-count budget): a long task
 * should get checked in on more than once, and an agent already checking on
 * its own never triggers it, since its own calls reset the clock. (AGT-4054)
 */
export const COORDINATION_CHECK_NUDGE_EVERY = 6;

/** Conditional reminder: checking is periodic, consulting is never automatic fan-out. */
export const COORDINATION_CHECK_NUDGE_PROMPT =
  'It has been a while since you checked your coordination inbox. Call coordination_read ' +
  'now to see if the operator or another agent sent anything. Respond once to an actionable ' +
  'message. Only if your current work has a concrete dependency, file/PR conflict, or ownership ' +
  'ambiguity, use coordination_peers (limit 3), then related/following durable threads, and send ' +
  'one targeted request. With no actionable ambiguity or no suitable peer, send nothing and ' +
  'continue; never fan out routine status and never park waiting for a peer.';

/** True when a coordination-enabled agent has gone too long without checking its inbox. */
export function shouldNudgeCoordinationCheck(
  hasCoordinationContext: boolean,
  turnsSinceLastCheck: number,
): boolean {
  return hasCoordinationContext && turnsSinceLastCheck >= COORDINATION_CHECK_NUDGE_EVERY;
}

// ============ History compaction (ported from the VEGA compaction.py pattern) ============

/**
 * Replace earlier turns (assistant+tool pairs) with a one-line summary.
 * OpenAI API constraint: a tool message must match the tool_call_id of the preceding assistant, so
 * old assistant+tool pairs are replaced with a text summary to avoid API errors.
 *
 * Retention rule (VEGA keep_recent): the most recent keepRecent message block is always kept verbatim.
 * Because a tool message must pair with the preceding assistant tool_call_id, the retention boundary is
 * aligned to the first assistant after the keepRecent point so no orphaned tool message is left.
 * If an existing [Prior turns compacted] summary is present, merge it into the new summary and replace it.
 * (Exported for tests — nothing outside calls it directly)
 */
/** What the adapters ask for as max_tokens; the request must leave this much of the window free. */
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 16384;
/** Compact when history reaches this share of what the request can carry (VEGA 0.75; ori 0.8). */
export const COMPACT_AT_FRACTION = 0.75;
/** Start trimming old tool outputs at this share of the compaction threshold. */
export const TRIM_AT_FRACTION = 0.5;
/** A tool output older than the recent window and larger than this is trimmed to a marker. */
export const TOOL_OUTPUT_TRIM_TOKENS = 2000;
/** Never derive a threshold below this — a smaller one would compact every turn. */
export const MIN_COMPACT_AT = 4096;
/** Cost and attention guard: even a 1M window does not get a 750k history. */
export const MAX_COMPACT_AT = 200_000;

export interface CompactionThreshold {
  compactAt: number;
  source: 'window' | 'fallback';
}

/**
 * Size the compaction threshold to the model's window when it is known.
 *
 * `0.75 × (window − reservedOutput)`, clamped to [MIN_COMPACT_AT, MAX_COMPACT_AT].
 * Unknown window → the fixed fallback (today's 60k), so a provider that does
 * not advertise `context_length` behaves exactly as before. A 32k model gets
 * 12k and is protected for the first time; a 262k model gets 184k instead of
 * being summarised at 60k and re-reading what it lost. (AGT-4386)
 */
export function resolveCompactionThreshold(
  contextWindowTokens: number | undefined,
  opts: { fallback: number; reservedOutputTokens?: number },
): CompactionThreshold {
  if (!Number.isFinite(contextWindowTokens) || (contextWindowTokens as number) <= 0) {
    return { compactAt: opts.fallback, source: 'fallback' };
  }
  const reserved = opts.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
  const usable = Math.max(0, (contextWindowTokens as number) - reserved);
  const derived = Math.floor(usable * COMPACT_AT_FRACTION);
  return { compactAt: Math.min(MAX_COMPACT_AT, Math.max(MIN_COMPACT_AT, derived)), source: 'window' };
}

const TRIM_MARKER_PREFIX = '[tool output trimmed:';

/**
 * Replace oversized tool outputs older than the last `keepRecent` messages
 * with a short marker that names the tool and invites a re-read. Assistant
 * text, tool calls and small outputs stay verbatim, so the conversation keeps
 * its shape; only the bulk goes. Returns how many outputs were trimmed.
 * Idempotent: an already-trimmed message is never touched again. (AGT-4386)
 */
export function trimOversizedToolOutputs(
  messages: ChatMessage[],
  opts: { maxTokens: number; keepRecent: number },
): number {
  const headerCount = messages[0]?.role === 'system' ? 2 : 1;
  const boundary = messages.length - opts.keepRecent;
  if (boundary <= headerCount) return 0;

  // tool_call_id → tool name, from the assistant turns that issued them.
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) toolNames.set(tc.id, tc.function.name);
    }
  }

  let trimmed = 0;
  for (let i = headerCount; i < boundary; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || typeof m.content !== 'string') continue;
    if (m.content.startsWith(TRIM_MARKER_PREFIX)) continue;
    const tokens = countTokensApprox(m.content);
    if (tokens <= opts.maxTokens) continue;
    const name = toolNames.get(m.tool_call_id) ?? 'tool';
    m.content = `${TRIM_MARKER_PREFIX} ~${tokens} tokens from "${name}". Read it again if you still need it.]`;
    trimmed++;
  }
  return trimmed;
}

export function compactPriorTurns(messages: ChatMessage[], keepRecent = 8): void {
  const headerCount = messages[0]?.role === 'system' ? 2 : 1;

  // Keep the most recent keepRecent messages — compute the upper-bound index for compaction
  const desired = Math.max(headerCount, messages.length - keepRecent);
  // Align the retention boundary to an assistant start (avoids orphan tool messages)
  let boundary = desired;
  while (boundary < messages.length && messages[boundary].role === 'tool') {
    boundary++;
  }
  // Walking forward runs off the end when the most recent turn made more tool
  // calls than keepRecent: the tail is then entirely tool messages, the
  // boundary lands at messages.length, and the compaction range covers the
  // whole history — including the results that had just arrived, which the
  // model then no longer has. Fall back to walking backwards to the assistant
  // those trailing tools belong to, so that turn is preserved whole.
  if (boundary >= messages.length) {
    boundary = desired;
    while (boundary > headerCount && messages[boundary].role === 'tool') {
      boundary--;
    }
  }
  if (boundary <= headerCount) return;

  const summaryParts: string[] = [];
  const toRemove: number[] = [];

  for (let i = headerCount; i < boundary; i++) {
    const msg = messages[i];

    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const calls = msg.tool_calls.map(tc => {
          try {
            const args = JSON.parse(tc.function.arguments);
            const key = args.path || args.pattern || args.command;
            const short = typeof key === 'string' ? key.slice(0, 40) : '';
            return `${tc.function.name}(${short})`;
          } catch {
            return tc.function.name;
          }
        });
        summaryParts.push(calls.join(', '));
      } else {
        // If it is an existing compacted summary, absorb its content as-is; otherwise keep the assistant explanatory text
        const text = (msg.content ?? '').trim();
        if (text) summaryParts.push(text.startsWith('[Prior') ? text : `note: ${text.slice(0, 200)}`);
      }
      toRemove.push(i);
    } else if (msg.role === 'tool') {
      const ok = !msg.content.startsWith('BLOCKED') && !msg.content.startsWith('Tool error');
      const firstLine = msg.content.split('\n')[0].slice(0, 50);
      summaryParts.push(ok ? '→ok' : `→err: ${firstLine}`);
      toRemove.push(i);
    }
  }

  if (toRemove.length === 0) return;

  const summaryText = `[Prior turns compacted] ${summaryParts.join(' | ')}`;

  for (let i = toRemove.length - 1; i >= 0; i--) {
    messages.splice(toRemove[i], 1);
  }

  messages.splice(headerCount, 0, {
    role: 'assistant',
    content: summaryText,
  });
}
