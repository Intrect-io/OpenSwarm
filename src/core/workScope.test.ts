import { describe, expect, it } from 'vitest';
import { describeWorkScope, getWorkScope, setWorkScope } from './workScope.js';

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
});
