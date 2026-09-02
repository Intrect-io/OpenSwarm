// ============================================
// OpenSwarm - Agentic Tool Loop
// Created: 2026-04-11
// Purpose: Codex/OpenRouter/Local 어댑터용 범용 에이전틱 루프 엔진.
//          OpenAI function calling 포맷 기반.
//          VEGA token_count.py 패턴 이식 — 토큰 기반 히스토리 압축.
// ============================================

import { TOOL_DEFINITIONS, APPLY_PATCH_TOOL, executeToolCalls, createReadCache, isProtectedPath, validatePath, type ToolCall, type ToolResult, type ToolDefinition } from './tools.js';
import { DIAGNOSTICS_TOOL } from './diagnosticsTool.js';
import { WEB_TOOL_DEFINITIONS } from './webTools.js';
import { detectRateLimit, RateLimitError } from './rateLimitError.js';
import { isInfraError } from './errorClassification.js';
import { parseSearchReplaceBlocks, applyEditBlock, type EditFormat } from '../support/editParser.js';
import type { CliRunResult } from './types.js';
import { COORDINATION_TOOL_DEFINITIONS, type CoordinationToolContext } from '../coordination/coordinationTools.js';
import { filterHumanSurfaceMcpTools, isHumanSurfaceReadOnlyEnabled } from '../mcp/humanSurfacePolicy.js';
import { SandboxExecutorClient } from '../sandboxExecutor/client.js';
import { getSandboxExecutorConfig } from '../sandboxExecutor/runtime.js';
import type { SandboxExecutorSession } from '../sandboxExecutor/protocol.js';

// ============ 토큰 카운팅 (VEGA token_count.py 이식) ============

// cl100k_base 근사: 한국어 0.78t/char, 영어 0.27t/char
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

// 도구 결과 길이 제한: 너무 작게 자르면 모델이 파일 절반만 보고 잘못 수정한다.
// 코딩 작업에 맞춰 넉넉히 보존(2500자), 초과 시 앞 1500 + 뒤 700자 유지.
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

// ============ 타입 ============

/** OpenAI Chat Completions API 메시지 포맷 */
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
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** Cached input tokens (prompt-cache hits). Subset of prompt_tokens. */
    cached_tokens?: number;
  };
}

/** 에이전틱 루프 설정 */
export interface AgenticLoopOptions {
  /** 시스템 프롬프트 */
  systemPrompt?: string;
  /** 사용자 프롬프트 (작업 지시) */
  prompt: string;
  /** 프로젝트 작업 디렉토리 (도구 실행 cwd) */
  cwd: string;
  /** 모델명 */
  model: string;
  /** API 호출 함수 (어댑터별로 주입) */
  callApi: (messages: ChatMessage[], tools: ToolDefinition[]) => Promise<ChatCompletionResponse>;
  /** 최대 도구 사용 턴 수 (기본: 20) */
  maxTurns?: number;
  /** 전체 타임아웃 (ms, 기본: 300000) */
  timeoutMs?: number;
  /** 실시간 로그 콜백 */
  onLog?: (line: string) => void;
  /** 도구 사용 허용 여부 (기본: true) */
  enableTools?: boolean;
  /** 토큰 기반 압축 트리거 임계값 (기본: 24000) */
  compactTokenThreshold?: number;
  /** 이 메시지 수를 넘어야 압축 후보 (VEGA compact_threshold, 기본: 24) */
  compactAfterMessages?: number;
  /** 압축 시 항상 원본 유지할 최근 메시지 수 (VEGA keep_recent, 기본: 8) */
  keepRecentMessages?: number;
  /**
   * 수정이 필수인 작업의 no-edit 종료 가드. 모델이 edit/write 도구를 한 번도 안 쓰고
   * 최종 텍스트로 끝내려 하면 "아직 수정 안 했다, 계속하라"고 N회까지 되민다.
   * 경량 모델(gemini 등)이 탐색만 하고 일찍 결론 내는 패턴 차단 (SWE 하이브리드에서 발견).
   * 기본 0 (비활성) — 수정 없는 작업(진단·분석)도 정상이므로 옵트인.
   */
  nudgeMaxOnNoEdit?: number;
  /** Verification-harness files for which edit/write are refused (see tools.ts ToolExecOptions) */
  protectedFiles?: string[];
  /** bash tool timeout — docker-based tests need minutes (default 30s) */
  bashTimeoutMs?: number;
  /** Expose web_fetch + web_search tools (default true). Disabled e.g. for SWE-bench integrity. */
  webTools?: boolean;
  /** Expose search_memory (default true). Disabled for isolated/temp repo benchmarks. */
  memoryTools?: boolean;
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
}

