// ============================================
// OpenSwarm - Turn ceiling (AGT-4388)
// Created: 2026-09-17
// Purpose: `maxTurns: 0` lifts the ceiling; a positive value still caps the run.
// Dependencies: vitest
// Test Status: npm test -- src/adapters/agenticLoop.turns.test.ts
// ============================================

import { describe, expect, it } from 'vitest';
import { runAgenticLoop } from './agenticLoop.js';
describe('maxTurns: 0 lifts the turn ceiling (AGT-4388)', () => {
  const toolCall = (i: number) => ({
    choices: [{
      message: {
        role: 'assistant' as const, content: null,
        tool_calls: [{ id: `c${i}`, type: 'function' as const, function: { name: 'read_file', arguments: JSON.stringify({ path: `nope-${i}.txt` }) } }],
      },
      finish_reason: 'tool_calls',
    }],
  });
  const done = { choices: [{ message: { role: 'assistant' as const, content: 'finished' }, finish_reason: 'stop' }] };

  it('runs past the old default of 20 tool turns and still ends on the model\'s own final answer', async () => {
    let calls = 0;
    const result = await runAgenticLoop({
      prompt: 'x', cwd: process.cwd(), model: 'test', webTools: false, maxTurns: 0,
      callApi: async () => (calls++ < 40 ? toolCall(calls) : done),
    });
    expect(calls).toBe(41);
    expect(result.text).toBe('finished');
  });

  it('a positive maxTurns still caps the run', async () => {
    let calls = 0;
    const logs: string[] = [];
    await runAgenticLoop({
      prompt: 'x', cwd: process.cwd(), model: 'test', webTools: false, maxTurns: 5,
      // The final-answer turn calls with no tools; answer it like a model would.
      callApi: async (_m, tools) => (tools.length === 0 ? done : calls++ < 40 ? toolCall(calls) : done),
      onLog: (l) => logs.push(l),
    });
    expect(calls).toBeLessThan(10);
    expect(logs.some((l) => l.includes('Final answer turn'))).toBe(true);
  });
});
