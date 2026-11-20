// AGT-4123: human /plan dispatch enforces maxChildrenPerTask but not dailyLimit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';

const loadConfigMock = vi.hoisted(() => vi.fn());
const getTaskSourceMock = vi.hoisted(() => vi.fn());
const createSubIssuesWithDependenciesMock = vi.hoisted(() => vi.fn());
const linearCalls = vi.hoisted(() => ({ addComment: vi.fn(async () => undefined), updateIssueState: vi.fn(async () => true) }));

vi.mock('../linear/index.js', async () => {
  const actual = await vi.importActual<typeof import('../linear/index.js')>('../linear/index.js');
  return { ...actual, addComment: linearCalls.addComment, updateIssueState: linearCalls.updateIssueState };
});

vi.mock('../core/config.js', async () => {
  const actual = await vi.importActual<typeof import('../core/config.js')>('../core/config.js');
  return { ...actual, loadConfig: loadConfigMock };
});

vi.mock('../automation/runnerExecution.js', async () => {
  const actual = await vi.importActual<typeof import('../automation/runnerExecution.js')>(
    '../automation/runnerExecution.js',
  );
  return {
    ...actual,
    getTaskSource: getTaskSourceMock,
    createSubIssuesWithDependencies: createSubIssuesWithDependenciesMock,
  };
});

import { startWebServer, stopWebServer } from './web.js';

import { AUTH, useTestDaemonToken } from './daemonToken.testing.js';

useTestDaemonToken();
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function subTasks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    title: `Task ${i + 1}`,
    description: `Do thing ${i + 1}`,
    estimatedMinutes: 30,
    priority: 3,
  }));
}

describe('POST /api/plan/dispatch decomposition limits (AGT-4123)', () => {
  let port = 0;
  const createTask = vi.fn();
  const updateState = vi.fn();
  const addComment = vi.fn(async () => undefined);
  const source = {
    kind: 'local',
    createTask,
    updateState,
    addComment,
  };

  beforeEach(async () => {
    loadConfigMock.mockReset();
    getTaskSourceMock.mockReset();
    createSubIssuesWithDependenciesMock.mockReset();
    createTask.mockReset();
    updateState.mockReset();
    addComment.mockClear();
    linearCalls.addComment.mockClear();
    linearCalls.updateIssueState.mockClear();

    // dailyLimit: 1 would block the autonomous path for a 3-child plan;
    // /plan must still admit because it does not reserve against dailyLimit.
    loadConfigMock.mockReturnValue({
      autonomous: {
        decomposition: {
          maxChildrenPerTask: 3,
          dailyLimit: 1,
        },
      },
    });
    getTaskSourceMock.mockReturnValue(source);
    createTask.mockResolvedValue({ id: 'parent-1', identifier: 'AGT-1' });
    createSubIssuesWithDependenciesMock.mockResolvedValue(true);

    port = await freePort();
    await startWebServer(port);
  });

  afterEach(async () => {
    await stopWebServer();
  });

  async function dispatch(tasks: ReturnType<typeof subTasks>) {
    return fetch(`http://127.0.0.1:${port}/api/plan/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ goal: 'Ship the feature', subTasks: tasks }),
    });
  }

  it('refuses Path A when sub-tasks exceed maxChildrenPerTask before creating issues', async () => {
    const res = await dispatch(subTasks(4));
    expect(res.status).toBe(400);
    const body = await res.json() as {
      error: string;
      code: string;
      maxChildrenPerTask: number;
    };
    expect(body.code).toBe('decomposition_child_cap');
    expect(body.maxChildrenPerTask).toBe(3);
    expect(body.error).toMatch(/over the 3 cap/);
    expect(createTask).not.toHaveBeenCalled();
    expect(createSubIssuesWithDependenciesMock).not.toHaveBeenCalled();
  });

  it('admits a plan at the cap without consulting dailyLimit', async () => {
    const tasks = subTasks(3);
    const res = await dispatch(tasks);
    expect(res.status).toBe(200);
    const body = await res.json() as { mode: string; parentIssue: { id: string } };
    expect(body.mode).toBe('local');
    expect(body.parentIssue.id).toBe('parent-1');
    expect(createTask).toHaveBeenCalledOnce();
    expect(createSubIssuesWithDependenciesMock).toHaveBeenCalledOnce();
    const call = createSubIssuesWithDependenciesMock.mock.calls[0];
    expect(call[2]).toHaveLength(3);
    // 7th arg is dailyLimit for logging only — still passed, never reserved.
    expect(call[6]).toBe(1);
  });

  // AGT-4800 (#853 review): a state change the dashboard makes comes with a comment saying why.
  it('posts a companion comment before moving a plan with no sub-tasks to Todo', async () => {
    updateState.mockResolvedValue(true);
    const res = await dispatch([]);
    expect(res.status).toBe(200);
    expect(addComment).toHaveBeenCalledWith('parent-1', expect.stringContaining('moved to Todo'));
    expect(updateState).toHaveBeenCalledWith('parent-1', 'Todo');
    expect(addComment.mock.invocationCallOrder[0]).toBeLessThan(updateState.mock.invocationCallOrder[0]);
  });

  it('posts a companion comment before the dashboard moves an issue to Todo', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/issue/move-to-todo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({ issueId: 'issue-7' }),
    });
    expect(res.status).toBe(200);
    expect(linearCalls.addComment).toHaveBeenCalledWith('issue-7', expect.stringContaining('Moved to Todo from the OpenSwarm dashboard'));
    expect(linearCalls.updateIssueState).toHaveBeenCalledWith('issue-7', 'Todo');
    expect(linearCalls.addComment.mock.invocationCallOrder[0]).toBeLessThan(linearCalls.updateIssueState.mock.invocationCallOrder[0]);
  });
});
