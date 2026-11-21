import { afterEach, describe, expect, it } from 'vitest';
import { isQueueTimeCollectorRunning, startQueueTimeCollector, stopQueueTimeCollector } from '../adapters/httpDispatcher.js';
import { aggregateAuditResults, formatAuditReport } from './reviewAudit.js';
import { beginReviewQueueTimeCapture, captureQueueTime, formatQueueTimeLine } from './reviewQueueTime.js';

afterEach(() => {
  stopQueueTimeCollector();
});

describe('formatQueueTimeLine (AGT-4313)', () => {
  it('formats p50, p90 and the sample count from a queue-time snapshot', () => {
    expect(formatQueueTimeLine({ count: 12, p50Ms: 3, p90Ms: 17.25 })).toBe(
      'Request queue time (undici create->sendHeaders): p50 3 ms, p90 17.3 ms over 12 request(s)',
    );
  });

  it('reports n/a instead of 0 ms when no in-process HTTP/1.1 request was observed', () => {
    const line = formatQueueTimeLine({ count: 0, p50Ms: 0, p90Ms: 0 });
    expect(line).toBe('Request queue time: n/a (no in-process HTTP/1.1 adapter requests observed)');
    expect(line).not.toContain('0 ms');
  });
});

describe('beginReviewQueueTimeCapture (AGT-4313)', () => {
  it('starts the collector for the capture and stops it on end', () => {
    expect(isQueueTimeCollectorRunning()).toBe(false);
    const capture = beginReviewQueueTimeCapture();
    expect(isQueueTimeCollectorRunning()).toBe(true);
    capture.end();
    expect(isQueueTimeCollectorRunning()).toBe(false);
    expect(capture.snapshot()).toEqual({ count: 0, p50Ms: 0, p90Ms: 0 });
  });

  it('leaves an already-running collector running when the capture ends', () => {
    startQueueTimeCollector();
    const capture = beginReviewQueueTimeCapture();
    capture.end();
    expect(isQueueTimeCollectorRunning()).toBe(true);
  });

  it('stops a collector it started even when the captured work throws', async () => {
    await expect(captureQueueTime(async () => {
      expect(isQueueTimeCollectorRunning()).toBe(true);
      throw new Error('fan-out failed');
    })).rejects.toThrow('fan-out failed');
    expect(isQueueTimeCollectorRunning()).toBe(false);
  });
});

describe('formatAuditReport transport section (AGT-4313)', () => {
  const summary = aggregateAuditResults([]);

  it('adds a Transport section with the queue time to the audit report', () => {
    const report = formatAuditReport(summary, 'repo', 'ts', { count: 4, p50Ms: 2, p90Ms: 9 });
    expect(report).toContain('## Transport');
    expect(report).toContain('p50 2 ms, p90 9 ms over 4 request(s)');
    expect(formatAuditReport(summary, 'repo', 'ts', { count: 0, p50Ms: 0, p90Ms: 0 })).toContain(
      '## Transport\nRequest queue time: n/a',
    );
  });

  it('omits the Transport section when no queue-time snapshot is given', () => {
    expect(formatAuditReport(summary, 'repo', 'ts')).not.toContain('## Transport');
  });
});
