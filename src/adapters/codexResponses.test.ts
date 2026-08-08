import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexResponsesAdapter,
  chatToResponsesInput,
  toolsToResponsesTools,
  reduceResponsesEvents,
  resolveReasoningEffort,
  selectDefaultCodexResponseModel,
} from './codexResponses.js';
import { runAgenticLoop, type ChatMessage } from './agenticLoop.js';
import { RateLimitError } from './rateLimitError.js';
import type { ToolDefinition } from './tools.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseWorkerOutput command backfill', () => {
  const adapter = new CodexResponsesAdapter();

  it('backfills empty self-reported commands with the agentic loop executed commands', () => {
    const raw = {
      exitCode: 0,
      stdout: '```json\n{"success":true,"summary":"Fixed","filesChanged":["db/x.py"],"commands":[]}\n```',
      stderr: '',
      durationMs: 1,
      executedCommands: ['pytest tests/test_x.py', 'ruff check .'],
    };
    const result = adapter.parseWorkerOutput(raw);
    expect(result.commands).toEqual(['pytest tests/test_x.py', 'ruff check .']);
  });

  it('merges + dedupes self-reported and executed commands', () => {
    const raw = {
      exitCode: 0,
      stdout: '```json\n{"success":true,"summary":"ok","filesChanged":["a.ts"],"commands":["npm test"]}\n```',
      stderr: '',
      durationMs: 1,
      executedCommands: ['npm test', 'npm run lint'],
    };
    const result = adapter.parseWorkerOutput(raw);
    expect(result.commands).toEqual(['npm test', 'npm run lint']);
  });

  it('leaves commands empty when the worker ran no shell commands', () => {
    const raw = {
      exitCode: 0,
      stdout: '```json\n{"success":true,"summary":"edit only","filesChanged":["a.ts"],"commands":[]}\n```',
      stderr: '',
      durationMs: 1,
      executedCommands: [],
    };
    const result = adapter.parseWorkerOutput(raw);
    expect(result.commands).toEqual([]);
  });

  it('preserves an explicit no-change justification', () => {
    const result = adapter.parseWorkerOutput({
      exitCode: 0,
      stdout: '```json\n{"success":true,"noChangesReason":"Already fixed and verified."}\n```',
      stderr: '', durationMs: 1, executedCommands: [],
    });
    expect(result.noChangesReason).toBe('Already fixed and verified.');
  });

  it('drops a non-string no-change justification', () => {
    const result = adapter.parseWorkerOutput({
      exitCode: 0,
      stdout: '```json\n{"success":true,"noChangesReason":{"fake":"reason"}}\n```',
      stderr: '', durationMs: 1, executedCommands: [],
    });
    expect(result.noChangesReason).toBeUndefined();
  });
});

describe('selectDefaultCodexResponseModel', () => {
  it('prefers the stable default when the live catalog includes it', () => {
    expect(selectDefaultCodexResponseModel([
      'gpt-5.3-codex-spark',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ])).toBe('gpt-5.6-terra');
  });

  it('does not pick Spark implicitly when another model is available', () => {
    expect(selectDefaultCodexResponseModel(['gpt-5.3-codex-spark', 'gpt-5.4-mini'])).toBe('gpt-5.4-mini');
  });

  it('does not choose Spark implicitly even if it is the only discovered model', () => {
    expect(selectDefaultCodexResponseModel(['gpt-5.3-codex-spark'])).toBe('gpt-5.6-terra');
  });
});

describe('unsupported-model fallback', () => {
  it('persists the fallback model across subsequent tool-loop API turns', async () => {
    const requestedModels: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/backend-api/codex/models')) {
        return new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-terra', priority: 1 }] }), { status: 200 });
      }

      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      requestedModels.push(String(body.model));
      if (body.model === 'unsupported-model') {
        return new Response('model is not supported for this account', { status: 400 });
      }

      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"ok"}',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
          'data: [DONE]',
          '',
        ].join('\n'),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    type CreateApiCaller = (
      initialToken: string,
      accountId: string,
      store: unknown,
      model: string,
    ) => (messages: ChatMessage[], tools: ToolDefinition[]) => Promise<unknown>;
    const adapter = new CodexResponsesAdapter() as unknown as { createApiCaller: CreateApiCaller };
    const callApi = adapter.createApiCaller('token', 'account', {}, 'unsupported-model');

    await callApi([{ role: 'user', content: 'first' }], []);
    await callApi([{ role: 'user', content: 'second' }], []);

    expect(requestedModels).toEqual(['unsupported-model', 'gpt-5.6-terra', 'gpt-5.6-terra']);
  });
});

