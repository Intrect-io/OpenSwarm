import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ITaskSource } from './taskSource.js';
import type { ExecutionContext } from './runnerExecution.js';

const buildTaskStateSyncComment = vi.fn();
const markTaskBlocked = vi.fn();
const markTaskBacklog = vi.fn();
const markTaskDone = vi.fn();
const loadRepoMetadata = vi.fn();
const mapLinearProject = vi.fn();
const fsStat = vi.fn();

// Keep this helper-focused suite isolated from the pipeline, filesystem, and
// persistent state dependencies loaded by runnerExecution.ts.
vi.mock('../agents/pairPipeline.js', async () => {
  const { buildTaskPrefix } = await import('../agents/pipelineTaskPrefix.js');
  return { createPipelineFromConfig: vi.fn(), buildTaskPrefix };
});
vi.mock('../agents/draftAnalyzer.js', () => ({ runDraftAnalysis: vi.fn() }));
vi.mock('../support/planner.js', () => ({
  needsDecomposition: vi.fn(),
  estimateTaskDuration: vi.fn(),
  runPlanner: vi.fn(),
  formatPlannerResult: vi.fn(),
}));
vi.mock('../support/worktreeManager.js', () => ({
  createWorktree: vi.fn(),
  commitAndCreatePR: vi.fn(),
  commitAndCreatePRWithHead: vi.fn(),
  findOpenPRFileOverlaps: vi.fn(),
  hasRecoverableWorktree: vi.fn(async () => false),
  preserveWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../knowledge/index.js', () => ({ analyzeIssue: vi.fn() }));
vi.mock('../agents/worker.js', () => ({ formatWorkReport: vi.fn() }));
vi.mock('../agents/reviewer.js', () => ({ formatReviewFeedback: vi.fn() }));
vi.mock('../agents/tester.js', () => ({ formatTestReport: vi.fn() }));
vi.mock('../agents/documenter.js', () => ({ formatDocReport: vi.fn() }));
vi.mock('../memory/index.js', () => ({ saveCognitiveMemory: vi.fn() }));
vi.mock('../orchestration/taskParser.js', () => ({
  loadParsedTask: vi.fn(),
  formatParsedTaskSummary: vi.fn(),
}));
vi.mock('../taskState/store.js', () => ({
  markTaskInProgress: vi.fn(),
  buildTaskStateSyncComment,
  completeParentIfChildrenDone: vi.fn(),
  markTaskBlocked,
  markTaskBacklog,
  markTaskDecomposed: vi.fn(),
  markTaskDone,
  releaseDependentTasks: vi.fn(),
  upsertTaskState: vi.fn(),
}));
vi.mock('./runnerState.js', () => ({
  getDecompositionDepth: vi.fn(),
  getChildrenCount: vi.fn(),
  getDailyCreationCount: vi.fn(),
  canCreateMoreIssues: vi.fn(),
  registerDecomposition: vi.fn(),
}));
vi.mock('../support/repoMetadata.js', () => ({ loadRepoMetadata }));
vi.mock('../support/projectMapper.js', () => ({ mapLinearProject }));
vi.mock('fs/promises', () => ({ stat: fsStat }));

let setTaskSource: typeof import('./runnerExecution.js')['setTaskSource'];
let getTaskSource: typeof import('./runnerExecution.js')['getTaskSource'];
let setNotifier: typeof import('./runnerExecution.js')['setNotifier'];
let reportToDiscord: typeof import('./runnerExecution.js')['reportToDiscord'];
let fetchLinearTasks: typeof import('./runnerExecution.js')['fetchLinearTasks'];
let resolveProjectPath: typeof import('./runnerExecution.js')['resolveProjectPath'];
let isValidProjectPath: typeof import('./runnerExecution.js')['isValidProjectPath'];
let syncFailureState: typeof import('./runnerExecution.js')['syncFailureState'];
let syncCancellationState: typeof import('./runnerExecution.js')['syncCancellationState'];
let syncSuccessState: typeof import('./runnerExecution.js')['syncSuccessState'];

beforeAll(async () => {
  const mod = await import('./runnerExecution.js');
  setTaskSource = mod.setTaskSource;
  getTaskSource = mod.getTaskSource;
  setNotifier = mod.setNotifier;
  reportToDiscord = mod.reportToDiscord;
  fetchLinearTasks = mod.fetchLinearTasks;
  resolveProjectPath = mod.resolveProjectPath;
  isValidProjectPath = mod.isValidProjectPath;
  syncFailureState = mod.syncFailureState;
  syncCancellationState = mod.syncCancellationState;
  syncSuccessState = mod.syncSuccessState;
});

function task(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-1',
    source: 'linear',
    title: 'Fix the flaky retry logic',
    description: 'The retry logic drops cursor state between pages.',
    priority: 2,
    createdAt: Date.now(),
    issueId: 'issue-1',
    issueIdentifier: 'INT-100',
    linearProject: { id: 'proj-1', name: 'OpenSwarm' },
    ...overrides,
  };
}

function makeTaskSource(overrides: Partial<ITaskSource> = {}): ITaskSource {
  return {
    kind: 'local',
    fetchTasks: vi.fn(async () => []),
    createTask: vi.fn(async () => ({ id: 'top-1', identifier: 'INT-200', title: 'top' })),
    updateState: vi.fn(async () => true),
    addComment: vi.fn(async () => {}),
    createSubIssue: vi.fn(async () => ({ id: 'sub-1', identifier: 'INT-101', title: 'sub-task' })),
    logPairStart: vi.fn(async () => {}),
    logPairComplete: vi.fn(async () => {}),
    logBlocked: vi.fn(async () => {}),
    logStuck: vi.fn(async () => {}),
    unstick: vi.fn(async () => {}),
    logHalt: vi.fn(async () => {}),
    markAsDecomposed: vi.fn(async () => {}),
    ...overrides,
  } as ITaskSource;
}

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    allowedProjects: [],
    getRolesForProject: vi.fn(() => undefined),
    reportToDiscord: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('runner execution state synchronization helpers', () => {
  let taskSource: ITaskSource;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    markTaskBlocked.mockReturnValue({ issueId: 'issue-1' });
    markTaskBacklog.mockReturnValue({ issueId: 'issue-1' });
    markTaskDone.mockReturnValue({ issueId: 'issue-1' });
    buildTaskStateSyncComment.mockReturnValue('sync comment');
    taskSource = makeTaskSource();
    setTaskSource(taskSource);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('syncFailureState no-ops without an issueId', async () => {
    await syncFailureState(task({ issueId: undefined }), 'blocked reason');
    expect(markTaskBlocked).not.toHaveBeenCalled();
  });

  it('syncFailureState marks the task blocked and comments', async () => {
    await syncFailureState(task({ blockedBy: ['dep-1'] }), 'blocked reason');
    expect(markTaskBlocked).toHaveBeenCalledWith('issue-1', 'blocked reason', ['dep-1'], undefined);
    expect(taskSource.addComment).toHaveBeenCalledWith('issue-1', 'sync comment');
  });

  it('syncFailureState tolerates an addComment failure', async () => {
    (taskSource.addComment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));
    await expect(syncFailureState(task(), 'blocked reason')).resolves.toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to sync blocked state'), expect.any(Error));
  });

  it('syncCancellationState no-ops without an issueId', async () => {
    await syncCancellationState(task({ issueId: undefined }));
    expect(markTaskBacklog).not.toHaveBeenCalled();
  });

  it('syncCancellationState moves the task to Backlog and comments', async () => {
    await syncCancellationState(task());
    expect(taskSource.updateState).toHaveBeenCalledWith('issue-1', 'Backlog');
    expect(taskSource.addComment).toHaveBeenCalledWith('issue-1', 'sync comment', undefined);
  });

  it('syncCancellationState fails closed when updateState throws', async () => {
    (taskSource.updateState as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));
    await expect(syncCancellationState(task())).rejects.toThrow('linear down');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to move cancelled task'), expect.any(Error));
    expect(taskSource.addComment).not.toHaveBeenCalled();
  });

  it('syncCancellationState fails closed when the tracker refuses Backlog', async () => {
    (taskSource.updateState as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    await expect(syncCancellationState(task())).rejects.toThrow('refused Backlog');
    expect(taskSource.addComment).not.toHaveBeenCalled();
  });

  it('syncCancellationState propagates an addComment failure for outbox retry', async () => {
    (taskSource.addComment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));
    await expect(syncCancellationState(task())).rejects.toThrow('linear down');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to sync cancelled state'), expect.any(Error));
  });

  it('syncCancellationState reuses the frozen comment and idempotency key', async () => {
    await syncCancellationState(task(), 'cancel:issue-1:attempt:1', 'frozen cancellation');
    expect(taskSource.addComment).toHaveBeenCalledWith(
      'issue-1',
      'frozen cancellation',
      'cancel:issue-1:attempt:1',
    );
  });

  it('syncSuccessState no-ops without an issueId', async () => {
    await syncSuccessState(task({ issueId: undefined }), 90);
    expect(markTaskDone).not.toHaveBeenCalled();
  });

  it('syncSuccessState marks the task done and comments with confidence', async () => {
    await syncSuccessState(task(), 92);
    expect(markTaskDone).toHaveBeenCalledWith('issue-1', expect.objectContaining({ confidence: 92 }));
    expect(taskSource.addComment).toHaveBeenCalledWith('issue-1', 'sync comment');
  });

  it('syncSuccessState tolerates an addComment failure', async () => {
    (taskSource.addComment as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));
    await expect(syncSuccessState(task(), 92)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to sync success state'), expect.any(Error));
  });
});

