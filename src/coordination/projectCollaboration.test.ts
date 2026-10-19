import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resetTraceDbForTests, recordTraceEvent, queryTrace } from './coordinationTrace.js';
import { getCoordinationStore, resetCoordinationStoreForTests, type CoordinationEvent } from './coordinationStore.js';
import { syncChannels, listChannelEntries, markChannelRead, readChannels } from './channelStore.js';
import { channelDatabase } from './channelSchema.js';
import { claimChannelDelivery, consumeChannelTaskInbox, findChannelDeliveryByKey, finishChannelDelivery, getChannelDelivery, interruptEndedTaskDeliveries,
  pendingCoordinatorMessages, recoverCoordinatorDeliveries, respondToChannelDelivery, retryChannelDelivery, sendChannelMessage } from './channelQueue.js';
import { createCoordinationThread, getCoordinationThread, listCoordinationThreads, postCoordinationThreadMessage, resolveCoordinationThread } from './coordinationThreads.js';
import { repositoryCell, resetRepositoryCellCacheForTests } from './repositoryCell.js';
import { buildProjectSnapshot, participantId } from './projectModel.js';
import { queryProjectSnapshot } from './projectQueries.js';
import { projectPage, tryHandleProjectRoutes } from './projectRoutes.js';
import { OrchestratorSupervisor } from './orchestratorSupervisor.js';
import { resolveOrchestratorConfig } from './orchestratorConfig.js';
import { executeCoordinationTool, waitForInbox } from './coordinationTools.js';
import { tryHandleAppRoutes } from '../support/webAppRoutes.js';
import { HttpError } from '../support/httpBody.js';

let root: string, repo: string, key: string;
let originalDb: string | undefined, originalBoard: string | undefined;
const e = (over: Partial<CoordinationEvent> = {}): CoordinationEvent => ({ id: 'q1', seq: 1, timestamp: Date.now(),
  repository: repo, repoKey: key, taskId: 'task', taskLabel: 'DEMO-1', actor: 'sable', actorName: 'Sable', actorRole: 'worker',
  kind: 'human-question', status: 'waiting', correlationId: 'question', summary: 'Which branch?', fingerprint: 'fp', ...over });
const send = (over = {}) => sendChannelMessage({ repoKey: key, body: 'Please review this project.', idempotencyKey: 'send-1', ...over });
const route = async (path: string, method = 'GET', body?: object, runner?: any) => {
  const output = { code: 0, body: '' };
  const response = { writeHead: (code: number) => { output.code = code; }, end: (data: string) => { output.body = data; } } as unknown as ServerResponse;
  const url = new URL(path, 'http://localhost');
  await tryHandleProjectRoutes({ method } as IncomingMessage, response, url.pathname, url, runner, [repo], async () => JSON.stringify(body));
  return { status: output.code, data: JSON.parse(output.body) };
};
beforeEach(() => {
  originalDb = process.env.OPENSWARM_AUTOMATION_DB; originalBoard = process.env.OPENSWARM_COORDINATION_FILE;
  root = mkdtempSync(join(tmpdir(), 'project-collaboration-')); repo = join(root, 'repo'); mkdirSync(repo);
  process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db'); process.env.OPENSWARM_COORDINATION_FILE = join(root, 'board.json');
  resetTraceDbForTests(); resetCoordinationStoreForTests(); key = repositoryCell(repo).repoKey; syncChannels([repo]);
});
afterEach(() => { resetTraceDbForTests(); resetCoordinationStoreForTests();
  process.env.OPENSWARM_AUTOMATION_DB = originalDb; process.env.OPENSWARM_COORDINATION_FILE = originalBoard; vi.restoreAllMocks(); });

