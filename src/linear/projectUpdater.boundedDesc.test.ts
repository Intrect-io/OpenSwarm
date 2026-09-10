import { describe, expect, it } from 'vitest';
import { buildBoundedProjectDescription } from './projectUpdater.js';

describe('buildBoundedProjectDescription', () => {
  it('keeps the compact automation summary when the base description is long', () => {
    const base = 'A'.repeat(400);
    const desc = buildBoundedProjectDescription(base, { done: 3, inProgress: 2, todo: 7 });

    expect(desc.length).toBeLessThanOrEqual(255);
    expect(desc.endsWith('[Done:3 InProgress:2 Todo:7]')).toBe(true);
    expect(desc).toContain('...');
  });

  it('fits short base text and summary without truncation', () => {
    const desc = buildBoundedProjectDescription('Ship it', { done: 1, inProgress: 0, todo: 0 });
    expect(desc).toBe('Ship it\n\n[Done:1 InProgress:0 Todo:0]');
    expect(desc.length).toBeLessThanOrEqual(255);
  });

  it('returns only the summary when base text is empty', () => {
    const desc = buildBoundedProjectDescription('', { done: 0, inProgress: 1, todo: 2 });
    expect(desc).toBe('[Done:0 InProgress:1 Todo:2]');
  });
});