describe('runner execution integration singletons', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('logs when no notifier is registered', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await reportToDiscord('hello from OpenSwarm');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('No notifier'), 'hello from OpenSwarm');
  });

  it('routes through a registered notifier', async () => {
    const notify = vi.fn(async () => {});
    setNotifier({ notify });
    await reportToDiscord('now routed');
    expect(notify).toHaveBeenCalledWith('now routed');
  });

  it('returns the registered task source', () => {
    const source = makeTaskSource();
    setTaskSource(source);
    expect(getTaskSource()).toBe(source);
  });

  it('fetches tasks from the registered source', async () => {
    const tasks = [task()];
    const source = makeTaskSource({ fetchTasks: vi.fn(async () => tasks) });
    setTaskSource(source);
    await expect(fetchLinearTasks()).resolves.toMatchObject({ tasks });
  });

  it('surfaces a fetch failure and logs recovery on the next success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetchTasks = vi.fn()
      .mockRejectedValueOnce(new Error('linear API down'))
      .mockResolvedValueOnce([]);
    setTaskSource(makeTaskSource({ fetchTasks }));

    await expect(fetchLinearTasks()).resolves.toMatchObject({ tasks: [], error: 'linear API down' });
    await expect(fetchLinearTasks()).resolves.toMatchObject({ tasks: [] });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('recovered after 1 failures'));
  });
});

