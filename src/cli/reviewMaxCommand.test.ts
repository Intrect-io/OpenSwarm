import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewResult } from '../agents/agentPair.js';
import { aggregateAuditResults, runFixVerifyLoop, type AuditRun, type AuditSummary } from './reviewAudit.js';

const ensureTaskSourceMock = vi.fn();
const ensureProjectMappingMock = vi.fn();
const resolveIssueFromBranchMock = vi.fn();
vi.mock('./reviewCommand.js', () => ({
  ensureTaskSource: (...args: unknown[]) => ensureTaskSourceMock(...args),
  ensureProjectMapping: (...args: unknown[]) => ensureProjectMappingMock(...args),
  resolveIssueFromBranch: (...args: unknown[]) => resolveIssueFromBranchMock(...args),
  buildReviewWorkerResult: vi.fn(),
}));

const synthesizeAuditIssuesMock = vi.fn();
vi.mock('./auditPM.js', () => ({
  synthesizeAuditIssues: (...args: unknown[]) => synthesizeAuditIssuesMock(...args),
}));

const fileReviewerFollowupsMock = vi.fn();
vi.mock('../automation/runnerExecution.js', () => ({
  fileReviewerFollowups: (...args: unknown[]) => fileReviewerFollowupsMock(...args),
}));

const loadConfigMock = vi.fn();
vi.mock('../core/config.js', async () => {
  const actual = await vi.importActual<typeof import('../core/config.js')>('../core/config.js');
  return { ...actual, loadConfig: (...args: unknown[]) => loadConfigMock(...args) };
});

const commitAndCreateAuditPRMock = vi.fn();
const removeWorktreeMock = vi.fn();
const preserveWorktreeMock = vi.fn();
vi.mock('../support/worktreeManager.js', async () => {
  const actual = await vi.importActual<typeof import('../support/worktreeManager.js')>('../support/worktreeManager.js');
  return {
    ...actual,
    commitAndCreateAuditPR: (...args: unknown[]) => commitAndCreateAuditPRMock(...args),
    removeWorktree: (...args: unknown[]) => removeWorktreeMock(...args),
    preserveWorktree: (...args: unknown[]) => preserveWorktreeMock(...args),
    createWorktree: vi.fn(),
  };
});

const {
  filePerAreaFollowups,
  filePmSynthesizedIssues,
  reviewMaxResultFailed,
  loadVerifyConfigBestEffort,
  dedupeAuditRunHistory,
  shipAuditWorktree,
  resolveFallbackAdapter,
} =
  await import('./reviewMaxCommand.js');

function makeRun(actions: ReviewResult['recommendedActions']): AuditRun {
  const review: ReviewResult = { decision: 'revise', feedback: 'x', recommendedActions: actions };
  return {
    results: [{ area: { label: 'src', dir: 'src', files: ['src/a.ts'] }, review }],
    summary: { decision: 'revise', totalAreas: 1, completed: 1, failed: 0, areas: [], issues: [], recommendedActions: actions ?? [] } as AuditSummary,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureTaskSourceMock.mockResolvedValue({ createTask: vi.fn(), createSubIssue: vi.fn() });
  resolveIssueFromBranchMock.mockReturnValue(undefined);
});

describe('loadVerifyConfigBestEffort (INT-2762)', () => {
  const defaults = { enabled: true, blockOnNewFailures: true, maxCommands: 4 };

  it('falls back to the built-in defaults when config discovery throws', () => {
    // Regression: a repo whose own config.json shadows the OpenSwarm config used
    // to abort `review --max --fix` right after the cost gate.
    loadConfigMock.mockImplementation(() => {
      throw new Error('Config validation failed:\n  - agents: Invalid input: expected array, received undefined');
    });

    expect(loadVerifyConfigBestEffort()).toEqual(defaults);
  });

  it('uses autonomous.verify when a valid config loads', () => {
    loadConfigMock.mockReturnValue({
      autonomous: { verify: { enabled: false, blockOnNewFailures: false, maxCommands: 2 } },
    });

    expect(loadVerifyConfigBestEffort()).toEqual({ enabled: false, blockOnNewFailures: false, maxCommands: 2 });
  });

  it('falls back to the defaults when the config has no verify block', () => {
    loadConfigMock.mockReturnValue({ autonomous: {} });

    expect(loadVerifyConfigBestEffort()).toEqual(defaults);
  });
});

