import { describe, expect, it, vi } from 'vitest';
import {
  buildHermesArgs,
  consultHermesAdvisor,
  isHermesAdvisorEnabled,
  parseAdvisorVerdict,
  parseHermesStream,
  type HermesRunner,
} from './hermesAdvisor.js';

const INIT = JSON.stringify({ type: 'system', subtype: 'init', model: 'deepseek/deepseek-v4-flash-0731', session_id: 's-1' });
const result = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'result', session_id: 's-1', exit_code: 0, text,
  tokens: { input: 10, output: 5, total: 15 }, duration_ms: 1234, ...extra,
});
const stream = (text: string) => [INIT, JSON.stringify({ type: 'text', text: 'x' }), result(text)].join('\n');
const runnerReturning = (stdout: string, over: Partial<Awaited<ReturnType<HermesRunner>>> = {}): HermesRunner =>
  vi.fn(async () => ({ exitCode: 0, stdout, stderr: '', timedOut: false, ...over }));

const QUESTION = { repository: '/repo', taskLabel: 'AGT-1', question: 'Which test runner does this repo use?' };

describe('isHermesAdvisorEnabled', () => {
  it('is off unless explicitly enabled', () => {
    expect(isHermesAdvisorEnabled({})).toBe(false);
    expect(isHermesAdvisorEnabled({ OPENSWARM_HERMES_ADVISOR: 'true' })).toBe(false);
    expect(isHermesAdvisorEnabled({ OPENSWARM_HERMES_ADVISOR: '1' })).toBe(true);
  });
});

describe('buildHermesArgs', () => {
  it('runs a bounded one-shot with a harmless toolset and no user rules', () => {
    const args = buildHermesArgs({ queryFile: '/tmp/q.txt', workDir: '/tmp/w', runBudgetSeconds: 90 });
    expect(args).toEqual(expect.arrayContaining(['chat', '--oneshot', '--format', 'stream-json', '--source', 'tool', '--ignore-rules']));
    expect(args[args.indexOf('--query-file') + 1]).toBe('/tmp/q.txt');
    expect(args[args.indexOf('-t') + 1]).toBe('todo');
    expect(args[args.indexOf('--run-budget') + 1]).toBe('90');
    // Approvals must never be bypassed on the advisor's behalf.
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--accept-hooks');
  });
});

describe('parseHermesStream', () => {
  it('extracts final text and runtime provenance', () => {
    expect(parseHermesStream(stream('{"a":1}'))).toEqual({
      text: '{"a":1}', model: 'deepseek/deepseek-v4-flash-0731', sessionId: 's-1',
      totalTokens: 15, durationMs: 1234, exitCode: 0,
    });
  });
  it('ignores non-JSON lines and returns no text without a result event', () => {
    expect(parseHermesStream(`banner\n${INIT}\n`).text).toBeUndefined();
  });
});

describe('parseAdvisorVerdict', () => {
  it('accepts a confident answer', () => {
    expect(parseAdvisorVerdict('{"decision":"answer","answer":"vitest","confidence":90}'))
      .toEqual({ decision: 'answer', answer: 'vitest', confidence: 90 });
  });
  it('accepts a fenced JSON block', () => {
    expect(parseAdvisorVerdict('```json\n{"decision":"decline","answer":"","confidence":0}\n```')?.decision).toBe('decline');
  });
  it.each([
    ['not json'],
    ['{"decision":"approve","answer":"x","confidence":99}'],
    ['{"decision":"answer","answer":"","confidence":99}'],
    ['{"decision":"answer","answer":"x"}'],
    ['{"decision":"answer","answer":"x","confidence":"high"}'],
  ])('rejects malformed verdict %s', (text) => {
    expect(parseAdvisorVerdict(text)).toBeUndefined();
  });
});

