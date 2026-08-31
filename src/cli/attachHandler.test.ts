import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordinationEvent } from '../coordination/coordinationStore.js';
import {
  latestAddressable,
  openQuestionFor,
  resolveIssue,
  runAttachCommand,
} from './attachHandler.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const readFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', () => ({ readFileSync: readFileSyncMock }));

function event(overrides: Partial<CoordinationEvent> = {}): CoordinationEvent {
  return {
    id: 'e1', seq: 1, timestamp: 1_000, repository: '/repo', taskId: 'uuid-1234-5678-9012',
    actor: 'worker-a', actorName: 'Worker A', actorRole: 'worker',
    kind: 'advice-request', status: 'open', correlationId: 'c1', summary: 'question?',
    fingerprint: 'fp1',
    ...overrides,
  };
}

// ---- Ported pure functions: same scenarios as tests/web/conversationModel.test.ts,
// to prove the TypeScript port behaves identically to the dashboard original it's
// mirrored from. ---------------------------------------------------------------

describe('latestAddressable (ported from conversationModel.mjs)', () => {
  it('returns the newest agent speaker, skipping the operator', () => {
    const target = latestAddressable([
      event({ id: 'a', seq: 1 }),
      event({ id: 'op', seq: 2, actor: 'operator-dashboard', actorName: 'Operator', actorRole: 'human' }),
    ]);
    expect(target?.id).toBe('a');
  });

  it('never addresses the daemon through its instruction snapshot', () => {
    const target = latestAddressable([
      event({ id: 'a', seq: 1 }),
      event({ id: 'snap', seq: 2, actor: 'daemon', actorRole: 'daemon', kind: 'instruction-snapshot' }),
    ]);
    expect(target?.id).toBe('a');
  });

  it('returns null when nobody can be addressed', () => {
    expect(latestAddressable([
      event({ actor: 'operator-dashboard', actorRole: 'human' }),
    ])).toBeNull();
  });

  // Caught by openswarm review, not self-caught: unlike the dashboard's own
  // latestAddressable (only excludes 'human'), this CLI has no human in the
  // loop to notice a bad pick, so a daemon-authored bookkeeping event must
  // not look addressable just because its actorRole isn't 'human'.
  it("skips a trailing adapter-route event — the daemon's provider-fallback bookkeeping, not an agent", () => {
    const target = latestAddressable([
      event({ id: 'worker-spoke', seq: 1, actor: 'sable', actorRole: 'worker' }),
      event({
        id: 'route', seq: 2, kind: 'adapter-route', actor: 'adapter-router', actorRole: 'daemon',
        recipient: 'sable',
      }),
    ]);
    expect(target?.id).toBe('worker-spoke');
  });

  it("skips a trailing mcp-audit event — the daemon's tool-policy bookkeeping, not an agent", () => {
    const target = latestAddressable([
      event({ id: 'worker-spoke', seq: 1, actor: 'sable', actorRole: 'worker' }),
      event({
        id: 'audit', seq: 2, kind: 'mcp-audit', actor: 'openswarm-daemon', actorRole: 'daemon',
      }),
    ]);
    expect(target?.id).toBe('worker-spoke');
  });

  it('still addresses a trailing review-run event — a real review agent, not daemon bookkeeping', () => {
    const target = latestAddressable([
      event({ id: 'worker-spoke', seq: 1, actor: 'sable', actorRole: 'worker' }),
      event({
        id: 'review', seq: 2, kind: 'review-run', actor: 'reviewer-eb2a', actorRole: 'review-agent',
      }),
    ]);
    expect(target?.id).toBe('review');
  });
});

