// ============================================
// OpenSwarm - Agentic Loop history compaction tests
// Regression guard for the worker-failure bug: over-eager compaction used to
// strip everything but the last assistant block every turn, so the model lost
// the files it had just read and looped 3-4 times. These tests pin the VEGA-style
// behaviour: keep recent blocks intact, never leave orphan tool messages.
// ============================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compactPriorTurns, toolCallKey, allToolCallsSeen, shouldNudgeReadLoop, READ_LOOP_NUDGE_AT, shouldNudgeCoordinationCheck, COORDINATION_CHECK_NUDGE_EVERY, COORDINATION_CHECK_NUDGE_PROMPT, runAgenticLoop, loopResultToCliResult, type ChatMessage, type AgenticLoopResult } from './agenticLoop.js';
import type { ToolCall } from './tools.js';

/** Scripted API response carrying a single tool call. */
const toolCallResp = (id: string, name: string, args: object) => ({
  choices: [{
    message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }] },
    finish_reason: 'tool_calls',
  }],
});
/** Scripted API response with no tool calls (model tries to finish). */
const finalResp = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

describe('progress-based stop helpers', () => {
  const mk = (name: string, args: string): ToolCall => ({ id: 'x', function: { name, arguments: args } });

  it('toolCallKey combines name + args', () => {
    expect(toolCallKey(mk('read_file', '{"path":"a"}'))).toBe('read_file:{"path":"a"}');
  });

  it('an empty turn (no tool calls) is not a stall', () => {
    expect(allToolCallsSeen([], new Set())).toBe(false);
  });

  it('all calls already seen → stalled turn', () => {
    const seen = new Set(['read_file:{"path":"a"}']);
    expect(allToolCallsSeen([mk('read_file', '{"path":"a"}')], seen)).toBe(true);
  });

  it('any new call (e.g. different path) → progress, not a stall', () => {
    const seen = new Set(['read_file:{"path":"a"}']);
    expect(allToolCallsSeen([mk('read_file', '{"path":"a"}'), mk('read_file', '{"path":"b"}')], seen)).toBe(false);
  });
});

/** Build a representative tool-using history: system + user + N (assistant→tool) rounds. */
function buildHistory(rounds: number): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a worker.' },
    { role: 'user', content: 'Do the task.' },
  ];
  for (let i = 0; i < rounds; i++) {
    messages.push({
      role: 'assistant',
      content: `Step ${i}: reading file`,
      tool_calls: [{
        id: `call_${i}`,
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: `src/file${i}.ts` }) },
      }],
    });
    messages.push({
      role: 'tool',
      tool_call_id: `call_${i}`,
      content: `contents of file${i}`,
    });
  }
  return messages;
}

/** Every tool message must immediately follow an assistant carrying its tool_call_id. */
function hasNoOrphanToolMessages(messages: ChatMessage[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    const prev = messages[i - 1];
    if (!prev || prev.role !== 'assistant' || !prev.tool_calls) return false;
    const ids = prev.tool_calls.map((tc) => tc.id);
    if (!ids.includes(m.tool_call_id)) return false;
  }
  return true;
}

