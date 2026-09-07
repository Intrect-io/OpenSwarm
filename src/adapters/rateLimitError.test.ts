import { describe, it, expect } from 'vitest';
import { classifyLimitResponse, detectRateLimit, rateLimitFromCodexHeaders, rateLimitFromHttpResponse, matchesRateLimitMessage, RateLimitError } from './rateLimitError.js';
import { resolveLimitResponse, throttleWaitMs } from './throttleRetry.js';
import { isInfraError } from './errorClassification.js';
import { runAgenticLoop } from './agenticLoop.js';

// Every provider's REAL usage/rate-limit wire string must be recognised (audit
// INT-2520). Grounded in actual observed output, not invented. A missed limit
// becomes a false STUCK (in-process) or loses the scheduler pause (CLI).
describe('per-provider usage-limit recognition (INT-2520 audit)', () => {
  const REAL_LIMIT_OUTPUTS: Array<[string, string]> = [
    ['codex CLI', `{"type":"error","message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:20 PM."}`],
    ['claude CLI (human phrase)', 'claude CLI failed with code 1: Limit reached · resets 8pm (Asia/Seoul) · add funds to continue with extra usage'],
    ['claude rate_limit_event', '{"type":"rate_limit_event","rate_limit_info":{"overageStatus":"rejected","overageDisabledReason":"out_of_credits"}}'],
    ['codex-responses header phrase', 'API error: Codex 100% used of 300min window — resets at 2026-06-30T12:00:00Z'],
    ['OpenAI 429 rate_limit_exceeded', '{"error":{"code":"rate_limit_exceeded","message":"Rate limit reached for gpt-5 …"}}'],
    ['OpenAI 429 insufficient_quota', '{"error":{"type":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}'],
    ['OpenRouter 402 insufficient credits', '{"error":{"code":402,"message":"Insufficient credits. Add more to continue."}}'],
    // Verbatim from the run that surfaced AGT-4215: OpenRouter relaying an upstream
    // BYOK provider's own exhausted-balance wording, which is NOT "insufficient credits".
    ['OpenRouter 402 relaying upstream BYOK balance',
      '{"error":{"message":"Provider returned error","code":402,"metadata":{"raw":"{\\"code\\":402,\\"msg\\":\\"insufficient balance\\"}","provider_name":"AtlasCloud","is_byok":true}}}'],
    ['HTTP 429 too many requests (local)', 'Local API error (429): Too Many Requests'],
  ];
  for (const [name, output] of REAL_LIMIT_OUTPUTS) {
    it(`detects: ${name}`, () => {
      expect(matchesRateLimitMessage(output)).toBe(true);
      expect(detectRateLimit(output, '')).toBeInstanceOf(RateLimitError);
    });
  }

  it('does NOT false-positive on ordinary prose that mentions these words', () => {
    // A worker's own output about a rate-limit / credits / usage feature.
    const benign = [
      'Added a usage dashboard; the plan limit is configurable per tenant.',
      'Implemented credit purchase flow and out-of-stock handling.',
      'The cache window is 5min; processed 429 rows in the batch.',
      'Refactored rateLimiter.ts to reset the counter each window.',
      // "insufficient balance" is the stock error string of wallet/payment code, and
      // these signatures are scanned against raw model output. A worker editing such
      // a repo must not pause the scheduler — which is why the AGT-4215 signature is
      // anchored on the provider's JSON key rather than added as a bare substring.
      "throw new Error('Insufficient balance') // wallet guard",
      'if (res.status === 402) throw new Error("Insufficient balance for this transfer");',
    ];
    for (const b of benign) {
      expect(matchesRateLimitMessage(b)).toBe(false);
      expect(detectRateLimit(b, '')).toBeNull();
    }
  });
});

