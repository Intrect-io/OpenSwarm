import { describe, expect, it } from 'vitest';
import { assignCallSign, callSignAddress } from './agentNames.js';

describe('agent call signs', () => {
  it('is deterministic for one identity so a name survives a restart', () => {
    const identity = { repository: '/repo', executionId: 'session-1', role: 'worker' as const };
    expect(assignCallSign(identity)).toEqual(assignCallSign(identity));
    expect(assignCallSign(identity).name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+-[A-Z][a-z]+$/);
  });

  it('gives different identities different names', () => {
    const a = assignCallSign({ repository: '/repo', executionId: 's1', role: 'worker' });
    const b = assignCallSign({ repository: '/repo', executionId: 's2', role: 'worker' });
    const c = assignCallSign({ repository: '/other', executionId: 's1', role: 'worker' });
    expect(new Set([a.address, b.address, c.address]).size).toBe(3);
  });

  it('never hands a live address to a second agent', () => {
    const first = assignCallSign({ repository: '/repo', executionId: 's1', role: 'worker' });
    const second = assignCallSign(
      { repository: '/repo', executionId: 's1', role: 'worker' },
      new Set([first.address]),
    );
    expect(second.address).not.toBe(first.address);
  });

  it('routes by a normalized address', () => {
    expect(callSignAddress('Magos Corvax-Vigilis')).toBe('magos-corvax-vigilis');
  });
});
