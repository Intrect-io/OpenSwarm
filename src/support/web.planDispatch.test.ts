// AGT-4123: human /plan dispatch enforces maxChildrenPerTask but not dailyLimit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';

const loadConfigMock = vi.hoisted(() => vi.fn());
const getTaskSourceMock = vi.hoisted(() => vi.fn());
const createSubIssuesWithDependenciesMock = vi.hoisted(() => vi.fn());

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
  const source = {
    kind: 'local',
    createTask,
    updateState,
  };

  beforeEach(async () => {
    loadConfigMock.mockReset();
    getTaskSourceMock.mockReset();
    createSubIssuesWithDependenciesMock.mockReset();
    createTask.mockReset();
    updateState.mockReset();

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
      headers: { 'Content-Type': 'application/json' },
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
});
