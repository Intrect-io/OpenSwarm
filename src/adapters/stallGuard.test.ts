import { describe, expect, it } from 'vitest';
import { StreamStallError, createStallGuard } from './stallGuard.js';
import { isTransientRequestError } from './throttleRetry.js';

describe('createStallGuard', () => {
  it('aborts after the idle window with a transient StreamStallError', async () => {
    const guard = createStallGuard(40);
    await new Promise((r) => setTimeout(r, 80));
    expect(guard.signal.aborted).toBe(true);
    expect(guard.stalled()).toBe(true);
    expect(guard.signal.reason).toBeInstanceOf(StreamStallError);
    expect(isTransientRequestError(guard.signal.reason)).toBe(true);
    guard.clear();
  });

  it('stays open while bytes keep arriving, and never fires once cleared', async () => {
    const guard = createStallGuard(60);
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 30));
      guard.touch();
    }
    expect(guard.signal.aborted).toBe(false);
    guard.clear();
    await new Promise((r) => setTimeout(r, 90));
    expect(guard.signal.aborted).toBe(false);
  });
});

describe('StreamStallError classification', () => {
  it('is an infrastructure error once retries are exhausted, as the timeout it replaces was', async () => {
    const { isInfraError } = await import('./errorClassification.js');
    expect(isInfraError(new StreamStallError(180_000))).toBe(true);
  });
});

describe('StreamStallError as a timeout', () => {
  it('is reported as a timeout, like the deadline abort it replaces', async () => {
    const { isTimeoutError } = await import('./errorClassification.js');
    expect(isTimeoutError(new StreamStallError(180_000))).toBe(true);
  });
});
