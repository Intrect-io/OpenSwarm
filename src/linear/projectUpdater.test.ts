import { describe, expect, it } from 'vitest';
import { buildOverviewDescription } from './projectUpdater.js';

describe('buildOverviewDescription', () => {
  it('reserves capacity so the compact summary survives a long base description', () => {
    const base = 'x'.repeat(300);
    const desc = buildOverviewDescription(base, { done: 3, inProgress: 1, todo: 7 });
    expect(desc.length).toBeLessThanOrEqual(255);
    expect(desc).toMatch(/\[Done:3 InProgress:1 Todo:7\]$/);
  });

  it('returns only the summary when the base is empty', () => {
    expect(buildOverviewDescription('', { done: 0, inProgress: 0, todo: 1 }))
      .toBe('Done:0 InProgress:0 Todo:1');
  });

  it('keeps a short base description intact', () => {
    const desc = buildOverviewDescription('Hello project', { done: 1, inProgress: 0, todo: 0 });
    expect(desc).toBe('Hello project\n\n[Done:1 InProgress:0 Todo:0]');
  });
});