describe('compactPriorTurns', () => {
  it('keeps the most recent keepRecent messages verbatim', () => {
    const messages = buildHistory(10); // 2 header + 20 round msgs = 22
    const before = messages.slice(-4).map((m) => JSON.stringify(m));

    compactPriorTurns(messages, 4);

    const after = messages.slice(-4).map((m) => JSON.stringify(m));
    expect(after).toEqual(before);
  });

  it('preserves the system + user header', () => {
    const messages = buildHistory(8);
    compactPriorTurns(messages, 4);

    expect(messages[0]).toEqual({ role: 'system', content: 'You are a worker.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Do the task.' });
  });

  it('never leaves an orphan tool message after compaction', () => {
    const messages = buildHistory(10);
    compactPriorTurns(messages, 5);
    expect(hasNoOrphanToolMessages(messages)).toBe(true);
  });

  it('replaces old rounds with a single [Prior turns compacted] summary', () => {
    const messages = buildHistory(10);
    compactPriorTurns(messages, 4);

    const summaries = messages.filter(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('[Prior turns compacted]'),
    );
    expect(summaries).toHaveLength(1);
    // The summary must sit right after the header, before the preserved tail.
    expect(messages[2].role).toBe('assistant');
    expect((messages[2] as { content: string }).content).toContain('[Prior turns compacted]');
  });

  it('shrinks total message count (actually compacts)', () => {
    const messages = buildHistory(10);
    const originalLen = messages.length;
    compactPriorTurns(messages, 4);
    expect(messages.length).toBeLessThan(originalLen);
  });

  it('is a no-op when nothing is old enough to compact', () => {
    // keepRecent larger than the whole body → boundary collapses to header, no change.
    const messages = buildHistory(2); // 2 header + 4 body = 6
    const snapshot = messages.map((m) => JSON.stringify(m));
    compactPriorTurns(messages, 10);
    expect(messages.map((m) => JSON.stringify(m))).toEqual(snapshot);
  });

  it('absorbs an existing summary instead of nesting summaries', () => {
    const messages = buildHistory(12);
    compactPriorTurns(messages, 4); // first pass creates a summary
    compactPriorTurns(messages, 4); // second pass should fold it in, not nest

    const summaries = messages.filter(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('[Prior turns compacted]'),
    );
    expect(summaries.length).toBeLessThanOrEqual(1);
  });
});

describe('shouldNudgeReadLoop — early read-loop nudge (ported 8a1420f)', () => {
  it('nudges once past the early turn with zero edits and budget left', () => {
    expect(shouldNudgeReadLoop(0, 0, 3, READ_LOOP_NUDGE_AT)).toBe(true);
    expect(shouldNudgeReadLoop(0, 0, 3, READ_LOOP_NUDGE_AT + 5)).toBe(true);
  });
  it('does NOT nudge before the early turn', () => {
    expect(shouldNudgeReadLoop(0, 0, 3, READ_LOOP_NUDGE_AT - 1)).toBe(false);
  });
  it('does NOT nudge once an edit has happened', () => {
    expect(shouldNudgeReadLoop(1, 0, 3, READ_LOOP_NUDGE_AT + 5)).toBe(false);
  });
  it('stops nudging once the budget is exhausted', () => {
    expect(shouldNudgeReadLoop(0, 3, 3, READ_LOOP_NUDGE_AT + 5)).toBe(false);
  });
});

// AGT-4054
describe('shouldNudgeCoordinationCheck', () => {
  it('nudges once enough turns have passed without a check, with coordination enabled', () => {
    expect(shouldNudgeCoordinationCheck(true, COORDINATION_CHECK_NUDGE_EVERY)).toBe(true);
    expect(shouldNudgeCoordinationCheck(true, COORDINATION_CHECK_NUDGE_EVERY + 5)).toBe(true);
  });
  it('does NOT nudge before enough turns have passed', () => {
    expect(shouldNudgeCoordinationCheck(true, COORDINATION_CHECK_NUDGE_EVERY - 1)).toBe(false);
  });
  it('does NOT nudge when there is no coordination context, regardless of turns elapsed', () => {
    expect(shouldNudgeCoordinationCheck(false, COORDINATION_CHECK_NUDGE_EVERY + 100)).toBe(false);
  });

  it('keeps consultation conditional, bounded, and non-blocking', () => {
    expect(COORDINATION_CHECK_NUDGE_PROMPT).toContain('concrete dependency');
    expect(COORDINATION_CHECK_NUDGE_PROMPT).toContain('file/PR conflict');
    expect(COORDINATION_CHECK_NUDGE_PROMPT).toContain('ownership ambiguity');
    expect(COORDINATION_CHECK_NUDGE_PROMPT).toContain('coordination_peers (limit 3)');
    expect(COORDINATION_CHECK_NUDGE_PROMPT).toContain('related/following durable threads');
    expect(COORDINATION_CHECK_NUDGE_PROMPT).toContain('no suitable peer, send nothing');
    expect(COORDINATION_CHECK_NUDGE_PROMPT).toContain('never fan out');
    expect(COORDINATION_CHECK_NUDGE_PROMPT).toContain('never park');
  });
});

