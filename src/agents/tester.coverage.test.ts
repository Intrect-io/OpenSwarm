// Purpose: additional coverage for the Tester agent beyond the existing
// tester.test.ts (which only covers the INT-2521 fake-pass guard in
// parseTesterOutput). Adds: prompt building (via the prompt forwarded to
// spawnCli), NDJSON/markdown-fence/plain-text output parsing branches,
// runTester's RateLimitError/infra-error passthrough vs generic failure
// result, and the two Discord-formatting helpers (formatTestReport,
// buildTestFixPrompt). spawnCli/getAdapter are mocked; nothing shells out.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerResult } from './agentPair.js';
import type { TesterResult } from './tester.js';

const spawnCli = vi.fn();

vi.mock('../adapters/index.js', () => ({
  getAdapter: () => ({}),
  spawnCli: (...args: unknown[]) => spawnCli(...(args as [])),
}));

const { runTester, parseTesterOutput, formatTestReport, buildTestFixPrompt } = await import('./tester.js');
const { RateLimitError } = await import('../adapters/rateLimitError.js');

const workerResult: WorkerResult = {
  success: true,
  summary: 'Refactored the parser',
  filesChanged: ['src/parser.ts', 'src/index.ts'],
  commands: ['npm run build'],
  output: 'done',
};

function baseOptions(overrides: Partial<Parameters<typeof runTester>[0]> = {}) {
  return {
    taskTitle: 'Refactor parser',
    taskDescription: 'Split the parser into smaller functions.',
    workerResult,
    projectPath: '/repo',
    ...overrides,
  };
}

describe('runTester prompt building', () => {
  beforeEach(() => spawnCli.mockClear());

  it('forwards a Tester Agent prompt with task + worker context to spawnCli', async () => {
    spawnCli.mockResolvedValueOnce({ stdout: '{"type":"result","result":"{\\"success\\":true,\\"testsPassed\\":1,\\"testsFailed\\":0}"}' });
    await runTester(baseOptions());
    expect(spawnCli).toHaveBeenCalledTimes(1);
    const opts = spawnCli.mock.calls[0][1] as { prompt: string; cwd: string };
    expect(opts.prompt).toContain('# Tester Agent');
    expect(opts.prompt).toContain('Refactor parser');
    expect(opts.prompt).toContain('Split the parser into smaller functions.');
    expect(opts.prompt).toContain('src/parser.ts, src/index.ts');
    expect(opts.prompt).toContain('npm run build');
    expect(opts.cwd).toBe('/repo');
  });

  it('truncates a long task description with an ellipsis', async () => {
    spawnCli.mockResolvedValueOnce({ stdout: '{"type":"result","result":"{\\"success\\":true,\\"testsPassed\\":0,\\"testsFailed\\":0}"}' });
    const longDesc = 'y'.repeat(250);
    await runTester(baseOptions({ taskDescription: longDesc }));
    const opts = spawnCli.mock.calls[0][1] as { prompt: string };
    expect(opts.prompt).toContain('y'.repeat(200) + '...');
    expect(opts.prompt).not.toContain('y'.repeat(201));
  });

  it('renders "(none)" for empty filesChanged/commands', async () => {
    spawnCli.mockResolvedValueOnce({ stdout: '{"type":"result","result":"{\\"success\\":true,\\"testsPassed\\":0,\\"testsFailed\\":0}"}' });
    await runTester(baseOptions({ workerResult: { ...workerResult, filesChanged: [], commands: [] } }));
    const opts = spawnCli.mock.calls[0][1] as { prompt: string };
    expect(opts.prompt).toContain('**Files Changed:** (none)');
    expect(opts.prompt).toContain('**Commands (self-reported, execution not observable):** (none)');
  });

  it('forwards timeoutMs, model, and maxTurns through to spawnCli', async () => {
    spawnCli.mockResolvedValueOnce({ stdout: '{"type":"result","result":"{\\"success\\":true,\\"testsPassed\\":0,\\"testsFailed\\":0}"}' });
    await runTester(baseOptions({ timeoutMs: 60000, model: 'gpt-5', maxTurns: 8 }));
    const opts = spawnCli.mock.calls[0][1] as { timeoutMs?: number; model?: string; maxTurns?: number };
    expect(opts.timeoutMs).toBe(60000);
    expect(opts.model).toBe('gpt-5');
    expect(opts.maxTurns).toBe(8);
  });
});