describe('durable project channels', () => {
  it('folds explicit historical path repo_keys for entries, needs, answers and live recipient reconciliation', async () => {
    recordTraceEvent(e({ repoKey: repo }));
    resetTraceDbForTests(); syncChannels([repo]);
    expect(listChannelEntries(key).items).toHaveLength(1);
    expect(queryProjectSnapshot([repo]).needs.map((n) => n.repoKey)).toEqual([key]);
    const board = vi.spyOn(getCoordinationStore(), 'snapshot').mockImplementation(() => { throw new Error('Board offline'); });
    const partial = queryProjectSnapshot([repo]); expect(partial.needs.map((n) => n.repoKey)).toEqual([key]);
    expect(partial.unavailable).toContain('live board'); board.mockRestore();
    const answer = await route(`/api/coordination/channels/${key}/messages`, 'POST', {
      body: 'Exact old-path answer', idempotencyKey: 'path-answer', taskId: 'task', recipient: 'sable', correlationId: 'question' });
    expect(answer.status).toBe(202); expect(queryProjectSnapshot([repo]).needs).toHaveLength(0);
    const taskMessage = send({ taskId: 'task', recipient: 'sable', idempotencyKey: 'old-path-task' });
    interruptEndedTaskDeliveries([{ repoKey: key, taskId: 'task', title: 'Still running', status: 'running', stage: 'worker' }]);
    expect(getChannelDelivery(taskMessage.id).status).toBe('queued');
    recordTraceEvent(e({ id: 'future-legacy', seq: 20, repoKey: repo, kind: 'advice-response', status: 'completed', correlationId: 'future' }));
    expect(listChannelEntries(key).items.some((e) => e.sourceId === 'future-legacy')).toBe(true);
    expect(channelDatabase().prepare('SELECT repo_key FROM coordination_trace WHERE event_id=?').get('q1')).toEqual({ repo_key: repo });
  });
  it('preserves legacy path-backed discussion IDs while folding history, task lists, replies and resolution into the canonical project', () => {
    channelDatabase().exec('DROP TRIGGER channel_project_message; DELETE FROM coordination_channels; DELETE FROM coordination_channel_aliases;');
    const thread = createCoordinationThread({ repository: repo, subject: 'Legacy path discussion', actor: 'legacy', taskId: 'task-a',
      relatedTaskIds: ['task-b'], body: 'Original source' });
    const original = getCoordinationThread({ repository: repo, threadId: thread.id }).messages.items[0];
    resetTraceDbForTests(); syncChannels([repo]);
    expect(readChannels().filter((c) => c.repoKey === repo)).toHaveLength(0);
    expect(listChannelEntries(key).items).toContainEqual(expect.objectContaining({ sourceId: original.id, threadId: thread.id }));
    expect(queryProjectSnapshot([repo]).tasks.filter((t) => t.repoKey === key).map((t) => t.taskId)).toEqual(['task-a', 'task-b']);
    expect(listCoordinationThreads({ repository: key }).items.map((t) => t.id)).toContain(thread.id);
    const reply = postCoordinationThreadMessage({ repository: key, threadId: thread.id, actor: 'legacy', taskId: 'task-a', body: 'Canonical scope reply' });
    expect(listChannelEntries(key).items.some((e) => e.sourceId === reply.id)).toBe(true);
    const saved = send({ threadId: thread.id, taskId: 'task-a', recipient: 'legacy' }); expect(saved.threadId).toBe(thread.id);
    consumeChannelTaskInbox(key, 'task-a', 'legacy');
    postCoordinationThreadMessage({ repository: repo, threadId: thread.id, actor: 'legacy', taskId: 'task-a',
      body: 'Exact reply through the original path', replyToDeliveryId: saved.id });
    expect(getChannelDelivery(saved.id).status).toBe('responded');
    const detail = getCoordinationThread({ repository: key, threadId: thread.id });
    expect(detail.thread.repository).toBe(repo); expect(detail.messages.items[0].id).toBe(original.id);
    expect(resolveCoordinationThread({ repository: key, threadId: thread.id, actor: 'legacy', taskId: 'task-a',
      expectedVersion: detail.thread.version }).status).toBe('resolved');
    expect(channelDatabase().prepare('SELECT repository FROM coordination_threads WHERE thread_id=?').get(thread.id)).toEqual({ repository: repo });
  });
  it('repairs an existing split projection without changing its seq or losing either read position', () => {
    const legacy = createCoordinationThread({ repository: repo, subject: 'Old projection', actor: 'legacy', taskId: 'legacy-task', body: 'Seen history' });
    const old = listChannelEntries(key).items[0]; const db = channelDatabase();
    db.prepare('UPDATE coordination_channel_entries SET repo_key=? WHERE source_id=?').run(repo, old.sourceId);
    db.prepare('INSERT INTO coordination_channels(repo_key,repository,name,read_seq) VALUES (?,?,?,?)').run(repo, repo, 'Split path channel', old.seq);
    const unseen = createCoordinationThread({ repository: key, subject: 'New canonical discussion', actor: 'worker', taskId: 'new-task', body: 'Still unread' });
    resetTraceDbForTests(); syncChannels([repo]);
    const channel = readChannels().find((c) => c.repoKey === key)!;
    expect(channel.readSeq).toBe(old.seq); expect(channel.unread).toBe(1);
    expect(readChannels().some((c) => c.repoKey === repo)).toBe(false);
    expect(listChannelEntries(key).items.find((e) => e.sourceId === old.sourceId)?.seq).toBe(old.seq);
    expect(listChannelEntries(key).items.map((e) => e.threadId)).toEqual([unseen.id, legacy.id]);
    expect(channelDatabase().prepare('SELECT COUNT(*) n FROM coordination_thread_messages').get()).toEqual({ n: 2 });
  });
  it('maps a historical sibling path but preserves opaque keys and rejects unrelated project scopes', () => {
    execFileSync('git', ['init', '-q', repo]); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=t@e.test', 'commit', '--allow-empty', '-qm', 'base']);
    const sibling = join(root, 'legacy-sibling'); execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'legacy-sibling', sibling]);
    resetRepositoryCellCacheForTests(); const canonical = repositoryCell(repo).repoKey;
    const thread = createCoordinationThread({ repository: sibling, subject: 'Sibling history', actor: 'legacy', taskId: 'same', body: 'One project' });
    const opaque = 'git:historical-opaque-key'; const other = createCoordinationThread({ repository: opaque, subject: 'Other project', actor: 'legacy', taskId: 'same', body: 'Separate history' });
    resetTraceDbForTests(); syncChannels([repo]);
    expect(listChannelEntries(canonical).items.map((e) => e.threadId)).toContain(thread.id);
    expect(readChannels().some((c) => c.repoKey === opaque && !c.configured)).toBe(true);
    expect(getCoordinationThread({ repository: canonical, threadId: thread.id }).thread.repository).toBe(sibling);
    expect(() => getCoordinationThread({ repository: canonical, threadId: other.id })).toThrow('not found');
    expect(() => postCoordinationThreadMessage({ repository: join(root, 'unknown'), threadId: thread.id, actor: 'legacy', taskId: 'same', body: 'Wrong project' })).toThrow('not found');
    expect(listCoordinationThreads({ repository: canonical }).items.some((t) => t.id === other.id)).toBe(false);
  });
  it('preserves consumed board messages and reports the unavailable channel inbox on DB failure', async () => {
    // 실제 DB open 실패를 사용한다. 존재하지 않는 부모는 자동 생성되므로 파일을 부모로 지정한다.
    resetTraceDbForTests(); writeFileSync(join(root, 'blocked'), 'file');
    process.env.OPENSWARM_AUTOMATION_DB = join(root, 'blocked', 'channel.db');
    const boardMessage = { id: 'board-only', summary: 'Do not lose this consumed message' };
    const consume = vi.fn(async () => [boardMessage]);
    const result = await waitForInbox({ consume }, { repository: repo, repoKey: key, taskId: 'task', actor: 'sable' }, 0);
    expect(result).toContainEqual(boardMessage);
    expect(result).toContainEqual(expect.objectContaining({ kind: 'inbox-source-unavailable', source: 'channels' }));
    expect(consume).toHaveBeenCalledTimes(1);
  });
  it('preserves claimed channel messages and reports a failed board source', async () => {
    const message = send({ taskId: 'task', recipient: 'sable' });
    const result = await waitForInbox({ consume: async () => { throw new Error('EACCES board'); } },
      { repository: repo, repoKey: key, taskId: 'task', actor: 'sable' }, 0);
    expect(result).toContainEqual(expect.objectContaining({ id: message.id }));
    expect(result).toContainEqual(expect.objectContaining({ kind: 'inbox-source-unavailable', source: 'board' }));
    expect(getChannelDelivery(message.id).status).toBe('processing');
  });
  it('does not settle a different simultaneous question when answering one exact correlation', () => {
    recordTraceEvent(e({ id: 'first-question', correlationId: 'first' }));
    recordTraceEvent(e({ id: 'second-question', seq: 2, correlationId: 'second' }));
    send({ taskId: 'task', recipient: 'sable', correlationId: 'first' });
    expect(queryProjectSnapshot([repo]).needs.map((n) => n.correlationId)).toEqual(['second']);
  });
  it('does not settle a second claimed delivery for a reply linked to only the first', () => {
    const first = send({ taskId: 'task', recipient: 'sable' });
    const second = send({ taskId: 'task', recipient: 'sable', threadId: first.threadId, idempotencyKey: 'second-delivery' });
    consumeChannelTaskInbox(key, 'task', 'sable');
    postCoordinationThreadMessage({ repository: key, threadId: first.threadId, actor: 'sable', taskId: 'task', body: 'Unrelated discussion' });
    expect(getChannelDelivery(first.id).status).toBe('processing');
    postCoordinationThreadMessage({ repository: key, threadId: first.threadId, actor: 'sable', taskId: 'task',
      body: 'First delivery only', replyToDeliveryId: first.id });
    expect(getChannelDelivery(first.id).status).toBe('responded');
    expect(getChannelDelivery(second.id).status).toBe('processing');
    expect(() => postCoordinationThreadMessage({ repository: key, threadId: first.threadId, actor: 'different-agent',
      taskId: 'task', body: 'Wrong actor', replyToDeliveryId: second.id })).toThrow('scope conflict');
  });
  it('does not accept a second answer to a legacy question without repo_key', () => {
    recordTraceEvent(e({ repository: repositoryCell(repo).repositoryPath, repoKey: undefined }));
    send({ taskId: 'task', recipient: 'sable', correlationId: 'question' });
    expect(() => send({ taskId: 'task', recipient: 'sable', correlationId: 'question', idempotencyKey: 'different' })).toThrow('already answered');
  });
  it('accepts the source task shown by Needs you when the trace envelope uses a different task ID', async () => {
    recordTraceEvent(e({ taskId: 'trace-envelope', sourceTaskId: 'actual-task' }));
    const needs = await route('/api/coordination/needs-you');
    expect(needs.data.items[0].taskId).toBe('actual-task');
    const result = await route(`/api/coordination/channels/${key}/messages`, 'POST', {
      body: 'Answer the actual source', idempotencyKey: 'source-answer', taskId: 'actual-task', recipient: 'sable', correlationId: 'question' });
    expect(result.status).toBe(202); expect(result.data.delivery.taskId).toBe('actual-task');
    expect(queryTrace({ correlationId: 'question' }).at(-1)?.targetTaskId).toBe('actual-task');
    expect(queryProjectSnapshot([repo]).needs).toHaveLength(0);
  });
  it('atomically saves a canonical thread, projection reference and coordinator delivery; retries once', () => {
    const first = send(); expect(first.status).toBe('queued'); expect(send()).toEqual(first);
    expect(pendingCoordinatorMessages(key)).toHaveLength(1);
    const page = listChannelEntries(key); expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ sourceKind: 'message', sourceId: first.messageId, threadId: first.threadId });
    expect(getCoordinationThread({ repository: key, threadId: first.threadId }).messages.items[0].id).toBe(first.messageId);
    expect(() => send({ body: 'Different' })).toThrow(/conflict/);
  });
  it('rolls back the thread and projection if queue persistence fails', () => {
    channelDatabase().exec(`CREATE TRIGGER reject_delivery BEFORE INSERT ON coordination_channel_deliveries BEGIN SELECT RAISE(ABORT,'DB failure'); END;`);
    expect(() => send()).toThrow('DB failure');
    expect(listChannelEntries(key).items).toHaveLength(0);
    expect(channelDatabase().prepare('SELECT COUNT(*) n FROM coordination_threads').get()).toEqual({ n: 0 });
  });
  it('projects existing Threads without copying messages, including multi-task discussion', () => {
    const thread = createCoordinationThread({ repository: key, subject: 'Shared interface', actor: 'sable', taskId: 'task', relatedTaskIds: ['other'], body: 'Original message' });
    const page = listChannelEntries(key); expect(page.items[0].threadId).toBe(thread.id);
    expect(listChannelEntries(key, { taskId: 'other' }).items).toHaveLength(1);
    expect(channelDatabase().prepare('SELECT COUNT(*) n FROM coordination_thread_messages').get()).toEqual({ n: 1 });
  });
  it('imports thread and trace sources in chronological order and establishes one read baseline', () => {
    const db = channelDatabase();
    db.exec('DROP TRIGGER channel_project_message; DROP TRIGGER channel_project_trace; DELETE FROM coordination_channels;');
    createCoordinationThread({ repository: key, subject: 'Newer discussion', actor: 'sable', taskId: 'task', body: 'Newer thread body', now: 200 });
    recordTraceEvent(e({ timestamp: 100, summary: 'Older trace' }));
    resetTraceDbForTests(); syncChannels([repo]);
    expect(listChannelEntries(key).items.map((e) => e.body)).toEqual(['Newer thread body', 'Older trace']);
    expect(readChannels()[0].unread).toBe(0);
  });
  it('uses monotonic read cursors across connections and never reads unseen pages', () => {
    for (let i = 0; i < 120; i++) recordTraceEvent(e({ id: `e-${i}`, seq: i + 1, correlationId: `c-${i}`, kind: 'advice-request' }));
    const page = listChannelEntries(key); expect(page.items).toHaveLength(50); expect(page.nextCursor).toBeTruthy();
    expect(readChannels()[0].unread).toBe(120);
    const seq = page.items.at(-1)!.seq;
    expect(markChannelRead(key, seq)).toBe(seq); expect(markChannelRead(key, 0)).toBe(seq);
    expect(readChannels()[0].unread).toBe(49);
    expect(() => markChannelRead(key, 99999)).toThrow('Invalid read');
    const next = listChannelEntries(key, { cursor: page.nextCursor });
    expect(next.items).toHaveLength(50); expect(new Set([...page.items, ...next.items].map((e) => e.seq)).size).toBe(100);
    const newPost = e({ id: 'late', seq: 200, correlationId: 'late' }); recordTraceEvent(newPost);
    const last = listChannelEntries(key, { cursor: next.nextCursor }); expect(last.items).toHaveLength(20);
    expect(last.items.every((e) => e.seq <= page.scope.throughSeq!)).toBe(true);
  });
  it('baselines only imported history and does not reset read positions on restart', () => {
    recordTraceEvent(e()); const before = readChannels()[0].readSeq;
    resetTraceDbForTests(); syncChannels([repo]);
    expect(readChannels()[0].readSeq).toBe(before); expect(readChannels()[0].unread).toBe(1);
    const other = join(root, 'older'); mkdirSync(other);
    recordTraceEvent(e({ id: 'old', repository: other, repoKey: repositoryCell(other).repoKey }));
    syncChannels([repo, other]); expect(readChannels().find((c) => c.repoKey === repositoryCell(other).repoKey)!.unread).toBe(0);
  });
  it('keeps removed channels read-only and still returns a previous receipt', () => {
    const item = send(); syncChannels([]); expect(readChannels()[0].configured).toBe(false);
    expect(() => send({ idempotencyKey: 'new' })).toThrow('read-only'); expect(send().id).toBe(item.id);
    expect(listChannelEntries(key).items).toHaveLength(1);
  });
  it('preserves interrupted unknown outcomes and requires an explicit retry', () => {
    const item = send(); const run = claimChannelDelivery(item.id)!;
    expect(claimChannelDelivery(item.id)).toBeUndefined(); recoverCoordinatorDeliveries(key);
    expect(getChannelDelivery(item.id).status).toBe('interrupted'); expect(pendingCoordinatorMessages(key)).toHaveLength(0);
    expect(retryChannelDelivery(key, item.id).status).toBe('queued');
    const retry = claimChannelDelivery(item.id)!; expect(retry).not.toBe(run);
    respondToChannelDelivery(item.id, retry, 'Coordinator', 'Independent response');
    recoverCoordinatorDeliveries(key); expect(getChannelDelivery(item.id).status).toBe('responded');
    expect(listChannelEntries(key).items).toHaveLength(2);
  });
  it('does not call saved or claimed work a response; records failures and environment skips', () => {
    const item = send(); const run = claimChannelDelivery(item.id)!;
    expect(getChannelDelivery(item.id).status).toBe('processing');
    finishChannelDelivery(item.id, run, 'queued', 'Coordinator unavailable'); expect(getChannelDelivery(item.id).status).toBe('queued');
    const run2 = claimChannelDelivery(item.id)!; finishChannelDelivery(item.id, run2, 'failed', 'HTTP 429');
    expect(getChannelDelivery(item.id)).toMatchObject({ status: 'failed', error: 'HTTP 429' });
  });
  it('interrupts ended/stage-replaced task deliveries while retaining a matching live execution', () => {
    recordTraceEvent(e({ kind: 'advice-request', status: 'running', actorRole: 'worker' }));
    const live = send({ taskId: 'task', recipient: 'sable' }); consumeChannelTaskInbox(key, 'task', 'sable');
    interruptEndedTaskDeliveries([{ repoKey: key, taskId: 'task', title: 'Live task', status: 'running', stage: 'worker', startedAt: live.createdAt - 10 }]);
    expect(getChannelDelivery(live.id).status).toBe('processing');
    interruptEndedTaskDeliveries([{ repoKey: key, taskId: 'task', title: 'Reviewer replaced worker', status: 'running', stage: 'reviewer' }]);
    expect(getChannelDelivery(live.id).status).toBe('interrupted');
    const ended = send({ taskId: 'task', recipient: 'sable', idempotencyKey: 'ended' });
    interruptEndedTaskDeliveries([]); expect(getChannelDelivery(ended.id).status).toBe('interrupted');
    const restarted = send({ taskId: 'task', recipient: 'sable', idempotencyKey: 'restarted' }); consumeChannelTaskInbox(key, 'task', 'sable');
    interruptEndedTaskDeliveries([{ repoKey: key, taskId: 'task', title: 'New run', status: 'running', stage: 'worker', startedAt: Date.now() + 1000 }]);
    expect(getChannelDelivery(restarted.id).status).toBe('interrupted');
  });
  it('delivers only to the exact project/task/address and observes the canonical thread reply', async () => {
    const item = send({ taskId: 'task', recipient: 'sable' });
    expect(consumeChannelTaskInbox('another', 'task', 'sable')).toHaveLength(0);
    expect(consumeChannelTaskInbox(key, 'other', 'sable')).toHaveLength(0);
    const inbox = await executeCoordinationTool('coordination_read', {}, { repository: repo, repoKey: key, taskId: 'task', actor: 'sable' });
    expect(JSON.parse(inbox.content)[0].metadata.threadId).toBe(item.threadId);
    expect(getChannelDelivery(item.id).status).toBe('processing');
    postCoordinationThreadMessage({ repository: key, threadId: item.threadId, taskId: 'other', actor: 'sable', body: 'Wrong task' });
    expect(getChannelDelivery(item.id).status).toBe('processing');
    postCoordinationThreadMessage({ repository: key, threadId: item.threadId, taskId: 'task', actor: 'sable', body: 'Acknowledged precisely', replyToDeliveryId: item.id });
    expect(getChannelDelivery(item.id).status).toBe('responded');
  });
  it('wakes coordination_wait for a durable task message without using trace as the queue', async () => {
    const waiting = waitForInbox(getCoordinationStore(), { repository: repo, repoKey: key, taskId: 'task', actor: 'sable' }, 1000);
    send({ taskId: 'task', recipient: 'sable' });
    expect((await waiting)[0]).toMatchObject({ recipient: 'sable', targetTaskId: 'task' });
  });
  it('commits an exact question answer with its queue, even when it is outside the live board', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123_456);
    recordTraceEvent(e()); const item = send({ taskId: 'task', recipient: 'sable', correlationId: 'question' });
    expect(queryTrace({ correlationId: 'question' }).at(-1)).toMatchObject({ kind: 'human-answer', detail: 'Please review this project.' });
    expect(queryProjectSnapshot([repo]).needs).toHaveLength(0);
    expect(listChannelEntries(key).items).toHaveLength(2); // question + original thread message, no copied answer
    expect(() => send({ idempotencyKey: 'another', taskId: 'task', recipient: 'sable', correlationId: 'question' })).toThrow('Question scope');
    expect(findChannelDeliveryByKey(key, 'send-1')!.id).toBe(item.id);
  });
});