/** 루프 실행 결과 */
export interface AgenticLoopResult {
  /** 최종 텍스트 응답 */
  text: string;
  /** 사용한 도구 호출 횟수 */
  toolCallCount: number;
  /** 총 API 호출 횟수 */
  apiCallCount: number;
  /** 총 토큰 사용량 (추적 가능한 경우) */
  totalTokens: number;
  /** 입력(prompt) 토큰 누적 — costInfo/로그의 in/out 분리 표기용 (INT-2508) */
  inputTokens: number;
  /** 출력(completion) 토큰 누적 */
  outputTokens: number;
  /** 캐시 적중 입력 토큰 누적 (totalTokens의 부분집합) — prompt-cache 효율 측정용 */
  cachedTokens: number;
  /** A blocking ask_human ended the run; the operator now owns the next step. */
  blockedOnOperator?: boolean;
  /** Exact correlation IDs returned by the blocking ask_human tool call. */
  operatorQuestionCorrelationIds?: string[];
  /** A side-effecting sandbox RPC lost its authoritative result; quarantine. */
  executionOutcomeUnknown?: boolean;
  /** 소요 시간 (ms) */
  durationMs: number;
  /** Shell commands the worker actually ran via the `bash` tool — ground truth
   *  for the validation-evidence gate (self-reported `commands` is often empty). */
  executedCommands: string[];
}

// ============ 에이전틱 루프 ============

/**
 * 에이전틱 도구 루프 실행
 *
 * 흐름:
 * 1. 프롬프트로 API 호출 (도구 정의 포함)
 * 2. 응답에 tool_calls가 있으면 → 도구 실행 → 결과를 메시지에 추가 → 2로
 * 3. 응답에 tool_calls가 없으면 (finish_reason = 'stop') → 최종 텍스트 반환
 */
