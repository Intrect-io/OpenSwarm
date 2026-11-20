import { describe, expect, it, vi } from 'vitest';
import { describeWorkScope, getWorkScope, recordScopedFetch, setWorkScope } from './workScope.js';

describe('work scope (AGT-3188)', () => {
  it('defaults to every issue in the allowed projects', () => {
    expect(setWorkScope(undefined)).toEqual({ milestone: null });
    expect(describeWorkScope(getWorkScope())).toBe('all issues in the allowed projects');
  });

  it('names the milestone when one is configured, and treats blank as unset', () => {
    setWorkScope({ milestone: ' S4 — Gate Trustworthiness ' });
    expect(getWorkScope()).toEqual({ milestone: 'S4 — Gate Trustworthiness' });
    expect(describeWorkScope(getWorkScope())).toBe('milestone "S4 — Gate Trustworthiness" only');
    expect(setWorkScope({ milestone: '  ' })).toEqual({ milestone: null });
  });

  it('flags a milestone that matched no open issues and warns once per distinct scope', () => {
    const warn = vi.fn();
    setWorkScope({ milestone: 'S9 — Renamed away' });
    expect(getWorkScope().matched).toBeUndefined();
    recordScopedFetch('S9 — Renamed away', 0, warn);
    recordScopedFetch('S9 — Renamed away', 0, warn);
    expect(getWorkScope()).toEqual({ milestone: 'S9 — Renamed away', matched: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"S9 — Renamed away" matched no open issues');

    setWorkScope({ milestone: 'S10 — Also empty' });
    recordScopedFetch('S10 — Also empty', 0, warn);
    expect(warn).toHaveBeenCalledTimes(2);

    recordScopedFetch('S10 — Also empty', 3, warn);
    expect(getWorkScope().matched).toBe(true);
  });

  it('records nothing without a milestone or for a stale milestone', () => {
    const warn = vi.fn();
    setWorkScope(undefined);
    recordScopedFetch(undefined, 0, warn);
    setWorkScope({ milestone: 'S11' });
    recordScopedFetch('S4', 0, warn);
    expect(getWorkScope()).toEqual({ milestone: 'S11' });
    expect(warn).not.toHaveBeenCalled();
  });
});
