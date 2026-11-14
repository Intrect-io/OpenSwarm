import { describe, expect, it } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import * as runner from './autonomousRunner.js';
import {
  decisionSelectionBudget,
  describeConflictCause,
  effectiveProjectConcurrency,
  failClosedConflictFallback,
  taskLabel,
  worktreeFanoutEnabled,
} from './runnerAdmissionPolicy.js';

const task = (id: string, issueIdentifier?: string) => ({ id, issueIdentifier, title: id }) as unknown as TaskItem;

describe('runnerAdmissionPolicy (AGT-4867 slice 1)', () => {
  it('fans out only with worktrees and same-project concurrency both on', () => {
    expect(worktreeFanoutEnabled({ worktreeMode: true })).toBe(true);
    expect(worktreeFanoutEnabled({ worktreeMode: false })).toBe(false);
    expect(worktreeFanoutEnabled({ worktreeMode: true, allowSameProjectConcurrent: false })).toBe(false);
    expect(worktreeFanoutEnabled({})).toBe(false);
  });

  it('caps per-project concurrency at the global pool, 1 without fan-out', () => {
    expect(effectiveProjectConcurrency({ worktreeMode: false, maxConcurrentTasks: 6 })).toBe(1);
    expect(effectiveProjectConcurrency({ worktreeMode: true, maxConcurrentTasks: 6 })).toBe(6);
    expect(effectiveProjectConcurrency({ worktreeMode: true, maxConcurrentTasks: 6, maxConcurrentPerProject: 2 })).toBe(2);
    expect(effectiveProjectConcurrency({ worktreeMode: true, maxConcurrentTasks: 3, maxConcurrentPerProject: 9 })).toBe(3);
    expect(effectiveProjectConcurrency({ worktreeMode: true, maxConcurrentTasks: 0 })).toBe(1);
  });

  it('oversamples decisions 3x the free slots, bounded by the candidates', () => {
    expect(decisionSelectionBudget(2, 50)).toBe(6);
    expect(decisionSelectionBudget(2, 4)).toBe(4);
    expect(decisionSelectionBudget(0, 4)).toBe(0);
  });

  it('admits only the first candidate when conflict analysis is unavailable', () => {
    expect(failClosedConflictFallback([
      { task: task('a'), projectPath: '/p' },
      { task: task('b'), projectPath: '/p' },
    ])).toEqual(new Set(['a']));
    expect(failClosedConflictFallback([])).toEqual(new Set());
  });

  it('labels tasks by identifier, else a short id', () => {
    expect(taskLabel(task('0123456789abcdef', 'AGT-1'))).toBe('AGT-1');
    expect(taskLabel(task('0123456789abcdef'))).toBe('01234567');
  });

  it('names the conflict cause, capping the file list at three', () => {
    expect(describeConflictCause({ kind: 'unknown-candidate' } as never, 'AGT-1')).toBe('candidate write scope unknown');
    expect(describeConflictCause({ kind: 'unknown-active' } as never, 'AGT-1')).toBe('AGT-1 write scope unknown');
    expect(describeConflictCause({ kind: 'overlap', shared: [] } as never, 'AGT-1')).toBe('overlaps AGT-1');
    expect(describeConflictCause({ kind: 'overlap', shared: ['a', 'b', 'c', 'd', 'e'] } as never, 'AGT-1'))
      .toBe('overlaps AGT-1 on a, b, c +2 more');
  });

  it('stays re-exported from autonomousRunner for existing importers', () => {
    expect(runner.decisionSelectionBudget).toBe(decisionSelectionBudget);
    expect(runner.effectiveProjectConcurrency).toBe(effectiveProjectConcurrency);
    expect(runner.failClosedConflictFallback).toBe(failClosedConflictFallback);
    expect(runner.worktreeFanoutEnabled).toBe(worktreeFanoutEnabled);
  });
});