describe('resolveFallbackAdapter', () => {
  it('does not arm the claude fallback when the active adapter is not codex', () => {
    // The regression: with no --adapter flag the primary was assumed to be
    // 'codex-responses', so an openrouter user had usage-limited areas silently
    // retried on `claude -p`.
    expect(resolveFallbackAdapter({}, () => 'openrouter')).toBeUndefined();
    expect(resolveFallbackAdapter({}, () => 'atlascloud')).toBeUndefined();
    expect(resolveFallbackAdapter({}, () => 'local')).toBeUndefined();
  });

  it('still falls back to claude when the active adapter is codex', () => {
    expect(resolveFallbackAdapter({}, () => 'codex')).toBe('claude');
    expect(resolveFallbackAdapter({}, () => 'codex-responses')).toBe('claude');
  });

  it('prefers an explicit --adapter over the process default', () => {
    expect(resolveFallbackAdapter({ adapter: 'openrouter' }, () => 'codex')).toBeUndefined();
    expect(resolveFallbackAdapter({ adapter: 'codex' }, () => 'openrouter')).toBe('claude');
  });

  it('honours --fallback and --no-fallback regardless of the active adapter', () => {
    expect(resolveFallbackAdapter({ fallbackAdapter: 'gpt' }, () => 'openrouter')).toBe('gpt');
    expect(resolveFallbackAdapter({ noFallback: true }, () => 'codex')).toBeUndefined();
  });
});

describe('reviewMaxResultFailed', () => {
  it('fails closed when --fix leaves a revise verdict unresolved', () => {
    expect(reviewMaxResultFailed({ decision: 'revise', gateRan: true, resolved: false }, true)).toBe(true);
    expect(reviewMaxResultFailed({ decision: 'approve', gateRan: true, resolved: true, verified: false }, true)).toBe(true);
    expect(reviewMaxResultFailed({ decision: 'approve', gateRan: true, resolved: true, verified: true }, true)).toBe(false);
  });

  it('preserves report-only review semantics without --fix', () => {
    expect(reviewMaxResultFailed({ decision: 'revise', gateRan: true }, false)).toBe(false);
    expect(reviewMaxResultFailed({ decision: 'reject', gateRan: true }, false)).toBe(true);
  });
});

describe('dedupeAuditRunHistory', () => {
  it('removes unchanged repeated area follow-ups and rebuilds the aggregate summary', () => {
    const original = makeRun([{ type: 'bug', title: 'Fix it', location: 'src/a.ts:9' }]);
    original.results[0]!.review!.issues = ['still broken'];
    const loaded = {
      legacyExcerpts: [],
      records: [{
        version: 1 as const,
        createdAt: '2026-07-20T00:00:00.000Z',
        kind: 'max' as const,
        files: ['src/a.ts'],
        fileHashes: { 'src/a.ts': 'file:same' },
        areas: [{
          label: 'src',
          files: ['src/a.ts'],
          review: {
            decision: 'revise' as const,
            feedback: 'first pass',
            recommendedActions: [{ type: 'bug', title: 'Fix it', location: 'src/a.ts:1' }],
          },
        }],
      }],
    };

    const result = dedupeAuditRunHistory(original, loaded, { 'src/a.ts': 'file:same' });

    expect(result.removed).toBe(1);
    expect(result.run.results[0]?.review?.issues).toEqual(['still broken']);
    expect(result.run.results[0]?.review?.recommendedActions).toEqual([]);
    expect(result.run.summary.recommendedActions).toEqual([]);
    expect(result.run.summary.issues).toEqual(['[src] still broken']);
  });
});

describe('filePerAreaFollowups (INT-2599)', () => {
  it('skips filing entirely when the project-mapping preflight aborts', async () => {
    ensureProjectMappingMock.mockResolvedValue({ projectId: undefined, abort: true });
    const run = makeRun([{ type: 'bug', title: 'fix it' }]);

    await filePerAreaFollowups('/repo', true, run);

    expect(fileReviewerFollowupsMock).not.toHaveBeenCalled();
  });

  it('threads the resolved projectId into fileReviewerFollowups', async () => {
    ensureProjectMappingMock.mockResolvedValue({ projectId: 'proj-123', abort: false });
    fileReviewerFollowupsMock.mockResolvedValue(1);
    const run = makeRun([{ type: 'bug', title: 'fix it' }]);

    await filePerAreaFollowups('/repo', true, run);

    expect(fileReviewerFollowupsMock).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.anything(),
      expect.objectContaining({ projectId: 'proj-123' }),
    );
  });
});

