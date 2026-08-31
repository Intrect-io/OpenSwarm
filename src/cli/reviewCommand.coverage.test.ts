// Coverage companion for reviewCommand.ts — targets the branches the base
// reviewCommand.test.ts doesn't reach: resolveProjectId's catch path, the
// ensureProjectMapping "already mapped" / default-dep / ExitPromptError-rethrow
// branches, the whole ensureTaskSource() Linear-init decision tree, and
// runReviewCommand's *default* (non-injected) review/getBranch/log/fileFollowups
// implementations. Every external module they dynamically import is mocked so
// nothing here makes a real git/Linear/adapter call.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewResult } from '../agents/agentPair.js';

const getTaskSourceMock = vi.fn();
const fileReviewerFollowupsMock = vi.fn();
vi.mock('../automation/runnerExecution.js', () => ({
  getTaskSource: getTaskSourceMock,
  fileReviewerFollowups: fileReviewerFollowupsMock,
}));

const isLinearInitializedMock = vi.fn();
const initLinearMock = vi.fn();
vi.mock('../linear/linear.js', () => ({
  isLinearInitialized: isLinearInitializedMock,
  initLinear: initLinearMock,
}));

const loadConfigMock = vi.fn();
vi.mock('../core/config.js', () => ({
  loadConfig: loadConfigMock,
}));

const getProfileMock = vi.fn();
// Must be a real `function`, not an arrow, so `new AuthProfileStoreMock()` (as the
// SUT calls it) actually constructs — vi.fn() only special-cases `new` for
// function/class implementations (arrow-function impls silently throw a TypeError,
// see the vitest console warning), which reviewCommand.ts's try/catch would swallow.
const AuthProfileStoreMock = vi.fn().mockImplementation(function () {
  return { getProfile: getProfileMock };
});
const ensureValidTokenMock = vi.fn();
vi.mock('../auth/index.js', () => ({
  AuthProfileStore: AuthProfileStoreMock,
  ensureValidToken: ensureValidTokenMock,
}));

const LinearTaskSourceMock = vi.fn().mockImplementation(function () {
  return { kind: 'linear-task-source' };
});
vi.mock('../automation/taskSource.js', () => ({
  LinearTaskSource: LinearTaskSourceMock,
}));

const runReviewerMock = vi.fn();
vi.mock('../agents/reviewer.js', () => ({
  runReviewer: runReviewerMock,
}));

// Default review-command coverage must not write repository-local history into
// the OpenSwarm checkout running the test suite.
const loadReviewHistoryMock = vi.fn(async () => ({ records: [], legacyExcerpts: [] }));
const captureReviewFileHashesMock = vi.fn(async () => ({}));
const saveReviewHistoryMock = vi.fn(async () => '/tmp/review-history.json');
vi.mock('./reviewHistory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reviewHistory.js')>();
  return {
    ...actual,
    loadReviewHistory: loadReviewHistoryMock,
    captureReviewFileHashes: captureReviewFileHashesMock,
    saveReviewHistory: saveReviewHistoryMock,
  };
});

const loadRepoMetadataMock = vi.fn();
vi.mock('../support/repoMetadata.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../support/repoMetadata.js')>();
  return { ...actual, loadRepoMetadata: loadRepoMetadataMock };
});

const resolveLinearCredentialMock = vi.fn();
const pickAndSaveLinearMappingMock = vi.fn();
vi.mock('./linearMapping.js', () => ({
  resolveLinearCredential: resolveLinearCredentialMock,
  pickAndSaveLinearMapping: pickAndSaveLinearMappingMock,
}));

const execFileSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

const startReviewProgressMock = vi.fn();
vi.mock('./reviewProgress.js', () => ({
  startReviewProgress: startReviewProgressMock,
}));

const {
  formatReviewOutput,
  resolveProjectId,
  ensureProjectMapping,
  ensureTaskSource,
  resolveTaskSource,
  runReviewCommand,
} = await import('./reviewCommand.js');

beforeEach(() => {
  vi.clearAllMocks();
  getTaskSourceMock.mockReturnValue(null);
  isLinearInitializedMock.mockReturnValue(false);
  loadConfigMock.mockReturnValue({ linearTeamId: '', linearApiKey: '' });
});