describe('consultHermesAdvisor', () => {
  it('returns an answer with provenance', async () => {
    const runner = runnerReturning(stream('{"decision":"answer","answer":"vitest","confidence":88}'));
    const verdict = await consultHermesAdvisor(QUESTION, { runner });
    expect(verdict).toMatchObject({
      status: 'answered', answer: 'vitest', confidence: 88,
      provenance: { model: 'deepseek/deepseek-v4-flash-0731', sessionId: 's-1', totalTokens: 15, durationMs: 1234 },
    });
    // The question reaches Hermes through a file, never through argv/shell.
    const [args] = (runner as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args.join(' ')).not.toContain('Which test runner');
  });

  it('declines below the confidence floor', async () => {
    const verdict = await consultHermesAdvisor(QUESTION, {
      runner: runnerReturning(stream('{"decision":"answer","answer":"maybe jest","confidence":40}')),
    });
    expect(verdict.status).toBe('declined');
  });

  it('passes an explicit decline through', async () => {
    const verdict = await consultHermesAdvisor(QUESTION, {
      runner: runnerReturning(stream('{"decision":"decline","answer":"needs the operator","confidence":0}')),
    });
    expect(verdict).toMatchObject({ status: 'declined', reason: 'needs the operator' });
  });

  it.each([
    ['timeout', runnerReturning('', { timedOut: true, exitCode: null })],
    ['non-zero exit', runnerReturning(stream('{"decision":"answer","answer":"x","confidence":99}'), { exitCode: 1 })],
    ['malformed verdict', runnerReturning(stream('sure, it is vitest'))],
    ['missing result event', runnerReturning(INIT)],
    ['spawn failure', vi.fn(async () => { throw new Error('ENOENT hermes'); }) as HermesRunner],
  ])('is unavailable on %s', async (_label, runner) => {
    const verdict = await consultHermesAdvisor(QUESTION, { runner });
    expect(verdict.status).toBe('unavailable');
    expect(verdict.answer).toBeUndefined();
  });
});

describe('advisorEnvironment', () => {
  it('passes only what a CLI needs, never OpenSwarm credentials', async () => {
    const { advisorEnvironment } = await import('./hermesAdvisor.js');
    const env = advisorEnvironment({
      PATH: '/bin', HOME: '/h', LC_ALL: 'C', HERMES_HOME: '/hh',
      OLLAMA_API_KEY: 'k', OPENROUTER_API_KEY: 'k', LINEAR_API_KEY: 'k', GITHUB_TOKEN: 't',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', HERMES_HOME: '/hh' });
  });

  it('keeps what a Windows process needs, whatever its casing', async () => {
    const { advisorEnvironment } = await import('./hermesAdvisor.js');
    const env = advisorEnvironment({
      Path: 'C:\\bin', SystemRoot: 'C:\\Windows', PATHEXT: '.CMD', USERPROFILE: 'C:\\u', APPDATA: 'C:\\a', GITHUB_TOKEN: 't',
    });
    expect(Object.keys(env).sort()).toEqual(['APPDATA', 'PATHEXT', 'Path', 'SystemRoot', 'USERPROFILE']);
  });
});

describe('runHermesProcess', () => {
  it('returns on timeout even when a grandchild keeps stdout open', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { runHermesProcess } = await import('./hermesAdvisor.js');
    const dir = mkdtempSync(join(tmpdir(), 'hermes-fake-'));
    const bin = join(dir, 'fake-hermes');
    // The backgrounded sleep inherits stdout; killing only the direct child
    // would leave the pipe open and the promise pending forever.
    writeFileSync(bin, '#!/bin/sh\nsleep 30 &\necho started\nsleep 30\n');
    chmodSync(bin, 0o755);
    try {
      const started = Date.now();
      const run = await runHermesProcess([], { timeoutMs: 1_500, bin });
      expect(run.timedOut).toBe(true);
      expect(run.stdout).toContain('started');
      expect(Date.now() - started).toBeLessThan(6_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
