// What the Sessions view shows, given the URL and what is known yet (INT-3402).
// The hash is read at startup while the session list arrives asynchronously,
// so the same question is asked again after the snapshot lands.

import { describe, expect, it } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { EMPTY_MESSAGE, resolveSelection } from '../../web/static/js/sessionSelection.mjs';

const sessions = [{ taskId: 'a' }, { taskId: 'b' }];

describe('resolveSelection', () => {
  it('honors a deep link once its session is known', () => {
    expect(resolveSelection({ hashTaskId: 'b', sessions, snapshotLoaded: true })).toEqual({ taskId: 'b' });
  });

  it('waits rather than declaring a deep link dead before the snapshot lands', () => {
    // The deep link is probably valid — the list just has not arrived. Saying
    // "not in history" here would be a guess presented as fact.
    const choice = resolveSelection({ hashTaskId: 'unknown', sessions: [], snapshotLoaded: false });
    expect(choice.message).toBe('Loading session…');
    expect(choice.taskId).toBeUndefined();
  });

  it('reports a genuinely unknown session only after the snapshot answered', () => {
    const choice = resolveSelection({ hashTaskId: 'unknown', sessions, snapshotLoaded: true });
    expect(choice.message).toContain('not in this daemon');
  });

  it('falls back to the most recent session when the hash names none', () => {
    expect(resolveSelection({ hashTaskId: null, sessions, snapshotLoaded: true })).toEqual({ taskId: 'a' });
  });

  it('shows the deploy prompt when there is nothing at all', () => {
    expect(resolveSelection({ hashTaskId: null, sessions: [], snapshotLoaded: true }))
      .toEqual({ message: EMPTY_MESSAGE });
  });
});