export async function runAgenticLoop(options: AgenticLoopOptions): Promise<AgenticLoopResult> {
  const {
    systemPrompt,
    prompt,
    cwd,
    callApi,
    maxTurns = 20,
    timeoutMs = 300000,
    onLog,
    enableTools = true,
    // 긴 작업(SWE-bench급 실전 repo)에서 압축이 너무 일찍·자주 터지면 모델이 읽은
    // 파일 컨텍스트를 잃고 같은 파일을 반복 read하다 수정에 도달 못 한다(무한 탐색).
    // 현대 모델 컨텍스트(128k+)에 맞춰 임계를 넉넉히, 최근 보존 블록도 늘린다.
    compactTokenThreshold = 60000,
    compactAfterMessages = 60,
    keepRecentMessages = 16,
    nudgeMaxOnNoEdit = 0,
    protectedFiles,
    bashTimeoutMs,
    webTools = true,
    memoryTools = true,
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
  const deadline = timeoutMs > 0 ? startTime + timeoutMs : Number.POSITIVE_INFINITY;

  // 메시지 히스토리 구성
  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  // 작업 루트(cwd)를 명시 — 모델이 모르면 '/'나 repo명 같은 절대경로를 추측해
  // 경로 검증(project 밖 접근)에 막힌다. 실전 repo(pylint 등)에서 search_files가
  // 전부 차단되던 결함(SWE-bench에서 발견). 도구는 이 루트 기준 상대경로를 쓰라고 안내.
  const cwdNote =
    `# Working directory\n` +
    `Your project root is: ${cwd}\n` +
    `All file tools operate within this root. Use paths relative to it (e.g. "src/foo.ts" or ".") ` +
    `or absolute paths under this root. Do NOT use "/" or a bare repo name — those are outside the project and will be rejected.\n` +
    `Local-only data, credentials, and cross-repository artifacts may be available read-only under /warehouse. ` +
    `Read /warehouse/INDEX.md before asking the operator for missing material, and never print secret values.\n\n`;
  messages.push({ role: 'user', content: cwdNote + prompt });

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
  const shellFilteredTools = shellTools
    ? memoryFilteredTools
    : memoryFilteredTools.filter((t) => t.function.name !== 'bash');
  const visibleBaseTools = readOnly
    ? shellFilteredTools.filter((t) => !['write_file', 'edit_file', 'bash'].includes(t.function.name))
    : shellFilteredTools;
  const tools = enableTools
    ? [
        ...visibleBaseTools,
        ...(filesystemTools && applyPatch && editFormat === 'json' && !readOnly ? [APPLY_PATCH_TOOL] : []),
        // Not in readOnly: it spawns compiler subprocesses, matching bash's exclusion.
        ...(filesystemTools && diagnosticsTool && !readOnly && shellTools ? [DIAGNOSTICS_TOOL] : []),
        // Both are withheld in readOnly. A read-only run exists because the
        // material under inspection is untrusted, and a fetch is an outbound
        // channel for anything the agent can read — the provider credential
        // included. MCP servers are withheld for the mirror reason: OpenSwarm's
        // own memory server exposes writes, so injected content could leave
        // something behind for a later run. (INT-3189)
        ...(webTools && !readOnly ? WEB_TOOL_DEFINITIONS : []),
        ...(readOnly ? [] : humanSurfaceFilteredMcp.tools),
        ...(readOnly || !coordinationContext ? [] : COORDINATION_TOOL_DEFINITIONS),
      ]
    : [];
  // The provider-visible schema is not an enforcement boundary. Carry the
  // exact same set into dispatch so a hidden tool call cannot reach a globally
  // registered MCP route (or another built-in withheld for this run).
  const allowedToolNames = new Set(tools.map((tool) => tool.function.name));
  const readCache = createReadCache(); // 루프 단위 read 캐시 (중복 read 차단)
  let toolCallCount = 0;
  let editToolCount = 0; // edit_file/write_file 호출 수 (no-edit 가드용)
  const executedCommands: string[] = []; // `bash` 도구로 실제 실행한 명령 (검증 증거 ground truth)
  // 진전 정체 감지: 이번 턴의 도구 호출이 모두 이전과 동일(name+args)하면 새 정보·변경
  // 없는 반복이다. N턴 연속이면 루프로 보고 조기 종료한다 — 고정 turn 한도(작업 제한)가
  // 아니라 진전 기반 중단. maxTurns는 비상 천장으로만 남는다.
  const seenToolCalls = new Set<string>();
  let blockedOnOperator = false;
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
  let finalText = '';

  for (let turn = 0; turn < maxTurns + 1; turn++) {
    // 사용자 중단 (Esc/Ctrl+C) — 현재 텍스트가 있으면 유지, 없으면 표시만.
    if (signal?.aborted) {
      onLog?.('■ Stopped by user');
      finalText = finalText || '(stopped)';
      break;
    }

    // 타임아웃 체크
    if (Date.now() > deadline) {
      onLog?.(`⏰ Agentic loop timeout after ${turn} turns`);
      break;
    }

    // 히스토리 압축 — VEGA compaction.py 패턴 이식.
    // 트리거: 메시지 수가 compactAfterMessages를 넘고 + 토큰이 임계값 초과일 때만.
    // 과거에는 turn>=2부터 매 턴 무조건 압축해 모델이 방금 읽은 파일·작업 맥락을
    // 즉시 잃고 헛돌았다(루프 재발). 이제 정말 길어질 때만 압축하고, 압축해도
    // 최근 keepRecentMessages 블록은 원본 유지한다.
    if (messages.length > compactAfterMessages) {
      const msgTokens = countMessageTokens(messages);
      if (msgTokens > compactTokenThreshold) {
        onLog?.(`📦 Compacting history (${messages.length} msgs, ${msgTokens} tokens > ${compactTokenThreshold})`);
        compactPriorTurns(messages, keepRecentMessages);
        // Compaction drops prior read content from the model's view, so the read
        // cache's premise ("content is already earlier in the conversation") no
        // longer holds — a stub re-read would leave the model without the file
        // contents it needs for edit_file's old_string. Clear it so the next
        // read returns full content again. (INT-1929)
        readCache.store.clear();
      }
    }

    // API 호출
    apiCallCount++;
    onLog?.(`▸ API call #${apiCallCount}${turn > 0 ? ` (tool turn ${turn})` : ''}`);

    let response: ChatCompletionResponse;
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
      finalText = `API error: ${msg}`;
      break;
    }

    if (response.usage) {
      totalTokens += response.usage.prompt_tokens + response.usage.completion_tokens;
      inputTokens += response.usage.prompt_tokens;
      outputTokens += response.usage.completion_tokens;
      cachedTokens += response.usage.cached_tokens ?? 0;
    }

    const choice = response.choices?.[0];
    if (!choice) {
      onLog?.('✖ Empty response from API');
      finalText = 'Empty API response';
      break;
    }

    const assistantMsg = choice.message;

    // 도구 호출이 없으면 최종 응답
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      // SEARCH/REPLACE 모드 — 도구 호출이 아니라 응답 본문의 S/R 블록으로 편집한다.
      // 블록이 있으면 직접 적용하고(보호 파일은 거부) 결과를 되돌려 루프를 잇는다. (INT-1676)
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

      // no-edit 종료 가드 — 수정 필수 작업인데 edit/write를 한 번도 안 하고 끝내려 하면
      // 되밀어 계속하게 한다(경량 모델의 조기 결론 패턴 차단).
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
      finalText = typeof content === 'string' && content.trim() ? content : '';
      break;
    }

    // 어시스턴트 메시지를 히스토리에 추가 (tool_calls 포함)
    messages.push({
      role: 'assistant',
      content: assistantMsg.content,
      tool_calls: assistantMsg.tool_calls,
    });

    // 도구 실행
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
      bashTimeoutMs,
      readOnly,
      filesystemTools,
      allowedToolNames,
      coordinationContext,
      sandboxExecutorSession,
      loopDeadlineAt: Number.isFinite(deadline) ? deadline : undefined,
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

    // Capture the shell commands the worker actually ran (ground truth for the
    // validation-evidence gate — the model's self-reported `commands` is often
    // empty). Only successful bash calls; deduped, capped. (INT-2485)
    toolCalls.forEach((tc, i) => {
      if (tc.function.name !== 'bash' || results[i]?.is_error) return;
      try {
        const cmd = String(JSON.parse(tc.function.arguments).command ?? '').trim();
        if (cmd && !executedCommands.includes(cmd) && executedCommands.length < 20) {
          executedCommands.push(cmd);
        }
      } catch { /* ignore unparseable args */ }
    });

    // Progress-based stop: if every tool call this turn repeats a prior one
    // (same name+args → no new info or change), count it as a stalled turn.
    // N consecutive stalled turns → wrap up via the final-answer turn.
    if (allToolCallsSeen(toolCalls, seenToolCalls)) {
      noProgressTurns++;
      if (noProgressTurns >= NO_PROGRESS_LIMIT) {
        onLog?.(`⚠ No new progress for ${NO_PROGRESS_LIMIT} turns (repeated tool calls) — wrapping up`);
        break;
      }
    } else {
      noProgressTurns = 0;
    }
    for (const tc of toolCalls) seenToolCalls.add(toolCallKey(tc));

    // 도구 결과를 메시지에 추가 (길이 초과 시 자동 truncate)
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

  // Final answer turn — maxTurns/타임아웃으로 끊겼는데 모델이 최종 텍스트를 못 낸 경우,
  // 도구 없이 호출해 결론을 강제한다. 이게 없으면 진단·분석형 작업이
  // 끝까지 도구만 호출하다 빈 결과("(no summary)")로 끝난다 — SWE 하이브리드 진단
  // 단계에서 발견된 결함.
  // 첫 salvage가 reasoning-only 응답처럼 사용자에게 보이는 content를 하나도 내지
  // 않으면 딱 한 번 재시도한다. 두 번 모두 비면 성공/REVISE로 위장하지 않고 실패로
  // 올려 보내 reviewer/worker 호출자가 명시적으로 처리하게 한다. (INT-1442, INT-2879)
  if (!finalText && apiCallCount > 0) {
    const maxFinalAnswerAttempts = 2;
    messages.push({
      role: 'user',
      content:
        "You've reached this turn's step limit, so stop calling tools now. Using everything " +
        'above, write a non-empty final answer now. Follow the output format requested in the ' +
        'original task exactly. Do not mention step/tool limits or "budget" to the user.',
    });

    for (let attempt = 1; attempt <= maxFinalAnswerAttempts && !finalText; attempt++) {
      if (attempt === 1) {
        onLog?.('▸ Final answer turn (no tools) — loop ended without a final message');
      } else {
        onLog?.('↻ Final answer was empty — retrying once (no tools)');
        messages.push({
          role: 'user',
          content:
            'Your previous final-answer attempt returned no user-visible text. Respond now with ' +
            'the complete, non-empty final answer in the exact format requested by the original task.',
        });
      }

      try {
        const response = await callApi(messages, []);
        if (response.usage) {
          totalTokens += response.usage.prompt_tokens + response.usage.completion_tokens;
          inputTokens += response.usage.prompt_tokens;
          outputTokens += response.usage.completion_tokens;
          cachedTokens += response.usage.cached_tokens ?? 0;
        }
        apiCallCount++;
        const content = response.choices?.[0]?.message?.content;
        finalText = typeof content === 'string' && content.trim() ? content : '';
      } catch (err) {
        // A rate limit on a salvage call must still propagate — swallowing it
        // here would return an empty result the scheduler reads as a plain failure
        // instead of pausing. Mirror the main call path: preserve a typed
        // RateLimitError, then re-detect an untyped one from the message. (INT-2519)
        if (err instanceof RateLimitError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        const rl = detectRateLimit('', msg);
        if (rl) throw rl;
        if (isInfraError(err)) throw err; // infra on salvage → infra_error, not fake result (INT-2520)
        onLog?.(`✖ Final answer turn failed (${attempt}/${maxFinalAnswerAttempts}): ${msg}`);
      }
    }

    if (!finalText) {
      onLog?.('✖ Final answer remained empty after one retry');
      throw new Error('Agentic loop produced no final message after one retry');
    }
  }

  return {
    text: finalText,
    toolCallCount,
    apiCallCount,
    totalTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    durationMs: Date.now() - startTime,
    executedCommands,
    blockedOnOperator,
    executionOutcomeUnknown,
    operatorQuestionCorrelationIds: operatorQuestionCorrelationIds.length > 0
      ? [...new Set(operatorQuestionCorrelationIds)]
      : undefined,
  };
}

/**
 * AgenticLoopResult → CliRunResult 변환
 *
 * costUsd is 0 by design: the loop cannot price tokens itself — codex-responses
 * bills through a ChatGPT subscription (no per-token marginal cost) and a
 * hardcoded price table would go stale. Adapters with real metering (openrouter)
 * can overwrite costUsd downstream. Tokens and duration are real measurements. (INT-2508)
 */
export function loopResultToCliResult(result: AgenticLoopResult): CliRunResult {
  return {
    exitCode: 0,
    stdout: result.text,
    stderr: '',
    durationMs: result.durationMs,
    executedCommands: result.executedCommands,
    blockedOnOperator: result.blockedOnOperator,
    executionOutcomeUnknown: result.executionOutcomeUnknown,
    operatorQuestionCorrelationIds: result.operatorQuestionCorrelationIds,
    costInfo: {
      costUsd: 0,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cachedTokens,
      cacheCreationTokens: 0,
      durationMs: result.durationMs,
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

// ============ 히스토리 압축 (VEGA compaction.py 패턴 이식) ============

/**
 * 이전 턴(assistant+tool 쌍)을 요약 1줄로 교체.
 * OpenAI API 제약: tool 메시지는 직전 assistant의 tool_call_id와 대응해야 하므로
 * 오래된 assistant+tool 쌍은 텍스트 요약으로 대체해 API 오류를 방지.
 *
 * 보존 기준 (VEGA keep_recent): 최근 keepRecent개 메시지 블록은 항상 원본 유지.
 * tool 메시지는 직전 assistant의 tool_call_id와 짝이 맞아야 하므로, 보존 경계는
 * keepRecent 지점 이후 첫 assistant로 정렬해 짝이 깨진 tool 메시지가 남지 않게 한다.
 * 기존 [Prior turns compacted] 요약이 있으면 새 요약에 합산 후 교체.
 * (테스트를 위해 export — 외부에서 직접 호출할 일은 없음)
 */
export function compactPriorTurns(messages: ChatMessage[], keepRecent = 8): void {
  const headerCount = messages[0]?.role === 'system' ? 2 : 1;

  // 최근 keepRecent개 메시지는 보존 — 압축 상한 인덱스 산출
  const desired = Math.max(headerCount, messages.length - keepRecent);
  // 보존 경계를 assistant 시작점으로 정렬 (orphan tool 메시지 방지)
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
        // 기존 compacted 요약이면 내용 그대로 흡수, 아니면 어시스턴트 설명 텍스트 보존
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

// ============ 헬퍼 ============

function summarizeToolArgs(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read_file': {
      // Include offset/limit so a chunked walk of a large file (advancing offsets
      // = legitimate investigation) is distinguishable from an identical re-read
      // (a real loop). Without this the log hides the signal needed to tell them
      // apart, and the turn-count nudge/maxTurns may cut a still-progressing read.
      const off = args.offset != null ? ` @${args.offset}` : '';
      const lim = args.limit != null ? `+${args.limit}` : '';
      return `${String(args.path ?? '')}${off}${lim}`;
    }
    case 'write_file':
      return String(args.path ?? '');
    case 'edit_file':
      return String(args.path ?? '');
    case 'search_files':
      return `"${args.pattern}" in ${args.path}`;
    case 'bash':
      return String(args.command ?? '').slice(0, 80);
    default:
      return '';
  }
}
