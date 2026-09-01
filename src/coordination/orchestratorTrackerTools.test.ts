import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalCoordinationFile = process.env.OPENSWARM_COORDINATION_FILE;
const originalAutomationDb = process.env.OPENSWARM_AUTOMATION_DB;
const originalWarehouseRoot = process.env.OPENSWARM_WAREHOUSE_ROOT;
let dir = '';
let warehouseDir = '';

async function setup() {
  dir = mkdtempSync(join(tmpdir(), 'osw-orchestrator-tracker-'));
  process.env.OPENSWARM_COORDINATION_FILE = join(dir, 'coordination.json');
  process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'automation.db');
  const storeModule = await import('./coordinationStore.js');
  const traceModule = await import('./coordinationTrace.js');
  storeModule.resetCoordinationStoreForTests();
  traceModule.resetTraceDbForTests();
  return {
    store: storeModule.getCoordinationStore(),
    tools: await import('./orchestratorTrackerTools.js'),
  };
}

afterEach(async () => {
  (await import('./coordinationStore.js')).resetCoordinationStoreForTests();
  (await import('./coordinationTrace.js')).resetTraceDbForTests();
  process.env.OPENSWARM_COORDINATION_FILE = originalCoordinationFile;
  process.env.OPENSWARM_AUTOMATION_DB = originalAutomationDb;
  process.env.OPENSWARM_WAREHOUSE_ROOT = originalWarehouseRoot;
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (warehouseDir) rmSync(warehouseDir, { recursive: true, force: true });
  dir = '';
  warehouseDir = '';
});

