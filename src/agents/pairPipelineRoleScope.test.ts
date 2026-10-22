// ============================================
// OpenSwarm - per-role tool scope + effort plumbing
// ============================================
//
// The declarative RoleConfig fields (`tools.allow`/`tools.deny`, `effort`) are
// only worth having if they reach the stage that runs. Split from
// pairPipeline.test.ts because that file is already at the repository's
// 1500-line gate; the subject here is the ROLE→STAGE hand-off, not the pipeline
// loop itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerOptions } from './worker.js';
import type { ReviewerOptions } from './reviewer.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const runWorker = vi.fn();
const runReviewer = vi.fn();
const runDocumenter = vi.fn();
const runAuditor = vi.fn();
const runSkillDocumenter = vi.fn();
const getDefaultModel = vi.fn();

vi.mock('./worker.js', async () => {
  const actual = await vi.importActual<typeof import('./worker.js')>('./worker.js');
  return { ...actual, runWorker };
});

vi.mock('./reviewer.js', async () => {
  const actual = await vi.importActual<typeof import('./reviewer.js')>('./reviewer.js');
  return { ...actual, runReviewer };
});

vi.mock('./documenter.js', async () => {
  const actual = await vi.importActual<typeof import('./documenter.js')>('./documenter.js');
  return { ...actual, runDocumenter };
});

vi.mock('./auditor.js', async () => {
  const actual = await vi.importActual<typeof import('./auditor.js')>('./auditor.js');
  return { ...actual, runAuditor };
});

vi.mock('./skillDocumenter.js', async () => {
  const actual = await vi.importActual<typeof import('./skillDocumenter.js')>('./skillDocumenter.js');
  return { ...actual, runSkillDocumenter };
});

vi.mock('../adapters/index.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/index.js')>('../adapters/index.js');
  return { ...actual, getAdapter: () => ({ getDefaultModel }) };
});

const boardEvents = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
vi.mock('../coordination/runCoordination.js', () => ({
  publishCoordination: vi.fn(async (event: Record<string, unknown>) => { boardEvents.list.push(event); }),
}));

function task(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-1',
    source: 'linear',
    title: 'heavy task',
    description: 'exercise role tool/effort routing',
    priority: 1,
    createdAt: Date.now(),
    estimatedMinutes: 60,
    ...overrides,
  };
}

describe('PairPipeline per-role tool scope and effort', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    runWorker.mockResolvedValue({
      success: true,
      summary: 'done',
      filesChanged: ['src/example.ts'],
      commands: ['npm test -- src/example.test.ts'],
      output: '',
      confidencePercent: 100,
    });
    runReviewer.mockResolvedValue({ decision: 'approve', feedback: 'approved' });
    runDocumenter.mockResolvedValue({ success: true, updatedFiles: [], apiDocsUpdated: false, summary: 'docs' });
    runAuditor.mockResolvedValue({ success: true, bsScore: 0, criticalCount: 0, warningCount: 0, minorCount: 0, issues: [], summary: 'clean' });
    runSkillDocumenter.mockResolvedValue({ success: true, updatedFiles: [], summary: 'skills' });
    getDefaultModel.mockResolvedValue('codex-live-model');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("carries each role's declared tool scope and effort to its stage call", async () => {
    // RoleConfig.tools/effort are declarations in the role, so they have to
    // travel the same path maxTurns does — otherwise a role that denies `bash`
    // still runs with it, and a documented field is silently inert.
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer'],
      maxIterations: 1,
      roles: {
        worker: {
          enabled: true,
          model: 'w',
          timeoutMs: 0,
          tools: { allow: ['read_file', 'write_file'], deny: ['scratch_*'] },
          effort: 'low',
        },
        reviewer: {
          enabled: true,
          model: 'r',
          timeoutMs: 0,
          tools: { deny: ['search_memory'] },
          effort: 'high',
        },
      },
    });

    await pipeline.run(task(), process.cwd());

    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining<Partial<WorkerOptions>>({
      toolAllow: ['read_file', 'write_file'],
      toolDeny: ['scratch_*'],
      reasoningEffort: 'low',
    }));
    expect(runReviewer).toHaveBeenCalledWith(expect.objectContaining<Partial<ReviewerOptions>>({
      toolAllow: undefined,
      toolDeny: ['search_memory'],
      reasoningEffort: 'high',
    }));
  });

  it("lets a matched jobProfile effort win over the role's declared effort", async () => {
    // Same precedence as model resolution in pipelineRoleSelection: the
    // task-shaped profile is more specific than the role default.
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 1,
      roles: {
        worker: { enabled: true, model: 'w', timeoutMs: 0, effort: 'low' },
      },
      jobProfiles: [{ name: 'heavy', minMinutes: 30, effort: 'high' }],
    });

    await pipeline.run(task(), process.cwd());

    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining<Partial<WorkerOptions>>({
      reasoningEffort: 'high',
    }));
  });

  it("hands the worker sandbox setting to every stage that has a shell, not only the worker (AGT-4783)", async () => {
    // Each stage's bash tool is the worker's bash tool. Only the worker stage got the OS fence, so a repo
    // script run by the documenter or the auditor could still write outside the worktree and reach the network.
    const { PairPipeline } = await import('./pairPipeline.js');
    const roleOf = { enabled: true, timeoutMs: 0 };
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer', 'documenter', 'auditor', 'skill-documenter'],
      maxIterations: 1,
      workerSandbox: 'on',
      skipAuditorUnderFileCount: 0, // the worker mock reports one changed file; the default threshold is 3
      roles: {
        worker: { ...roleOf, model: 'w' }, reviewer: { ...roleOf, model: 'r' },
        documenter: { ...roleOf, model: 'd' }, auditor: { ...roleOf, model: 'a' },
        'skill-documenter': { ...roleOf, model: 's' },
      },
    });

    await pipeline.run(task(), process.cwd());

    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining({ sandbox: 'on' }));
    expect(runDocumenter).toHaveBeenCalledWith(expect.objectContaining({ sandbox: 'on' }));
    expect(runAuditor).toHaveBeenCalledWith(expect.objectContaining({ sandbox: 'on' }));
    expect(runSkillDocumenter).toHaveBeenCalledWith(expect.objectContaining({ sandbox: 'on' }));
  });
});
