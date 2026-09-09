// Purpose: useMonitor contains timed-out fetches and clamps the poll interval
// (AGT-3417). The hook is the network/effect boundary for the monitor tabs.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { act } from 'react';
import { Text } from 'ink';
import { useMonitor, clampPollIntervalMs } from './useMonitor.js';
import type { Table } from '../monitorRows.js';

const table: Table = { columns: ['name'], rows: [['a']] };

// Let the effect run / React flush state updates.
const tick = () => new Promise((r) => setTimeout(r, 5));

function Probe({ port, fetcher, intervalMs }: {
  port?: number;
  fetcher: (port: number, signal?: AbortSignal) => Promise<Table>;
  intervalMs?: number;
}) {
  const { table, error, loading } = useMonitor(port, fetcher, intervalMs);
  if (error) return <Text>{`err:${error}`}</Text>;
  if (!table) return <Text>{loading ? 'loading' : 'idle'}</Text>;
  return <Text>{`rows:${table.rows.length}`}</Text>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('clampPollIntervalMs', () => {
  it('clamps below the 100ms floor and above the 5min ceiling', () => {
    expect(clampPollIntervalMs(10)).toBe(100);
    expect(clampPollIntervalMs(1_000_000)).toBe(300_000);
    expect(clampPollIntervalMs(5000)).toBe(5000);
  });

  it('replaces non-finite values with the 5000ms default', () => {
    expect(clampPollIntervalMs(Number.NaN)).toBe(5000);
    expect(clampPollIntervalMs(Number.POSITIVE_INFINITY)).toBe(5000);
    expect(clampPollIntervalMs(undefined)).toBe(5000);
  });
});

describe('useMonitor', () => {
  it('renders fetched rows and clears the error on success', async () => {
    const fetcher = vi.fn(async () => table);
    const r = render(<Probe port={3847} fetcher={fetcher} />);
    await act(tick);
    expect(r.lastFrame()).toContain('rows:1');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected fetch as an error string', async () => {
    const fetcher = vi.fn(async () => { throw new Error('boom'); });
    const r = render(<Probe port={3847} fetcher={fetcher} />);
    await act(tick);
    expect(r.lastFrame()).toContain('err:boom');
  });

  it('aborts a timed-out fetch and lets the next interval start a fresh request', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const aborts: Array<() => void> = [];
    const fetcher = vi.fn((_port: number, signal?: AbortSignal) => new Promise<Table>((_, reject) => {
      calls += 1;
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      aborts.push(() => reject(new Error('never settles on its own')));
    }));
    const r = render(<Probe port={3847} fetcher={fetcher} intervalMs={100} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls).toBe(1);

    // First request hangs; the 15s timeout aborts it, the race rejects, and the
    // finally block clears inFlight so the next tick can start a new request.
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(r.lastFrame()).toContain('timed out');

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(calls).toBe(2); // no fan-out: exactly one new request after the drain
    r.unmount();
  });

  it('does not start a second request while one is in flight', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetcher = vi.fn(async () => { calls += 1; await new Promise(() => {}); });
    const r = render(<Probe port={3847} fetcher={fetcher} intervalMs={100} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(calls).toBe(1); // inFlight guard held across several ticks
    r.unmount();
  });

  it('aborts the in-flight request on unmount', async () => {
    let aborted = false;
    const fetcher = vi.fn((_port: number, signal?: AbortSignal) => new Promise<Table>(() => {
      signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
    }));
    const r = render(<Probe port={3847} fetcher={fetcher} intervalMs={100} />);
    await act(tick);
    r.unmount();
    expect(aborted).toBe(true);
  });
});