describe('orchestrator tracker tools', () => {
  it('keeps hidden tracker calls unavailable to worker roles', async () => {
    const { tools } = await setup();
    const result = await tools.executeOrchestratorTrackerTool('tracker_cached_issue', { issue: 'AX-967' }, {
      repository: '/repo', taskId: 'worker', actor: 'worker-a', actorRole: 'worker',
    });
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('orchestrator') });
  });

  it('reads the heartbeat cache without resolving the issue remotely', async () => {
    const { store, tools } = await setup();
    await store.publish({
      repository: '/repo', taskId: 'issue-uuid', taskLabel: 'AX-967', actor: 'worker-a',
      kind: 'human-question', status: 'waiting', correlationId: 'hq-1', summary: 'Save the canonical comment',
    });
    const resolveIssue = vi.fn();
    const result = await tools.executeOrchestratorTrackerTool('tracker_cached_issue', { issue: 'AX-967' }, {
      repository: '/repo', taskId: 'orchestrator:sweep', actor: 'orchestrator-a', actorRole: 'orchestrator',
      tracker: {
        getCachedIssue: () => ({ issueId: 'issue-uuid', identifier: 'AX-967', title: 'Canonical docs' }),
        resolveIssue,
        addComment: vi.fn(),
      },
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ found: true, source: 'cache', issue: { identifier: 'AX-967' } });
    expect(resolveIssue).not.toHaveBeenCalled();
  });

  it('saves only to a board-linked issue with a stable idempotency key', async () => {
    const { store, tools } = await setup();
    await store.publish({
      repository: '/repo', taskId: 'issue-uuid', taskLabel: 'AX-967', actor: 'worker-a',
      kind: 'human-question', status: 'waiting', correlationId: 'hq-1', summary: 'Save the canonical comment',
    });
    const addComment = vi.fn(async () => undefined);
    const context = {
      repository: '/repo', taskId: 'orchestrator:sweep', actor: 'orchestrator-a', actorRole: 'orchestrator',
      tracker: {
        getCachedIssue: vi.fn(),
        resolveIssue: vi.fn(async () => ({ issueId: 'issue-uuid', identifier: 'AX-967', source: 'tracker' as const })),
        addComment,
      },
    };
    const saved = await tools.executeOrchestratorTrackerTool('tracker_save_comment', {
      issue: 'AX-967', body: '정본: docs/runbook.md', idempotency_key: 'ax-967-canonical-doc',
    }, context);
    expect(saved.isError).toBe(false);
    expect(addComment).toHaveBeenCalledWith(
      'issue-uuid', '정본: docs/runbook.md', 'orchestrator:ax-967-canonical-doc',
    );

    const denied = await tools.executeOrchestratorTrackerTool('tracker_save_comment', {
      issue: 'AX-999', body: 'out of scope', idempotency_key: 'other',
    }, context);
    expect(denied).toMatchObject({ isError: true, content: expect.stringContaining('not linked') });
    expect(addComment).toHaveBeenCalledTimes(1);
  });

  it('settles a same-cell worker question under the orchestrator identity', async () => {
    const { store, tools } = await setup();
    await store.publish({
      repository: '/repo', taskId: 'issue-uuid', taskLabel: 'AX-967', actor: 'worker-a', actorRole: 'worker',
      kind: 'human-question', status: 'waiting', correlationId: 'hq-1', summary: 'Which doc is canonical?',
    });
    const answered = await tools.executeOrchestratorTrackerTool('coordination_answer_question', {
      correlation_id: 'hq-1', answer: '정본은 docs/runbook.md이며 AX-967 댓글에도 저장했다.',
    }, {
      repository: '/repo', taskId: 'orchestrator:sweep', actor: 'orchestrator-a',
      actorName: 'Supervisor A', actorRole: 'orchestrator',
    });
    expect(answered.isError).toBe(false);
    expect(store.exchange('hq-1')).toContainEqual(expect.objectContaining({
      kind: 'human-answer', status: 'completed', actor: 'Supervisor A', actorRole: 'orchestrator',
    }));
  });

  it('fails closed for cross-cell answers and bounded or unknown writes', async () => {
    const { store, tools } = await setup();
    const orchestrator = {
      repository: '/repo', taskId: 'orchestrator:sweep', actor: 'orchestrator-a', actorRole: 'orchestrator',
    };
    await expect(tools.executeOrchestratorTrackerTool('tracker_cached_issue', { issue: ' ' }, orchestrator))
      .resolves.toMatchObject({ isError: true, content: 'issue is required' });
    await expect(tools.executeOrchestratorTrackerTool('coordination_answer_question', {
      correlation_id: '', answer: '',
    }, orchestrator)).resolves.toMatchObject({ isError: true, content: expect.stringContaining('required') });
    await store.publish({
      repository: '/other', taskId: 'issue-uuid', taskLabel: 'AX-967', actor: 'worker-a',
      kind: 'human-question', status: 'waiting', correlationId: 'hq-other', summary: 'Other repository question',
    });
    const context = {
      repository: '/repo', taskId: 'orchestrator:sweep', actor: 'orchestrator-a', actorRole: 'orchestrator',
      tracker: {
        getCachedIssue: vi.fn(),
        resolveIssue: vi.fn(),
        addComment: vi.fn(),
      },
    };
    await expect(tools.executeOrchestratorTrackerTool('coordination_answer_question', {
      correlation_id: 'hq-other', answer: 'cross-cell answer',
    }, context)).resolves.toMatchObject({ isError: true, content: expect.stringContaining('not in this repository') });

    await store.publish({
      repository: '/repo', taskId: 'issue-uuid', taskLabel: 'AX-967', actor: 'worker-a',
      kind: 'human-question', status: 'waiting', correlationId: 'hq-local', summary: 'Local question',
    });
    await expect(tools.executeOrchestratorTrackerTool('tracker_cached_issue', { issue: 'AX-967' }, orchestrator))
      .resolves.toMatchObject({ isError: true, content: 'Tracker bridge is unavailable' });
    await expect(tools.executeOrchestratorTrackerTool('tracker_cached_issue', { issue: 'AX-967' }, context))
      .resolves.toMatchObject({ isError: false, content: JSON.stringify({ found: false, source: 'cache' }) });
    await expect(tools.executeOrchestratorTrackerTool('tracker_save_comment', {
      issue: 'AX-967', body: '', idempotency_key: '',
    }, context)).resolves.toMatchObject({ isError: true, content: expect.stringContaining('required') });
    await expect(tools.executeOrchestratorTrackerTool('tracker_save_comment', {
      issue: 'AX-967', body: 'x'.repeat(20_001), idempotency_key: 'bounded',
    }, context)).resolves.toMatchObject({ isError: true, content: expect.stringContaining('bounded limit') });
    await expect(tools.executeOrchestratorTrackerTool('tracker_save_comment', {
      issue: 'AX-967', body: 'verified but missing issue', idempotency_key: 'not-found',
    }, context)).resolves.toMatchObject({ isError: true, content: expect.stringContaining('could not be resolved') });
    await expect(tools.executeOrchestratorTrackerTool('unknown_tracker_tool', { issue: 'AX-967' }, context))
      .resolves.toMatchObject({ isError: true, content: expect.stringContaining('Unknown supervisor tracker tool') });
    expect(context.tracker.addComment).not.toHaveBeenCalled();
  });

  it('reads development-host files inside the repository and refuses path escape', async () => {
    const { tools } = await setup();
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const src = join(dir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'app.ts'), 'export const n = 1;\nexport const m = 2;\n');
    const orchestrator = {
      repository: dir, taskId: 'orchestrator:sweep', actor: 'orchestrator-a', actorRole: 'orchestrator' as const,
    };
    const read = await tools.executeOrchestratorTrackerTool('host_read_file', { path: 'src/app.ts' }, orchestrator);
    expect(read.isError).toBe(false);
    expect(read.content).toContain('export const n = 1;');
    const escaped = await tools.executeOrchestratorTrackerTool('host_read_file', { path: '../secret' }, orchestrator);
    expect(escaped).toMatchObject({ isError: true, content: expect.stringContaining('outside') });
    const workerDenied = await tools.executeOrchestratorTrackerTool('host_read_file', { path: 'src/app.ts' }, {
      repository: dir, taskId: 'worker', actor: 'worker-a', actorRole: 'worker',
    });
    expect(workerDenied.isError).toBe(true);
    expect(await tools.executeOrchestratorTrackerTool('host_read_file', {}, orchestrator))
      .toMatchObject({ isError: true, content: expect.stringContaining('path is required') });
    expect(await tools.executeOrchestratorTrackerTool('host_read_file', { path: 'src' }, orchestrator))
      .toMatchObject({ isError: true, content: expect.stringContaining('not a regular file') });
    const paged = await tools.executeOrchestratorTrackerTool(
      'host_read_file',
      { path: 'src/app.ts', offset: 2, limit: 1 },
      orchestrator,
    );
    expect(paged.isError).toBe(false);
    expect(paged.content).toContain('export const m = 2;');
    expect(paged.content).not.toContain('export const n = 1;');

    warehouseDir = mkdtempSync(join(tmpdir(), 'osw-warehouse-'));
    writeFileSync(join(warehouseDir, 'note.md'), 'from warehouse\n');
    process.env.OPENSWARM_WAREHOUSE_ROOT = warehouseDir;
    const warehouseRead = await tools.executeOrchestratorTrackerTool(
      'host_read_file',
      { path: join(warehouseDir, 'note.md') },
      orchestrator,
    );
    expect(warehouseRead).toMatchObject({ isError: false, content: expect.stringContaining('from warehouse') });
    expect(await tools.executeOrchestratorTrackerTool('host_search_files', { pattern: 'warehouse', path: warehouseDir }, orchestrator))
      .toMatchObject({ isError: true, content: expect.stringContaining('limited to the repository checkout') });
    expect(await tools.executeOrchestratorTrackerTool('host_search_files', {}, orchestrator))
      .toMatchObject({ isError: true, content: expect.stringContaining('pattern is required') });
    expect(await tools.executeOrchestratorTrackerTool('host_search_files', { pattern: 'export const' }, orchestrator))
      .toMatchObject({ isError: true, content: expect.stringContaining('git grep failed') });

    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', 'src/app.ts'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 't'], { cwd: dir });
    const found = await tools.executeOrchestratorTrackerTool('host_search_files', { pattern: 'export const n' }, orchestrator);
    expect(found.isError).toBe(false);
    expect(found.content).toContain('src/app.ts');
    const none = await tools.executeOrchestratorTrackerTool('host_search_files', { pattern: 'this-string-is-absent-zzzz' }, orchestrator);
    expect(none).toMatchObject({ isError: false, content: '(no matches)' });
  });
});
