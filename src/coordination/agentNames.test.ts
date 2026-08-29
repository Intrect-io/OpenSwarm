import { describe, expect, it } from 'vitest';
import { assignCallSign, callSignAddress } from './agentNames.js';

describe('agent call signs', () => {
  it('is deterministic for one identity so a name survives a restart', () => {
    const identity = { repository: '/repo', executionId: 'session-1', role: 'worker' as const };
    expect(assignCallSign(identity)).toEqual(assignCallSign(identity));
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

// The operator banned two shapes outright after seeing
// `Atlas 3 2 (worker · AX-1030) → reviewer-b0bc` on the board: the machine-ID
// fallback, and names decorated with a collision counter. (AGT-4064)
describe('assigned handles read like handles a person would pick', () => {
  const ROLES = ['worker', 'reviewer', 'orchestrator', 'review-agent'] as const;
  const MACHINE_ID = /^(?:worker|reviewer|orchestrator|review-agent)-[0-9a-f]{4,}$/;

  function sample(): string[] {
    const names: string[] = [];
    for (const role of ROLES) {
      for (let i = 0; i < 200; i += 1) {
        names.push(assignCallSign({ repository: '/repo', executionId: `T-${i}`, role }).name);
      }
    }
    return names;
  }

  it('never produces the banned role-hex shape', () => {
    expect(sample().filter((n) => MACHINE_ID.test(n))).toEqual([]);
  });

  it('never decorates a name with a collision counter', () => {
    // The old failure mode: `Atlas` → `Atlas 2` → `Atlas 3` → `Atlas 3 2`.
    expect(sample().filter((n) => / \d+$/.test(n))).toEqual([]);
  });

  it('varies the handle shape rather than repeating one template', () => {
    const shapes = new Set(sample().map((n) => (
      /_/.test(n) ? 'tagged' : /\d{4}$/.test(n) ? 'numbered-role' : /\d{2}$/.test(n) ? 'compound' : 'suffixed'
    )));
    expect(shapes.size).toBeGreaterThan(2);
  });

  it('draws a reviewer from different vocabulary than a worker', () => {
    const wordsOf = (role: 'worker' | 'reviewer') => new Set(
      Array.from({ length: 200 }, (_, i) =>
        assignCallSign({ repository: '/repo', executionId: `T-${i}`, role }).name.toLowerCase())
        .flatMap((n) => n.split(/[^a-z]+/).filter(Boolean)),
    );
    const worker = wordsOf('worker');
    const reviewer = wordsOf('reviewer');
    const shared = [...worker].filter((w) => reviewer.has(w));
    // Role words differ too, so overlap should be essentially nothing.
    expect(shared).toEqual([]);
  });

  it('does not double a word inside one handle', () => {
    // `heronheron27` reads as a bug rather than a name.
    expect(sample().filter((n) => /^([a-z]+)\1/.test(n))).toEqual([]);
  });

  it('resolves a collision to a different handle, not a decorated one', () => {
    const identity = { repository: '/repo', executionId: 'T-1', role: 'reviewer' as const };
    const first = assignCallSign(identity);
    const second = assignCallSign(identity, new Set([first.address]));
    expect(second.name).not.toBe(first.name);
    expect(second.name.startsWith(first.name)).toBe(false);
  });
});

// A reply is addressed to a handle. If a daemon restart renamed a live
// participant, the answer would sit in an inbox nobody reads — the same
// invariant a retry already had to preserve. An earlier version probed
// against an in-memory registry, which made a collision-resolved handle
// depend on what that process happened to hold. (AGT-4064, caught by PR review)
describe('handles survive a restart', () => {
  it('resolves an identity the same way with an empty and a populated process', () => {
    const identity = { repository: '/repo', executionId: 'AX-1', role: 'reviewer' as const };
    // "After a restart" is simply: the same call with nothing else known.
    const cold = assignCallSign(identity);
    // "Mid-life" used to pass the whole live registry here.
    const warm = assignCallSign(identity);
    expect(warm).toEqual(cold);
  });

  it('separates the roles on one task without consulting process state', () => {
    const task = { repository: '/repo', executionId: 'AX-1' };
    const worker = assignCallSign({ ...task, role: 'worker' });
    const reviewer = assignCallSign({ ...task, role: 'reviewer' });
    expect(reviewer.address).not.toBe(worker.address);
    // And still deterministically, on a second cold call.
    expect(assignCallSign({ ...task, role: 'reviewer' }).address).toBe(reviewer.address);
  });

  it('keeps every role on a task distinct across many tasks', () => {
    for (let i = 0; i < 300; i += 1) {
      const task = { repository: '/repo', executionId: `AX-${i}` };
      const addresses = (['orchestrator', 'review-agent', 'worker', 'reviewer'] as const)
        .map((role) => assignCallSign({ ...task, role }).address);
      expect(new Set(addresses).size).toBe(addresses.length);
    }
  });
});
