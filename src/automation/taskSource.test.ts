import { afterEach, describe, expect, it } from 'vitest';
import { SqliteIssueStore } from '../issues/sqliteStore.js';
import { SqliteTaskSource, issueToTask } from './taskSource.js';

function freshStore(): SqliteIssueStore {
  return new SqliteIssueStore(':memory:');
}

describe('issueToTask mapping', () => {
  it('maps priority + status to the runner vocabulary', () => {
    const store = freshStore();
    const issue = store.createIssue({ projectId: 'p', title: 'T', priority: 'high', status: 'in_progress' });
    const task = issueToTask(issue);
    expect(task.source).toBe('local');
    expect(task.priority).toBe(2); // high → 2
    expect(task.linearState).toBe('In Progress');
    expect(task.issueId).toBe(issue.id);
    store.close();
  });
});

describe('SqliteTaskSource', () => {
  let store: SqliteIssueStore;
  afterEach(() => store?.close());

  it('fetchTasks returns only todo/in_progress issues', async () => {
    store = freshStore();
    store.createIssue({ projectId: 'p', title: 'todo-one', status: 'todo' });
    store.createIssue({ projectId: 'p', title: 'running', status: 'in_progress' });
    store.createIssue({ projectId: 'p', title: 'backlogged', status: 'backlog' });
    store.createIssue({ projectId: 'p', title: 'finished', status: 'done' });

    const src = new SqliteTaskSource(store);
    const tasks = await src.fetchTasks();
    const titles = tasks.map((t) => t.title).sort();
    expect(titles).toEqual(['running', 'todo-one']);
    expect(tasks.every((t) => t.source === 'local')).toBe(true);
  });

  it('updateState transitions the issue status', async () => {
    store = freshStore();
    const issue = store.createIssue({ projectId: 'p', title: 'x', status: 'todo' });
    const src = new SqliteTaskSource(store);
    await src.updateState(issue.id, 'Done');
    expect(store.getIssue(issue.id)?.status).toBe('done');
  });

  it('returns false when a local state transition targets a missing issue', async () => {
    store = freshStore();
    const src = new SqliteTaskSource(store);
    await expect(src.updateState('missing', 'Done')).resolves.toBe(false);
  });

  it('explicitly looks up terminal local issues that fetchTasks excludes', async () => {
    store = freshStore();
    const issue = store.createIssue({ projectId: 'p', title: 'finished', status: 'done' });
    const src = new SqliteTaskSource(store);

    await expect(src.lookupIssueState(issue.id)).resolves.toEqual({
      ok: true,
      issue: { state: 'done', stateType: 'completed' },
    });
    await expect(src.lookupIssueState('missing')).resolves.toEqual({ ok: true, issue: null });
  });

  it('addComment records a commented event', async () => {
    store = freshStore();
    const issue = store.createIssue({ projectId: 'p', title: 'x' });
    const src = new SqliteTaskSource(store);
    await src.addComment(issue.id, 'hello');
    const events = store.getEvents(issue.id);
    expect(events.some((e) => e.type === 'commented')).toBe(true);
  });

  it('round-trips durable completion markers through execution comments', async () => {
    store = freshStore();
    const issue = store.createIssue({ projectId: 'p', title: 'x', status: 'todo' });
    const src = new SqliteTaskSource(store);
    await src.logPairComplete(issue.id, 'session', {
      attempts: 1,
      duration: 3,
      filesChanged: ['src/a.ts'],
      idempotencyMarker: 'complete:issue:attempt:1',
    });

    const comments = await src.getExecutionComments(issue.id);
    expect(comments.some((comment) =>
      comment.body.includes('<!-- openswarm-effect:complete:issue:attempt:1 -->'))).toBe(true);
    expect(store.getIssue(issue.id)?.status).toBe('done');
  });

  it('deduplicates concurrent/retried local completion comments by marker', async () => {
    store = freshStore();
    const issue = store.createIssue({ projectId: 'p', title: 'x', status: 'todo' });
    const src = new SqliteTaskSource(store);
    const stats = {
      attempts: 1,
      duration: 3,
      filesChanged: ['src/a.ts'],
      idempotencyMarker: 'complete:issue:attempt:1',
    };

    await Promise.all([
      src.logPairComplete(issue.id, 'session', stats),
      src.logPairComplete(issue.id, 'session', stats),
    ]);
    const comments = store.getEvents(issue.id, 100)
      .filter((event) => event.type === 'commented' && event.content?.includes('openswarm-effect:complete:issue:attempt:1'));
    expect(comments).toHaveLength(1);
  });

  it('createSubIssue creates a child under the parent project', async () => {
    store = freshStore();
    const parent = store.createIssue({ projectId: 'proj-x', title: 'parent' });
    const src = new SqliteTaskSource(store);
    const result = await src.createSubIssue(parent.id, 'child', 'desc', { priority: 1, estimatedMinutes: 20 });
    expect('id' in result).toBe(true);
    if ('id' in result) {
      const child = store.getIssue(result.id);
      expect(child?.parentId).toBe(parent.id);
      expect(child?.projectId).toBe('proj-x');
      expect(child?.priority).toBe('urgent'); // 1 → urgent
    }
  });

  it('returns the first local child when an identical idempotent decomposition create is retried', async () => {
    store = freshStore();
    const parent = store.createIssue({ projectId: 'proj-x', title: 'parent' });
    const src = new SqliteTaskSource(store);
    const idempotencyId = '22222222-2222-4222-8222-222222222222';

    const first = await src.createSubIssue(parent.id, 'first title', 'desc', { idempotencyId });
    const retried = await src.createSubIssue(parent.id, 'first title', 'desc', { idempotencyId });
    expect(first).toEqual(retried);
    expect(store.listIssues({ parentId: parent.id, limit: 20, offset: 0 }).total).toBe(1);
  });

  it('rejects an idempotent child collision when a retried plan changed', async () => {
    store = freshStore();
    const parent = store.createIssue({ projectId: 'proj-x', title: 'parent' });
    const src = new SqliteTaskSource(store);
    const idempotencyId = '33333333-3333-4333-8333-333333333333';

    await src.createSubIssue(parent.id, 'first title', 'desc', { idempotencyId });
    const collided = await src.createSubIssue(parent.id, 'changed title', 'desc', { idempotencyId });
    expect(collided).toEqual({
      error: expect.stringContaining('existing artifact does not match'),
    });
    expect(store.listIssues({ parentId: parent.id, limit: 20, offset: 0 }).total).toBe(1);
  });

  it('createTask creates a top-level todo issue', async () => {
    store = freshStore();
    const src = new SqliteTaskSource(store, 'proj-default');
    const result = await src.createTask('a goal', 'details');
    expect('id' in result).toBe(true);
    if ('id' in result) {
      const issue = store.getIssue(result.id);
      expect(issue?.title).toBe('a goal');
      expect(issue?.status).toBe('todo');
      expect(issue?.parentId).toBeUndefined();
    }
  });

  it('markAsDecomposed comments + keeps the parent active for crash recovery', async () => {
    store = freshStore();
    const issue = store.createIssue({ projectId: 'p', title: 'big', status: 'todo' });
    const src = new SqliteTaskSource(store);
    await src.markAsDecomposed(issue.id, 3, 90);
    expect(store.getIssue(issue.id)?.status).toBe('in_progress');
    expect(store.getEvents(issue.id).some((e) => e.type === 'commented')).toBe(true);
  });

  it('deduplicates a retried decomposition summary comment', async () => {
    store = freshStore();
    const issue = store.createIssue({ projectId: 'p', title: 'big', status: 'todo' });
    const src = new SqliteTaskSource(store);
    await src.markAsDecomposed(issue.id, 3, 90, `decomposition:${issue.id}:summary`);
    await src.markAsDecomposed(issue.id, 3, 90, `decomposition:${issue.id}:summary`);
    expect(store.getEvents(issue.id, 100).filter((event) => event.type === 'commented')).toHaveLength(1);
  });
});
