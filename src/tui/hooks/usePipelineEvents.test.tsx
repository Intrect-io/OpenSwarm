// Purpose: usePipelineEvents caps the coalesced SSE batch (AGT-3458). The hook
// is the effect boundary the Pipeline/Logs tabs render from; a burst inside one
// flush window must not accumulate without bound before a single dispatch.
// Batch sizes are observed at the reducer seam (the pure function the hook
// delegates to), because the rendered state caps logs/stages independently.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { act } from 'react';
import { Text } from 'ink';
import { usePipelineEvents } from './usePipelineEvents.js';

// The hook's own batch cap; must agree with usePipelineEvents' MAX_BATCH_EVENTS.
const MAX_BATCH_EVENTS = 256;

const captured = vi.hoisted(() => ({
  onEvent: null as ((e: unknown) => void) | null,
  batchSizes: [] as number[],
}));

vi.mock('../sse.js', () => ({
  connectEventStream: (opts: { onEvent: (e: unknown) => void }) => {
    captured.onEvent = opts.onEvent;
    return { close: () => { captured.onEvent = null; } };
  },
}));

vi.mock('../pipelineEvents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pipelineEvents.js')>();
  return {
    ...actual,
    reducePipelineEvents: (state: Parameters<typeof actual.reducePipelineEvents>[0], events: Parameters<typeof actual.reducePipelineEvents>[1]) => {
      captured.batchSizes.push(events.length);
      return actual.reducePipelineEvents(state, events);
    },
  };
});

function Probe({ port, flushMs }: { port?: number; flushMs?: number }) {
  const { logs } = usePipelineEvents(port, flushMs);
  return <Text>{`logs:${logs.length}`}</Text>;
}

const logEvent = (line: string) => ({ type: 'log', data: { taskId: 't1', stage: 'worker', line } });

afterEach(() => {
  captured.onEvent = null;
  captured.batchSizes = [];
  vi.useRealTimers();
});

describe('usePipelineEvents batch bounds (AGT-3458)', () => {
  it('flushes a flood in bounded slices instead of one unbounded batch', async () => {
    vi.useFakeTimers();
    render(<Probe port={1} flushMs={90} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(captured.onEvent).not.toBeNull();

    await act(async () => {
      for (let i = 0; i < 600; i += 1) captured.onEvent!(logEvent(`line ${i}`));
      await vi.advanceTimersByTimeAsync(0);
    });
    // Slices, not a single 600-event dispatch: the cap forces the first slices,
    // the tail waits for the window.
    expect(captured.batchSizes.length).toBeGreaterThan(1);
    expect(Math.max(...captured.batchSizes)).toBeLessThanOrEqual(MAX_BATCH_EVENTS);

    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    // Every event still reached the reducer, in order.
    expect(captured.batchSizes.reduce((a, b) => a + b, 0)).toBe(600);
  });

  it('reduces a normal single event as before', async () => {
    vi.useFakeTimers();
    const r = render(<Probe port={1} flushMs={90} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    await act(async () => {
      captured.onEvent!(logEvent('only'));
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(captured.batchSizes).toEqual([1]);
    expect(r.lastFrame()).toBe('logs:1');
  });

  it('stays idle without a port', () => {
    expect(render(<Probe />).lastFrame()).toBe('logs:0');
  });
});
