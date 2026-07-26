// ============================================
// OpenSwarm - Linear workflow-state name mapping
// ============================================
//
// Workflow state names are configured per workspace, not fixed by the API.
// Emitting exactly one spelling meant resolveLinearStateId threw for any team
// that spells a state differently — and Linear's own default for the cancelled
// state is the US "Canceled", so the bridge failed to sync that status outward
// for teams that never renamed it.

import { describe, expect, it } from 'vitest';
import { mapStatusToLinear } from './linearBridge.js';

describe('mapStatusToLinear', () => {
  it('offers both spellings of the cancelled state', () => {
    const candidates = mapStatusToLinear('cancelled');
    expect(candidates).toContain('Cancelled');
    expect(candidates).toContain('Canceled'); // Linear's default
  });

  it.each([
    ['backlog', 'Backlog'],
    ['todo', 'Todo'],
    ['in_progress', 'In Progress'],
    ['in_review', 'In Review'],
    ['done', 'Done'],
    ['cancelled', 'Cancelled'],
  ] as const)('keeps %s resolving to %s first', (status, expected) => {
    expect(mapStatusToLinear(status)[0]).toBe(expected);
  });

  it('returns at least one candidate for every status', () => {
    for (const status of ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const) {
      expect(mapStatusToLinear(status).length).toBeGreaterThan(0);
    }
  });

  // Candidates are compared case-insensitively at resolution time, so listing
  // the same name twice in different cases would be dead weight rather than
  // extra coverage.
  it('lists no duplicate candidates', () => {
    for (const status of ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const) {
      const lowered = mapStatusToLinear(status).map((c) => c.toLowerCase());
      expect(new Set(lowered).size).toBe(lowered.length);
    }
  });
});