describe('runTester output parsing (via spawnCli stdout)', () => {
  beforeEach(() => spawnCli.mockClear());

  it('parses a fenced ```json block inside a NDJSON "result" event', async () => {
    const ndjson = JSON.stringify({
      type: 'result',
      result: '```json\n{"success":true,"testsPassed":12,"testsFailed":0,"coverage":91.2,"suggestions":["add edge case tests"]}\n```',
    });
    spawnCli.mockResolvedValueOnce({ stdout: ndjson });
    const result = await runTester(baseOptions());
    expect(result.success).toBe(true);
    expect(result.testsPassed).toBe(12);
    expect(result.testsFailed).toBe(0);
    expect(result.coverage).toBe(91.2);
    expect(result.suggestions).toEqual(['add edge case tests']);
  });

  it('parses an unfenced JSON object via brace-depth balancing, including failedTests/error', async () => {
    const ndjson = JSON.stringify({
      type: 'result',
      result: 'Preamble. {"success":false,"testsPassed":3,"testsFailed":2,"failedTests":["t1","t2"],"error":"assertion mismatch"} trailing',
    });
    spawnCli.mockResolvedValueOnce({ stdout: ndjson });
    const result = await runTester(baseOptions());
    expect(result.success).toBe(false);
    expect(result.testsPassed).toBe(3);
    expect(result.testsFailed).toBe(2);
    expect(result.failedTests).toEqual(['t1', 't2']);
    expect(result.error).toBe('assertion mismatch');
  });

  it('reads text from an item.completed agent_message event when there is no "result" event', async () => {
    const ndjson = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '```json\n{"success":true,"testsPassed":5,"testsFailed":0}\n```' },
    });
    spawnCli.mockResolvedValueOnce({ stdout: ndjson });
    const result = await runTester(baseOptions());
    expect(result.success).toBe(true);
    expect(result.testsPassed).toBe(5);
  });

  it('falls back to text extraction when the JSON block is malformed', async () => {
    const ndjson = JSON.stringify({
      type: 'result',
      result: '```json\n{ not valid json }\n```\n7 passed, 0 failed. Coverage: 88.0%',
    });
    spawnCli.mockResolvedValueOnce({ stdout: ndjson });
    const result = await runTester(baseOptions());
    expect(result.success).toBe(true);
    expect(result.testsPassed).toBe(7);
    expect(result.coverage).toBe(88.0);
  });

  it('falls back to plain-text extraction when stdout has no NDJSON at all', async () => {
    spawnCli.mockResolvedValueOnce({
      stdout: '1 failed, 4 passed in 2.3s\nFAILED test_mod.py::test_x - AssertionError\ncoverage: 55%',
    });
    const result = await runTester(baseOptions());
    expect(result.success).toBe(false);
    expect(result.testsPassed).toBe(4);
    expect(result.testsFailed).toBe(1);
    expect(result.coverage).toBe(55);
    expect(result.failedTests).toEqual(['test_mod.py::test_x']);
  });

  it('extracts and logs cost info when the result event carries usage/cost fields', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ndjson = JSON.stringify({
      type: 'result',
      result: '{"success":true,"testsPassed":1,"testsFailed":0}',
      total_cost_usd: 0.0456,
      usage: { input_tokens: 300, output_tokens: 100 },
      duration_ms: 2100,
    });
    spawnCli.mockResolvedValueOnce({ stdout: ndjson });
    const result = await runTester(baseOptions());
    expect(result.costInfo).toBeDefined();
    expect(result.costInfo!.costUsd).toBeCloseTo(0.0456);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[Tester] Cost:'));
    logSpy.mockRestore();
  });

  it('defaults missing numeric/array fields when normalizing a parsed JSON result', async () => {
    const ndjson = JSON.stringify({ type: 'result', result: '{"success":true}' });
    spawnCli.mockResolvedValueOnce({ stdout: ndjson });
    const result = await runTester(baseOptions());
    expect(result.testsPassed).toBe(0);
    expect(result.testsFailed).toBe(0);
    expect(result.coverage).toBeUndefined();
    expect(result.failedTests).toBeUndefined();
    expect(result.suggestions).toBeUndefined();
  });
});

describe('runTester error handling (INT-2521 infra vs task-verdict distinction)', () => {
  beforeEach(() => spawnCli.mockClear());

  it('rethrows RateLimitError without wrapping it into a failure result', async () => {
    spawnCli.mockRejectedValueOnce(new RateLimitError(999, 'quota exceeded'));
    await expect(runTester(baseOptions())).rejects.toBeInstanceOf(RateLimitError);
  });

  it('rethrows an infra-classified error (CLI non-zero exit) instead of reporting "tests failed"', async () => {
    spawnCli.mockRejectedValueOnce(new Error('claude CLI failed with code 1'));
    await expect(runTester(baseOptions())).rejects.toThrow('claude CLI failed with code 1');
  });

  it('returns a failure TesterResult for a genuine (non-infra) error', async () => {
    spawnCli.mockRejectedValueOnce(new Error('unexpected null pointer in worker diff'));
    const result = await runTester(baseOptions());
    expect(result.success).toBe(false);
    expect(result.testsPassed).toBe(0);
    expect(result.testsFailed).toBe(0);
    expect(result.output).toBe('');
    expect(result.error).toBe('unexpected null pointer in worker diff');
  });

  it('stringifies a non-Error throw', async () => {
    spawnCli.mockRejectedValueOnce('a plain string rejection');
    const result = await runTester(baseOptions());
    expect(result.success).toBe(false);
    expect(result.error).toBe('a plain string rejection');
  });

  it('recovers when the CLI resolves with a non-string stdout (defensive parse-error path)', async () => {
    // A malformed adapter result (stdout missing/non-string) makes `output.split`
    // throw inside parseTesterOutput's NDJSON scan; this exercises its outer catch
    // (console.error + extractFromText fallback), which itself throws again on a
    // null input and is caught one level up by runTester's isInfraError/generic path.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    spawnCli.mockResolvedValueOnce({ stdout: null as unknown as string });
    const result = await runTester(baseOptions());
    expect(result.success).toBe(false);
    expect(result.output).toBe('');
    errorSpy.mockRestore();
  });
});

