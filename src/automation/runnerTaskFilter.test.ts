// Created: 2026-11-22
// Purpose: pin the TaskFilterHost contract — moved functions call each other through the host, read late
// Dependencies: runnerTaskFilter
// Test Status: passing

import { describe, expect, it, vi } from 'vitest';

let answered = false;
vi.mock('../coordination/coordinationStore.js', () => ({
  getCoordinationStore: () => ({ allQuestionsAnswered: () => answered }),
}));

import { answerArrivedFor, readmitAnsweredRun, type TaskFilterHost } from './runnerTaskFilter.js';

function fakeHost(overrides: Partial<TaskFilterHost> = {}): TaskFilterHost {
  const host = {
    scheduler: { hasAvailableSlot: () => false, getAvailableSlots: () => 0 },
    durableRuns: { readmitParkedRun: vi.fn(() => true) },
    completedTaskIds: new Set<string>(),
    failedTaskCounts: new Map<string, number>(),
    failedTaskRetryTimes: new Map<string, number>([['AGT-1', Date.now() + 60_000]]),
    consecutiveInfraErrorCounts: new Map<string, number>([['AGT-1', 2]]),
    unresolvableIssueIds: new Set<string>(),
    maxRetryCount: 4,
    answerArrivedFor: () => false,
    readmitAnsweredRun: () => false,
    resumeAnsweredQuestionPark: () => false,
    parkedOnOperator: () => false,
    scheduleNextHeartbeat: () => {},
    saveTaskState: () => {},
    syslog: () => {},
    ...overrides,
  };
  return host as unknown as TaskFilterHost;
}

describe('TaskFilterHost contract (AGT-4867)', () => {
  it('readmitAnsweredRun asks the host, at call time, whether the answer arrived', () => {
    const host = fakeHost();
    expect(readmitAnsweredRun(host, 'AGT-1')).toBe(false);
    // A member reassigned after the host was built is the one honoured.
    (host as { answerArrivedFor: (id: string) => boolean }).answerArrivedFor = () => true;
    expect(readmitAnsweredRun(host, 'AGT-1')).toBe(true);
    expect(host.failedTaskRetryTimes.has('AGT-1')).toBe(false);
    expect(host.consecutiveInfraErrorCounts.has('AGT-1')).toBe(false);
  });

  it('answerArrivedFor reads the park through the host', () => {
    answered = true;
    const parkedOnOperator = vi.fn(() => true);
    expect(answerArrivedFor(fakeHost({ parkedOnOperator }), 'AGT-1')).toBe(true);
    expect(parkedOnOperator).toHaveBeenCalledWith('AGT-1');
    expect(answerArrivedFor(fakeHost(), 'AGT-1')).toBe(false);
  });
});