describe('openQuestionFor (ported from conversationModel.mjs, AGT-4030)', () => {
  const question = (over: Partial<CoordinationEvent> = {}) => event({
    kind: 'human-question', status: 'waiting', correlationId: 'hq-1',
    actor: 'sable', actorRole: 'worker', recipient: 'human', seq: 5, ...over,
  });

  it('finds the question an agent is still parked on', () => {
    expect(openQuestionFor([event({ seq: 1 }), question()], 'sable', { taskId: 'uuid-1234-5678-9012' })?.correlationId).toBe('hq-1');
  });

  it('ignores a question that has since been answered', () => {
    const answered = event({
      kind: 'human-answer', status: 'completed', correlationId: 'hq-1',
      actor: 'operator-dashboard', actorRole: 'human', recipient: 'sable', seq: 6,
    });
    expect(openQuestionFor([question(), answered], 'sable', { taskId: 'uuid-1234-5678-9012' })).toBeNull();
  });

  it('is null for a different agent, and for none', () => {
    const scope = { taskId: 'uuid-1234-5678-9012' };
    expect(openQuestionFor([question()], 'worker-3f2a', scope)).toBeNull();
    expect(openQuestionFor([question()], undefined, scope)).toBeNull();
    expect(openQuestionFor([event({ seq: 1 })], 'sable', scope)).toBeNull();
  });

  it('will not cross tasks, and refuses when given no scope at all', () => {
    const theirs = question({ taskId: 'another-task', correlationId: 'hq-other' });
    expect(openQuestionFor([theirs], 'sable', { taskId: 'uuid-1234-5678-9012' })).toBeNull();
    expect(openQuestionFor([theirs], 'sable', {})).toBeNull();
  });
});

// ---- resolveIssue ------------------------------------------------------------

describe('resolveIssue', () => {
  it('resolves an identifier to its issue id via the injected getIssue', async () => {
    const ensureTaskSource = vi.fn().mockResolvedValue(undefined);
    const getIssue = vi.fn().mockResolvedValue({ id: 'uuid-abc', identifier: 'AGT-123' });
    const result = await resolveIssue('AGT-123', { ensureTaskSource, getIssue });
    expect(ensureTaskSource).toHaveBeenCalled();
    expect(getIssue).toHaveBeenCalledWith('AGT-123');
    expect(result).toEqual({ id: 'uuid-abc', identifier: 'AGT-123' });
  });

  it('returns null when the issue cannot be found', async () => {
    const result = await resolveIssue('AGT-999', {
      ensureTaskSource: vi.fn().mockResolvedValue(undefined),
      getIssue: vi.fn().mockResolvedValue(null),
    });
    expect(result).toBeNull();
  });
});

// ---- runAttachCommand (full HTTP flow) ---------------------------------------

function statsOk() {
  return { ok: true, json: async () => ({}) };
}

function historyOk(events: CoordinationEvent[]) {
  return { ok: true, json: async () => ({ events }) };
}

function attachmentOk(filename: string, path: string, bytes = 42) {
  return { ok: true, json: async () => ({ id: 'att-1', filename, path, bytes }) };
}

function messageOk() {
  return { ok: true, json: async () => ({ delivered: true, mode: 'note', event: event() }) };
}

const deps = {
  ensureTaskSource: vi.fn().mockResolvedValue(undefined),
  getIssue: vi.fn().mockResolvedValue({ id: 'uuid-1234-5678-9012', identifier: 'AGT-123' }),
};

