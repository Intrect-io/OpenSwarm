import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// dispatchWork checks the project path exists before any lookup, so the test
// needs a real directory rather than a placeholder string.
const repo = mkdtempSync(join(tmpdir(), 'work-dispatch-'));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const linear = vi.hoisted(() => ({
  isLinearInitialized: vi.fn(() => true),
  lookupIssue: vi.fn(),
  getIssue: vi.fn(),
  updateIssueState: vi.fn(async () => true),
}));
vi.mock('../linear/linear.js', () => linear);
vi.mock('../support/repoMetadata.js', () => ({
  loadRepoMetadata: vi.fn(async () => ({ linear: { projectId: 'proj-1' } })),
}));
vi.mock('../orchestration/decisionEngine.js', () => ({
  linearIssueToTask: (issue: { id: string; title: string }) => ({ id: issue.id, title: issue.title }),
  normalizeProjectPath: (path: string) => path,
}));

const { dispatchWork } = await import('./workRunner.js');

// dispatchWork probes the runner with an empty batch first, to fail fast when
// the daemon is not configured for queued work.
const runner = {
  getAllowedProjects: () => [repo],
  enqueueIssues: vi.fn(async () => undefined),
} as never;

describe('dispatchWork lookup reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    linear.isLinearInitialized.mockReturnValue(true);
    linear.updateIssueState.mockResolvedValue(true);
  });

  it('names the credential failure instead of blaming the issue', async () => {
    // An expired token used to surface as "not found", which sent the operator
    // looking for a missing issue that was there the whole time.
    linear.lookupIssue.mockResolvedValue({
      ok: false,
      error: 'Authentication required, not authenticated',
    });

    const result = await dispatchWork(runner, { issueIds: ['AGT-1'], projectPath: repo });

    expect(result.items[0]).toMatchObject({ issueId: 'AGT-1', status: 'skipped' });
    expect(result.items[0].reason).toContain('Linear lookup failed');
    expect(result.items[0].reason).toContain('Authentication required');
    expect(result.queued).toBe(0);
  });

  it('still reports a genuinely missing issue as not found', async () => {
    linear.lookupIssue.mockResolvedValue({ ok: true, issue: null });

    const result = await dispatchWork(runner, { issueIds: ['AGT-2'], projectPath: repo });

    expect(result.items[0].reason).toBe('not found');
  });
});
