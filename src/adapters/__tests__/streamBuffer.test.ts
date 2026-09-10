import { describe, it, expect } from 'vitest';
import { SmartStreamBuffer } from '../streamBuffer.js';
import { extractResultFromStreamJson } from '../../agents/cliStreamParser.js';
import { extractCostFromStreamJson } from '../../support/costTracker.js';

// Helper: build an NDJSON line for a given event
function ndjson(event: Record<string, unknown>): string {
  return JSON.stringify(event) + '\n';
}

describe('SmartStreamBuffer', () => {
  it('handles empty input', () => {
    const buf = new SmartStreamBuffer();
    const stdout = buf.buildFilteredStdout();
    expect(stdout).toBe('');

    const info = buf.getSizeInfo();
    expect(info.rawBytes).toBe(0);
    expect(info.filteredBytes).toBe(0);
    expect(info.savingsPercent).toBe(0);
  });

  it('preserves result events verbatim', () => {
    const resultEvent = {
      type: 'result',
      result: 'Task completed successfully',
      total_cost_usd: 0.05,
      usage: { input_tokens: 1000, output_tokens: 500 },
      duration_ms: 12000,
    };
    const buf = new SmartStreamBuffer();
    buf.processChunk(ndjson(resultEvent));

    const stdout = buf.buildFilteredStdout();
    const lines = stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('result');
    expect(parsed.result).toBe('Task completed successfully');
    expect(parsed.total_cost_usd).toBe(0.05);
  });

  it('extracts only text blocks from assistant events, discarding tool_use', () => {
    const assistantEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I will read the file now.' },
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: '/very/long/path.ts', content: 'x'.repeat(5000) },
          },
          { type: 'text', text: 'The file looks good.' },
        ],
      },
    };
    const buf = new SmartStreamBuffer();
    buf.processChunk(ndjson(assistantEvent));

    const stdout = buf.buildFilteredStdout();
    expect(stdout).toContain('I will read the file now.');
    expect(stdout).toContain('The file looks good.');
    expect(stdout).not.toContain('x'.repeat(100));
    expect(stdout).not.toContain('tool_use');
  });

  it('discards tool_result and system events', () => {
    const events = [
      ndjson({ type: 'system', message: 'initializing...' }),
      ndjson({ type: 'tool_result', content: 'file contents here...' }),
      ndjson({
        type: 'content_block_start',
        content_block: { type: 'text', text: '' },
      }),
      ndjson({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'delta text' },
      }),
      ndjson({ type: 'content_block_stop' }),
      ndjson({
        type: 'result',
        result: 'done',
        total_cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    ];

    const buf = new SmartStreamBuffer();
    for (const e of events) {
      buf.processChunk(e);
    }

    const stdout = buf.buildFilteredStdout();
    const lines = stdout.split('\n').filter(Boolean);
    // Only the result event should remain
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).type).toBe('result');
  });

  it('achieves significant savings with large tool_use input', () => {
    const largeInput = 'x'.repeat(10240); // 10KB of tool input
    const events = [
      ndjson({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Reading file...' },
            { type: 'tool_use', name: 'Read', input: { content: largeInput } },
          ],
        },
      }),
      ndjson({
        type: 'result',
        result: 'done',
        total_cost_usd: 0.02,
        usage: { input_tokens: 500, output_tokens: 200 },
      }),
    ];

    const buf = new SmartStreamBuffer();
    for (const e of events) {
      buf.processChunk(e);
    }

    const info = buf.getSizeInfo();
    expect(info.rawBytes).toBeGreaterThan(10000);
    expect(info.filteredBytes).toBeLessThan(info.rawBytes);
    expect(info.savingsPercent).toBeGreaterThan(50);
  });

  it('handles chunked input (incomplete lines)', () => {
    const fullLine = JSON.stringify({
      type: 'result',
      result: 'chunked test',
      total_cost_usd: 0.03,
      usage: { input_tokens: 200, output_tokens: 100 },
    });

    // Split the line in the middle
    const mid = Math.floor(fullLine.length / 2);
    const chunk1 = fullLine.slice(0, mid);
    const chunk2 = fullLine.slice(mid) + '\n';

    const buf = new SmartStreamBuffer();
    buf.processChunk(chunk1);
    buf.processChunk(chunk2);

    const stdout = buf.buildFilteredStdout();
    const lines = stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.result).toBe('chunked test');
  });

  it('buildFilteredStdout is compatible with extractResultFromStreamJson', () => {
    const events = [
      ndjson({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Working on task...' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
      ndjson({
        type: 'result',
        result: '{"success":true,"summary":"All tests pass"}',
        total_cost_usd: 0.04,
        usage: { input_tokens: 800, output_tokens: 300 },
      }),
    ];

    const buf = new SmartStreamBuffer();
    for (const e of events) {
      buf.processChunk(e);
    }

    const stdout = buf.buildFilteredStdout();
    const resultText = extractResultFromStreamJson(stdout);
    expect(resultText).toBe('{"success":true,"summary":"All tests pass"}');
  });

  it('buildFilteredStdout is compatible with extractCostFromStreamJson', () => {
    const events = [
      ndjson({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'hello' }],
        },
      }),
      ndjson({
        type: 'result',
        result: 'done',
        total_cost_usd: 0.0567,
        usage: {
          input_tokens: 1200,
          output_tokens: 800,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 50,
        },
        duration_ms: 15000,
        model: 'claude-sonnet-4-5-20250929',
      }),
    ];

    const buf = new SmartStreamBuffer();
    for (const e of events) {
      buf.processChunk(e);
    }

    const stdout = buf.buildFilteredStdout();
    const costInfo = extractCostFromStreamJson(stdout);
    expect(costInfo).toBeDefined();
    expect(costInfo!.costUsd).toBe(0.0567);
    expect(costInfo!.inputTokens).toBe(1200);
    expect(costInfo!.outputTokens).toBe(800);
    expect(costInfo!.cacheReadTokens).toBe(100);
    expect(costInfo!.cacheCreationTokens).toBe(50);
    expect(costInfo!.durationMs).toBe(15000);
    expect(costInfo!.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('calculates savings percent correctly', () => {
    const buf = new SmartStreamBuffer();

    // Small text event
    const textEvent = ndjson({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ok' }] },
    });

    // Large tool_use event (raw bytes are large, filtered is small)
    const toolEvent = ndjson({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { content: 'y'.repeat(1000) } },
        ],
      },
    });

    // Result
    const resultEvent = ndjson({
      type: 'result',
      result: 'done',
      total_cost_usd: 0.01,
    });

    buf.processChunk(textEvent);
    buf.processChunk(toolEvent);
    buf.processChunk(resultEvent);

    const info = buf.getSizeInfo();
    expect(info.rawBytes).toBeGreaterThan(0);
    expect(info.filteredBytes).toBeGreaterThan(0);
    expect(info.filteredBytes).toBeLessThan(info.rawBytes);
    // Savings should be positive since we dropped the tool_use content
    expect(info.savingsPercent).toBeGreaterThan(0);
    expect(info.savingsPercent).toBeLessThan(100);
  });

  it('handles multiple result events (uses last one)', () => {
    const buf = new SmartStreamBuffer();

    buf.processChunk(ndjson({
      type: 'result',
      result: 'intermediate',
      total_cost_usd: 0.01,
    }));
    buf.processChunk(ndjson({
      type: 'result',
      result: 'final result',
      total_cost_usd: 0.05,
    }));

    const stdout = buf.buildFilteredStdout();
    const lines = stdout.split('\n').filter(Boolean);
    // Both result events should be present
    expect(lines).toHaveLength(2);
    expect(stdout).toContain('intermediate');
    expect(stdout).toContain('final result');
  });

  it('keeps sustained streams bounded while preserving newest context', () => {
    const buf = new SmartStreamBuffer();
    for (let i = 0; i < 400; i++) {
      buf.processChunk(ndjson({ type: 'assistant', message: { content: [{ type: 'text', text: `${i}:` + 'x'.repeat(2000) }] } }));
      buf.processChunk(ndjson({ type: 'result', result: `result-${i}` }));
    }
    const stdout = buf.buildFilteredStdout();
    expect(Buffer.byteLength(stdout)).toBeLessThan(300 * 1024);
    expect(stdout).toContain('399:');
    expect(stdout).not.toContain('"text":"0:' + 'x'.repeat(100));
    expect(stdout.split('\n').filter((line) => JSON.parse(line).type === 'result')).toHaveLength(8);
  });

  it('caps a single oversized result event rather than retaining it verbatim', () => {
    const buf = new SmartStreamBuffer();
    const huge = 'H'.repeat(200_000);
    buf.processChunk(ndjson({
      type: 'result',
      result: huge,
      total_cost_usd: 0.01,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const stdout = buf.buildFilteredStdout();
    expect(Buffer.byteLength(stdout, 'utf8')).toBeLessThanOrEqual(64 * 1024 + 64);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.type).toBe('result');
    expect(parsed.total_cost_usd).toBe(0.01);
    expect(String(parsed.result).length).toBeLessThan(huge.length);
    expect(String(parsed.result)).toContain('[truncated]');
  });

  it('handles non-JSON lines gracefully', () => {
    const buf = new SmartStreamBuffer();
    buf.processChunk('this is not json\n');
    buf.processChunk('{"type":"result","result":"ok"}\n');

    const stdout = buf.buildFilteredStdout();
    const lines = stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).result).toBe('ok');
  });

  it('flush handles trailing line without newline', () => {
    const buf = new SmartStreamBuffer();
    // Chunk without trailing newline
    buf.processChunk('{"type":"result","result":"trailing"}');

    // Before flush, line is buffered
    let stdout = buf.buildFilteredStdout();
    expect(stdout).toContain('trailing');

    // flush is called internally by buildFilteredStdout
    const info = buf.getSizeInfo();
    expect(info.filteredBytes).toBeGreaterThan(0);
  });
});
