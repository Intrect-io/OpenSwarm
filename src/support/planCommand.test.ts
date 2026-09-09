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
