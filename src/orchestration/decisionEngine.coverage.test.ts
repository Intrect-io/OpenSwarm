import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowConfig } from './workflow.js';
import type { ParsedTask } from './taskParser.js';

// This file targets the DecisionEngine class methods (heartbeat, heartbeatMultiple,
// executeTask, filterExecutableTasks, prioritizeTasks, validateScope, taskToWorkflow,
// addToBacklog, getDiscoveredTasks, getStats) and the module-level loadState/saveState
// + getDecisionEngine/runHeartbeat singleton helpers — none of which are exercised by
// the sibling decisionEngine.*.test.ts files (those only cover the pure/exported helper
// functions). All external side effects (fs, workflow/taskParser storage, timeWindow,
// memory, knowledge graph, task readiness) are mocked so the whole suite stays in-memory.

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock('fs/promises', () => fsMock);

const timeWindowMock = vi.hoisted(() => ({ checkWorkAllowed: vi.fn() }));
vi.mock('../support/timeWindow.js', () => timeWindowMock);

const taskStateMock = vi.hoisted(() => ({ getTaskReadiness: vi.fn() }));
vi.mock('../taskState/store.js', () => taskStateMock);

const memoryMock = vi.hoisted(() => ({ saveCognitiveMemory: vi.fn() }));
vi.mock('../memory/index.js', () => memoryMock);

const knowledgeMock = vi.hoisted(() => ({ analyzeIssue: vi.fn() }));
vi.mock('../knowledge/index.js', () => knowledgeMock);

const workflowMock = vi.hoisted(() => ({
  loadWorkflow: vi.fn(),
  listWorkflows: vi.fn(),
  createCIPipelineTemplate: vi.fn(),
}));
vi.mock('./workflow.js', () => workflowMock);

const taskParserMock = vi.hoisted(() => ({
  parseTask: vi.fn(),
  saveParsedTask: vi.fn(),
  loadParsedTask: vi.fn(),
  formatParsedTaskSummary: vi.fn(),
}));
vi.mock('./taskParser.js', () => taskParserMock);

import {
  DecisionEngine,
  getDecisionEngine,
  runHeartbeat,
  type TaskItem,
  type DiscoveredTask,
} from './decisionEngine.js';

function task(partial: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'issue-1',
    issueId: 'issue-1',
    issueIdentifier: 'INT-1',
    source: 'linear',
    title: 'fix(worker): retry transient failures',
    priority: 3,
    linearState: 'Todo',
    createdAt: 0,
    ...partial,
  };
}

function workflow(partial: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    projectPath: '/repo/project',
    steps: [{ id: 'step1', name: 'Step 1', prompt: 'do it' }],
    ...partial,
  };
}

function parsedTaskFixture(partial: Partial<ParsedTask> = {}): ParsedTask {
  return {
    original: { id: 'issue-1', title: 'fix(worker): retry transient failures', description: '' },
    analysis: {
      type: 'bug_fix',
      complexity: 'simple',
      estimatedSteps: 1,
      requiresHumanReview: false,
      risks: [],
    },
    subtasks: [],
    workflow: workflow(),
    parsedAt: 0,
    ...partial,
  };
}

