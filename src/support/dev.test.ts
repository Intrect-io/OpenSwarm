import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RunOptions = {
  prompt: string;
  cwd: string;
  timeoutMs: number;
  maxTurns?: number;
  signal?: AbortSignal;
  baseEnv?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
};
type RunResult = { success: boolean; stdout: string; resultText: string; error?: string };

const runs = vi.hoisted(() => ({
  list: [] as Array<{ options: RunOptions; finish: (r: RunResult) => void; fail: (e: Error) => void }>,
}));
const runClaudeTaskMock = vi.hoisted(() => vi.fn());

vi.mock('../adapters/claudeTask.js', () => ({ runClaudeTask: runClaudeTaskMock }));

import { DEV_TASK_OUTPUT_MAX_CHARS, cancelTask, getActiveTasks, runDevTask } from './dev.js';

describe('runDevTask on runClaudeTask', () => {
  let repo: string;
  const savedLinear = process.env.LINEAR_API_KEY;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'openswarm-dev-'));
    runs.list = [];
    runClaudeTaskMock.mockReset();
    runClaudeTaskMock.mockImplementation((options: RunOptions) => new Promise<RunResult>((resolve, reject) => {
      runs.list.push({ options, finish: resolve, fail: reject });
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(repo, { recursive: true, force: true });
    if (savedLinear === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = savedLinear;
  });

  it('returns before the run completes, then streams lines and completes once', async () => {
    const progress: string[] = [];
    const onComplete = vi.fn();
    const started = await runDevTask(repo, 'fix it', 'tester', (c) => progress.push(c), onComplete, true);
    expect('taskId' in started).toBe(true);
    expect(onComplete).not.toHaveBeenCalled();
    expect(getActiveTasks()).toHaveLength(1);

    const run = runs.list[0];
    run.options.onLog?.('💭 reading files');
    expect(progress).toEqual(['💭 reading files\n']);

    run.finish({ success: true, stdout: '', resultText: 'Done.' });
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete).toHaveBeenCalledWith('Done.', 0);
    expect(getActiveTasks()).toHaveLength(0);
  });

  it('pins a deadline and a turn cap, and hands the child an allowlisted env', async () => {
    process.env.LINEAR_API_KEY = 'daemon-only-secret';
    await runDevTask(repo, 'fix it', 'tester', undefined, undefined, true);

    const { options } = runs.list[0];
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.maxTurns).toBeGreaterThan(0);
    expect(options.cwd).toBe(repo);
    expect(options.baseEnv).toBeDefined();
    expect(options.baseEnv?.LINEAR_API_KEY).toBeUndefined();
    expect(options.baseEnv?.PATH).toBe(process.env.PATH);

    runs.list[0].finish({ success: true, stdout: '', resultText: '' });
  });

  it('cancel aborts the run but keeps the slot until the run settles', async () => {
    const onComplete = vi.fn();
    const started = await runDevTask(repo, 'fix it', 'tester', undefined, onComplete, true);
    if (!('taskId' in started)) throw new Error('expected a task');

    expect(cancelTask(started.taskId)).toBe(true);
    expect(runs.list[0].options.signal?.aborted).toBe(true);
    expect(getActiveTasks()).toHaveLength(1);
    // A second run for the same repo is refused while the first is shutting down.
    expect(await runDevTask(repo, 'again', 'tester', undefined, undefined, true)).toHaveProperty('error');

    runs.list[0].finish({ success: false, stdout: '', resultText: '', error: 'Dev task cancelled' });
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][0]).toContain('Dev task cancelled');
    expect(onComplete.mock.calls[0][1]).toBe(-1);
    expect(getActiveTasks()).toHaveLength(0);
  });

  it('finalizes even if the runner itself rejects', async () => {
    const onComplete = vi.fn();
    await runDevTask(repo, 'fix it', 'tester', undefined, onComplete, true);
    runs.list[0].fail(new Error('boom'));
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][1]).toBe(-1);
    expect(getActiveTasks()).toHaveLength(0);
  });

  it('retains at most the cap of dev task output and still passes resultText to the completion callback', async () => {
    // Stream roughly three times the cap; every line is numbered so the tail is identifiable.
    const filler = 'x'.repeat(1000);
    const lineCount = Math.ceil((DEV_TASK_OUTPUT_MAX_CHARS * 3) / filler.length);
    const streamLines = (run: (typeof runs.list)[number]): void => {
      for (let i = 0; i < lineCount; i++) run.options.onLog?.(`line-${i} ${filler}`);
    };
    const lastLine = `line-${lineCount - 1} ${filler}`;

    // A successful run hands its resultText to the callback, not the stream.
    const onDone = vi.fn();
    await runDevTask(repo, 'fix it', 'tester', undefined, onDone, true);
    streamLines(runs.list[0]);
    runs.list[0].finish({ success: true, stdout: '', resultText: 'Done.' });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledWith('Done.', 0);

    // The report still quotes the tail of the output.
    const reports = readdirSync(join(repo, 'reports'));
    expect(reports).toHaveLength(1);
    expect(readFileSync(join(repo, 'reports', reports[0]), 'utf8')).toContain(lastLine);

    // With no resultText the callback falls back to the retained output, which is bounded.
    const onFallback = vi.fn();
    await runDevTask(repo, 'fix it', 'tester', undefined, onFallback, true);
    streamLines(runs.list[1]);
    runs.list[1].finish({ success: true, stdout: '', resultText: '' });
    await vi.waitFor(() => expect(onFallback).toHaveBeenCalledTimes(1));
    const [retained, code] = onFallback.mock.calls[0] as [string, number];
    expect(code).toBe(0);
    const marker = retained.indexOf('\n');
    expect(retained.slice(0, marker)).toMatch(/earlier characters of output were not retained/);
    expect(retained.length - marker - 1).toBeLessThanOrEqual(DEV_TASK_OUTPUT_MAX_CHARS);
    expect(retained.endsWith(`${lastLine}\n`)).toBe(true);
    expect(retained).not.toContain('line-0 ');
  });
});
