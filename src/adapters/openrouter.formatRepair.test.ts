// The OpenRouter adapter must hand the caller's format repair to the agentic
// loop — `review --max --adapter openrouter` is where verdict-less answers were
// measured (AGT-4313). Without this, the reviewer asks and nobody listens.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgenticLoopOptions } from './agenticLoop.js';

const captured: { options?: AgenticLoopOptions } = {};
vi.mock('./agenticLoop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agenticLoop.js')>();
  return {
    ...actual,
    runAgenticLoop: vi.fn(async (options: AgenticLoopOptions) => {
      captured.options = options;
      return {
        text: 'Decision: approve', toolCallCount: 0, apiCallCount: 1, totalTokens: 0, inputTokens: 0,
        outputTokens: 0, cachedTokens: 0, costUsd: 0, meteredCalls: 0, durationMs: 1, executedCommands: [],
      };
    }),
  };
});

const { OpenRouterCliAdapter } = await import('./openrouter.js');

describe('OpenRouter forwards finalAnswerRepair to the loop (AGT-4313)', () => {
  const prev = process.env.OPENROUTER_API_KEY;
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
  });

  it('passes the repair through unchanged', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const repair = { needsRepair: () => true, prompt: 'restate it' };
    await new OpenRouterCliAdapter().run({ prompt: 'review', cwd: process.cwd(), model: 'x/y', readOnly: true, finalAnswerRepair: repair });
    expect(captured.options?.finalAnswerRepair).toBe(repair);
  });
});