describe('resolveProjectId (INT-1968)', () => {
  it('returns undefined when loadRepoMetadata throws', async () => {
    loadRepoMetadataMock.mockRejectedValueOnce(new Error('unreadable'));
    await expect(resolveProjectId('/some/repo')).resolves.toBeUndefined();
  });

  it('returns the mapped projectId when present', async () => {
    loadRepoMetadataMock.mockResolvedValueOnce({ linear: { projectId: 'proj-7' } });
    await expect(resolveProjectId('/some/repo')).resolves.toBe('proj-7');
  });
});

describe('ensureProjectMapping — extra branches (INT-2599)', () => {
  const cwd = '/tmp/openswarm-test-ensure-project-mapping-coverage';

  it('returns the existing project when the repo already has an openswarm.json mapping', async () => {
    loadRepoMetadataMock.mockResolvedValueOnce({ linear: { projectId: 'proj-existing' } });
    const resolveCredential = vi.fn();
    const result = await ensureProjectMapping(cwd, undefined, { resolveCredential });
    expect(result).toEqual({ projectId: 'proj-existing', abort: false });
    expect(resolveCredential).not.toHaveBeenCalled(); // short-circuited before touching Linear
  });

  it('uses the default resolveCredential (via ./linearMapping.js) when none is injected', async () => {
    loadRepoMetadataMock.mockResolvedValueOnce(null);
    resolveLinearCredentialMock.mockResolvedValueOnce(null);
    const result = await ensureProjectMapping(cwd, undefined, {});
    expect(result).toEqual({ projectId: undefined, abort: false });
    expect(resolveLinearCredentialMock).toHaveBeenCalledOnce();
  });

  it('uses the default pickAndSave (via ./linearMapping.js) when none is injected', async () => {
    loadRepoMetadataMock.mockResolvedValueOnce(null);
    pickAndSaveLinearMappingMock.mockResolvedValueOnce({
      kind: 'saved',
      teamId: 'team-1',
      mapping: { teamId: 'team-1', projectId: 'proj-default-pick' },
    });
    const result = await ensureProjectMapping(cwd, undefined, {
      resolveCredential: async () => ({ apiKey: 'x' }),
      isTTY: true,
    });
    expect(result).toEqual({ projectId: 'proj-default-pick', abort: false });
    expect(pickAndSaveLinearMappingMock).toHaveBeenCalledWith(cwd, { apiKey: 'x' });
  });

  it('rethrows a non-ExitPromptError from the picker instead of swallowing it', async () => {
    loadRepoMetadataMock.mockResolvedValueOnce(null);
    await expect(
      ensureProjectMapping(cwd, undefined, {
        resolveCredential: async () => ({ apiKey: 'x' }),
        isTTY: true,
        pickAndSave: async () => {
          throw new Error('picker exploded');
        },
      }),
    ).rejects.toThrow('picker exploded');
  });

  it('rethrows a thrown non-Error value as-is (the instanceof guard falls through)', async () => {
    loadRepoMetadataMock.mockResolvedValueOnce(null);
    await expect(
      ensureProjectMapping(cwd, undefined, {
        resolveCredential: async () => ({ apiKey: 'x' }),
        isTTY: true,
        pickAndSave: async () => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 'not an Error instance';
        },
      }),
    ).rejects.toBe('not an Error instance');
  });

  it('swallows an ExitPromptError raised directly by ensureProjectMapping\'s own picker call', async () => {
    loadRepoMetadataMock.mockResolvedValueOnce(null);
    const exitPromptError = new Error('ctrl-c');
    exitPromptError.name = 'ExitPromptError';
    const result = await ensureProjectMapping(cwd, undefined, {
      resolveCredential: async () => ({ apiKey: 'x' }),
      isTTY: true,
      pickAndSave: async () => {
        throw exitPromptError;
      },
    });
    expect(result).toEqual({ projectId: undefined, abort: true });
  });

  it('falls back to real process.stdin.isTTY when `isTTY` is not injected', async () => {
    loadRepoMetadataMock.mockResolvedValueOnce(null);
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const result = await ensureProjectMapping(cwd, undefined, {
        resolveCredential: async () => ({ apiKey: 'x' }),
        log: () => {},
      });
      // No TTY (real process.stdin.isTTY is false in the test runner) → fails closed.
      expect(result).toEqual({ projectId: undefined, abort: true });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });
});

