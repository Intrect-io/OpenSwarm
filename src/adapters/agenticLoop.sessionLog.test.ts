// ============================================
// OpenSwarm - the loop leaves a readable transcript behind (AGT-4442)
//
// The operator's reason for this file: a worker edited a failing contract test
// to skip the rows it objected to, and the only trace was one log line naming
// the file. These tests pin what an operator must be able to read back after
// the fact — the prompt, each tool call with its arguments and output, and the
// final text — including on the paths where the loop throws or where history
// compaction has already mutated `messages` in place.
// ============================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgenticLoop } from './agenticLoop.js';

let root: string;
const saved = process.env.OPENSWARM_SESSION_LOG_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'osw-loop-session-'));
  process.env.OPENSWARM_SESSION_LOG_DIR = root;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (saved === undefined) delete process.env.OPENSWARM_SESSION_LOG_DIR;
  else process.env.OPENSWARM_SESSION_LOG_DIR = saved;
});

const toolCallResp = (id: string, name: string, args: object) => ({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
    },
    finish_reason: 'tool_calls',
  }],
});
const finalResp = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

/** The single transcript written under the overridden directory. */
function transcript(): Array<Record<string, unknown>> {
  const taskDirs = readdirSync(root);
  expect(taskDirs).toHaveLength(1);
  const files = readdirSync(join(root, taskDirs[0]));
  expect(files).toHaveLength(1);
  return readFileSync(join(root, taskDirs[0], files[0]), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('runAgenticLoop session transcript (AGT-4442)', () => {
  it('records the prompt, the tool call with its arguments and output, and the final text', async () => {
    let call = 0;
    const result = await runAgenticLoop({
      systemPrompt: 'You are a worker.',
      prompt: 'fix the contract test',
      cwd: process.cwd(),
      model: 'test-model',
      webTools: false,
      maxTurns: 5,
      usageAttribution: { adapter: 'openrouter', taskId: 'AX-1556', stage: 'worker' },
      callApi: async () => {
        call += 1;
        return call === 1
          ? toolCallResp('c1', 'read_file', { path: 'package.json' })
          : finalResp('patched the adapter');
      },
    });

    expect(result.text).toBe('patched the adapter');
    const log = transcript();

    // Identity: an operator reading the file knows whose work it is.
    expect(log[0]).toMatchObject({
      type: 'start', adapter: 'openrouter', taskId: 'AX-1556', stage: 'worker', model: 'test-model',
    });

    const prompt = log.find((e) => e.type === 'notice' && e.note === 'prompt');
    expect(prompt?.systemPrompt).toBe('You are a worker.');
    expect(String(prompt?.prompt)).toContain('fix the contract test');

    // The tool call, with the arguments that decided what it touched.
    const tool = log.find((e) => e.type === 'tool');
    expect(tool).toMatchObject({ name: 'read_file', isError: false });
    expect(String(tool?.arguments)).toContain('package.json');
    expect(String(tool?.output)).toContain('openswarm');

    // The assistant turn that requested it, and the answer it ended on.
    const assistant = log.filter((e) => e.type === 'assistant');
    expect(assistant.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(assistant[0].toolCalls)).toContain('read_file');

    const end = log[log.length - 1];
    expect(end).toMatchObject({ type: 'end', outcome: 'returned', text: 'patched the adapter' });
    expect(end.toolCallCount).toBe(1);
  });

  it('closes the record when the loop throws, so a crashed run is still readable', async () => {
    await expect(runAgenticLoop({
      prompt: 'do the thing',
      cwd: process.cwd(),
      model: 'test-model',
      webTools: false,
      maxTurns: 2,
      usageAttribution: { adapter: 'openrouter', taskId: 'AX-1557', stage: 'worker' },
      // The loop classifies this before rethrowing, so the record must hold
      // the classified error rather than the raw string it started as.
      callApi: async () => { throw new Error('429 rate limit'); },
    })).rejects.toThrow(/rate limit/i);

    const log = transcript();
    const end = log[log.length - 1];
    expect(end).toMatchObject({ type: 'end', outcome: 'threw' });
    expect(String(end.error)).toMatch(/RateLimitError/);
  });

  it('keeps a tool result that later compaction would have dropped from `messages`', async () => {
    // compactPriorTurns / trimOversizedToolOutputs mutate the array in place,
    // so an end-of-run snapshot of `messages` shows the surviving window. The
    // transcript is written as events happen, so the early output stays.
    let call = 0;
    await runAgenticLoop({
      prompt: 'read a lot',
      cwd: process.cwd(),
      model: 'test-model',
      webTools: false,
      maxTurns: 40,
      compactAfterMessages: 4,
      compactTokenThreshold: 1,
      usageAttribution: { adapter: 'openrouter', taskId: 'AX-1558', stage: 'worker' },
      callApi: async () => {
        call += 1;
        if (call === 1) return toolCallResp('c1', 'read_file', { path: 'tsconfig.json' });
        if (call < 8) return toolCallResp(`c${call}`, 'read_file', { path: `src/index-${call}.ts` });
        return finalResp('done reading');
      },
    });

    const log = transcript();
    const first = log.find((e) => e.type === 'tool');
    // The very first tool output — the one compaction is most likely to lose.
    expect(String(first?.arguments)).toContain('tsconfig.json');
    expect(String(first?.output).length).toBeGreaterThan(0);
    expect(log.filter((e) => e.type === 'tool').length).toBeGreaterThanOrEqual(7);
  });

  it('records a failing tool call as an error, not as a silent gap', async () => {
    let call = 0;
    await runAgenticLoop({
      prompt: 'read a missing file',
      cwd: process.cwd(),
      model: 'test-model',
      webTools: false,
      maxTurns: 5,
      usageAttribution: { adapter: 'openrouter', taskId: 'AX-1559', stage: 'worker' },
      callApi: async () => {
        call += 1;
        return call === 1
          ? toolCallResp('c1', 'read_file', { path: 'no/such/file-AGT-4442.txt' })
          : finalResp('gave up');
      },
    });

    const tool = transcript().find((e) => e.type === 'tool');
    expect(tool?.isError).toBe(true);
    expect(String(tool?.output)).toMatch(/ENOENT|not found|no such file/i);
  });

  it('still returns its result when the log directory cannot be written', async () => {
    // A log that can fail a run is worse than no log. The recorder declines,
    // every `session?.` call becomes a no-op, and the work is unaffected.
    const locked = join(root, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o400);
    process.env.OPENSWARM_SESSION_LOG_DIR = join(locked, 'sessions');
    try {
      const result = await runAgenticLoop({
        prompt: 'work anyway',
        cwd: process.cwd(),
        model: 'test-model',
        webTools: false,
        maxTurns: 2,
        usageAttribution: { adapter: 'openrouter', taskId: 'AX-1560', stage: 'worker' },
        callApi: async () => finalResp('finished regardless'),
      });
      expect(result.text).toBe('finished regardless');
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('files an unattributed run under adhoc rather than losing it', async () => {
    await runAgenticLoop({
      prompt: 'no attribution',
      cwd: process.cwd(),
      model: 'test-model',
      webTools: false,
      maxTurns: 2,
      callApi: async () => finalResp('ok'),
    });
    expect(readdirSync(root)).toEqual(['adhoc']);
  });

  it('records the salvage turn, so a cut-short run explains itself instead of stopping mid-tool (AGT-4450)', async () => {
    // The loop hits its step limit and asks once more with no tools. That call
    // produced the reviewer's entire REVISE verdict on AX-1556 and left no
    // trace: the transcript ended on a tool result. (AGT-4450)
    let call = 0;
    const result = await runAgenticLoop({
      systemPrompt: 'You are a reviewer.',
      prompt: 'judge the diff',
      cwd: process.cwd(),
      model: 'test-model',
      webTools: false,
      maxTurns: 2,
      usageAttribution: { adapter: 'openrouter', taskId: 'AX-1556', stage: 'reviewer' },
      callApi: async (_messages: unknown, tools: unknown[]) => {
        call += 1;
        // The salvage call is the one made with no tools.
        if (Array.isArray(tools) && tools.length === 0) return finalResp('decision: revise');
        return toolCallResp(`c${call}`, 'read_file', { path: 'package.json' });
      },
    });

    expect(result.text).toBe('decision: revise');
    const log = transcript();

    const salvage = log.find((e) => e.type === 'notice' && e.note === 'salvage');
    expect(salvage).toBeDefined();
    // The operator learns the run was cut short without counting API calls.
    expect(String(salvage?.reason)).toContain('without a final message');
    expect(String(salvage?.prompt)).toContain('step limit');

    const assistants = log.filter((e) => e.type === 'assistant');
    expect(assistants[assistants.length - 1]).toMatchObject({
      salvage: 1,
      content: 'decision: revise',
    });

    // The signature that exposed this: a salvaged run recorded one fewer
    // assistant event than it made API calls.
    const end = log[log.length - 1];
    expect(assistants.length).toBe(end.apiCallCount);
  });

  it('records both empty salvage attempts and why the run ended with no answer (AGT-4450)', async () => {
    const empty = { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] };
    let call = 0;
    await expect(runAgenticLoop({
      systemPrompt: 'You are a worker.',
      prompt: 'do the thing',
      cwd: process.cwd(),
      model: 'test-model',
      webTools: false,
      maxTurns: 2,
      usageAttribution: { adapter: 'openrouter', taskId: 'AX-1557', stage: 'worker' },
      callApi: async (_messages: unknown, tools: unknown[]) => {
        call += 1;
        if (Array.isArray(tools) && tools.length === 0) return empty;
        return toolCallResp(`c${call}`, 'read_file', { path: 'package.json' });
      },
    })).rejects.toThrow(/no final message/);

    const log = transcript();
    expect(log.find((e) => e.note === 'salvage-retry')).toMatchObject({ attempt: 2 });
    expect(String(log.find((e) => e.note === 'salvage-exhausted')?.reason)).toContain('empty');
    // Both attempts are present, empty content and all.
    expect(log.filter((e) => e.type === 'assistant' && e.salvage !== undefined)).toHaveLength(2);
  });
});