describe('runAgenticLoop nudge budgets (INT-1925)', () => {
  it('read-loop nudges do not drain the no-edit guard budget', async () => {
    const logs: string[] = [];
    let call = 0;
    // Read a different (nonexistent) file each turn so the no-progress stall
    // detector never fires; zero edits throughout. After the read-loop nudge
    // fires (turn >= READ_LOOP_NUDGE_AT), the model tries to finish with no edits.
    const callApi = async () => {
      call++;
      if (call <= READ_LOOP_NUDGE_AT + 1) {
        return toolCallResp(`c${call}`, 'read_file', { path: `nope${call}.ts` });
      }
      return finalResp('analysis only');
    };
    await runAgenticLoop({
      prompt: 'fix the bug', cwd: process.cwd(), model: 'test', callApi,
      nudgeMaxOnNoEdit: 1, maxTurns: 30, webTools: false,
      onLog: (l) => logs.push(l),
    });
    // The read-loop nudge fired AND, with a separate counter, the finish-turn
    // no-edit guard STILL had budget to fire afterwards. (Shared-counter bug
    // would have left the guard exhausted → no "No-edit guard" log.)
    expect(logs.some((l) => l.includes('Read-loop nudge'))).toBe(true);
    expect(logs.some((l) => l.includes('No-edit guard'))).toBe(true);
  });
});

describe('runAgenticLoop warehouse discovery (AGT-4128)', () => {
  it('points every tool-loop worker at the warehouse index before it asks for local-only data', async () => {
    let firstMessages: ChatMessage[] = [];
    await runAgenticLoop({
      prompt: 'run the repository tests',
      cwd: process.cwd(),
      model: 'test',
      webTools: false,
      maxTurns: 1,
      callApi: async (messages) => {
        firstMessages = messages;
        return finalResp('done');
      },
    });
    expect(firstMessages[0].content).toContain('/warehouse/INDEX.md');
    expect(firstMessages[0].content).toContain('never print secret values');
  });
});

describe('runAgenticLoop timeout contract', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('treats timeoutMs=0 as no deadline, matching spawnCli', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);
    let calls = 0;
    const callApi = async () => {
      calls++;
      return finalResp('done');
    };

    const res = await runAgenticLoop({
      prompt: 'x',
      cwd: process.cwd(),
      model: 'test',
      callApi,
      webTools: false,
      timeoutMs: 0,
      maxTurns: 1,
    });

    expect(calls).toBe(1);
    expect(res.text).toBe('done');
  });
});

describe('runAgenticLoop final-answer recovery (INT-2879)', () => {
  it('routes a whitespace-only ordinary final response through recovery', async () => {
    const logs: string[] = [];
    let calls = 0;
    const callApi = async () => {
      calls++;
      return calls === 1 ? finalResp(' \n ') : finalResp('Decision: approve\nNo findings.');
    };

    const result = await runAgenticLoop({
      prompt: 'review the change',
      cwd: process.cwd(),
      model: 'test',
      callApi,
      webTools: false,
      maxTurns: 1,
      onLog: (line) => logs.push(line),
    });

    expect(calls).toBe(2);
    expect(result.text).toContain('Decision: approve');
    expect(logs).toContain('▸ Final answer turn (no tools) — loop ended without a final message');
  });

  it('retries once when the first no-tools final answer is empty', async () => {
    const logs: string[] = [];
    let calls = 0;
    const callApi = async (_messages: ChatMessage[], tools: unknown[]) => {
      calls++;
      if (tools.length > 0) return toolCallResp('c1', 'read_file', { path: 'missing.ts' });
      return calls === 2 ? finalResp('   ') : finalResp('Decision: revise\nFix the missing edge-case test.');
    };

    const result = await runAgenticLoop({
      prompt: 'review the change',
      cwd: process.cwd(),
      model: 'test',
      callApi: callApi as never,
      webTools: false,
      maxTurns: 0,
      onLog: (line) => logs.push(line),
    });

    expect(calls).toBe(3);
    expect(result.text).toContain('Fix the missing edge-case test.');
    expect(logs).toContain('↻ Final answer was empty — retrying once (no tools)');
  });

  it('fails explicitly when the retry is also reasoning-only/empty', async () => {
    let calls = 0;
    const callApi = async (_messages: ChatMessage[], tools: unknown[]) => {
      calls++;
      if (tools.length > 0) return toolCallResp('c1', 'read_file', { path: 'missing.ts' });
      return finalResp(calls === 2 ? '' : ' \n ');
    };

    await expect(
      runAgenticLoop({
        prompt: 'review the change',
        cwd: process.cwd(),
        model: 'test',
        callApi: callApi as never,
        webTools: false,
        maxTurns: 0,
      }),
    ).rejects.toThrow('Agentic loop produced no final message after one retry');
    expect(calls).toBe(3);
  });
});