describe('chatToResponsesInput', () => {
  it('lifts system messages into instructions and keeps user/assistant as input', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are precise.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const { instructions, input } = chatToResponsesInput(messages);
    expect(instructions).toBe('You are precise.');
    expect(input).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('maps assistant tool_calls → function_call and tool results → function_call_output', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'read file' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    ];
    const { input } = chatToResponsesInput(messages);
    expect(input).toEqual([
      { role: 'user', content: 'read file' },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
    ]);
  });

  it('concatenates multiple system messages', () => {
    const { instructions } = chatToResponsesInput([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
    ]);
    expect(instructions).toBe('A\n\nB');
  });
});

describe('toolsToResponsesTools', () => {
  it('flattens the nested function:{} into the Responses flat tool shape', () => {
    const tools: ToolDefinition[] = [
      { type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } },
    ];
    expect(toolsToResponsesTools(tools)).toEqual([
      { type: 'function', name: 'bash', description: 'run', parameters: { type: 'object' }, strict: false },
    ]);
  });
});

describe('reduceResponsesEvents', () => {
  it('accumulates output_text deltas into assistant content with finish_reason stop', () => {
    const res = reduceResponsesEvents([
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
    ]);
    expect(res.choices[0].message.content).toBe('Hello');
    expect(res.choices[0].message.tool_calls).toBeUndefined();
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(res.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cached_tokens: 0 });
  });

  it('surfaces cached_tokens from input_tokens_details (prompt-cache observability)', () => {
    const res = reduceResponsesEvents([
      { type: 'response.output_text.delta', delta: 'ok' },
      { type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 10, input_tokens_details: { cached_tokens: 800 } } } },
    ]);
    expect(res.usage).toEqual({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, cached_tokens: 800 });
  });

  it('assembles a function_call from added + arguments.delta, keyed by item id, emitting call_id', () => {
    const res = reduceResponsesEvents([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'edit_file' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"x.ts"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 4 } } },
    ]);
    const tc = res.choices[0].message.tool_calls;
    expect(tc).toHaveLength(1);
    expect(tc![0]).toEqual({ id: 'call_9', type: 'function', function: { name: 'edit_file', arguments: '{"path":"x.ts"}' } });
    expect(res.choices[0].finish_reason).toBe('tool_calls');
  });

  it('arguments.done overrides accumulated deltas', () => {
    const res = reduceResponsesEvents([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'bash' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: 'partial' },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"cmd":"ls"}' },
    ]);
    expect(res.choices[0].message.tool_calls![0].function.arguments).toBe('{"cmd":"ls"}');
  });

  it('accepts final function-call details from response.output_item.done', () => {
    const res = reduceResponsesEvents([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'emit_marker', arguments: '' } },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'emit_marker', arguments: '{"marker":"SPARK_TOOL_OK"}' } },
    ]);
    expect(res.choices[0].message.tool_calls![0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'emit_marker', arguments: '{"marker":"SPARK_TOOL_OK"}' },
    });
  });

  it('maps Spark-style argument done events even when item_id is omitted for a single call', () => {
    const res = reduceResponsesEvents([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'emit_marker' } },
      { type: 'response.function_call_arguments.done', arguments: '{"marker":"SPARK_TOOL_OK"}' },
    ]);
    expect(res.choices[0].message.tool_calls![0].function.arguments).toBe('{"marker":"SPARK_TOOL_OK"}');
  });

  it('reduces the live-observed Spark function-call event sequence', () => {
    const res = reduceResponsesEvents([
      { type: 'response.created' },
      { type: 'response.in_progress' },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'emit_marker', arguments: '' } },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'emit_marker', arguments: '{"marker":"SPARK_TOOL_OK"}' } },
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"marker":"SPARK_TOOL_OK"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 42, output_tokens: 7 } } },
    ]);

    expect(res.choices[0]).toEqual({
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'emit_marker', arguments: '{"marker":"SPARK_TOOL_OK"}' },
          },
        ],
      },
    });
    expect(res.usage).toEqual({ prompt_tokens: 42, completion_tokens: 7, total_tokens: 49, cached_tokens: 0 });
  });
});