describe('formatReviewOutput — "revise" decision (yellow branch, INT-1966)', () => {
  it('uses the yellow color and the ✎ mark for a non-approve/non-reject decision', () => {
    const review: ReviewResult = { decision: 'revise', feedback: 'needs tweaks' };
    const colored = formatReviewOutput(review, true);
    expect(colored).toContain('\x1b[33m'); // ANSI yellow
    expect(formatReviewOutput(review, false)).toContain('✎ Decision: REVISE');
  });

  it('omits the feedback line entirely when there is no feedback', () => {
    const review: ReviewResult = { decision: 'approve', feedback: '' };
    const out = formatReviewOutput(review);
    expect(out).toBe('✓ Decision: APPROVE'); // single line, no blank feedback line appended
  });
});

describe('ensureTaskSource (INT-1969)', () => {
  it('returns the already-registered task source without touching Linear init', async () => {
    getTaskSourceMock.mockReturnValueOnce({ kind: 'existing-source' });
    const result = await ensureTaskSource();
    expect(result).toEqual({ kind: 'existing-source' });
    expect(isLinearInitializedMock).not.toHaveBeenCalled();
  });

  it('initializes Linear via the OAuth profile and returns a LinearTaskSource', async () => {
    isLinearInitializedMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    loadConfigMock.mockReturnValueOnce({ linearTeamId: 'team-1', linearApiKey: '' });
    getProfileMock.mockReturnValueOnce({ id: 'linear:default' });
    ensureValidTokenMock.mockResolvedValueOnce('token-abc');

    const result = await ensureTaskSource();

    expect(initLinearMock).toHaveBeenCalledWith('token-abc', 'team-1', true);
    expect(LinearTaskSourceMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: 'linear-task-source' });
  });

  it('falls back to config.linearApiKey when there is no OAuth profile', async () => {
    isLinearInitializedMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    loadConfigMock.mockReturnValueOnce({ linearTeamId: 'team-2', linearApiKey: 'key-xyz' });
    getProfileMock.mockReturnValueOnce(undefined);

    await ensureTaskSource();

    expect(ensureValidTokenMock).not.toHaveBeenCalled();
    expect(initLinearMock).toHaveBeenCalledWith('key-xyz', 'team-2');
  });

  // A revoked or expired OAuth grant used to take the profile branch, throw, and
  // leave a configured-and-valid apiKey untried. The two credentials are
  // independent, so a dead one is a reason to try the other. (AGT-4152)
  it('falls back to the apiKey when the OAuth profile refresh is rejected', async () => {
    isLinearInitializedMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    loadConfigMock.mockReturnValueOnce({ linearTeamId: 'team-3', linearApiKey: 'key-live' });
    getProfileMock.mockReturnValueOnce({ id: 'linear:default' });
    const revoked = Object.assign(new Error('Token refresh failed (400): Refresh token revoked'), {
      name: 'TokenRefreshError',
      status: 400,
    });
    ensureValidTokenMock.mockRejectedValueOnce(revoked);

    const result = await resolveTaskSource();

    expect(initLinearMock).toHaveBeenCalledWith('key-live', 'team-3');
    expect(result).toEqual({ source: { kind: 'linear-task-source' } });
  });

  // Without an apiKey there is nothing to fall back to, and the OAuth cause is
  // what the operator needs — it must not flatten to "unconfigured". (AGT-4148)
  it('reports the rejected credential when no apiKey is configured', async () => {
    // Exactly one queued value: the rethrow exits before the confirmation check,
    // and a leftover mockReturnValueOnce would leak into the next test.
    isLinearInitializedMock.mockReturnValueOnce(false);
    loadConfigMock.mockReturnValueOnce({ linearTeamId: 'team-4', linearApiKey: '' });
    getProfileMock.mockReturnValueOnce({ id: 'linear:default' });
    ensureValidTokenMock.mockRejectedValueOnce(Object.assign(new Error('Token refresh failed (400): revoked'), {
      name: 'TokenRefreshError',
      status: 400,
    }));

    const result = await resolveTaskSource();

    expect(initLinearMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ source: null, reason: 'credential-rejected' });
  });

  // A live OAuth profile must still win; the apiKey is a fallback, not a peer.
  it('does not touch the apiKey when the OAuth profile works', async () => {
    isLinearInitializedMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    loadConfigMock.mockReturnValueOnce({ linearTeamId: 'team-5', linearApiKey: 'key-unused' });
    getProfileMock.mockReturnValueOnce({ id: 'linear:default' });
    ensureValidTokenMock.mockResolvedValueOnce('token-live');

    await resolveTaskSource();

    expect(initLinearMock).toHaveBeenCalledTimes(1);
    expect(initLinearMock).toHaveBeenCalledWith('token-live', 'team-5', true);
  });

  it('returns null when there is no linearTeamId configured at all', async () => {
    isLinearInitializedMock.mockReturnValueOnce(false).mockReturnValueOnce(false);
    loadConfigMock.mockReturnValueOnce({ linearTeamId: '', linearApiKey: '' });

    const result = await ensureTaskSource();

    expect(initLinearMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('skips the team/credential lookup entirely when Linear is already initialized', async () => {
    isLinearInitializedMock.mockReturnValueOnce(true).mockReturnValueOnce(true);

    const result = await ensureTaskSource();

    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'linear-task-source' });
  });

  it('returns null when the Linear init logic throws', async () => {
    isLinearInitializedMock.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    await expect(ensureTaskSource()).resolves.toBeNull();
  });
});