describe('runAgenticLoop tool exposure options', () => {
  it('hides search_memory when memoryTools=false without disabling file tools', async () => {
    let toolNames: string[] = [];

    await runAgenticLoop({
      prompt: 'x',
      cwd: process.cwd(),
      model: 'test',
      webTools: false,
      memoryTools: false,
      maxTurns: 1,
      callApi: async (_messages, tools) => {
        toolNames = tools.map((tool) => tool.function.name);
        return finalResp('done');
      },
    });

    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('bash');
    expect(toolNames).not.toContain('search_memory');
  });

  it('withholds bash when shellTools=false while leaving the path-checked file tools', async () => {
    let toolNames: string[] = [];

    await runAgenticLoop({
      prompt: 'x',
      cwd: process.cwd(),
      model: 'test',
      shellTools: false,
      maxTurns: 1,
      callApi: async (_messages, tools) => {
        toolNames = tools.map((tool) => tool.function.name);
        return finalResp('done');
      },
    });

    expect(toolNames).not.toContain('bash');
    // run_diagnostics spawns compilers, so it goes with the shell.
    expect(toolNames).not.toContain('run_diagnostics');
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('write_file');
  });

  it('withholds every filesystem tool while preserving MCP and coordination tools', async () => {
    let toolNames: string[] = [];

    await runAgenticLoop({
      prompt: 'x',
      cwd: process.cwd(),
      model: 'test',
      filesystemTools: false,
      webTools: false,
      memoryTools: false,
      maxTurns: 1,
      mcpTools: [{
        type: 'function',
        function: { name: 'linear__get_issue', description: '', parameters: { type: 'object' } },
      }],
      coordinationContext: { repository: '/repo', taskId: 'supervisor', actor: 'orchestrator' },
      callApi: async (_messages, tools) => {
        toolNames = tools.map((tool) => tool.function.name);
        return finalResp('done');
      },
    });

    expect(toolNames).toContain('linear__get_issue');
    expect(toolNames).toContain('coordination_read');
    expect(toolNames).not.toContain('read_file');
    expect(toolNames).not.toContain('search_files');
    expect(toolNames).not.toContain('write_file');
    expect(toolNames).not.toContain('edit_file');
    expect(toolNames).not.toContain('bash');
  });

  it('refuses a hidden MCP name that was not granted to this run', async () => {
    let turn = 0;
    let deniedResult = '';

    await runAgenticLoop({
      prompt: 'x',
      cwd: process.cwd(),
      model: 'test',
      filesystemTools: false,
      webTools: false,
      memoryTools: false,
      maxTurns: 2,
      mcpTools: [{
        type: 'function',
        function: { name: 'linear__get_issue', description: '', parameters: { type: 'object' } },
      }],
      callApi: async (messages, tools) => {
        if (turn++ === 0) {
          expect(tools.map((tool) => tool.function.name)).toEqual(['linear__get_issue']);
          return toolCallResp('hidden-call', 'linear__delete_issue', { id: 'AX-1' });
        }
        deniedResult = messages.at(-1)?.content ?? '';
        return finalResp('done');
      },
    });

    expect(deniedResult).toContain('TOOL_NOT_ALLOWED');
    expect(deniedResult).toContain('linear__delete_issue');
  });
});

describe('runAgenticLoop blocking human decision', () => {
  it('stops the run instead of letting the model continue past the question', async () => {
    const calls: string[] = [];
    let turn = 0;

    const result = await runAgenticLoop({
      prompt: 'x',
      cwd: process.cwd(),
      model: 'test',
      maxTurns: 5,
      coordinationContext: {
        repository: process.cwd(),
        taskId: 't1',
        actor: 'magos-test',
        actorName: 'Magos Test-Vector',
        notifyOperator: async () => true,
      },
      callApi: async () => {
        turn += 1;
        calls.push(`turn-${turn}`);
        if (turn === 1) return toolCallResp('c1', 'ask_human', { question: 'Ship v2?' });
        return finalResp('Blocked on the operator decision; nothing else to do.');
      },
    });

    // One turn asks, one salvage turn reports. The model never gets a third
    // turn in which it could answer its own question.
    expect(calls).toEqual(['turn-1', 'turn-2']);
    expect(result.text).toContain('Blocked');
  });
});