describe('identity, aggregate and page contracts', () => {
  it('collapses sibling worktrees and preserves same task/name across projects', () => {
    execFileSync('git', ['init', '-q', repo]); execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=t@e.test', 'commit', '--allow-empty', '-qm', 'base']);
    const sibling = join(root, 'sibling'); execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'sibling', sibling]);
    resetRepositoryCellCacheForTests();
    const channels = syncChannels([repo, sibling]);
    expect(channels.filter((c) => c.configured)).toHaveLength(1);
    const k = repositoryCell(repo).repoKey; expect(repositoryCell(sibling).repoKey).toBe(k);
    expect(participantId(k, 'same', 'sable')).not.toBe(participantId('other', 'same', 'sable'));
  });
  it.each([10, 100])('counts the complete %i-project fixture independently of a 500-item board', (n) => {
    const channels = Array.from({ length: n }, (_, p) => ({ repoKey: `p-${p}`, repository: '', name: `Project ${p}`, configured: true, unread: 0, readSeq: 0, latestSeq: 0 }));
    const events = channels.flatMap((c) => Array.from({ length: 10 }, (_, a) => e({ id: `${c.repoKey}-${a}`, repoKey: c.repoKey, taskId: 'same', actor: `a-${a}`, actorName: 'Sable', correlationId: `${c.repoKey}-${a}` })));
    const snapshot = buildProjectSnapshot({ channels, events, sessions: channels.map((c) => ({ repoKey: c.repoKey, taskId: 'same', title: 'Same task ID', status: 'running' })) });
    expect(snapshot.totals).toMatchObject({ runningTasks: n, recentParticipants: n * 10, needsYou: n * 10 });
    expect(snapshot.tasks).toHaveLength(n);
    const page = projectPage(snapshot.projects, (p) => p.repoKey, 'projects', new URLSearchParams()); expect(page.items).toHaveLength(Math.min(n, 50));
  });
  it('finds old unresolved questions beyond 500 and does not resurrect answered correlations', () => {
    recordTraceEvent(e());
    for (let i = 0; i < 610; i++) recordTraceEvent(e({ id: `log-${i}`, seq: i + 2, kind: 'mcp-audit', correlationId: `log-${i}` }));
    expect(queryProjectSnapshot([repo]).needs).toHaveLength(1);
    recordTraceEvent(e({ id: 'answer', seq: 700, kind: 'human-answer', status: 'completed', actor: 'operator', actorRole: 'human' }));
    recordTraceEvent(e({ id: 'other', seq: 701, kind: 'advice-response', status: 'completed', actor: 'operator', actorRole: 'human', correlationId: 'other' }));
    expect(queryProjectSnapshot([repo]).needs).toHaveLength(0);
  });
  it('separates 30m activity, real running state, missing sources and overlapping operator parks', () => {
    const channels = readChannels();
    const snapshot = buildProjectSnapshot({ channels, sessions: [], events: [e({ timestamp: Date.now() - 31 * 60_000 })],
      parked: [{ id: 'park', repoKey: key, taskId: 'task', kind: 'parked' }] });
    expect(snapshot.totals).toMatchObject({ runningTasks: 0, recentParticipants: 0, needsYou: 1 });
    const partial = buildProjectSnapshot({ channels, sessions: [], events: [], unavailable: ['sessions', 'activity'] });
    expect(partial.projects[0]).toMatchObject({ runningTasks: null, recentParticipants: null, needsYou: 0 });
  });
});

