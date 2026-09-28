// Purpose: close coverage gaps left by backlogGrooming.test.ts —
// repoSnapshotSummary's not-found/unreadable branches (via buildBacklogGroomingPrompt),
// parseBacklogGroomingOutput's non-object/missing-field/catch branches,
// runBacklogGroomingPlanner's adapter-driven branches (empty task list, exit codes,
// thrown errors), applyBacklogGrooming's early-return/no-updateDescription-support/
// final-comment-failure branches, and the untested summarizeGroomingDecision helper.
// spawnCli/getAdapter are mocked; nothing here shells out or touches real ~/.openswarm state.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ITaskSource } from './taskSource.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const spawnCli = vi.fn();
const getAdapter = vi.fn(() => ({ name: 'codex' }));

vi.mock('../adapters/index.js', () => ({
  getAdapter: (...args: unknown[]) => getAdapter(...(args as [])),
  spawnCli: (...args: unknown[]) => spawnCli(...(args as [])),
}));

const {
  applyBacklogGrooming,
  buildBacklogGroomingPrompt,
  parseBacklogGroomingOutput,
  runBacklogGroomingPlanner,
  summarizeGroomingDecision,
} = await import('./backlogGrooming.js');

function baseTask(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 't-1',
    source: 'linear',
    title: 'Do the thing',
    priority: 1,
    createdAt: 1,
    ...overrides,
  } as TaskItem;
}

function source() {
  return {
    kind: 'linear',
    addComment: vi.fn(async () => {}),
    updateState: vi.fn(async () => true),
    updateDescription: vi.fn(async () => {}),
  } as unknown as ITaskSource & {
    addComment: ReturnType<typeof vi.fn>;
    updateState: ReturnType<typeof vi.fn>;
    updateDescription: ReturnType<typeof vi.fn>;
  };
}

describe('repoSnapshotSummary branches (via buildBacklogGroomingPrompt)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'backlog-grooming-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports not found when no repo-snapshot.json exists', () => {
    const prompt = buildBacklogGroomingPrompt({ projectPath: dir, tasks: [] });
    expect(prompt).toContain('repo-snapshot.json: not found');
  });

  it('reports parsed slug/node/edge counts when the snapshot is valid JSON', () => {
    mkdirSync(join(dir, '.openswarm'), { recursive: true });
    writeFileSync(
      join(dir, '.openswarm', 'repo-snapshot.json'),
      JSON.stringify({ projectSlug: 'my-proj', nodeCount: 12, edgeCount: 34 }),
      'utf8',
    );
    const prompt = buildBacklogGroomingPrompt({ projectPath: dir, tasks: [] });
    expect(prompt).toContain('repo-snapshot.json: my-proj (12 nodes, 34 edges)');
  });

  it('reports unreadable when the snapshot file exists but is not valid JSON', () => {
    mkdirSync(join(dir, '.openswarm'), { recursive: true });
    writeFileSync(join(dir, '.openswarm', 'repo-snapshot.json'), '{ not json', 'utf8');
    const prompt = buildBacklogGroomingPrompt({ projectPath: dir, tasks: [] });
    expect(prompt).toContain('repo-snapshot.json: unreadable');
  });
});

