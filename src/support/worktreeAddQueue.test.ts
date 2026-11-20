import { describe, expect, it } from 'vitest';
import { serializePerRepository } from './worktreeAddQueue.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('serializePerRepository (PR #929 CI race)', () => {
  it('never runs two operations of one repository at the same time', async () => {
    let running = 0;
    let peak = 0;
    const op = async () => { running++; peak = Math.max(peak, running); await tick(); running--; };
    await Promise.all(Array.from({ length: 6 }, () => serializePerRepository('/repo/a', op)));
    expect(peak).toBe(1);
  });

  it('treats paths that resolve to the same repository as one queue', async () => {
    const order: string[] = [];
    await Promise.all([
      serializePerRepository('/repo/b', async () => { await tick(); order.push('first'); }),
      serializePerRepository('/repo/b/', async () => { order.push('second'); }),
    ]);
    expect(order).toEqual(['first', 'second']);
  });

  it('lets different repositories run together', async () => {
    let running = 0;
    let peak = 0;
    const op = async () => { running++; peak = Math.max(peak, running); await tick(); running--; };
    await Promise.all([serializePerRepository('/repo/c', op), serializePerRepository('/repo/d', op)]);
    expect(peak).toBe(2);
  });

  it('keeps the queue moving after a failure and returns each result to its caller', async () => {
    const failed = serializePerRepository('/repo/e', async () => { throw new Error('add failed'); });
    const next = serializePerRepository('/repo/e', async () => 'ok');
    await expect(failed).rejects.toThrow('add failed');
    await expect(next).resolves.toBe('ok');
  });
});