// AGT-4054: an operator/agent can message a running worker/reviewer without
// it asking first (unlike ask_human), so nothing else surfaces that — this
// nudge is the only active prompt telling the agent to go check.
describe('runAgenticLoop coordination-inbox nudge (AGT-4054)', () => {
  const coordinationContext = {
    repository: process.cwd(),
    taskId: 't-coord-nudge',
    actor: 'worker-coord-nudge-test',
    actorName: 'Coord Nudge Test',
  };

  it('nudges to check the coordination inbox after enough turns of silence', async () => {
    const logs: string[] = [];
    const prompts: string[] = [];
    let call = 0;
    const callApi = async (messages: ChatMessage[]) => {
      prompts.push(...messages.flatMap((message) => typeof message.content === 'string' ? [message.content] : []));
      call++;
      if (call <= COORDINATION_CHECK_NUDGE_EVERY + 1) {
        return toolCallResp(`c${call}`, 'read_file', { path: `nope${call}.ts` });
      }
      return finalResp('done');
    };

    await runAgenticLoop({
      prompt: 'x', cwd: process.cwd(), model: 'test', callApi,
      coordinationContext, maxTurns: COORDINATION_CHECK_NUDGE_EVERY + 5, webTools: false,
      onLog: (l) => logs.push(l),
    });

    expect(logs.some((l) => l.includes('Coordination-inbox nudge'))).toBe(true);
    expect(prompts).toContain(COORDINATION_CHECK_NUDGE_PROMPT);
  });

  it('does NOT nudge when the run has no coordination context', async () => {
    const logs: string[] = [];
    let call = 0;
    const callApi = async () => {
      call++;
      if (call <= COORDINATION_CHECK_NUDGE_EVERY + 3) {
        return toolCallResp(`c${call}`, 'read_file', { path: `nope${call}.ts` });
      }
      return finalResp('done');
    };

    await runAgenticLoop({
      prompt: 'x', cwd: process.cwd(), model: 'test', callApi,
      maxTurns: COORDINATION_CHECK_NUDGE_EVERY + 5, webTools: false,
      onLog: (l) => logs.push(l),
    });

    expect(logs.some((l) => l.includes('Coordination-inbox nudge'))).toBe(false);
  });

  it('resets the clock when the agent checks its inbox on its own', async () => {
    const logs: string[] = [];
    let call = 0;
    // 3 turns of silence (turns 0-2), a self-initiated check at turn 3, then
    // 4 more turns of silence (turns 4-7) — 7 turns elapsed since turn 0
    // overall, which WOULD cross COORDINATION_CHECK_NUDGE_EVERY (6) measured
    // from the start. It must NOT cross measured from the turn-3 check
    // (turn 7 - turn 3 = 4 < 6). A broken/missing reset would nudge around
    // turn 6; a working one keeps this silent through turn 7.
    const CHECK_AT_CALL = 4;
    const callApi = async () => {
      call++;
      if (call === CHECK_AT_CALL) return toolCallResp(`c${call}`, 'coordination_read', {});
      if (call <= CHECK_AT_CALL + 4) {
        return toolCallResp(`c${call}`, 'read_file', { path: `nope${call}.ts` });
      }
      return finalResp('done');
    };

    await runAgenticLoop({
      prompt: 'x', cwd: process.cwd(), model: 'test', callApi,
      coordinationContext, maxTurns: 10, webTools: false,
      onLog: (l) => logs.push(l),
    });

    expect(logs.some((l) => l.includes('Coordination-inbox nudge'))).toBe(false);
  });

  it('does NOT reset the clock on coordination_history alone — it consumes nothing from the live inbox', async () => {
    const logs: string[] = [];
    let call = 0;
    // Call coordination_history every turn instead of coordination_read. If it
    // wrongly counted as a check, this would look identical to the previous
    // test and never nudge — but it must, because the live inbox was never
    // actually consumed. Vary the args per call so the no-progress stall
    // guard (identical tool calls 3 turns running) doesn't cut the run short.
    const callApi = async () => {
      call++;
      if (call <= COORDINATION_CHECK_NUDGE_EVERY + 1) {
        return toolCallResp(`c${call}`, 'coordination_history', { limit: call });
      }
      return finalResp('done');
    };

    await runAgenticLoop({
      prompt: 'x', cwd: process.cwd(), model: 'test', callApi,
      coordinationContext, maxTurns: COORDINATION_CHECK_NUDGE_EVERY + 5, webTools: false,
      onLog: (l) => logs.push(l),
    });

    expect(logs.some((l) => l.includes('Coordination-inbox nudge'))).toBe(true);
  });
});

