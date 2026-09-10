// ============================================
// OpenSwarm - useMonitor (EPIC INT-1813 S6 / INT-1939)
// Polls a monitor fetcher on an interval. Network/effect boundary — the mappers
// it renders are pure + tested.
// ============================================

import { useEffect, useState } from 'react';
import type { Table } from '../monitorRows.js';

const MONITOR_REQUEST_TIMEOUT_MS = 15_000;

// Clamp the poll interval to safe finite bounds: below 100ms the polling loop
// can starve the TUI render loop, and non-finite values (NaN/Infinity) would
// make setInterval fire immediately/never. Above 5 min a stale tab just polls
// rarely — still valid, so it is the upper bound.
const MIN_POLL_INTERVAL_MS = 100;
const MAX_POLL_INTERVAL_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 5000;

export function clampPollIntervalMs(intervalMs: number | undefined): number {
  const raw = typeof intervalMs === 'number' && Number.isFinite(intervalMs)
    ? intervalMs
    : DEFAULT_POLL_INTERVAL_MS;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(raw, MAX_POLL_INTERVAL_MS));
}

export interface MonitorResult {
  table: Table | null;
  error: string | null;
  loading: boolean;
}

type MonitorFetcher = (port: number, signal?: AbortSignal) => Promise<Table>;

export function useMonitor(
  port: number | undefined,
  fetcher: MonitorFetcher,
  intervalMs = 5000,
): MonitorResult {
  const [table, setTable] = useState<Table | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setTable(null);
    setError(null);
    setLoading(Boolean(port));
    if (!port) return;
    let cancelled = false;
    let inFlight = false;
    let activeController: AbortController | null = null;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      activeController = controller;
      setLoading(true);
      const onAbort = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error('monitor request aborted'));
        }, { once: true });
      });
      const timeout = setTimeout(() => {
        controller.abort(new Error(`monitor request timed out after ${MONITOR_REQUEST_TIMEOUT_MS}ms`));
      }, MONITOR_REQUEST_TIMEOUT_MS);
      try {
        const t = await Promise.race([fetcher(port, controller.signal), onAbort]);
        if (!cancelled) {
          setTable(t);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        clearTimeout(timeout);
        if (activeController === controller) activeController = null;
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), clampPollIntervalMs(intervalMs));
    return () => {
      cancelled = true;
      activeController?.abort();
      clearInterval(timer);
    };
  }, [port, fetcher, intervalMs]);

  return { table, error, loading };
}