describe('rateLimitFromHttpResponse (INT-2520)', () => {
  it('429 → RateLimitError regardless of body wording', () => {
    expect(rateLimitFromHttpResponse(429, new Headers(), 'server busy')).toBeInstanceOf(RateLimitError);
  });
  it('402 → RateLimitError (openrouter out-of-credits)', () => {
    expect(rateLimitFromHttpResponse(402, new Headers(), 'Insufficient credits')).toBeInstanceOf(RateLimitError);
  });
  it('parses Retry-After (seconds) into resetsAt', () => {
    const err = rateLimitFromHttpResponse(429, new Headers({ 'retry-after': '120' }), '');
    expect(err?.resetsAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
  it('ignores OpenAI duration-style x-ratelimit-reset-* (not epoch) — no 1970 timestamp (INT-2520 review)', () => {
    // "1s"/"6ms" are durations; parseInt-ing them as epoch would give resetsAt≈1.
    const err = rateLimitFromHttpResponse(429, new Headers({ 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-reset-tokens': '6ms' }), '');
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err?.resetsAt).toBeUndefined(); // falls back to the safe 60s default downstream
  });
  it('non-limit status with a quota body still fires (e.g. 400 insufficient_quota)', () => {
    expect(rateLimitFromHttpResponse(400, new Headers(), '{"code":"insufficient_quota"}')).toBeInstanceOf(RateLimitError);
  });
  it('ordinary 500 with no quota wording → null', () => {
    expect(rateLimitFromHttpResponse(500, new Headers(), 'internal error')).toBeNull();
  });
});

describe('reset-time extraction — snake_case AND camelCase (INT-2521)', () => {
  it('detectRateLimit reads claude camelCase "resetsAt" (was defaulting to 60s)', () => {
    const claudeEvent = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1783249200,"overageDisabledReason":"out_of_credits"}}';
    const err = detectRateLimit(claudeEvent, '');
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err?.resetsAt).toBe(1783249200);
  });
  it('detectRateLimit still reads codex/OpenAI snake_case "resets_at"', () => {
    const err = detectRateLimit('error: usage_limit_reached "resets_at": 1782343811', '');
    expect(err?.resetsAt).toBe(1782343811);
  });
});

describe('detectRateLimit (INT-1906)', () => {
  it('detects a Codex usage_limit_reached payload and parses resets_at', () => {
    const stdout =
      'API error: Codex responses error (429): {"error":{"type":"usage_limit_reached",' +
      '"message":"The usage limit has been reached","plan_type":"prolite","resets_at":1782343811}}';
    const err = detectRateLimit(stdout, '');
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err?.resetsAt).toBe(1782343811);
    // The label embeds the ISO reset time for operator-facing logs.
    expect(err?.message).toContain('2026'); // 1782343811 → 2026-06-…
  });

  it('detects a rate_limit_error type without resets_at (resetsAt undefined)', () => {
    const err = detectRateLimit('{"type":"rate_limit_error","message":"slow down"}', '');
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err?.resetsAt).toBeUndefined();
  });

  it('detects a 429 paired with rate-limit wording in stderr', () => {
    const err = detectRateLimit('', 'HTTP 429 — rate limit exceeded, retry later');
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('returns null for ordinary CLI failures (no false positive)', () => {
    expect(detectRateLimit('TypeError: x is not a function', 'exit code 1')).toBeNull();
  });

  it('does not treat a bare "429" without rate-limit wording as a rate limit', () => {
    // e.g. a diff line, a port number, or unrelated numeric output.
    expect(detectRateLimit('listening on port 4290; processed 429 rows', '')).toBeNull();
  });

  it('detects the human-readable Codex usage-limit phrasing (INT-2519)', () => {
    // rateLimitFromCodexHeaders output that reached a CLI/string path.
    expect(detectRateLimit('API error: Codex 100% used of 300min window — resets at 2026-06-30T12:00:00Z', ''))
      .toBeInstanceOf(RateLimitError);
    expect(detectRateLimit('', 'Codex usage limit reached — resets at …')).toBeInstanceOf(RateLimitError);
    expect(detectRateLimit('overageStatus: out_of_credits', '')).toBeInstanceOf(RateLimitError);
  });

  it('does not treat ordinary "used"/"window" wording as a rate limit (no false positive)', () => {
    expect(detectRateLimit('the cache window is 5min; 80% used of the disk', '')).toBeNull();
  });

  it('scans both stdout and stderr (signal split across streams)', () => {
    const err = detectRateLimit('partial output', 'error: usage_limit_reached "resets_at": 1782343811');
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err?.resetsAt).toBe(1782343811);
  });
});

describe('runAgenticLoop rate-limit propagation (INT-1906 blocker)', () => {
  it('re-throws a 429 raised by callApi as a RateLimitError', async () => {
    // The in-process adapters surface a 429 by throwing from callApi. The loop
    // used to swallow it into finalText; it must now propagate so the pipeline
    // pauses instead of returning a normal failed result.
    const callApi = async () => {
      throw new Error('OpenRouter API error (429): {"error":{"message":"Rate limit exceeded"}}');
    };
    await expect(
      runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 't', callApi, webTools: false, maxTurns: 2 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('re-throws an INFRA error (undici fetch failed) instead of a fake empty success (INT-2520)', async () => {
    // Local/in-process adapters used to have a connection-refused swallowed into a
    // finalText='API error…' → exitCode:0 fake success → reviewer reject → STUCK.
    // It must now propagate so the pipeline classifies it infra_error (not STUCK).
    const callApi = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    await expect(
      runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 't', callApi, webTools: false, maxTurns: 2 }),
    ).rejects.toThrow(/fetch failed/);
  });

  // The preserve-progress property this has guarded since INT-2520: an error that is
  // neither a rate limit nor infra must not kill a run that has already caused a SIDE
  // EFFECT, because a worker may have edited files or run commands that throwing
  // would discard. AGT-4215 moved the boundary rather than removing the property —
  // it is now keyed on that side effect (editToolCount / executedCommands) instead of
  // on a turn counter, so a read-only run, which can never acquire one, is never
  // silently handed an error string as its "result".
  it('does NOT re-throw an ordinary API error once the run has done real work', async () => {
    let n = 0;
    const callApi = async () => {
      n += 1;
      if (n === 1) {
        return {
          choices: [{
            message: { role: 'assistant', content: null, tool_calls: [
              { id: 'c1', type: 'function' as const, function: { name: 'bash', arguments: JSON.stringify({ command: 'echo agt4215' }) } },
            ] },
            finish_reason: 'tool_calls',
          }],
        };
      }
      throw new Error('the model returned malformed JSON');
    };
    const res = await runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 't', callApi: callApi as never, webTools: false, maxTurns: 3 });
    expect(res.executedCommands.length).toBeGreaterThan(0);
    expect(res.text).toContain('API error');
  });

  // The read-only case the turn-based first cut missed: a reviewer has no edit or
  // bash tool, so it can never accumulate progress. A failure on its SECOND call
  // must still propagate, or the operator gets "no parseable verdict" one turn later.
  it('re-throws when a later call fails but the run never produced a side effect', async () => {
    let n = 0;
    const callApi = async () => {
      n += 1;
      if (n === 1) {
        return {
          choices: [{
            message: { role: 'assistant', content: null, tool_calls: [
              { id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: 'nope.ts' }) } },
            ] },
            finish_reason: 'tool_calls',
          }],
        };
      }
      throw new Error('the model returned malformed JSON');
    };
    await expect(
      runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 't', callApi: callApi as never, webTools: false, maxTurns: 3 }),
    ).rejects.toThrow(/agentic-loop: API call failed with no work to preserve/);
  });

  // The other side of that boundary. Returning this as a normal result gave the
  // caller a "success" whose entire body was an error string; parseReviewerResult
  // then reported "no parseable verdict" and the CLI blamed the adapter. Measured
  // on 14/14 audit areas where the real cause was a 402 billing failure. (AGT-4215)
  it('re-throws an ordinary API error that kills the FIRST call', async () => {
    const callApi = async () => { throw new Error('the model returned malformed JSON'); };
    await expect(
      runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 't', callApi, webTools: false, maxTurns: 2 }),
    ).rejects.toThrow(/agentic-loop: API call failed with no work to preserve/);
  });

  // And it must be classified as infra, or each in-process adapter's own catch
  // re-swallows it into {exitCode: 1, stdout: ''} — spawnCli does not inspect
  // exitCode for adapters implementing run(), so the empty stdout would reach the
  // parser and reproduce the very message this fix removes. (AGT-4215)
  it('marks that first-call failure as infra so every layer re-throws it', async () => {
    const callApi = async () => { throw new Error('the model returned malformed JSON'); };
    const err = await runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 't', callApi, webTools: false, maxTurns: 2 })
      .then(() => null, (e: unknown) => e);
    expect(isInfraError(err)).toBe(true);
  });

  // End-to-end shape of the reported incident: the upstream 402 arrives on call #1.
  // It must surface as a RateLimitError (pause + a billing message), never as a
  // swallowed result the reviewer parser turns into "no parseable verdict".
  it('surfaces an upstream "insufficient balance" 402 on the first call as a rate limit', async () => {
    const callApi = async () => {
      // Verbatim shape: the phrase arrives nested inside a JSON string, so the real
      // bytes carry backslashes — \"msg\":\"insufficient balance\".
      throw new Error(String.raw`OpenRouter API error (402): {"error":{"message":"Provider returned error","code":402,"metadata":{"raw":"{\"code\":402,\"msg\":\"insufficient balance\"}","provider_name":"AtlasCloud","is_byok":true}}}`);
    };
    await expect(
      runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 't', callApi, webTools: false, maxTurns: 2 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('preserves a TYPED RateLimitError whose human message detectRateLimit would miss (INT-2519)', async () => {
    // codexResponses throws rateLimitFromCodexHeaders → a typed RateLimitError whose
    // message ("Codex 100% used of 300min window — resets at …") lacks the raw tokens
    // detectRateLimit scans for. Before the instanceof guard this was stringified,
    // failed re-detection, and became a 2s empty "success" → 55% HALT → false STUCK.
    const callApi = async () => {
      throw new RateLimitError(1782824950, 'Codex 100% used of 300min window — resets at 2026-06-30T12:00:00.000Z', 100, 300);
    };
    await expect(
      runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 't', callApi, webTools: false, maxTurns: 2 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('propagates an UNTYPED rate limit thrown from the final-answer salvage turn (INT-2519)', async () => {
    // Drive the loop to exhaust maxTurns with no final text (tool calls only), so the
    // final-answer salvage call fires. That call throws an untyped 429 — it must
    // propagate, not be swallowed like an ordinary error.
    let n = 0;
    const callApi = async (_messages: unknown, tools: unknown[]) => {
      if (Array.isArray(tools) && tools.length === 0) {
        // salvage call (tools stripped) → untyped rate-limit error
        throw new Error('HTTP 429 — rate limit exceeded, retry later');
      }
      n += 1;
      return {
        choices: [{
          message: { role: 'assistant', content: null, tool_calls: [
            { id: `c${n}`, type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: `nope${n}.ts` }) } },
          ] },
          finish_reason: 'tool_calls',
        }],
      };
    };
    await expect(
      runAgenticLoop({ prompt: 'x', cwd: process.cwd(), model: 't', callApi: callApi as never, webTools: false, maxTurns: 2 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('rateLimitFromCodexHeaders (INT-2192)', () => {
  it('extracts reset/used/window from x-codex-* headers', () => {
    const headers = new Headers({
      'x-codex-primary-reset-at': '1782824950',
      'x-codex-primary-used-percent': '100',
      'x-codex-primary-window-minutes': '300',
    });
    const err = rateLimitFromCodexHeaders(headers, '');
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.resetsAt).toBe(1782824950);
    expect(err.usedPercent).toBe(100);
    expect(err.windowMinutes).toBe(300);
    expect(err.message).toContain('100% used');
  });

  it('falls back to the body resets_at when headers are absent', () => {
    const err = rateLimitFromCodexHeaders(new Headers(), '{"error":{"type":"usage_limit_reached","resets_at":1782824949}}');
    expect(err.resetsAt).toBe(1782824949);
    expect(err.usedPercent).toBeUndefined();
  });
});

describe('classifyLimitResponse — spent quota vs short-window throttle (INT-2907)', () => {
  it('treats a body quota signature as a spent quota', () => {
    const c = classifyLimitResponse(new Headers(), '{"error":{"type":"usage_limit_reached","resets_at":1782824949}}');
    expect(c.quota).toBe(true);
  });

  it('treats a 100%-consumed primary window as a spent quota even with a bare body', () => {
    const c = classifyLimitResponse(new Headers({ 'x-codex-primary-used-percent': '100' }), 'Too Many Requests');
    expect(c.quota).toBe(true);
    expect(c.usedPercent).toBe(100);
  });

  it('treats a plain concurrency 429 as a throttle, not a quota', () => {
    // The exact production shape: quota to spare, but 16 subagents at once.
    const c = classifyLimitResponse(new Headers({ 'x-codex-primary-used-percent': '12' }), '{"error":{"message":"Too many requests"}}');
    expect(c.quota).toBe(false);
    expect(c.usedPercent).toBe(12);
  });

  it('does not promote rate_limit_exceeded (a throttle code) to a quota', () => {
    expect(classifyLimitResponse(new Headers(), '{"code":"rate_limit_exceeded"}').quota).toBe(false);
  });

  it('does not call a bare 402 a spent quota — only a credit signature does (INT-2520 contract)', () => {
    // "Payment Required" is also used for auth/billing states that are not
    // exhaustion; pausing the scheduler on those is the regression this guards.
    expect(classifyLimitResponse(new Headers(), 'Payment Required').quota).toBe(false);
    expect(classifyLimitResponse(new Headers(), 'Insufficient credits. Add more to continue.').quota).toBe(true);
  });

  it('surfaces Retry-After for the throttle wait', () => {
    expect(classifyLimitResponse(new Headers({ 'retry-after': '7' }), '').retryAfterSeconds).toBe(7);
    expect(classifyLimitResponse(new Headers(), '').retryAfterSeconds).toBeUndefined();
  });
});

describe('resolveLimitResponse gating (INT-2907)', () => {
  const state = () => ({ attempts: 0 });

  it('leaves a non-limit failure to the caller', async () => {
    await expect(resolveLimitResponse('openai', 500, new Headers(), 'Internal Server Error', state())).resolves.toBe('other');
  });

  it('leaves a bare 402 to the caller instead of pausing on it', async () => {
    await expect(resolveLimitResponse('openrouter', 402, new Headers(), 'Payment Required', state())).resolves.toBe('other');
  });

  it('still pauses on the out-of-credits 402 openrouter actually sends', async () => {
    await expect(
      resolveLimitResponse('openrouter', 402, new Headers(), '{"error":{"message":"Insufficient credits. Add more to continue."}}', state()),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  // An upstream BYOK provider proxied through OpenRouter reports ITS balance, in its
  // own words. Before AGT-4215 this matched no signature, so it returned 'other' and
  // the agentic loop swallowed it into a normal result — the operator was told the
  // reviewer produced "no parseable verdict" when the account simply needed topping up.
  it('pauses on a 402 relaying an upstream provider\'s "insufficient balance"', async () => {
    const body = '{"error":{"message":"Provider returned error","code":402,"metadata":'
      + '{"raw":"{\\"code\\":402,\\"msg\\":\\"insufficient balance\\"}","provider_name":"AtlasCloud","is_byok":true}}}';
    await expect(
      resolveLimitResponse('openrouter', 402, new Headers(), body, state()),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('throttle backoff + downstream classification (INT-2907)', () => {
  it('honors Retry-After, caps it, and otherwise escalates the backoff', () => {
    // Backoff carries up to 1s of jitter so concurrent subagents don't retry in lockstep.
    for (const [attempt, base] of [[0, 5_000], [1, 15_000], [2, 40_000]] as const) {
      const wait = throttleWaitMs(attempt);
      expect(wait).toBeGreaterThanOrEqual(base);
      expect(wait).toBeLessThan(base + 1_000);
    }
    expect(throttleWaitMs(0, 7)).toBe(7_000); // Retry-After honored verbatim (no jitter)
    expect(throttleWaitMs(0, 9_999)).toBe(120_000); // capped
    expect(throttleWaitMs(0, 0)).toBeGreaterThanOrEqual(5_000); // bogus Retry-After → backoff
  });

  it('classifies an exhausted throttle budget as infra, never as a rate limit', () => {
    // Wording matters: if this message tripped detectRateLimit it would be
    // re-promoted downstream and abort the whole review --max run again.
    const msg = 'throttle-retry: codex still limited (HTTP 429, window 42% used) after 3 retries';
    expect(matchesRateLimitMessage(msg)).toBe(false);
    expect(detectRateLimit('', msg)).toBeNull();
    expect(isInfraError(new Error(msg))).toBe(true);
  });
});