describe('runReviewCommand default deps (no injected review/getBranch/log/fileFollowups)', () => {
  const approveWithFollowups = async () =>
    ({ decision: 'approve', feedback: 'ok', recommendedActions: [{ type: 'test', title: 't' }] }) as ReviewResult;

  it('uses console.log when no `log` dep is supplied (no-changes path)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const out = await runReviewCommand({}, { getChangedFiles: async () => [] });
      expect(out).toBeNull();
      expect(logSpy).toHaveBeenCalledWith('No working-tree changes to review.');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('builds the reviewer call itself (working-tree mode) when no `review` dep is supplied', async () => {
    runReviewerMock.mockResolvedValueOnce({ decision: 'approve', feedback: 'ok' } as ReviewResult);
    await runReviewCommand(
      {},
      { getChangedFiles: async () => ['a.ts'], startProgress: () => null, log: () => {} },
    );
    expect(runReviewerMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskTitle: 'CLI working-tree review', projectPath: process.cwd(), mode: 'direct' }),
    );
  });

  it('forwards --read-only to the reviewer so CI reviews cannot mutate or shell out', async () => {
    // The CI gate reviews an attacker-authored diff. If the flag stopped at the
    // CLI boundary the reviewer would keep bash with the provider credential in
    // the environment. (INT-3189)
    runReviewerMock.mockResolvedValueOnce({ decision: 'approve', feedback: 'ok' } as ReviewResult);
    await runReviewCommand(
      { base: 'origin/main', readOnly: true },
      { getChangedFiles: async () => ['a.ts'], startProgress: () => null, log: () => {} },
    );
    expect(runReviewerMock).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  });

  it('leaves the local review unrestricted when --read-only is absent', async () => {
    runReviewerMock.mockResolvedValueOnce({ decision: 'approve', feedback: 'ok' } as ReviewResult);
    await runReviewCommand(
      {},
      { getChangedFiles: async () => ['a.ts'], startProgress: () => null, log: () => {} },
    );
    expect(runReviewerMock.mock.calls.at(-1)?.[0].readOnly).toBeUndefined();
  });

  it('builds the reviewer call itself (committed-diff mode) when `opts.base` is set', async () => {
    runReviewerMock.mockResolvedValueOnce({ decision: 'approve', feedback: 'ok' } as ReviewResult);
    await runReviewCommand(
      { base: 'origin/main' },
      { getChangedFiles: async () => ['a.ts'], startProgress: () => null, log: () => {} },
    );
    expect(runReviewerMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskTitle: 'CLI committed-diff review (vs origin/main)', mode: 'direct' }),
    );
  });

  it('resolves the branch itself via execFileSync when no `getBranch` dep is supplied', async () => {
    execFileSyncMock.mockReturnValueOnce(Buffer.from('feat/int-4242-thing\n'));
    const fileFollowups = vi.fn(async () => 1);
    const logs: string[] = [];
    await runReviewCommand(
      { fileIssue: true },
      {
        getChangedFiles: async () => ['a.ts'],
        review: approveWithFollowups,
        fileFollowups,
        startProgress: () => null,
        log: (l) => logs.push(l),
      },
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      expect.objectContaining({ cwd: process.cwd() }),
    );
    expect(fileFollowups).toHaveBeenCalledWith('INT-4242', expect.anything());
  });

  it('logs the skip message when the project-mapping preflight aborts', async () => {
    const logs: string[] = [];
    await runReviewCommand(
      { fileIssue: 'INT-1' },
      {
        getChangedFiles: async () => ['a.ts'],
        review: approveWithFollowups,
        ensureProjectMapping: async () => ({ projectId: undefined, abort: true }),
        startProgress: () => null,
        log: (l) => logs.push(l),
      },
    );
    expect(logs.join('\n')).toContain('Skipped filing follow-ups');
  });

  it('files via the default fileFollowups (ensureTaskSource + fileReviewerFollowups) when none is injected', async () => {
    getTaskSourceMock.mockReturnValueOnce({ kind: 'existing-source' });
    fileReviewerFollowupsMock.mockResolvedValueOnce(3);
    const logs: string[] = [];
    const result = await runReviewCommand(
      { fileIssue: 'INT-1' },
      {
        getChangedFiles: async () => ['a.ts'],
        review: approveWithFollowups,
        ensureProjectMapping: async () => ({ projectId: 'proj-9', abort: false }),
        startProgress: () => null,
        log: (l) => logs.push(l),
      },
    );
    expect(fileReviewerFollowupsMock).toHaveBeenCalledWith(
      { kind: 'existing-source' },
      'INT-1',
      result,
      { autoFile: true, projectId: 'proj-9', requireApprove: false },
    );
    expect(logs.join('\n')).toContain('Filed 3 follow-up sub-issue(s) under INT-1.');
  });

  it('default fileFollowups returns 0 (and reports it) when no task source is available', async () => {
    getTaskSourceMock.mockReturnValueOnce(null);
    isLinearInitializedMock.mockReturnValue(false);
    loadConfigMock.mockReturnValue({ linearTeamId: '', linearApiKey: '' });
    const logs: string[] = [];
    await runReviewCommand(
      { fileIssue: 'INT-1' },
      {
        getChangedFiles: async () => ['a.ts'],
        review: approveWithFollowups,
        ensureProjectMapping: async () => ({ projectId: undefined, abort: false }),
        startProgress: () => null,
        log: (l) => logs.push(l),
      },
    );
    expect(fileReviewerFollowupsMock).not.toHaveBeenCalled();
    // Names the cause instead of the old ambiguous "Is Linear connected?", which
    // read the same whether the credential was dead or simply absent. (AGT-4148)
    const out = logs.join('\n');
    expect(out).toContain('Linear is not configured, so it could not file follow-ups');
    expect(out).toContain('openswarm auth login --provider linear');
  });

  it('logs the changed-file count when opts.debug is set', async () => {
    const logs: string[] = [];
    await runReviewCommand(
      { debug: true },
      {
        getChangedFiles: async () => ['a.ts', 'b.ts'],
        review: async () => ({ decision: 'approve', feedback: 'ok' }) as ReviewResult,
        startProgress: () => null,
        log: (l) => logs.push(l),
      },
    );
    expect(logs.join('\n')).toContain('Reviewing 2 changed file(s): a.ts, b.ts');
  });

  it('the default getBranch swallows a git failure via .catch(() => "") (no parent inferred)', async () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });
    const fileFollowups = vi.fn(async () => 2);
    const logs: string[] = [];
    await runReviewCommand(
      { fileIssue: true },
      {
        getChangedFiles: async () => ['a.ts'],
        review: approveWithFollowups,
        fileFollowups,
        ensureProjectMapping: async () => ({ projectId: undefined, abort: false }),
        startProgress: () => null,
        log: (l) => logs.push(l),
      },
    );
    // Branch resolution failed → no parent id → standalone follow-ups, not a crash.
    expect(fileFollowups).toHaveBeenCalledWith(undefined, expect.anything());
    expect(logs.join('\n')).toContain('standalone follow-up issue');
  });

  it('starts the real spinner (via ./reviewProgress.js) when stderr is a TTY and no startProgress dep is given', async () => {
    const originalIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    const note = vi.fn();
    const stop = vi.fn();
    startReviewProgressMock.mockReturnValueOnce({ note, stop });
    try {
      await runReviewCommand(
        {},
        {
          getChangedFiles: async () => ['a.ts'],
          review: async (_wr, _cwd, onLog) => {
            onLog?.('🔧 read_file: a.ts');
            return { decision: 'approve', feedback: 'ok' } as ReviewResult;
          },
          log: () => {},
        },
      );
      expect(startReviewProgressMock).toHaveBeenCalledOnce();
      expect(note).toHaveBeenCalledWith('🔧 read_file: a.ts');
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(process.stderr, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });
});
