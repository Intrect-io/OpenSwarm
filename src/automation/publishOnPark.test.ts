import { describe, expect, it } from 'vitest';
import { shouldPublishParkedWork } from './publishOnPark.js';

describe('shouldPublishParkedWork (AGT-4076)', () => {
  it('publishes when a run parks for the operator with a worktree', () => {
    expect(shouldPublishParkedWork(true, { finalStatus: 'waiting_on_operator' })).toBe(true);
  });

  it('does not publish an approved run — the normal path already does', () => {
    // Publishing here too would open a second PR for the same branch.
    expect(shouldPublishParkedWork(true, { finalStatus: 'approved' })).toBe(false);
  });

  it('does not publish a failed run', () => {
    expect(shouldPublishParkedWork(true, { finalStatus: 'failed' })).toBe(false);
  });

  it('does not publish a superseded run — admission was refused, so nothing ran', () => {
    expect(shouldPublishParkedWork(true, { finalStatus: 'superseded' })).toBe(false);
  });

  it('does not publish twice when a PR already exists', () => {
    expect(shouldPublishParkedWork(true, {
      finalStatus: 'waiting_on_operator', prUrl: 'https://github.com/o/r/pull/1',
    })).toBe(false);
  });

  it('does not publish without a worktree — there is nothing to publish from', () => {
    expect(shouldPublishParkedWork(false, { finalStatus: 'waiting_on_operator' })).toBe(false);
  });
});