describe('resolveProjectPath / isValidProjectPath', () => {
  function makeFsStatImpl(dirs: Record<string, string[]>) {
    return async (path: string) => {
      const normalized = String(path);
      if (normalized in dirs) return { isDirectory: () => true, isFile: () => false };
      for (const [dir, markers] of Object.entries(dirs)) {
        if (markers.some((marker) => normalized === `${dir}/${marker}`)) {
          return { isDirectory: () => false, isFile: () => true };
        }
      }
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${normalized}'`), { code: 'ENOENT' });
    };
  }

  let originalHome: string | undefined;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    originalHome = process.env.HOME;
    process.env.HOME = '/home/testuser';
    loadRepoMetadata.mockReset().mockResolvedValue(null);
    mapLinearProject.mockReset().mockResolvedValue(null);
    fsStat.mockReset().mockImplementation(makeFsStatImpl({}));
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('returns null immediately when the task has no Linear project info', async () => {
    await expect(resolveProjectPath(makeCtx(), task({ linearProject: undefined }))).resolves.toBeNull();
    expect(loadRepoMetadata).not.toHaveBeenCalled();
  });

  it('resolves via the openswarm.json project mapping', async () => {
    loadRepoMetadata.mockResolvedValueOnce({ linear: { projectId: 'proj-1' } });
    fsStat.mockImplementation(makeFsStatImpl({ '/home/dev/repoA': ['.git'] }));
    await expect(resolveProjectPath(
      makeCtx({ allowedProjects: ['/home/dev/repoA'] }),
      task(),
    )).resolves.toBe('/home/dev/repoA');
  });

  it('tolerates unreadable metadata and uses an allowed-project basename match', async () => {
    loadRepoMetadata.mockRejectedValueOnce(new Error('EACCES'));
    fsStat.mockImplementation(makeFsStatImpl({ '/home/dev/OpenSwarm': ['.git'] }));
    await expect(resolveProjectPath(
      makeCtx({ allowedProjects: ['/home/dev/OpenSwarm'] }),
      task(),
    )).resolves.toBe('/home/dev/OpenSwarm');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('openswarm.json unreadable'));
  });

  it('matches allowedProjects case-insensitively by basename', async () => {
    fsStat.mockImplementation(makeFsStatImpl({ '/home/dev/openswarm-repo': ['package.json'] }));
    await expect(resolveProjectPath(
      makeCtx({ allowedProjects: ['/home/dev/openswarm-repo'] }),
      task({ linearProject: { id: 'proj-1', name: 'openswarm-repo' } }),
    )).resolves.toBe('/home/dev/openswarm-repo');
  });

  it.each([
    ['direct project path', '/home/testuser/dev/OpenSwarm', 'OpenSwarm', '.git'],
    ['lowercase project path', '/home/testuser/dev/openswarm', 'OpenSwarm', '.git'],
    ['tools project path', '/home/testuser/dev/tools/pykis', 'pykis', 'pyproject.toml'],
  ])('resolves the %s fallback', async (_label, path, projectName, marker) => {
    fsStat.mockImplementation(makeFsStatImpl({ [path]: [marker] }));
    await expect(resolveProjectPath(
      makeCtx(),
      task({ linearProject: { id: 'proj-1', name: projectName } }),
    )).resolves.toBe(path);
  });

  it('does not dispatch a valid direct fallback outside a configured allow-list', async () => {
    fsStat.mockImplementation(makeFsStatImpl({
      '/home/testuser/dev/OpenSwarm': ['.git'],
      '/home/dev/repoA': ['.git'],
    }));
    await expect(resolveProjectPath(
      makeCtx({ allowedProjects: ['/home/dev/repoA'] }),
      task(),
    )).resolves.toBeNull();
  });

  it('uses the fuzzy mapper as the last fallback', async () => {
    mapLinearProject.mockResolvedValueOnce('/some/fuzzy/match');
    await expect(resolveProjectPath(
      makeCtx(),
      task({ linearProject: { id: 'proj-1', name: 'Unmatched Project' } }),
    )).resolves.toBe('/some/fuzzy/match');
    expect(mapLinearProject).toHaveBeenCalledWith('proj-1', 'Unmatched Project', []);
  });

  it('does not dispatch a fuzzy mapping outside a configured allow-list', async () => {
    mapLinearProject.mockResolvedValueOnce('/some/fuzzy/match');
    await expect(resolveProjectPath(
      makeCtx({ allowedProjects: ['/home/dev/repoA'] }),
      task({ linearProject: { id: 'proj-1', name: 'Unmatched Project' } }),
    )).resolves.toBeNull();
  });

  it('returns null when every resolution priority fails', async () => {
    await expect(resolveProjectPath(
      makeCtx(),
      task({ linearProject: { id: 'proj-1', name: 'Nowhere' } }),
    )).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to resolve project path'));
  });

  it('rejects a path that is not a directory', async () => {
    fsStat.mockImplementation(async () => ({ isDirectory: () => false }));
    await expect(isValidProjectPath('/some/file.txt')).resolves.toBe(false);
  });

  it('rejects a path when stat throws', async () => {
    fsStat.mockImplementation(async () => { throw new Error('ENOENT'); });
    await expect(isValidProjectPath('/does/not/exist')).resolves.toBe(false);
  });

  it('rejects a directory without a repository marker', async () => {
    fsStat.mockImplementation(makeFsStatImpl({ '/repo/empty-dir': [] }));
    await expect(isValidProjectPath('/repo/empty-dir')).resolves.toBe(false);
  });

  it('accepts a directory when a later marker exists', async () => {
    fsStat.mockImplementation(makeFsStatImpl({ '/repo/node-project': ['package.json'] }));
    await expect(isValidProjectPath('/repo/node-project')).resolves.toBe(true);
  });
});