describe('HTTP and supervisor integration', () => {
  it('wires configured dashboard-only channels through the app router and retains removed history read-only', async () => {
    let configured = [repo];
    const app = async (path: string, method = 'GET', body?: object) => {
      const out = { status: 0, body: '' }; const url = new URL(path, 'http://localhost');
      const response = { writeHead: (status: number) => { out.status = status; }, end: (text: string) => { out.body = text; } } as unknown as ServerResponse;
      expect(await tryHandleAppRoutes({ method } as IncomingMessage, response, url.pathname, url, undefined,
        async () => JSON.stringify(body), () => configured)).toBe(true);
      return { status: out.status, data: JSON.parse(out.body) };
    };
    expect((await app('/api/coordination/projects')).data.items[0]).toMatchObject({ repoKey: key, configured: true, coordinatorAvailable: false });
    const path = `/api/coordination/channels/${key}/messages`; const body = { body: 'Dashboard-only request', idempotencyKey: 'dashboard' };
    expect((await app(path, 'POST', body)).data.delivery.status).toBe('queued');
    configured = [];
    expect((await app('/api/coordination/projects')).data.items[0].configured).toBe(false);
    expect((await app(path, 'POST', { ...body, idempotencyKey: 'archived' })).status).toBe(409);
    expect((await app(`/api/coordination/channels/${key}/entries`)).data.items).toHaveLength(1);
  });
  it('preserves body-reader errors and explicit retry state through the HTTP contract', async () => {
    const item = send(); const run = claimChannelDelivery(item.id)!;
    finishChannelDelivery(item.id, run, 'failed', 'Provider 429');
    const retry = await route(`/api/coordination/channels/${key}/deliveries/${item.id}/retry`, 'POST', {});
    expect(retry.status).toBe(202); expect(retry.data.delivery.status).toBe('queued');
    const out = { status: 0 }; const path = `/api/coordination/channels/${key}/messages`;
    await tryHandleProjectRoutes({ method: 'POST' } as IncomingMessage,
      { writeHead: (status: number) => { out.status = status; }, end: () => {} } as unknown as ServerResponse,
      path, new URL(path, 'http://localhost'), undefined, [repo], async () => { throw new HttpError(413, 'Too large'); });
    expect(out.status).toBe(413); expect(pendingCoordinatorMessages(key)).toHaveLength(1);
  });
  it('pages the full task relation inventory while bounding the selected graph and keeping selection', async () => {
    let seq = 1;
    for (let from = 0; from < 26; from++) {
      for (let to = 0; to < (from < 10 ? 10 : 1); to++) {
        recordTraceEvent(e({ id: `edge-${from}-${to}`, seq: seq++, actor: `peer-${String(from).padStart(2, '0')}`,
          actorName: `Peer ${from}`, recipient: `peer-${String(to).padStart(2, '0')}`, recipientName: `Peer ${to}`,
          targetTaskId: 'task', kind: 'advice-response', status: 'completed', correlationId: `edge-${from}-${to}` }));
      }
    }
    const list = await route(`/api/coordination/projects/${key}/tasks`);
    expect(list.status).toBe(200); expect(list.data.items[0].taskId).toBe('task');
    const selected = participantId(key, 'task', 'peer-25');
    const detail = await route(`/api/coordination/projects/${key}/tasks/task?node=${encodeURIComponent(selected)}`);
    expect(detail.status).toBe(200); expect(detail.data.graph.nodes).toHaveLength(20);
    expect(detail.data.graph.edges).toHaveLength(40); expect(detail.data.graph.nodes.some((n: {id: string}) => n.id === selected)).toBe(true);
    expect(detail.data.participants.items).toHaveLength(26); expect(detail.data.relationships.items).toHaveLength(50);
    const next = await route(`/api/coordination/projects/${key}/tasks/task?part=connections&cursor=${encodeURIComponent(detail.data.relationships.nextCursor)}`);
    expect(next.status).toBe(200); expect(next.data.items).toHaveLength(50);
    const search = await route(`/api/coordination/projects/${key}/tasks/task?search=Peer%2025`);
    expect(search.data.participants.items).toHaveLength(1); expect(search.data.relationships.items.length).toBeGreaterThan(0);
  });
  it('accepts a currently running task recipient, validates reads, and opens the exact Needs-you item', async () => {
    recordTraceEvent(e());
    const running = { getRunningTasks: () => [{ projectPath: repo, task: { id: 'task', title: 'Current task' }, startedAt: Date.now(), stage: 'worker' }],
      getQueuedTasks: () => [], isProjectCoordinatorAvailable: () => false };
    const needs = await route('/api/coordination/needs-you');
    expect(needs.data.items[0]).toMatchObject({ repoKey: key, taskId: 'task', correlationId: 'question', actor: 'sable' });
    const result = await route(`/api/coordination/channels/${key}/messages`, 'POST', {
      body: 'An exact task reply', taskId: 'task', recipient: 'sable', idempotencyKey: 'live-task' }, running);
    expect(result.status).toBe(202); expect(result.data.delivery).toMatchObject({ taskId: 'task', recipient: 'sable', status: 'queued' });
    const position = await route(`/api/coordination/channels/${key}/read`); expect(position.data.readSeq).toBe(0);
    expect((await route(`/api/coordination/channels/${key}/read`, 'POST', { throughSeq: 1 })).data.readSeq).toBe(1);
    expect((await route(`/api/coordination/channels/${key}/read`, 'POST', { throughSeq: -1 })).status).toBe(400);
  });
  it('stops picking queued messages after disable and recovers unknown disabled-project runs without executing', async () => {
    let enabled = true;
    const first = send(); const second = send({ idempotencyKey: 'second' });
    const run = vi.fn(async () => { enabled = false; return { callSign: 'Coordinator', output: 'one response', toolsGranted: [], toolsDenied: [], adapter: 'codex-responses' as const, model: 'test' }; });
    const supervisor = new OrchestratorSupervisor({ config: resolveOrchestratorConfig({ orchestrator: { enabled: true } })!,
      getRepositories: () => enabled ? [repo] : [], getPending: () => [],
      buildInstructionCapsule: () => ({ text: '', digest: '', sources: [], errors: [], repositoryRoot: repo }), run });
    await supervisor.requestSweep(); expect(run).toHaveBeenCalledTimes(1);
    expect(getChannelDelivery(first.id).status).toBe('responded'); expect(getChannelDelivery(second.id).status).toBe('queued');
    claimChannelDelivery(second.id); await supervisor.requestSweep();
    expect(getChannelDelivery(second.id).status).toBe('interrupted'); expect(run).toHaveBeenCalledTimes(1);
    await supervisor.stop();
  });
  it('rejects unknown project keys, archived writes, cross-project cursors and ended recipients', async () => {
    expect((await route('/api/coordination/channels/unknown/entries')).status).toBe(404);
    expect((await route(`/api/coordination/channels/${key}/messages`, 'POST', { body: 'wrong task', taskId: 'ended', recipient: 'sable', idempotencyKey: 'k' })).status).toBe(409);
    expect((await route('/api/coordination/projects?limit=0')).status).toBe(400);
    expect((await route(`/api/coordination/channels/${key}/entries?cursor=garbage`)).status).toBe(400);
  });
  it('returns an idempotent saved/queued receipt without enabling or invoking a coordinator', async () => {
    const url = `/api/coordination/channels/${key}/messages`;
    const body = { body: 'Please triage', idempotencyKey: 'repeat' };
    const first = await route(url, 'POST', body); const second = await route(url, 'POST', body);
    expect(first.status).toBe(202); expect(first.data).toMatchObject({ delivery: { status: 'queued' }, coordinatorAvailable: false });
    expect(second.data.delivery.id).toBe(first.data.delivery.id);
  });
  it('runs a queued coordinator request under the supervisor lifecycle and stores its response', async () => {
    const run = vi.fn(async (options: { objective: string }) => {
      expect(options.objective).toContain('Please review this project.');
      return { callSign: 'Coordinator', output: 'Reviewed the exact request.', toolsGranted: [], toolsDenied: [], adapter: 'codex-responses' as const, model: 'test' };
    });
    const item = send();
    const supervisor = new OrchestratorSupervisor({ config: resolveOrchestratorConfig({ orchestrator: { enabled: true } })!,
      getRepositories: () => [repo], getPending: () => [], buildInstructionCapsule: () => ({ text: '', digest: '', sources: [], errors: [], repositoryRoot: repo }), run });
    await supervisor.requestSweep(); expect(run).toHaveBeenCalledTimes(1);
    expect(getChannelDelivery(item.id).status).toBe('responded'); await supervisor.requestSweep(); expect(run).toHaveBeenCalledTimes(1);
    const messages = getCoordinationThread({ repository: key, threadId: item.threadId }).messages.items;
    expect(messages.map((m) => m.body)).toEqual(['Please review this project.', 'Reviewed the exact request.']);
    await supervisor.stop();
  });
});