describe('runAgenticLoop read cache vs compaction (INT-1929)', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aloop-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  /** Drive two identical reads of f.txt, capturing the tool result the model sees each call. */
  const runTwoReads = async (opts: { compactAfterMessages: number; compactTokenThreshold?: number; keepRecentMessages?: number }) => {
    await fs.writeFile(path.join(tmp, 'f.txt'), 'ALPHA_CONTENT', 'utf-8');
    const seen: string[] = [];
    let call = 0;
    const callApi = async (messages: ChatMessage[]) => {
      const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
      if (lastTool && lastTool.role === 'tool') seen.push(lastTool.content);
      call++;
      if (call <= 2) return toolCallResp(`c${call}`, 'read_file', { path: 'f.txt' });
      return finalResp('done');
    };
    await runAgenticLoop({
      prompt: 'inspect f', cwd: tmp, model: 'test', callApi,
      webTools: false, maxTurns: 10, ...opts,
    });
    return seen;
  };

  it('returns a STUB on an in-loop re-read when no compaction happens', async () => {
    const seen = await runTwoReads({ compactAfterMessages: 999 });
    expect(seen.some((c) => c.includes('ALPHA_CONTENT'))).toBe(true);
    expect(seen.some((c) => c.includes('already read'))).toBe(true);
  });

  it('clears the read cache on compaction so a re-read returns full content again (INT-1929)', async () => {
    // Force the compaction branch every eligible turn (low thresholds), but keep
    // recent messages verbatim so the assertion sees the real re-read result.
    const seen = await runTwoReads({ compactAfterMessages: 2, compactTokenThreshold: 1, keepRecentMessages: 999 });
    expect(seen.filter((c) => c.includes('ALPHA_CONTENT')).length).toBeGreaterThanOrEqual(2);
    expect(seen.some((c) => c.includes('already read'))).toBe(false);
  });
});

describe('loopResultToCliResult costInfo (INT-2508)', () => {
  it('carries loop-measured tokens/duration as costInfo with zero (subscription) cost', () => {
    const loop: AgenticLoopResult = {
      text: 'done',
      toolCallCount: 3,
      apiCallCount: 4,
      totalTokens: 12000,
      inputTokens: 10000,
      outputTokens: 2000,
      cachedTokens: 8000,
      durationMs: 45200,
      executedCommands: ['npm test'],
    };
    const cli = loopResultToCliResult(loop);
    expect(cli.costInfo).toEqual({
      costUsd: 0,
      inputTokens: 10000,
      outputTokens: 2000,
      cacheReadTokens: 8000,
      cacheCreationTokens: 0,
      durationMs: 45200,
    });
    expect(cli.stdout).toBe('done');
    expect(cli.executedCommands).toEqual(['npm test']);
  });
});