describe('parseBacklogGroomingOutput edge branches', () => {
  it('drops non-object decision entries', () => {
    const result = parseBacklogGroomingOutput(`\`\`\`json
{"decisions": [null, "not-an-object", 42, {"issueId":"id-1","status":"active","reason":"ok"}]}
\`\`\``, new Set(['id-1']));
    expect(result.success).toBe(true);
    expect(result.decisions.map(d => d.issueId)).toEqual(['id-1']);
  });

  it('drops decision entries missing required fields', () => {
    const result = parseBacklogGroomingOutput(`\`\`\`json
{"decisions": [{"identifier":"INT-9"}, {"issueId":"id-1","status":"active"}, {"issueId":"id-2","reason":"no status"}]}
\`\`\``, new Set(['id-1', 'id-2']));
    expect(result.success).toBe(true);
    expect(result.decisions).toEqual([]);
  });

  it('returns a failure result when the output cannot be parsed as JSON', () => {
    const result = parseBacklogGroomingOutput('not json at all, no brace here', new Set());
    expect(result.success).toBe(false);
    expect(result.decisions).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});

describe('runBacklogGroomingPlanner', () => {
  beforeEach(() => {
    spawnCli.mockReset();
    getAdapter.mockClear();
  });

  it('returns immediately without invoking the adapter when there are no tasks', async () => {
    const result = await runBacklogGroomingPlanner({ tasks: [], projectPath: '/repo' });
    expect(result).toEqual({ success: true, decisions: [] });
    expect(getAdapter).not.toHaveBeenCalled();
    expect(spawnCli).not.toHaveBeenCalled();
  });

  it('parses decisions from a successful adapter run', async () => {
    spawnCli.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '```json\n{"decisions":[{"issueId":"id-1","status":"active","reason":"fine"}]}\n```',
      stderr: '',
    });
    const result = await runBacklogGroomingPlanner({
      tasks: [baseTask({ issueId: 'id-1' })],
      projectPath: '/repo',
    });
    expect(result.success).toBe(true);
    expect(result.decisions.map(d => d.issueId)).toEqual(['id-1']);
  });

  it('still attempts to parse stdout when exit code is non-zero but stdout is non-empty', async () => {
    spawnCli.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '```json\n{"decisions":[{"issueId":"id-1","status":"active","reason":"fine"}]}\n```',
      stderr: 'warning: partial output',
    });
    const result = await runBacklogGroomingPlanner({
      tasks: [baseTask({ issueId: 'id-1' })],
      projectPath: '/repo',
    });
    expect(result.success).toBe(true);
    expect(result.decisions).toHaveLength(1);
  });

  it('drops out-of-scope decision ids from planner output', async () => {
    spawnCli.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '```json\n{"decisions":[{"issueId":"other","status":"stale","reason":"nope","closeState":"Done"}]}\n```',
      stderr: '',
    });
    const result = await runBacklogGroomingPlanner({
      tasks: [baseTask({ issueId: 'id-1' })],
      projectPath: '/repo',
    });
    expect(result.success).toBe(true);
    expect(result.decisions).toEqual([]);
  });

  it('reports stderr as the error when exit code is non-zero and stdout is empty', async () => {
    spawnCli.mockResolvedValueOnce({ exitCode: 1, stdout: '   ', stderr: 'adapter blew up' });
    const result = await runBacklogGroomingPlanner({ tasks: [baseTask()], projectPath: '/repo' });
    expect(result).toEqual({ success: false, decisions: [], error: 'adapter blew up' });
  });

  it('falls back to a generic exit-code message when stderr is also empty', async () => {
    spawnCli.mockResolvedValueOnce({ exitCode: 3, stdout: '', stderr: '' });
    const result = await runBacklogGroomingPlanner({ tasks: [baseTask()], projectPath: '/repo' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Planner adapter exited with code 3');
  });

  it('catches adapter throws and returns a failure result', async () => {
    spawnCli.mockRejectedValueOnce(new Error('adapter crashed'));
    const result = await runBacklogGroomingPlanner({ tasks: [baseTask()], projectPath: '/repo' });
    expect(result).toEqual({ success: false, decisions: [], error: 'adapter crashed' });
  });
});

describe('applyBacklogGrooming additional branches', () => {
  it('returns the default (zeroed) result immediately when the planner result failed', async () => {
    const src = source();
    const applied = await applyBacklogGrooming(src, { success: false, decisions: [], error: 'boom' });
    expect(applied).toEqual({
      commented: 0,
      failedComments: 0,
      updatedDescriptions: 0,
      moved: 0,
      movedIssueIds: [],
      skippedUnknown: 0,
    });
    expect(src.addComment).not.toHaveBeenCalled();
  });

  it('counts a failed comment in apply mode when there is no code evidence', async () => {
    const src = source();
    src.addComment.mockRejectedValueOnce(new Error('Linear unavailable'));
    const applied = await applyBacklogGrooming(src, {
      success: true,
      decisions: [{ issueId: 'id-1', status: 'stale', reason: 'trust me', closeState: 'Done' }],
    }, 'apply', new Set(['id-1']));
    expect(applied.commented).toBe(0);
    expect(applied.failedComments).toBe(1);
    expect(src.updateState).not.toHaveBeenCalled();
  });

  it('skips the description update when the task source does not support it', async () => {
    const src = {
      kind: 'linear',
      addComment: vi.fn(async () => {}),
      updateState: vi.fn(async () => true),
      // No updateDescription implemented on this source.
    } as unknown as ITaskSource & { addComment: ReturnType<typeof vi.fn> };
    const applied = await applyBacklogGrooming(src, {
      success: true,
      decisions: [{ issueId: 'id-1', status: 'needs_update', reason: 'drifted', evidence: ['src/a.ts:1'], updatedDescription: 'new body' }],
    }, 'apply', new Set(['id-1']));
    expect(applied.updatedDescriptions).toBe(0);
    expect(src.addComment.mock.calls[0][1]).toContain('description update skipped because this task source does not support it');
  });

  it('still counts the underlying mutation even when the trailing comment fails', async () => {
    const src = source();
    src.addComment.mockRejectedValueOnce(new Error('comment API down'));
    const applied = await applyBacklogGrooming(src, {
      success: true,
      decisions: [{ issueId: 'id-1', status: 'stale', reason: 'implemented', evidence: ['src/a.ts:1'], closeState: 'Done' }],
    }, 'apply', new Set(['id-1']));
    expect(src.updateState).toHaveBeenCalledWith('id-1', 'Done');
    expect(applied.moved).toBe(1);
    expect(applied.movedIssueIds).toEqual(['id-1']);
    expect(applied.commented).toBe(0);
    expect(applied.failedComments).toBe(1);
  });
});

describe('summarizeGroomingDecision', () => {
  it('prefers the human-readable identifier over the raw issue id', () => {
    const summary = summarizeGroomingDecision({ issueId: 'uuid-1', identifier: 'INT-42', status: 'stale', reason: 'already shipped' });
    expect(summary).toBe('INT-42: stale — already shipped');
  });

  it('falls back to the raw issue id when no identifier is present', () => {
    const summary = summarizeGroomingDecision({ issueId: 'uuid-1', status: 'active', reason: 'still valid' });
    expect(summary).toBe('uuid-1: active — still valid');
  });
});
