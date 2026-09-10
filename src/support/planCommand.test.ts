import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPlanCommand, type PlanIO } from './planCommand.js';
import * as planner from './planner.js';

vi.mock('./planner.js', () => ({ runPlanner: vi.fn() }));
const mockedRunPlanner = vi.mocked(planner.runPlanner);

interface FakeSub {
  title: string;
  description: string;
  estimatedMinutes: number;
  priority: number;
  dependencies?: string[];
}

/** A scripted PlanIO: returns queued confirm answers / edit texts, records prints. */
function makeIO(answers: Array<'yes' | 'no' | 'edit'>, texts: string[] = []) {
  const out: string[] = [];
  let ai = 0;
  let ti = 0;
  const io: PlanIO = {
    print: (l) => { out.push(l); },
    confirm: async () => answers[ai++] ?? 'no',
    promptText: async () => texts[ti++] ?? '',
  };
  return { io, out };
}

function plannerResult(subTasks: FakeSub[], needsDecomposition = true) {
  return {
    success: true,
    originalIssue: 'g',
    needsDecomposition,
    subTasks,
    totalEstimatedMinutes: subTasks.reduce((s, t) => s + (t.estimatedMinutes || 0), 0),
  };
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return JSON.parse((fetchMock.mock.calls[call][1] as { body: string }).body);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('runPlanCommand', () => {
  it('dispatches the approved sub-tasks on yes', async () => {
    mockedRunPlanner.mockResolvedValue(plannerResult([
      { title: 'A', description: 'da', estimatedMinutes: 10, priority: 2 },
      { title: 'B', description: 'db', estimatedMinutes: 15, priority: 3, dependencies: ['A'] },
    ]) as never);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ mode: 'linear', parentIssue: { identifier: 'INT-9' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { io, out } = makeIO(['yes']);
    await runPlanCommand('build X', io, { projectPath: '/tmp/proj' });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/plan/dispatch');
    const body = bodyOf(fetchMock);
    expect(body.goal).toBe('build X');
    expect(body.projectPath).toBe('/tmp/proj');
    expect(body.subTasks).toHaveLength(2);
    expect(out.join('\n')).toContain('INT-9');
  });

  it('does not dispatch on no', async () => {
    mockedRunPlanner.mockResolvedValue(
      plannerResult([{ title: 'A', description: 'd', estimatedMinutes: 5, priority: 2 }]) as never,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { io, out } = makeIO(['no']);
    await runPlanCommand('g', io, {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('Cancelled');
  });

  it('drops a sub-task on edit, then dispatches the remainder', async () => {
    mockedRunPlanner.mockResolvedValue(plannerResult([
      { title: 'A', description: 'da', estimatedMinutes: 10, priority: 2 },
      { title: 'B', description: 'db', estimatedMinutes: 15, priority: 3 },
    ]) as never);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ mode: 'exec', taskIds: ['t1'] }), { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // edit → drop #2 → yes
    const { io } = makeIO(['edit', 'yes'], ['2']);
    await runPlanCommand('g', io, {});

    const body = bodyOf(fetchMock);
    expect(body.subTasks).toHaveLength(1);
    expect(body.subTasks[0].title).toBe('A');
  });

  it('uses the single-task path when no decomposition is needed', async () => {
    mockedRunPlanner.mockResolvedValue(plannerResult([], false) as never);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ mode: 'linear', parentIssue: { identifier: 'INT-1' } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { io } = makeIO(['yes']);
    await runPlanCommand('small task', io, {});

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(bodyOf(fetchMock).subTasks).toEqual([]);
  });

  it('reports a planner failure without dispatching', async () => {
    mockedRunPlanner.mockResolvedValue({
      success: false,
      error: 'boom',
      originalIssue: 'g',
      needsDecomposition: false,
      subTasks: [],
      totalEstimatedMinutes: 0,
    } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { io, out } = makeIO([]);
    await runPlanCommand('g', io, {});

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('boom');
  });

  it('dispatches the approved plan to the daemon', async () => {
    mockedRunPlanner.mockResolvedValue(plannerResult([
      { title: 'a', description: 'a', estimatedMinutes: 10, priority: 1 },
      { title: 'b', description: 'b', estimatedMinutes: 20, priority: 2, dependencies: ['a'] },
    ]) as never);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ mode: 'pipeline', taskIds: ['1', '2'] }) }));
    vi.stubGlobal('fetch', fetchMock);

    const { io, out } = makeIO(['yes']);
    await runPlanCommand('g', io, {});

    expect(mockedRunPlanner).toHaveBeenCalledWith(expect.objectContaining({ taskTitle: 'g' }));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(bodyOf(fetchMock).subTasks).toHaveLength(2);
    expect(out.join('\n')).toContain('Dispatched 2 task(s)');
  });

  it('contains a rejected planner run as a controlled error message (AGT-3417)', async () => {
    mockedRunPlanner.mockRejectedValue(new Error('RateLimitError: slow down'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { io, out } = makeIO([]);
    await expect(runPlanCommand('g', io, {})).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('✖ Planner failed: RateLimitError: slow down');
  });

  it('stringifies non-Error planner rejections (AGT-3417)', async () => {
    mockedRunPlanner.mockRejectedValue('plain string failure');
    const { io, out } = makeIO([]);
    await expect(runPlanCommand('g', io, {})).resolves.toBeUndefined();
    expect(out.join('\n')).toContain('✖ Planner failed: plain string failure');
  });
});