describe('filePmSynthesizedIssues (INT-2599)', () => {
  it('skips creating the master issue and synthesized issues when the preflight aborts', async () => {
    ensureProjectMappingMock.mockResolvedValue({ projectId: undefined, abort: true });
    const source = { createTask: vi.fn(), createSubIssue: vi.fn() };
    ensureTaskSourceMock.mockResolvedValue(source);
    const summary: AuditSummary = {
      decision: 'revise',
      totalAreas: 1,
      completed: 1,
      failed: 0,
      areas: [],
      issues: [],
      recommendedActions: [{ type: 'bug', title: 'fix it' }],
    };

    await filePmSynthesizedIssues('/repo', {}, summary, '# report', '2026-07-10T00-00-00');

    expect(source.createTask).not.toHaveBeenCalled();
    expect(source.createSubIssue).not.toHaveBeenCalled();
    expect(synthesizeAuditIssuesMock).not.toHaveBeenCalled();
  });

  it('passes the resolved projectId to the master issue and synthesized sub-issues', async () => {
    ensureProjectMappingMock.mockResolvedValue({ projectId: 'proj-456', abort: false });
    const source = {
      createTask: vi.fn().mockResolvedValue({ id: 'master-1', identifier: 'INT-1', title: 'master' }),
      createSubIssue: vi.fn().mockResolvedValue({ id: 'sub-1', identifier: 'INT-2', title: 'sub' }),
    };
    ensureTaskSourceMock.mockResolvedValue(source);
    synthesizeAuditIssuesMock.mockResolvedValue([
      { title: 'grouped fix', priority: 2, items: ['fix it'], description: 'body' },
    ]);
    const summary: AuditSummary = {
      decision: 'revise',
      totalAreas: 1,
      completed: 1,
      failed: 0,
      areas: [],
      issues: [],
      recommendedActions: [{ type: 'bug', title: 'fix it' }],
    };

    await filePmSynthesizedIssues('/repo', {}, summary, '# report', '2026-07-10T00-00-00');

    expect(source.createTask).toHaveBeenCalledWith(expect.any(String), '# report', 'proj-456');
    expect(source.createSubIssue).toHaveBeenCalledWith(
      'master-1',
      'grouped fix',
      'body',
      expect.objectContaining({ projectId: 'proj-456' }),
    );
  });
});

