import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initLocale } from '../locale/index.js';

// Mock the adapter layer so runPlanner exercises the agentic-loop path without a real model.
vi.mock('../adapters/index.js', () => ({
  getAdapter: vi.fn(() => ({ name: 'mock' })),
  spawnCli: vi.fn(),
}));

import { runPlanner } from './planner.js';
import * as adapters from '../adapters/index.js';
import { RateLimitError } from '../adapters/rateLimitError.js';

const mockedSpawnCli = vi.mocked(adapters.spawnCli);

function cliResult(stdout: string, exitCode = 0) {
  return { exitCode, stdout, stderr: exitCode === 0 ? '' : 'boom', durationMs: 1 };
}

const PLAN_JSON =
  '```json\n{"needsDecomposition":true,"subTasks":[{"title":"A","description":"d","estimatedMinutes":20,"priority":2}],"totalEstimatedMinutes":20}\n```';

beforeAll(() => { initLocale('en'); });
afterEach(() => { vi.clearAllMocks(); });

describe('runPlanner — agentic loop migration', () => {
  it('parses a decomposition from the loop plain-text JSON output', async () => {
    mockedSpawnCli.mockResolvedValue(cliResult(`Here is the plan:\n${PLAN_JSON}`) as never);
    const res = await runPlanner({ taskTitle: 'big task', taskDescription: 'do it', projectPath: '/tmp/x' });
    expect(res.success).toBe(true);
    expect(res.needsDecomposition).toBe(true);
    expect(res.subTasks).toHaveLength(1);
    expect(res.subTasks[0].title).toBe('A');
  });

  it('rejects structurally invalid generated tasks with actionable evidence', async () => {
    mockedSpawnCli.mockResolvedValue(cliResult('```json\n{"needsDecomposition":true,"subTasks":[{"title":"","description":"d","estimatedMinutes":0,"priority":9}],"totalEstimatedMinutes":-1}\n```') as never);
    const res = await runPlanner({ taskTitle: 'bad plan', taskDescription: 'do it', projectPath: '/tmp/x' });
    expect(res.success).toBe(false);
    expect(res.needsDecomposition).toBe(false);
    expect(res.subTasks).toEqual([]);
    expect(res.error).toContain('Invalid planner output');
    expect(res.error).toContain('subTasks.0.title');
  });

  it('rejects a decomposition without generated tasks', async () => {
    mockedSpawnCli.mockResolvedValue(cliResult('```json\n{"needsDecomposition":true,"subTasks":[],"totalEstimatedMinutes":20}\n```') as never);
    const res = await runPlanner({ taskTitle: 'empty plan', taskDescription: 'do it', projectPath: '/tmp/x' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('at least one task');
  });

  it('runs read-only and multi-turn (guard appended, maxTurns > 1)', async () => {
    mockedSpawnCli.mockResolvedValue(cliResult(PLAN_JSON) as never);
    await runPlanner({ taskTitle: 't', taskDescription: 'd', projectPath: '/tmp/x' });
    const opts = mockedSpawnCli.mock.calls[0][1];
    expect(opts.prompt).toContain('PLANNING ONLY');
    expect(opts.readOnly).toBe(true);
    expect(opts.maxTurns).toBeGreaterThan(1);
  });

  it('drops a Claude-CLI model id (claude-*) → adapter default', async () => {
    mockedSpawnCli.mockResolvedValue(cliResult(PLAN_JSON) as never);
    await runPlanner({ taskTitle: 't', taskDescription: 'd', projectPath: '/tmp/x', model: 'claude-opus-4-7' });
    expect(mockedSpawnCli.mock.calls[0][1].model).toBeUndefined();
  });

  it('keeps an OpenRouter-style Claude model id (org-prefixed)', async () => {
    mockedSpawnCli.mockResolvedValue(cliResult(PLAN_JSON) as never);
    await runPlanner({ taskTitle: 't', taskDescription: 'd', projectPath: '/tmp/x', model: 'anthropic/claude-opus-4' });
    expect(mockedSpawnCli.mock.calls[0][1].model).toBe('anthropic/claude-opus-4');
  });

  it('returns failure when the adapter errors with no output', async () => {
    mockedSpawnCli.mockResolvedValue(cliResult('', 1) as never);
    const res = await runPlanner({ taskTitle: 't', taskDescription: 'd', projectPath: '/tmp/x' });
    expect(res.success).toBe(false);
    expect(res.error).toBeTruthy();
  });

  // INT-2510: a provider-pinned config id (decomposition.plannerModel 'gpt-5.5')
  // reached `claude -p --model gpt-5.5` and 404'd every decomposition.
  it('drops a foreign provider id for the effective adapter (gpt-5.5 on claude)', async () => {
    vi.mocked(adapters.getAdapter).mockReturnValueOnce({ name: 'claude' } as never);
    mockedSpawnCli.mockResolvedValue(cliResult(PLAN_JSON) as never);
    await runPlanner({ taskTitle: 't', taskDescription: 'd', projectPath: '/tmp/x', model: 'gpt-5.5' });
    expect(mockedSpawnCli.mock.calls[0][1].model).toBeUndefined();
  });

  it('keeps a claude alias on the claude adapter', async () => {
    vi.mocked(adapters.getAdapter).mockReturnValueOnce({ name: 'claude' } as never);
    mockedSpawnCli.mockResolvedValue(cliResult(PLAN_JSON) as never);
    await runPlanner({ taskTitle: 't', taskDescription: 'd', projectPath: '/tmp/x', model: 'sonnet' });
    expect(mockedSpawnCli.mock.calls[0][1].model).toBe('sonnet');
  });

  it('re-throws a RateLimitError instead of flattening it to {success:false} (INT-2521)', async () => {
    // A swallowed rate limit made decomposeTask fall back to direct execution,
    // which hammered the exhausted provider. It must propagate so the pipeline pauses.
    mockedSpawnCli.mockRejectedValue(new RateLimitError(1782824950, 'Codex usage limit reached') as never);
    await expect(
      runPlanner({ taskTitle: 't', taskDescription: 'd', projectPath: '/tmp/x' }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('plan JSON containing braces inside string values', () => {
  const planWith = (description: string) =>
    JSON.stringify({
      needsDecomposition: true,
      subTasks: [{ title: 'A', description, estimatedMinutes: 20, priority: 2 }],
      totalEstimatedMinutes: 20,
    });

  // Brace counting that ignores string literals ends the JSON at the wrong
  // offset, JSON.parse fails, and the whole plan falls through to a lossy text
  // heuristic — the model's actual decomposition is discarded. Descriptions
  // quoting code are ordinary, so this is not an exotic input.
  it.each([
    ['an unmatched closing brace', 'remove the trailing } here'],
    ['an unmatched opening brace', 'starts a block with { here'],
    ['a balanced pair', 'replace if (x) { y } with a switch'],
    ['several braces', '} then { then } again'],
  ])('keeps the plan intact with %s', async (_label, description) => {
    mockedSpawnCli.mockResolvedValue(cliResult(planWith(description)) as never);

    const res = await runPlanner({ taskTitle: 'big task', taskDescription: 'do it', projectPath: '/tmp/x' });

    expect(res.success).toBe(true);
    expect(res.needsDecomposition).toBe(true);
    expect(res.subTasks).toHaveLength(1);
    expect(res.subTasks[0].description).toBe(description);
  });

  it('keeps a plan whose description contains an escaped quote before a brace', async () => {
    const description = 'the \\"guard\\" closes with }';
    mockedSpawnCli.mockResolvedValue(cliResult(planWith(description)) as never);

    const res = await runPlanner({ taskTitle: 'big task', taskDescription: 'do it', projectPath: '/tmp/x' });

    expect(res.success).toBe(true);
    expect(res.subTasks[0].description).toBe(description);
  });

  it('still stops at the end of the first JSON object when trailing prose follows', async () => {
    mockedSpawnCli.mockResolvedValue(
      cliResult(`${planWith('plain')}\n\nThat is the plan. Let me know if } looks wrong.`) as never,
    );

    const res = await runPlanner({ taskTitle: 'big task', taskDescription: 'do it', projectPath: '/tmp/x' });

    expect(res.success).toBe(true);
    expect(res.subTasks).toHaveLength(1);
  });
});