describe('Spark-shaped Responses events through the OpenSwarm loop', () => {
  it('executes an apply_patch tool call and feeds the result into the next turn', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'openswarm-spark-loop-'));
    const filePath = join(cwd, 'note.txt');
    writeFileSync(filePath, 'status=ALPHA', 'utf8');
    const patch = [
      '*** Begin Patch',
      '*** Update File: note.txt',
      '@@',
      '-status=ALPHA',
      '+status=SPARK_TOOL_OK',
      '*** End Patch',
    ].join('\n');
    let apiCalls = 0;

    try {
      const result = await runAgenticLoop({
        cwd,
        model: 'gpt-5.3-codex-spark',
        prompt: 'Change note.txt to SPARK_TOOL_OK.',
        webTools: false,
        applyPatch: true,
        maxTurns: 4,
        callApi: async (messages, tools) => {
          apiCalls++;
          if (apiCalls === 1) {
            expect(tools.some((t) => t.function.name === 'apply_patch')).toBe(true);
            return reduceResponsesEvents([
              { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_patch', call_id: 'call_patch', name: 'apply_patch', arguments: '' } },
              {
                type: 'response.output_item.done',
                item: {
                  type: 'function_call',
                  id: 'fc_patch',
                  call_id: 'call_patch',
                  name: 'apply_patch',
                  arguments: JSON.stringify({ input: patch }),
                },
              },
              { type: 'response.function_call_arguments.done', item_id: 'fc_patch', arguments: JSON.stringify({ input: patch }) },
            ]);
          }

          expect(messages.some((m) => m.role === 'tool' && m.content.includes('Patched: note.txt'))).toBe(true);
          return {
            choices: [{ message: { role: 'assistant', content: 'status=SPARK_TOOL_OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      });

      expect(result.toolCallCount).toBe(1);
      expect(result.text).toBe('status=SPARK_TOOL_OK');
      expect(readFileSync(filePath, 'utf8')).toBe('status=SPARK_TOOL_OK');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('resolveReasoningEffort — jobProfile effort wiring', () => {
  it('explicit profile effort wins over disableReasoning', () => {
    expect(resolveReasoningEffort('high', true)).toBe('high');
    expect(resolveReasoningEffort('high', false)).toBe('high');
    expect(resolveReasoningEffort('low', false)).toBe('low');
  });

  it('falls back to low when reasoning is disabled (worker default)', () => {
    expect(resolveReasoningEffort(undefined, true)).toBe('low');
  });

  it('falls back to medium otherwise', () => {
    expect(resolveReasoningEffort(undefined, false)).toBe('medium');
    expect(resolveReasoningEffort(undefined, undefined)).toBe('medium');
  });
})

const liveSparkIt = process.env.OPEN_SWARM_LIVE_CODEX_SPARK ? it : it.skip;

describe('codex-responses live Spark smoke', () => {
  // Opt-in because this hits the ChatGPT OAuth backend. Manual evidence captured
  // while adding explicit Spark support: this test passed with Spark calling
  // read_file → apply_patch → read_file and changing note.txt to SPARK_TOOL_OK.
  liveSparkIt('uses PKCE auth and Spark to edit through the OpenSwarm tool loop', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'openswarm-spark-edit-'));
    const filePath = join(cwd, 'note.txt');
    writeFileSync(filePath, 'status=ALPHA\n', 'utf8');
    const logs: string[] = [];

    try {
      const result = await new CodexResponsesAdapter().run({
        cwd,
        model: 'gpt-5.3-codex-spark',
        prompt:
          'Use tools to edit note.txt. Change the exact text "status=ALPHA" to "status=SPARK_TOOL_OK". ' +
          'After editing, verify by reading the file and answer with the final file content only.',
        systemPrompt:
          'You are an edit-tool smoke test. You must inspect and modify the file using tools; do not answer without editing.',
        enableTools: true,
        webTools: false,
        maxTurns: 8,
        nudgeMaxOnNoEdit: 2,
        timeoutMs: 180000,
        onLog: (line) => logs.push(line),
      });

      expect(result.exitCode).toBe(0);
      expect(logs.some((line) => /edit_file|apply_patch|write_file/.test(line))).toBe(true);
      expect(readFileSync(filePath, 'utf8').trim()).toBe('status=SPARK_TOOL_OK');
      expect(result.stdout).toContain('SPARK_TOOL_OK');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180000);
});

describe('429 throttle vs spent quota (INT-2907)', () => {
  type CreateApiCaller = (
    initialToken: string,
    accountId: string,
    store: unknown,
    model: string,
  ) => (messages: ChatMessage[], tools: ToolDefinition[]) => Promise<unknown>;

  const okStream = () =>
    new Response(
      [
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        'data: [DONE]',
        '',
      ].join('\n'),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );

  const callerWith = (fetchMock: ReturnType<typeof vi.fn>) => {
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new CodexResponsesAdapter() as unknown as { createApiCaller: CreateApiCaller };
    return adapter.createApiCaller('token', 'account', {}, 'gpt-5.5');
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits out a concurrency throttle and retries instead of reporting a usage limit', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      // Two throttles (quota to spare), then the real answer.
      if (calls <= 2) {
        return new Response('{"error":{"message":"Too many requests"}}', {
          status: 429,
          headers: { 'x-codex-primary-used-percent': '12' },
        });
      }
      return okStream();
    });
    const callApi = callerWith(fetchMock);

    vi.useFakeTimers();
    const pending = callApi([{ role: 'user', content: 'hi' }], []);
    await vi.advanceTimersByTimeAsync(5_000 + 15_000 + 2_000); // + jitter headroom
    await expect(pending).resolves.toBeDefined();
    expect(calls).toBe(3);
  });

  it('honors Retry-After for the wait', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '3' } });
      }
      return okStream();
    });
    const callApi = callerWith(fetchMock);

    vi.useFakeTimers();
    const pending = callApi([{ role: 'user', content: 'hi' }], []);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls).toBe(1); // still waiting out the server's Retry-After
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeDefined();
    expect(calls).toBe(2);
  });

  it('fails fast on a genuinely spent quota — no retry, typed RateLimitError', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"error":{"type":"usage_limit_reached","resets_at":1782824949}}', {
        status: 429,
        headers: { 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300' },
      }),
    );
    const callApi = callerWith(fetchMock);

    await expect(callApi([{ role: 'user', content: 'hi' }], [])).rejects.toBeInstanceOf(RateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a persistent throttle as infra, not as a usage limit', async () => {
    const fetchMock = vi.fn(async () => new Response('busy', { status: 429 }));
    const callApi = callerWith(fetchMock);

    vi.useFakeTimers();
    const pending = callApi([{ role: 'user', content: 'hi' }], []).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(5_000 + 15_000 + 40_000 + 3_000); // + jitter headroom
    const err = (await pending) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect(err.message).toContain('throttle-retry:');
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('records healthy-quota headers from a SUCCESS response for the cockpit gauge (INT-3402)', async () => {
    const { getQuotaSnapshot, __resetQuotaForTests } = await import('./quotaSnapshot.js');
    __resetQuotaForTests();
    const fetchMock = vi.fn(async () =>
      new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"ok"}',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
          'data: [DONE]',
          '',
        ].join('\n'),
        {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'x-codex-primary-used-percent': '37',
            'x-codex-primary-window-minutes': '300',
            'x-codex-primary-reset-at': '1900000000',
          },
        },
      ),
    );
    const callApi = callerWith(fetchMock);
    await callApi([{ role: 'user', content: 'hi' }], []);

    const obs = getQuotaSnapshot().providers.find((p) => p.provider === 'codex');
    expect(obs).toMatchObject({
      usedPercent: 37,
      windowMinutes: 300,
      resetsAt: 1900000000,
      source: 'success-headers',
    });
    __resetQuotaForTests();
  });

  it('records nothing from a success response without usage headers', async () => {
    const { getQuotaSnapshot, __resetQuotaForTests } = await import('./quotaSnapshot.js');
    __resetQuotaForTests();
    const callApi = callerWith(vi.fn(async () => okStream()));
    await callApi([{ role: 'user', content: 'hi' }], []);
    expect(getQuotaSnapshot().providers).toHaveLength(0);
  });
});