describe('shipAuditWorktree (INT-2905)', () => {
  beforeEach(() => {
    removeWorktreeMock.mockResolvedValue(undefined);
    preserveWorktreeMock.mockResolvedValue(true);
  });
  const audit = {
    info: { worktreePath: '/repo/worktree/audit-1', branchName: 'swarm/audit-1', originalPath: '/repo', issueId: 'audit-1' },
    baseSha: 'abc123',
    forkedFromBranch: 'feat/in-flight',
  };
  const summary: AuditSummary = {
    decision: 'approve',
    totalAreas: 1,
    completed: 1,
    failed: 0,
    areas: [],
    issues: [],
    recommendedActions: [{ type: 'bug', title: 'fix it' }],
  };

  it('closes the audit issue it created and comments the PR link', async () => {
    commitAndCreateAuditPRMock.mockResolvedValue('https://example.test/pull/9');
    const source = { addComment: vi.fn().mockResolvedValue(undefined) };
    ensureTaskSourceMock.mockResolvedValue(source);

    const url = await shipAuditWorktree(audit, summary, '2026-07-21T00-00-00', {
      issueId: 'issue-uuid',
      identifier: 'INT-9',
      closes: true,
      fixResult: { resolved: true, verified: true, verificationStatus: 'passed' },
    });

    expect(url).toBe('https://example.test/pull/9');
    const req = commitAndCreateAuditPRMock.mock.calls[0][1] as { body: string; baseSha: string; forkedFromBranch: string };
    expect(req.body).toContain('Closes INT-9');
    expect(req.baseSha).toBe('abc123');
    expect(req.forkedFromBranch).toBe('feat/in-flight');
    expect(source.addComment).toHaveBeenCalledWith('issue-uuid', expect.stringContaining('https://example.test/pull/9'));
  });

  it('only references — never closes — an issue the user passed with --issues', async () => {
    commitAndCreateAuditPRMock.mockResolvedValue('https://example.test/pull/10');
    ensureTaskSourceMock.mockResolvedValue({ addComment: vi.fn() });

    await shipAuditWorktree(audit, summary, '2026-07-21T00-00-00', {
      issueId: 'INT-9',
      identifier: 'INT-9',
      closes: false,
      fixResult: { resolved: true, verified: true, verificationStatus: 'passed' },
    });

    const req = commitAndCreateAuditPRMock.mock.calls[0][1] as { body: string };
    expect(req.body).toContain('Refs INT-9');
    expect(req.body).not.toContain('Closes');
  });

  it('discards the worktree when the audit changed nothing', async () => {
    commitAndCreateAuditPRMock.mockResolvedValue(null);

    const url = await shipAuditWorktree(audit, summary, '2026-07-21T00-00-00', {
      closes: false,
      fixResult: { resolved: true, verified: true, verificationStatus: 'passed' },
    });

    expect(url).toBeNull();
    expect(removeWorktreeMock).toHaveBeenCalledWith(audit.info);
  });

  it('keeps the worktree and does not throw when the PR fails', async () => {
    commitAndCreateAuditPRMock.mockRejectedValue(new Error('push rejected'));

    const url = await shipAuditWorktree(audit, summary, '2026-07-21T00-00-00', {
      closes: false,
      fixResult: { resolved: true, verified: true, verificationStatus: 'passed' },
    });

    expect(url).toBeNull();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('preserves candidate work and refuses to publish when the verification gate fails', async () => {
    const url = await shipAuditWorktree(audit, { ...summary, decision: 'revise' }, '2026-07-21T00-00-00', {
      closes: false,
      fixResult: { resolved: false, verified: false, verificationStatus: 'failed' },
    });

    expect(url).toBeNull();
    expect(commitAndCreateAuditPRMock).not.toHaveBeenCalled();
    expect(preserveWorktreeMock).toHaveBeenCalledWith(audit.info, expect.stringContaining('publication blocked'));
  });

  it('refuses publication when boolean flags conflict with a non-passed verification status', async () => {
    const url = await shipAuditWorktree(audit, summary, '2026-07-21T00-00-00', {
      closes: false,
      fixResult: { resolved: true, verified: true, verificationStatus: 'infra' },
    });

    expect(url).toBeNull();
    expect(commitAndCreateAuditPRMock).not.toHaveBeenCalled();
    expect(preserveWorktreeMock).toHaveBeenCalledWith(audit.info, expect.stringContaining('verification=infra'));
  });

  it('orders fix-unit planning, sandbox promotion, re-review, verification, then publication', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'openswarm-review-fix-pipeline-'));
    try {
      await mkdir(join(repo, 'src'));
      await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
      await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
      execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'base'], { cwd: repo });

      const area = { label: 'src', dir: 'src', files: ['src/a.ts'] };
      const initial: AuditRun = {
        results: [{ area, review: { decision: 'revise', feedback: '', issues: ['a must be 2'] } }],
        summary: aggregateAuditResults([]),
      };
      const events: string[] = [];
      const loop = await runFixVerifyLoop(initial, repo, {
        concurrency: 2,
        maxRounds: 1,
        repositoryContext: {
          canonicalRoot: repo,
          workspaces: [],
          manifests: [],
          verificationCommands: ['npm test'],
          sharedPaths: [],
          repoMemories: [],
          dependencyGraphAvailable: true,
          dependencyMap: {},
          preflight: { ready: true, issues: [] },
        },
      }, {
        fixWorker: async (unit, sandbox) => {
          events.push(`sandbox:${unit.label}`);
          await writeFile(join(sandbox, 'src', 'a.ts'), 'export const a = 2;\n');
          return { success: true };
        },
        review: async () => {
          events.push('re-review');
          expect(await readFile(join(repo, 'src', 'a.ts'), 'utf8')).toContain('= 2');
          return { decision: 'approve', feedback: '' };
        },
        verify: async () => {
          events.push('verify');
          return { success: (await readFile(join(repo, 'src', 'a.ts'), 'utf8')).includes('= 2') };
        },
      });

      commitAndCreateAuditPRMock.mockImplementation(async () => {
        events.push('publish');
        return 'https://example.test/pull/11';
      });
      const url = await shipAuditWorktree(
        { ...audit, info: { ...audit.info, worktreePath: repo } },
        loop.finalRun.summary,
        '2026-07-21T00-00-00',
        { closes: false, fixResult: loop },
      );

      expect(loop.resolved).toBe(true);
      expect(loop.verified).toBe(true);
      expect(url).toBe('https://example.test/pull/11');
      expect(events).toEqual(['sandbox:src', 're-review', 'verify', 'publish']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