describe('parseTesterOutput additional branches', () => {
  it('returns null from the unfenced brace-balanced parse when the sliced text is still invalid JSON', () => {
    // Wrap in an NDJSON "result" event so extractResultJson (not the outer
    // extractFromText-only path) is actually exercised. Python-style `True`
    // keeps the braces balanced but is invalid JSON, so JSON.parse still
    // throws after the depth-balancing slice.
    const ndjson = JSON.stringify({
      type: 'result',
      result: 'noise {"success": True} noise, 3 passed',
    });
    const result = parseTesterOutput(ndjson);
    // extractResultJson returns null (invalid JSON even after brace-balancing) -> falls to extractFromText.
    expect(result.testsPassed).toBe(3);
  });

  it('extracts an error message using the "keyword: message" pattern', () => {
    const result = parseTesterOutput('Error: could not resolve module "./missing.js"\n1 failed');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/could not resolve module/);
  });

  it('falls back to a raw matching line when no colon pattern is present', () => {
    const result = parseTesterOutput('Something failed unexpectedly\nno further detail');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Something failed unexpectedly');
  });

  it('falls back to "Unknown error" when hasError is true but no line literally contains error/fail', () => {
    const result = parseTesterOutput('Exception occurred while parsing, nothing else notable');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown error');
  });
});

describe('formatTestReport', () => {
  function baseResult(overrides: Partial<TesterResult> = {}): TesterResult {
    return { success: true, testsPassed: 10, testsFailed: 0, output: '', ...overrides };
  }

  it('renders a passing report with coverage', () => {
    const text = formatTestReport(baseResult({ coverage: 91.256 }));
    expect(text).toContain('✅ **Tester Result: PASS**');
    expect(text).toContain('**Passed:** 10 | **Failed:** 0');
    expect(text).toContain('**Coverage:** 91.3%');
  });

  it('renders a failing report without a coverage line when coverage is undefined', () => {
    const text = formatTestReport(baseResult({ success: false, testsPassed: 2, testsFailed: 3 }));
    expect(text).toContain('❌ **Tester Result: FAIL**');
    expect(text).not.toContain('**Coverage:**');
  });

  it('lists up to 5 failed tests and an overflow count beyond that', () => {
    const failedTests = Array.from({ length: 7 }, (_, i) => `test_${i}`);
    const text = formatTestReport(baseResult({ success: false, failedTests }));
    expect(text).toContain('**Failed Tests:**');
    for (const t of failedTests.slice(0, 5)) expect(text).toContain(`\`${t}\``);
    expect(text).toContain('... +2 more');
    expect(text).not.toContain('`test_5`');
  });

  it('lists up to 3 suggestions', () => {
    const suggestions = ['s1', 's2', 's3', 's4'];
    const text = formatTestReport(baseResult({ suggestions }));
    expect(text).toContain('**Suggestions:**');
    expect(text).toContain('s1');
    expect(text).toContain('s3');
    expect(text).not.toContain('s4');
  });

  it('includes an error line when present', () => {
    const text = formatTestReport(baseResult({ success: false, error: 'runner crashed' }));
    expect(text).toContain('**Error:** runner crashed');
  });
});

describe('buildTestFixPrompt', () => {
  function baseResult(overrides: Partial<TesterResult> = {}): TesterResult {
    return { success: false, testsPassed: 2, testsFailed: 3, output: '', ...overrides };
  }

  it('lists failed tests and fix suggestions with numbering', () => {
    const prompt = buildTestFixPrompt(baseResult({
      failedTests: ['test_a', 'test_b'],
      suggestions: ['Check null handling', 'Add missing import'],
    }));
    expect(prompt).toContain('## Test Failures');
    expect(prompt).toContain('**Passed:** 2 | **Failed:** 3');
    expect(prompt).toContain('### Failed Tests:');
    expect(prompt).toContain('1. `test_a`');
    expect(prompt).toContain('2. `test_b`');
    expect(prompt).toContain('### Fix Suggestions:');
    expect(prompt).toContain('1. Check null handling');
    expect(prompt).toContain('2. Add missing import');
    expect(prompt).toContain('Fix the above test failures.');
  });

  it('omits the Failed Tests / Fix Suggestions sections when absent', () => {
    const prompt = buildTestFixPrompt(baseResult());
    expect(prompt).not.toContain('### Failed Tests:');
    expect(prompt).not.toContain('### Fix Suggestions:');
    expect(prompt).toContain('Fix the above test failures.');
  });
});