function discoveredTask(partial: Partial<DiscoveredTask> = {}): DiscoveredTask {
  return {
    title: 'Improve caching',
    description: 'Found opportunity to cache results',
    source: 'code-scan',
    suggestedPriority: 3,
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  timeWindowMock.checkWorkAllowed.mockReturnValue({ allowed: true, reason: 'ok', currentTime: '00:00:00' });
  taskStateMock.getTaskReadiness.mockReturnValue({ ready: true, blockedBy: [] });
  fsMock.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  fsMock.writeFile.mockResolvedValue(undefined);
  fsMock.mkdir.mockResolvedValue(undefined);
  workflowMock.loadWorkflow.mockResolvedValue(workflow());
  workflowMock.listWorkflows.mockResolvedValue([]);
  workflowMock.createCIPipelineTemplate.mockReturnValue(workflow({ id: 'ci-fallback' }));
  taskParserMock.parseTask.mockReturnValue(parsedTaskFixture());
  taskParserMock.saveParsedTask.mockResolvedValue(undefined);
  taskParserMock.loadParsedTask.mockResolvedValue(null);
  taskParserMock.formatParsedTaskSummary.mockReturnValue('## Auto Analysis Result');
  knowledgeMock.analyzeIssue.mockResolvedValue(null);
  memoryMock.saveCognitiveMemory.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// loadState (private, reached only via init())
// ---------------------------------------------------------------------------
describe('DecisionEngine.init — loadState', () => {
  it('loads durable outcome totals while ignoring retired throttle fields', async () => {
    fsMock.readFile.mockResolvedValueOnce(
      JSON.stringify({ lastRunAt: 123, consecutiveTasksRun: 2, totalTasksCompleted: 5, totalTasksFailed: 1 }),
    );
    const engine = new DecisionEngine();
    await engine.init();
    expect(engine.getStats()).toEqual({
      totalCompleted: 5,
      totalFailed: 1,
    });
  });

  it('falls back to defaults when the state file is missing/corrupt', async () => {
    fsMock.readFile.mockRejectedValueOnce(new Error('ENOENT'));
    const engine = new DecisionEngine();
    await engine.init();
    expect(engine.getStats()).toEqual({
      totalCompleted: 0,
      totalFailed: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// heartbeat()
// ---------------------------------------------------------------------------
describe('DecisionEngine.heartbeat', () => {
  it('skips when the time window blocks work', async () => {
    timeWindowMock.checkWorkAllowed.mockReturnValueOnce({ allowed: false, reason: 'outside market hours', currentTime: '03:00' });
    const engine = new DecisionEngine();
    const result = await engine.heartbeat([task()]);
    expect(result).toEqual({ action: 'skip', reason: 'Time window blocked: outside market hours' });
  });

  it('skips when there are no executable tasks at all', async () => {
    const engine = new DecisionEngine();
    const result = await engine.heartbeat([]);
    expect(result).toEqual({ action: 'skip', reason: 'No executable tasks in backlog' });
  });

  it('filters out a task whose project path is not allowed', async () => {
    const engine = new DecisionEngine({ allowedProjects: ['/allowed/repo'] });
    const result = await engine.heartbeat([task({ projectPath: '/not-allowed/repo' })]);
    expect(result).toEqual({ action: 'skip', reason: 'No executable tasks in backlog' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('project not allowed'));
  });

  it('filters out a parent/EPIC umbrella issue', async () => {
    const engine = new DecisionEngine();
    const result = await engine.heartbeat([task({ title: '[EPIC] consolidate branches' })]);
    expect(result).toEqual({ action: 'skip', reason: 'No executable tasks in backlog' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('parent/EPIC issue is not executable'));
  });

  it('filters out a task in a non-actionable Linear state', async () => {
    const engine = new DecisionEngine();
    const result = await engine.heartbeat([task({ linearState: 'Done' })]);
    expect(result).toEqual({ action: 'skip', reason: 'No executable tasks in backlog' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Linear state "Done" is not actionable'));
  });

  it('filters out a task that is not ready (blocked by a dependency)', async () => {
    taskStateMock.getTaskReadiness.mockReturnValueOnce({ ready: false, blockedBy: ['blocker-1'], reason: 'waiting on dependency' });
    const engine = new DecisionEngine();
    const result = await engine.heartbeat([task()]);
    expect(result).toEqual({ action: 'skip', reason: 'No executable tasks in backlog' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('waiting on dependency (blocked by: blocker-1)'));
  });

  it('rejects a task whose source is outside backlog scope', async () => {
    const engine = new DecisionEngine();
    const result = await engine.heartbeat([task({ source: 'github_pr' })]);
    expect(result).toEqual({
      action: 'skip',
      reason: 'Scope violation: Task source "github_pr" not allowed. Only backlog items permitted.',
    });
  });

  it('rejects a task missing both issueId and workflowId', async () => {
    const engine = new DecisionEngine();
    const result = await engine.heartbeat([task({ issueId: undefined, workflowId: undefined })]);
    expect(result).toEqual({
      action: 'skip',
      reason: 'Scope violation: Task must have explicit issueId or workflowId',
    });
  });

  it('skips when no workflow can be resolved (title empty short-circuits auto-parse, no projectPath fallback)', async () => {
    const engine = new DecisionEngine();
    const t = task({ title: '', workflowId: undefined });
    const result = await engine.heartbeat([t]);
    expect(result).toEqual({ action: 'skip', task: t, reason: 'No matching workflow for task' });
  });

  it('auto-executes the top task when autoExecute is true', async () => {
    const engine = new DecisionEngine({ autoExecute: true });
    const t = task({ workflowId: 'wf-1' });
    const wf = workflow();
    workflowMock.loadWorkflow.mockResolvedValueOnce(wf);
    const result = await engine.heartbeat([t]);
    expect(result).toEqual({ action: 'execute', task: t, workflow: wf, reason: `Auto-executing: ${t.title}` });
  });

  it('defers (requires approval) when autoExecute is false', async () => {
    const engine = new DecisionEngine({ autoExecute: false });
    const t = task({ workflowId: 'wf-1' });
    const wf = workflow();
    workflowMock.loadWorkflow.mockResolvedValueOnce(wf);
    const result = await engine.heartbeat([t]);
    expect(result).toEqual({
      action: 'defer',
      task: t,
      workflow: wf,
      reason: `Ready to execute (requires approval): ${t.title}`,
    });
  });
});

// ---------------------------------------------------------------------------
// taskToWorkflow (private, reached via heartbeat())
// ---------------------------------------------------------------------------
describe('DecisionEngine.taskToWorkflow (via heartbeat)', () => {
  it('finds an existing workflow by matching projectPath', async () => {
    const engine = new DecisionEngine();
    const match = workflow({ id: 'match-by-path', projectPath: '/repo/x' });
    workflowMock.listWorkflows.mockResolvedValueOnce([workflow({ id: 'other', projectPath: '/repo/y' }), match]);
    const result = await engine.heartbeat([task({ workflowId: undefined, projectPath: '/repo/x' })]);
    expect(result.workflow).toEqual(match);
  });

  it('finds an existing workflow by matching linearIssue', async () => {
    const engine = new DecisionEngine();
    const match = workflow({ id: 'match-by-issue', linearIssue: 'issue-1' });
    workflowMock.listWorkflows.mockResolvedValueOnce([match]);
    const result = await engine.heartbeat([task({ workflowId: undefined })]);
    expect(result.workflow).toEqual(match);
  });

  it('reuses a cached parsed task workflow when one already exists', async () => {
    const engine = new DecisionEngine();
    const cachedWorkflow = workflow({ id: 'cached' });
    taskParserMock.loadParsedTask.mockResolvedValueOnce(parsedTaskFixture({ workflow: cachedWorkflow }));
    const result = await engine.heartbeat([task({ workflowId: undefined, projectPath: undefined })]);
    expect(result.workflow).toEqual(cachedWorkflow);
    expect(taskParserMock.parseTask).not.toHaveBeenCalled();
  });

  it('auto-parses when no cache/workflow exists, using knowledge-graph impact analysis', async () => {
    const engine = new DecisionEngine();
    const generatedWorkflow = workflow({ id: 'generated' });
    knowledgeMock.analyzeIssue.mockResolvedValueOnce({
      estimatedScope: 'medium',
      directModules: ['a.ts'],
      dependentModules: ['b.ts'],
      testFiles: ['a.test.ts'],
    });
    taskParserMock.parseTask.mockReturnValueOnce(
      parsedTaskFixture({
        workflow: generatedWorkflow,
        analysis: {
          type: 'bug_fix',
          complexity: 'complex',
          estimatedSteps: 3,
          requiresHumanReview: true,
          risks: ['touches auth'],
        },
        subtasks: [{ id: 's1', order: 1, title: 'do part 1' } as ParsedTask['subtasks'][number]],
      }),
    );
    const result = await engine.heartbeat([task({ workflowId: undefined, projectPath: '/repo/x' })]);
    expect(result.workflow).toEqual(generatedWorkflow);
    expect(taskParserMock.saveParsedTask).toHaveBeenCalled();
    expect(knowledgeMock.analyzeIssue).toHaveBeenCalledWith('/repo/x', task().title, task().description);
  });

  it('tolerates a failing impact analysis (non-critical, logged as warning)', async () => {
    const engine = new DecisionEngine();
    knowledgeMock.analyzeIssue.mockRejectedValueOnce(new Error('graph unavailable'));
    const result = await engine.heartbeat([task({ workflowId: undefined, projectPath: '/repo/x' })]);
    expect(result.action).not.toBe('skip');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Impact analysis failed (non-critical):'), expect.any(Error));
  });

  it('falls back to the CI pipeline template when title is empty but projectPath is set', async () => {
    const engine = new DecisionEngine();
    const ciWorkflow = workflow({ id: 'ci-fallback-explicit' });
    workflowMock.createCIPipelineTemplate.mockReturnValueOnce(ciWorkflow);
    const result = await engine.heartbeat([task({ title: '', workflowId: undefined, projectPath: '/repo/x' })]);
    expect(result.workflow).toEqual(ciWorkflow);
    expect(workflowMock.createCIPipelineTemplate).toHaveBeenCalledWith('/repo/x');
  });
});

// ---------------------------------------------------------------------------
// executeTask
// ---------------------------------------------------------------------------
describe('DecisionEngine.executeTask', () => {
  it('throws without persisting retired pace-throttle state', async () => {
    const engine = new DecisionEngine();
    const t = task();
    await expect(engine.executeTask(t, workflow())).rejects.toThrow(
      'Legacy workflow executor has been removed. Use pair mode (pairMode: true) for task execution.',
    );
    expect(engine.getStats()).toEqual({ totalCompleted: 0, totalFailed: 0 });
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateAllowedProjects / getStats
// ---------------------------------------------------------------------------
describe('DecisionEngine.updateAllowedProjects', () => {
  it('replaces the allowed project list used by later scope checks', async () => {
    const engine = new DecisionEngine({ allowedProjects: ['/old/repo'] });
    engine.updateAllowedProjects(['/new/repo']);
    // A task under the old path should now be rejected; one under the new path should pass.
    const rejected = await engine.heartbeat([task({ projectPath: '/old/repo/sub' })]);
    expect(rejected).toEqual({ action: 'skip', reason: 'No executable tasks in backlog' });

    const accepted = await engine.heartbeat([task({ projectPath: '/new/repo/sub', workflowId: 'wf-1' })]);
    expect(accepted.action).not.toBe('skip');
  });
});

// ---------------------------------------------------------------------------
// getTaskParseSummary
// ---------------------------------------------------------------------------
describe('DecisionEngine.getTaskParseSummary', () => {
  it('returns null when no parsed task is cached', async () => {
    const engine = new DecisionEngine();
    taskParserMock.loadParsedTask.mockResolvedValueOnce(null);
    await expect(engine.getTaskParseSummary('issue-1')).resolves.toBeNull();
  });

  it('formats the cached parsed task summary', async () => {
    const engine = new DecisionEngine();
    const parsed = parsedTaskFixture();
    taskParserMock.loadParsedTask.mockResolvedValueOnce(parsed);
    taskParserMock.formatParsedTaskSummary.mockReturnValueOnce('## summary text');
    const summary = await engine.getTaskParseSummary('issue-1');
    expect(summary).toBe('## summary text');
    expect(taskParserMock.formatParsedTaskSummary).toHaveBeenCalledWith(parsed);
  });
});

// ---------------------------------------------------------------------------
// addToBacklog / getDiscoveredTasks
// ---------------------------------------------------------------------------
describe('DecisionEngine.addToBacklog', () => {
  it('appends to an existing discovered-tasks file and records a memory belief', async () => {
    const engine = new DecisionEngine();
    fsMock.readFile.mockResolvedValueOnce(JSON.stringify([discoveredTask({ title: 'existing' })]));
    await engine.addToBacklog(discoveredTask({ title: 'new finding' }));

    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    const written = JSON.parse(fsMock.writeFile.mock.calls[0][1] as string);
    expect(written).toHaveLength(2);
    expect(written[1].title).toBe('new finding');
    expect(memoryMock.saveCognitiveMemory).toHaveBeenCalledWith(
      'belief',
      expect.stringContaining('new finding'),
      { confidence: 0.5, derivedFrom: 'discovery' },
    );
  });

  it('starts a fresh list when the discovered-tasks file is unreadable', async () => {
    const engine = new DecisionEngine();
    fsMock.readFile.mockRejectedValueOnce(new Error('ENOENT'));
    await engine.addToBacklog(discoveredTask());
    const written = JSON.parse(fsMock.writeFile.mock.calls[0][1] as string);
    expect(written).toHaveLength(1);
  });

  it('tolerates a failing memory save (non-critical, logged as warning)', async () => {
    const engine = new DecisionEngine();
    memoryMock.saveCognitiveMemory.mockRejectedValueOnce(new Error('memory store down'));
    await expect(engine.addToBacklog(discoveredTask())).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Memory save failed (non-critical):'), expect.any(Error));
  });
});

describe('DecisionEngine.getDiscoveredTasks', () => {
  it('returns the persisted discovered task list', async () => {
    const engine = new DecisionEngine();
    const list = [discoveredTask({ title: 'a' }), discoveredTask({ title: 'b' })];
    fsMock.readFile.mockResolvedValueOnce(JSON.stringify(list));
    await expect(engine.getDiscoveredTasks()).resolves.toEqual(list);
  });

  it('returns an empty list when the file is missing', async () => {
    const engine = new DecisionEngine();
    fsMock.readFile.mockRejectedValueOnce(new Error('ENOENT'));
    await expect(engine.getDiscoveredTasks()).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// heartbeatMultiple()
// ---------------------------------------------------------------------------
describe('DecisionEngine.heartbeatMultiple', () => {
  it('skips when the time window blocks work', async () => {
    timeWindowMock.checkWorkAllowed.mockReturnValueOnce({ allowed: false, reason: 'blocked', currentTime: '03:00' });
    const engine = new DecisionEngine();
    const result = await engine.heartbeatMultiple([task()], 3);
    expect(result).toEqual({ action: 'skip', tasks: [], reason: 'Time window blocked: blocked', skippedCount: 1 });
  });

  it('excludes already-running projects and skips when nothing remains', async () => {
    const engine = new DecisionEngine();
    const t = task({ linearProject: { id: 'proj-A', name: 'A' } });
    const result = await engine.heartbeatMultiple([t], 3, ['proj-A']);
    expect(result).toEqual({ action: 'skip', tasks: [], reason: 'No executable tasks in backlog', skippedCount: 1 });
  });

  it('reports zero selected when every candidate fails validation/workflow mapping', async () => {
    const engine = new DecisionEngine();
    const a = task({ id: 'a', issueId: 'a', title: '', workflowId: undefined, projectPath: undefined });
    const b = task({ id: 'b', issueId: 'b', title: '', workflowId: undefined, projectPath: undefined });
    const result = await engine.heartbeatMultiple([a, b], 3);
    expect(result).toEqual({
      action: 'skip',
      tasks: [],
      reason: 'No tasks passed validation/workflow mapping',
      skippedCount: 2,
    });
  });

  it('auto-executes multiple selected tasks when autoExecute is true', async () => {
    const engine = new DecisionEngine({ autoExecute: true });
    const a = task({ id: 'a', issueId: 'a', workflowId: 'wf-1' });
    const b = task({ id: 'b', issueId: 'b', workflowId: 'wf-1' });
    const result = await engine.heartbeatMultiple([a, b], 3);
    expect(result.action).toBe('execute');
    expect(result.tasks.map((s) => s.task.id)).toEqual(['a', 'b']);
    expect(result.reason).toBe('Auto-executing 2 tasks');
    expect(result.skippedCount).toBe(0);
  });

  it('defers multiple selected tasks (requires approval) when autoExecute is false', async () => {
    const engine = new DecisionEngine({ autoExecute: false });
    const a = task({ id: 'a', issueId: 'a', workflowId: 'wf-1' });
    const result = await engine.heartbeatMultiple([a], 3);
    expect(result.action).toBe('defer');
    expect(result.reason).toBe('Ready to execute 1 tasks (requires approval)');
  });
});

// ---------------------------------------------------------------------------
// prioritizeTasks (private, reached via heartbeatMultiple sort ordering)
// ---------------------------------------------------------------------------
describe('DecisionEngine.prioritizeTasks (via heartbeatMultiple ordering)', () => {
  const selectOrder = async (tasks: TaskItem[]): Promise<string[]> => {
    const engine = new DecisionEngine();
    const result = await engine.heartbeatMultiple(tasks, tasks.length);
    return result.tasks.map((s) => s.task.id);
  };

  it('orders by dependency downstream weight first (unblocker before its dependent)', async () => {
    const blocker = task({ id: 'd1', issueId: 'd1', workflowId: 'wf-1' });
    const dependent = task({ id: 'd2', issueId: 'd2', workflowId: 'wf-1', blockedBy: ['d1'] });
    expect(await selectOrder([dependent, blocker])).toEqual(['d1', 'd2']);
  });

  it('orders by topoRank when downstream weight ties', async () => {
    const first = task({ id: 't1', issueId: 't1', workflowId: 'wf-1', topoRank: 1 });
    const second = task({ id: 't2', issueId: 't2', workflowId: 'wf-1', topoRank: 2 });
    expect(await selectOrder([second, first])).toEqual(['t1', 't2']);
  });

  it('orders by priority when downstream/topoRank tie', async () => {
    const urgent = task({ id: 'p1', issueId: 'p1', workflowId: 'wf-1', priority: 1 });
    const low = task({ id: 'p2', issueId: 'p2', workflowId: 'wf-1', priority: 4 });
    expect(await selectOrder([low, urgent])).toEqual(['p1', 'p2']);
  });

  it('orders by dueDate (earlier first) when both have one', async () => {
    const earlier = task({ id: 'e1', issueId: 'e1', workflowId: 'wf-1', dueDate: 100 });
    const later = task({ id: 'e2', issueId: 'e2', workflowId: 'wf-1', dueDate: 200 });
    expect(await selectOrder([later, earlier])).toEqual(['e1', 'e2']);
  });

  it('prefers the task with a dueDate over one without it (array order: [withDate, withoutDate])', async () => {
    const withDate = task({ id: 'w1', issueId: 'w1', workflowId: 'wf-1', dueDate: 100 });
    const withoutDate = task({ id: 'w2', issueId: 'w2', workflowId: 'wf-1' });
    expect(await selectOrder([withDate, withoutDate])).toEqual(['w1', 'w2']);
  });

  it('prefers the task with a dueDate over one without it (array order: [withoutDate, withDate])', async () => {
    const withoutDate = task({ id: 'w2', issueId: 'w2', workflowId: 'wf-1' });
    const withDate = task({ id: 'w1', issueId: 'w1', workflowId: 'wf-1', dueDate: 100 });
    expect(await selectOrder([withoutDate, withDate])).toEqual(['w1', 'w2']);
  });

  it('falls back to createdAt (older first) when nothing else differs', async () => {
    const older = task({ id: 'c1', issueId: 'c1', workflowId: 'wf-1', createdAt: 100 });
    const newer = task({ id: 'c2', issueId: 'c2', workflowId: 'wf-1', createdAt: 200 });
    expect(await selectOrder([newer, older])).toEqual(['c1', 'c2']);
  });
});

// ---------------------------------------------------------------------------
// getDecisionEngine / runHeartbeat singleton helpers
// ---------------------------------------------------------------------------
describe('getDecisionEngine / runHeartbeat', () => {
  it('reuses the same instance across calls without a config override', () => {
    const first = getDecisionEngine({ autoExecute: true });
    const second = getDecisionEngine();
    expect(second).toBe(first);
  });

  it('creates a new instance whenever a config is passed', () => {
    const first = getDecisionEngine({ autoExecute: true });
    const second = getDecisionEngine({ autoExecute: false });
    expect(second).not.toBe(first);
  });

  it('runs init() + heartbeat() end-to-end via the convenience function', async () => {
    const t = task({ workflowId: 'wf-1' });
    const result = await runHeartbeat([t], { autoExecute: true });
    expect(result.action).toBe('execute');
    expect(result.task).toEqual(t);
  });
});