describe('runAttachCommand', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    readFileSyncMock.mockReset();
    readFileSyncMock.mockReturnValue(Buffer.from('file contents'));
    deps.ensureTaskSource.mockClear();
    deps.getIssue.mockClear();
  });

  it('uploads a single file and notifies the addressable agent', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(statsOk())
      .mockResolvedValueOnce(historyOk([event({ actor: 'sable', actorRole: 'worker', actorName: 'Sable' })]))
      .mockResolvedValueOnce(attachmentOk('report.pdf', '/state/attachments/uuid-1234-5678-9012/report.pdf'))
      .mockResolvedValueOnce(messageOk());

    const code = await runAttachCommand('AGT-123', ['/local/report.pdf'], { message: 'here is the data', deps });

    expect(code).toBe(0);
    const [, historyInit] = fetchMock.mock.calls[1];
    const [attachUrl, attachInit] = fetchMock.mock.calls[2];
    expect(attachUrl).toContain('/api/coordination/attachment?taskId=uuid-1234-5678-9012&filename=report.pdf');
    expect(attachInit.method).toBe('POST');
    const [messageUrl, messageInit] = fetchMock.mock.calls[3];
    expect(messageUrl).toContain('/api/coordination/message');
    const sentBody = JSON.parse(messageInit.body as string);
    expect(sentBody.recipient).toBe('sable');
    expect(sentBody.text).toContain('here is the data');
    expect(sentBody.text).toContain('/state/attachments/uuid-1234-5678-9012/report.pdf');
    // A daemon that answers the health probe can still stall on a later
    // request — every operational call after it needs its own bound, or an
    // interactive CLI has no way out of a stalled daemon (caught by
    // openswarm review, not self-caught).
    expect(historyInit.signal).toBeInstanceOf(AbortSignal);
    expect(attachInit.signal).toBeInstanceOf(AbortSignal);
    expect(messageInit.signal).toBeInstanceOf(AbortSignal);
    consoleLog.mockRestore();
  });

  it('uploads multiple files and folds every path into one message', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(statsOk())
      .mockResolvedValueOnce(historyOk([event({ actor: 'sable', actorRole: 'worker' })]))
      .mockResolvedValueOnce(attachmentOk('a.txt', '/state/a.txt'))
      .mockResolvedValueOnce(attachmentOk('b.txt', '/state/b.txt'))
      .mockResolvedValueOnce(messageOk());

    const code = await runAttachCommand('AGT-123', ['/local/a.txt', '/local/b.txt'], { deps });

    expect(code).toBe(0);
    const [, messageInit] = fetchMock.mock.calls[4];
    const sentBody = JSON.parse(messageInit.body as string);
    expect(sentBody.text).toContain('/state/a.txt');
    expect(sentBody.text).toContain('/state/b.txt');
  });

  it('prefers answering an open blocking question over the agent\'s later, unrelated remark', async () => {
    // The agent asks a question (seq 5, correlationId hq-1) and, while still
    // parked waiting for an answer, says something else on a different
    // exchange (seq 6, correlationId c-later) — latestAddressable() picks
    // that later remark as `target`, but the reply must still ride the
    // still-open question's correlationId, not the later one (AGT-4030's
    // exact bug: addressing the newest exchange instead leaves the agent
    // parked forever).
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const question = event({
      id: 'q', kind: 'human-question', status: 'waiting', correlationId: 'hq-1',
      actor: 'sable', actorRole: 'worker', recipient: 'human', seq: 5,
      taskId: 'uuid-1234-5678-9012', repository: '/work/cgf-portal',
    });
    const laterRemark = event({
      id: 'later', kind: 'advice-request', status: 'open', correlationId: 'c-later',
      actor: 'sable', actorRole: 'worker', seq: 6,
      taskId: 'uuid-1234-5678-9012', repository: '/work/cgf-portal',
    });
    fetchMock
      .mockResolvedValueOnce(statsOk())
      .mockResolvedValueOnce(historyOk([question, laterRemark]))
      .mockResolvedValueOnce(attachmentOk('a.txt', '/state/a.txt'))
      .mockResolvedValueOnce(messageOk());

    await runAttachCommand('AGT-123', ['/local/a.txt'], { deps });

    const [, messageInit] = fetchMock.mock.calls[3];
    const sentBody = JSON.parse(messageInit.body as string);
    expect(sentBody.correlationId).toBe('hq-1');
  });

  it('fails cleanly when no agent is addressable yet, without uploading anything', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(statsOk())
      .mockResolvedValueOnce(historyOk([]));

    const code = await runAttachCommand('AGT-123', ['/local/a.txt'], { deps });

    expect(code).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); // stats + history only — no upload attempt
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('No agent is addressable yet'));
    consoleError.mockRestore();
  });

  it('fails cleanly when the daemon is unreachable, without hanging', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const code = await runAttachCommand('AGT-123', ['/local/a.txt'], { deps });

    expect(code).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('not reachable'));
    consoleError.mockRestore();
  });

  it('surfaces the server error verbatim when an upload is rejected (413)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(statsOk())
      .mockResolvedValueOnce(historyOk([event({ actor: 'sable', actorRole: 'worker' })]))
      .mockResolvedValueOnce({ ok: false, status: 413, text: async () => JSON.stringify({ error: 'Attachment exceeds 67108864 bytes' }) });

    const code = await runAttachCommand('AGT-123', ['/local/huge.bin'], { deps });

    expect(code).toBe(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Attachment exceeds 67108864 bytes'));
    consoleError.mockRestore();
  });

  it('returns 1 when the issue identifier cannot be resolved', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(statsOk());
    const code = await runAttachCommand('AGT-999', ['/local/a.txt'], {
      deps: { ensureTaskSource: vi.fn().mockResolvedValue(undefined), getIssue: vi.fn().mockResolvedValue(null) },
    });
    expect(code).toBe(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Issue not found'));
    consoleError.mockRestore();
  });
});

