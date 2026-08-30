import { describe, it, expect } from 'vitest';
import { classifyStuck, linearIssueToTask } from './decisionEngine.js';

// INT-1908: a permanently-blocked issue is parked in Backlog with the `swarm:stuck`
// label. classifyStuck encodes the heartbeat filter's decision so the daemon never
// re-runs an exhausted issue — yet still retries when the user pulls it back.
describe('classifyStuck — stuck/recovery decision (INT-1908)', () => {
  it('skips a stuck issue parked in Backlog (retries exhausted)', () => {
    expect(classifyStuck({ isStuck: true, linearState: 'Backlog', hasFailureHistory: false }))
      .toBe('skip-stuck');
  });

  it('recovers a stuck issue the user pulled back to Todo', () => {
    expect(classifyStuck({ isStuck: true, linearState: 'Todo', hasFailureHistory: false }))
      .toBe('recover');
  });

  it('recovers a stuck issue pulled back to In Progress / In Review', () => {
    expect(classifyStuck({ isStuck: true, linearState: 'In Progress', hasFailureHistory: false }))
      .toBe('recover');
    expect(classifyStuck({ isStuck: true, linearState: 'In Review', hasFailureHistory: false }))
      .toBe('recover');
  });

  it('does NOT recover a stuck issue that is still in Backlog even with failure history', () => {
    // The old bug: blocking left issues in a recoverable state, so they recovered
    // every heartbeat. Backlog must stay skipped regardless of counters.
    expect(classifyStuck({ isStuck: true, linearState: 'Backlog', hasFailureHistory: true }))
      .toBe('skip-stuck');
  });

  it('recovers a non-stuck issue in an active state with failure history (manual retry)', () => {
    expect(classifyStuck({ isStuck: false, linearState: 'Todo', hasFailureHistory: true }))
      .toBe('recover');
  });

  it('passes a fresh non-stuck issue through to the normal checks', () => {
    expect(classifyStuck({ isStuck: false, linearState: 'Todo', hasFailureHistory: false }))
      .toBe('pass');
    expect(classifyStuck({ isStuck: false, linearState: 'Backlog', hasFailureHistory: false }))
      .toBe('pass');
  });

  it('treats an undefined state as non-recoverable', () => {
    expect(classifyStuck({ isStuck: true, linearState: undefined, hasFailureHistory: true }))
      .toBe('skip-stuck');
  });
});

describe('linearIssueToTask — label propagation', () => {
  it('carries Linear labels onto the TaskItem so the filter can see the stuck marker', () => {
    const task = linearIssueToTask({
      id: 'uuid-1',
      identifier: 'INT-1',
      title: 'x',
      url: 'https://linear.app/intrect/issue/INT-1/x',
      priority: 2,
      state: 'Backlog',
      labels: ['swarm:stuck', 'core'],
    });
    expect(task.labels).toEqual(['swarm:stuck', 'core']);
    expect(task.issueUrl).toBe('https://linear.app/intrect/issue/INT-1/x');
  });

  it('leaves labels undefined when none are provided', () => {
    const task = linearIssueToTask({ id: 'u', identifier: 'INT-2', title: 'y', priority: 3 });
    expect(task.labels).toBeUndefined();
  });
});