describe('401 refresh scope', () => {
  const okStreamResponse = () =>
    new Response(
      [
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
        'data: [DONE]',
        '',
      ].join('\n'),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );

  /** Duck-typed AuthProfileStore: refreshAndRetry only needs get/set. */
  function fakeStore() {
    let profile = {
      type: 'oauth' as const,
      provider: 'openai-gpt',
      access: 'stale',
      refresh: 'refresh-token',
      expires: Date.now() + 3_600_000,
      clientId: 'client',
    };
    return {
      getProfile: () => profile,
      setProfile: (_k: string, p: typeof profile) => { profile = p; },
      // refreshAndRetry expires the token through the store rather than writing
      // a snapshot back, so the fake has to offer the same door. (INT-2961)
      expireProfile: (_k: string) => { profile = { ...profile, expires: 0 }; return true; },
    };
  }

  // The regression: `retried` lived in createApiCaller's closure, so it was set
  // once per run. The first 401 consumed the only refresh the whole run had,
  // and a second token expiry — ordinary in a run measured in hours — then
  // failed every remaining call without ever attempting the refresh.
  it('refreshes again when the token expires a second time in the same run', async () => {
    let responsesCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 }), {
          status: 200,
        });
      }
      responsesCalls++;
      // One 401 at the start of each of the two turns.
      if (responsesCalls === 1 || responsesCalls === 3) {
        return new Response('unauthorized', { status: 401 });
      }
      return okStreamResponse();
    });
    vi.stubGlobal('fetch', fetchMock);

    type CreateApiCaller = (
      initialToken: string,
      accountId: string,
      store: unknown,
      model: string,
    ) => (messages: ChatMessage[], tools: ToolDefinition[]) => Promise<unknown>;
    const adapter = new CodexResponsesAdapter() as unknown as { createApiCaller: CreateApiCaller };
    const callApi = adapter.createApiCaller('token', 'account', fakeStore(), 'gpt-5.5');

    await expect(callApi([{ role: 'user', content: 'first' }], [])).resolves.toBeDefined();
    // The second turn must get its own retry budget.
    await expect(callApi([{ role: 'user', content: 'second' }], [])).resolves.toBeDefined();
    expect(responsesCalls).toBe(4);
  });

  // The retry stays once per call: a 401 that survives the refresh must fail
  // rather than loop.
  it('does not retry a second time within one call', async () => {
    let responsesCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes('oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'fresh', refresh_token: 'r2', expires_in: 3600 }), {
          status: 200,
        });
      }
      responsesCalls++;
      return new Response('unauthorized', { status: 401 });
    });
    vi.stubGlobal('fetch', fetchMock);

    type CreateApiCaller = (
      initialToken: string,
      accountId: string,
      store: unknown,
      model: string,
    ) => (messages: ChatMessage[], tools: ToolDefinition[]) => Promise<unknown>;
    const adapter = new CodexResponsesAdapter() as unknown as { createApiCaller: CreateApiCaller };
    const callApi = adapter.createApiCaller('token', 'account', fakeStore(), 'gpt-5.5');

    await expect(callApi([{ role: 'user', content: 'hi' }], [])).rejects.toThrow();
    expect(responsesCalls).toBe(2);
  });
});