// ---- Message-only ------------------------------------------------------------
// The dashboard's chat box can send a bare message, and an operator answering a
// parked question usually has nothing to upload. `attach` required a file until
// this change, so the CLI could not answer a question at all.

describe('runAttachCommand without files', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    readFileSyncMock.mockReset();
    deps.ensureTaskSource.mockClear();
    deps.getIssue.mockClear();
  });

  it('delivers a message with no upload and no attachment note', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(statsOk())
      .mockResolvedValueOnce(historyOk([event({ actor: 'sable', actorRole: 'worker', actorName: 'Sable' })]))
      .mockResolvedValueOnce(messageOk());

    const code = await runAttachCommand('AGT-123', [], { message: 'use the staging bucket', deps });

    expect(code).toBe(0);
    // Health probe, history, message — no attachment POST in between.
    expect(fetchMock.mock.calls).toHaveLength(3);
    expect(readFileSyncMock).not.toHaveBeenCalled();
    const [messageUrl, messageInit] = fetchMock.mock.calls[2];
    expect(messageUrl).toContain('/api/coordination/message');
    const sentBody = JSON.parse(messageInit.body as string);
    expect(sentBody.recipient).toBe('sable');
    expect(sentBody.text).toBe('use the staging bucket');
    expect(sentBody.text).not.toContain('Attached files');
    consoleLog.mockRestore();
  });

  it('refuses a call with neither a file nor a message before touching the daemon', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await runAttachCommand('AGT-123', [], { deps });

    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('or a message with -m'));
    consoleError.mockRestore();
  });

  it('treats a whitespace-only message as no message', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await runAttachCommand('AGT-123', [], { message: '   ', deps });

    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

// ---- Addressing one exchange -------------------------------------------------
// `openswarm board` prints a correlationId per exchange. Without a way to hand
// one back, the board advertised an address the answer command could not take
// and the reply rode whichever exchange was newest.

describe('runAttachCommand --correlation', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    readFileSyncMock.mockReset();
    deps.ensureTaskSource.mockClear();
    deps.getIssue.mockClear();
  });

  it('answers the named exchange, not the newest one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(statsOk())
      .mockResolvedValueOnce(historyOk([
        event({ id: 'q', seq: 5, correlationId: 'hq-older', actor: 'sable', actorRole: 'worker' }),
        event({ id: 'l', seq: 6, correlationId: 'c-newer', actor: 'rowan', actorRole: 'worker' }),
      ]))
      .mockResolvedValueOnce(messageOk());

    const code = await runAttachCommand('AGT-123', [], { message: 'the older one', correlationId: 'hq-older', deps });

    expect(code).toBe(0);
    const body = JSON.parse(fetchMock.mock.calls[2][1].body as string);
    expect(body.correlationId).toBe('hq-older');
    expect(body.recipient).toBe('sable');
  });

  it('refuses an unknown correlationId instead of silently answering another', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(statsOk())
      .mockResolvedValueOnce(historyOk([event({ actor: 'sable', actorRole: 'worker' })]));

    const code = await runAttachCommand('AGT-123', [], { message: 'hi', correlationId: 'hq-nope', deps });

    expect(code).toBe(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('hq-nope'));
    // No message POST — the third call never happens.
    expect(fetchMock.mock.calls).toHaveLength(2);
    consoleError.mockRestore();
  });

  it('still auto-selects the parked question when no id is given', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(statsOk())
      .mockResolvedValueOnce(historyOk([event({ seq: 5, correlationId: 'hq-1', actor: 'sable', actorRole: 'worker' })]))
      .mockResolvedValueOnce(messageOk());

    const code = await runAttachCommand('AGT-123', [], { message: 'hi', deps });

    expect(code).toBe(0);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string).correlationId).toBe('hq-1');
  });
});