describe('compactPriorTurns with a wide tool fan-out', () => {
  /**
   * One assistant turn issuing many parallel tool calls — the shape the loop
   * produces whenever a model batches reads. The tail of the array is then all
   * tool messages, which is what the boundary alignment could not handle.
   */
  function buildFanOut(priorRounds: number, toolsInFinalTurn: number): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a worker.' },
      { role: 'user', content: 'Do the task.' },
    ];
    for (let i = 0; i < priorRounds; i++) {
      messages.push({
        role: 'assistant',
        content: `Prior step ${i}`,
        tool_calls: [{ id: `prior_${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      });
      messages.push({ role: 'tool', tool_call_id: `prior_${i}`, content: `prior result ${i}` });
    }
    messages.push({
      role: 'assistant',
      content: 'Reading everything at once',
      tool_calls: Array.from({ length: toolsInFinalTurn }, (_, i) => ({
        id: `fan_${i}`,
        type: 'function' as const,
        function: { name: 'read_file', arguments: JSON.stringify({ path: `src/f${i}.ts` }) },
      })),
    });
    for (let i = 0; i < toolsInFinalTurn; i++) {
      messages.push({ role: 'tool', tool_call_id: `fan_${i}`, content: `fan result ${i}` });
    }
    return messages;
  }

  /** Orphan check that allows a run of tool messages after one assistant. */
  function fanOutHasNoOrphans(messages: ChatMessage[]): boolean {
    let openIds: string[] = [];
    for (const m of messages) {
      if (m.role === 'assistant') {
        openIds = (m.tool_calls ?? []).map((tc) => tc.id);
        continue;
      }
      if (m.role === 'tool' && !openIds.includes(m.tool_call_id as string)) return false;
    }
    return true;
  }

  // The defect: walking the boundary forward past a tail of tool messages ran
  // off the end, so the compaction range covered everything — the model lost
  // the results it had just received and re-ran the same reads.
  it('keeps the turn whose results just arrived', () => {
    const messages = buildFanOut(3, 9);

    compactPriorTurns(messages, 8);

    const kept = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(kept).toContain('Reading everything at once');
    for (let i = 0; i < 9; i++) expect(kept).toContain(`fan result ${i}`);
  });

  it('still compacts the rounds before it', () => {
    const messages = buildFanOut(3, 9);

    compactPriorTurns(messages, 8);

    const kept = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(kept).toContain('[Prior turns compacted]');
    expect(kept).not.toContain('prior result 0');
  });

  it('leaves no orphan tool message', () => {
    const messages = buildFanOut(3, 9);
    compactPriorTurns(messages, 8);
    expect(fanOutHasNoOrphans(messages)).toBe(true);
  });

  it.each([9, 12, 30])('holds for %i parallel tool calls', (toolCount) => {
    const messages = buildFanOut(2, toolCount);

    compactPriorTurns(messages, 8);

    const kept = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(kept).toContain('Reading everything at once');
    expect(kept).toContain(`fan result ${toolCount - 1}`);
    expect(fanOutHasNoOrphans(messages)).toBe(true);
  });
});

// `allToolCallsSeen` keys on name+args, and `coordination_read` takes no
// parameters — so every inbox check produced an identical key and three checks
// of a quiet inbox tripped the stall detector. An agent waiting for a reply was
// killed for waiting. (AGT-4065)
describe('checking an inbox is not a stall', () => {
  const call = (name: string, args = '{}') => ({ id: `c-${name}-${args}`, function: { name, arguments: args } });

  it('does not count a repeated inbox check as a stalled turn', async () => {
    const { allToolCallsSeen } = await import('./agenticLoop.js');
    const seen = new Set<string>();
    const turn = [call('coordination_read')];
    // Simulate three consecutive identical checks, as an agent awaiting a reply
    // would make.
    for (let i = 0; i < 3; i += 1) {
      expect(allToolCallsSeen(turn, seen)).toBe(false);
      seen.add('coordination_read:{}');
    }
  });

  it('does not count a wait as a stalled turn either', async () => {
    const { allToolCallsSeen } = await import('./agenticLoop.js');
    expect(allToolCallsSeen([call('coordination_wait', '{"timeout_ms":5000}')],
      new Set(['coordination_wait:{"timeout_ms":5000}']))).toBe(false);
  });

  it('still catches a genuine stall on tools that read only this agent\'s own work', async () => {
    const { allToolCallsSeen } = await import('./agenticLoop.js');
    const repeated = [call('read_file', '{"path":"a.ts"}')];
    expect(allToolCallsSeen(repeated, new Set(['read_file:{"path":"a.ts"}']))).toBe(true);
  });

  it('a turn that also checked the inbox is not a stall, even when its other calls repeat', async () => {
    const { allToolCallsSeen } = await import('./agenticLoop.js');
    const mixed = [call('read_file', '{"path":"a.ts"}'), call('coordination_read')];
    expect(allToolCallsSeen(mixed, new Set(['read_file:{"path":"a.ts"}', 'coordination_read:{}']))).toBe(false);
  });
});
