// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { renderThreadDetail, renderThreadList, renderThreadMessageBody, startThreadBoard } from '../../web/static/js/threadBoard.mjs';

function shell(): Document {
  document.body.innerHTML = `
    <select id="repo"><option value="">Select repository</option></select>
    <div id="status"></div>
    <select id="thread-status"><option value="open">open</option><option value="resolved">resolved</option><option value="">all</option></select>
    <button id="refresh"></button>
    <div id="threads"></div>
    <form id="new-thread">
      <input name="taskId" /><input name="subject" /><textarea name="body"></textarea>
      <input name="relatedTaskIds" /><input name="relatedFiles" /><button type="submit">create</button>
    </form>
    <div id="empty"></div><section id="detail">
      <h2 id="detail-subject"></h2><div id="detail-meta"></div><button id="follow"></button><button id="resolve"></button>
      <div id="messages"></div>
      <form id="reply-form"><textarea name="body"></textarea><button type="submit">reply</button></form>
    </section>`;
  return document;
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  window.history.replaceState({}, '', '/threads');
});

describe('repository thread board', () => {
  it('renders agent-controlled text without HTML injection', () => {
    const doc = shell();
    const thread = {
      id: 't1', subject: '<img src=x onerror=alert(1)>', status: 'open', relatedTaskIds: ['AGT-1'],
      relatedFiles: [], updatedAt: 1, messageCount: 1, participantCount: 1, version: 2,
    };
    renderThreadList(doc, doc.getElementById('threads')!, [thread], null, () => {});
    renderThreadDetail(doc, {
      thread,
      participants: [{ actor: '<script>alert(2)</script>', taskId: 'task-a' }],
      messages: { items: [{
        actor: 'worker', taskId: 'task-a', body: '<svg onload=alert(3)>', createdAt: 1,
      }] },
    });
    expect(doc.getElementById('threads')!.textContent).toContain('<img');
    expect(doc.getElementById('messages')!.textContent).toContain('<svg');
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('svg')).toBeNull();
    expect(doc.querySelector('script')).toBeNull();
  });

  it('renders fenced code with safe syntax tokens', () => {
    const doc = shell();
    const holder = doc.createElement('div');
    renderThreadMessageBody(doc, holder, 'Use `src/a.ts`.\n```ts\nconst answer = 42; // safe\n```\n<img src=x>');
    expect(holder.querySelector('pre code')).not.toBeNull();
    expect(holder.querySelector('.token-keyword')?.textContent).toBe('const');
    expect(holder.querySelector('.token-number')?.textContent).toBe('42');
    expect(holder.querySelector('.inline-code')?.textContent).toBe('src/a.ts');
    expect(holder.querySelector('img')).toBeNull();
    expect(holder.textContent).toContain('<img src=x>');
  });

  it('loads every repository thread before a repository is selected', async () => {
    const doc = shell();
    const thread = {
      id: 'thread-all', repository: 'git:0123456789abcdef0123456789abcdef', subject: 'Shared decision',
      status: 'open', relatedTaskIds: [], relatedFiles: [], messageCount: 1, participantCount: 1, updatedAt: 1,
    };
    const fetchImpl = vi.fn(async (path: string) => {
      if (path === '/api/work/projects') return response([]);
      if (path.startsWith('/api/coordination/threads?')) return response({ items: [thread] });
      if (path.startsWith('/api/coordination/threads/thread-all?')) {
        return response({ thread, participants: [], messages: { items: [] } });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const view = startThreadBoard(doc, { fetchImpl, pollMs: 0 });
    await vi.waitFor(() => expect(doc.querySelector('[data-thread-id="thread-all"]')).not.toBeNull());
    expect(fetchImpl).toHaveBeenCalledWith('/api/coordination/threads?limit=200&status=open', expect.any(Object));
    (doc.querySelector('[data-thread-id="thread-all"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(doc.getElementById('detail-subject')?.textContent).toBe('Shared decision'));
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('repository=git%3A0123456789abcdef0123456789abcdef'), expect.any(Object));
    view.stop();
  });

  it('drives create, follow, reply, read, and CAS resolve through the HTTP contract', async () => {
    const doc = shell();
    let thread = {
      id: 'thread-1', repository: '/repo', subject: 'Integration order', status: 'open', version: 2,
      relatedTaskIds: ['AGT-1'], relatedFiles: ['src/a.ts'], relatedPullRequests: [],
      createdByActor: 'worker-a', createdByTaskId: 'task-a', createdAt: 1, updatedAt: 1,
      messageCount: 1, participantCount: 1,
    };
    let participants: Array<Record<string, unknown>> = [
      { actor: 'worker-a', actorName: 'Worker A', actorRole: 'worker', taskId: 'task-a' },
    ];
    let messages: Array<Record<string, unknown>> = [
      { id: 'm1', actor: 'worker-a', actorName: 'Worker A', actorRole: 'worker', taskId: 'task-a', body: 'Foundation first.', createdAt: 1 },
    ];
    const calls: Array<{ path: string; method: string; body?: any }> = [];
    const fetchImpl = vi.fn(async (path: string, options: Record<string, any> = {}) => {
      const method = options.method ?? 'GET';
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, method, body });
      if (path === '/api/work/projects') return response({ projects: [{ name: 'OpenSwarm', path: '/repo' }] });
      if (path.startsWith('/api/coordination/threads?')) return response({ items: [thread] });
      if (path.startsWith('/api/coordination/threads/thread-1?')) {
        return response({ thread, participants, messages: { items: messages } });
      }
      if (path.endsWith('/follow')) {
        participants = [...participants, { actor: 'operator-dashboard', actorName: 'Operator', taskId: 'operator' }];
        thread = { ...thread, version: thread.version + 1, participantCount: participants.length };
        return response({ following: true, participants });
      }
      if (path.endsWith('/read')) return response({ lastReadSeq: messages.length });
      if (path.endsWith('/messages')) {
        messages = [...messages, { id: 'm2', actor: 'operator-dashboard', taskId: 'operator', body: body.body, createdAt: 2 }];
        thread = { ...thread, version: thread.version + 1, messageCount: messages.length };
        return response({ message: messages.at(-1) }, 201);
      }
      if (path.endsWith('/resolve')) {
        expect(body.expectedVersion).toBe(thread.version);
        thread = { ...thread, version: thread.version + 1, status: 'resolved' };
        return response({ thread });
      }
      if (path === '/api/coordination/threads' && method === 'POST') {
        return response({ thread: { ...thread, id: 'thread-2', subject: body.subject } }, 201);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    });

    const view = startThreadBoard(doc, { fetchImpl, pollMs: 0 });
    await vi.waitFor(() => expect((doc.getElementById('repo') as HTMLSelectElement).options).toHaveLength(2));
    const repo = doc.getElementById('repo') as HTMLSelectElement;
    repo.value = '/repo';
    repo.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(doc.querySelector('[data-thread-id="thread-1"]')).not.toBeNull());
    (doc.querySelector('[data-thread-id="thread-1"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(doc.getElementById('detail-subject')!.textContent).toBe('Integration order'));

    (doc.getElementById('follow') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(doc.getElementById('follow')!.textContent).toBe('following'));
    expect(calls.some((call) => call.path.endsWith('/read'))).toBe(true);

    (doc.querySelector('#reply-form textarea') as HTMLTextAreaElement).value = 'Proceed after foundation.';
    doc.getElementById('reply-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(doc.getElementById('messages')!.textContent).toContain('Proceed after foundation.'));

    (doc.getElementById('resolve') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(thread.status).toBe('resolved'));
    expect(calls.findLast((call) => call.path.endsWith('/resolve'))?.body.expectedVersion).toBe(4);

    (doc.querySelector('#new-thread [name="taskId"]') as HTMLInputElement).value = 'AGT-2';
    (doc.querySelector('#new-thread [name="subject"]') as HTMLInputElement).value = 'New decision';
    doc.getElementById('new-thread')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(calls.some((call) => call.path === '/api/coordination/threads' && call.method === 'POST')).toBe(true));
    view.stop();
  });

  it('asks in the page before resolving when the shell offers a confirm card (AGT-4201 §3.2)', async () => {
    const doc = shell();
    doc.getElementById('detail')!.insertAdjacentHTML('beforeend', `
      <div id="resolve-confirm" hidden>
        <p id="resolve-confirm-text"></p>
        <button id="resolve-cancel" type="button"></button>
        <button id="resolve-confirm-btn" type="button"></button>
      </div>`);
    const thread = {
      id: 'thread-1', repository: '/repo', subject: 'Cut the release', status: 'open', version: 7,
      relatedTaskIds: [], relatedFiles: [], messageCount: 0, participantCount: 0, updatedAt: 1,
    };
    const resolves: unknown[] = [];
    const fetchImpl = vi.fn(async (path: string, options: Record<string, any> = {}) => {
      if (path === '/api/work/projects') return response([]);
      if (path.startsWith('/api/coordination/threads?')) return response({ items: [thread] });
      if (path.startsWith('/api/coordination/threads/thread-1?')) return response({ thread, participants: [], messages: { items: [] } });
      if (path.endsWith('/resolve')) { resolves.push(JSON.parse(options.body)); return response({ thread: { ...thread, status: 'resolved' } }); }
      throw new Error(`Unexpected request: ${path}`);
    });
    const view = startThreadBoard(doc, { fetchImpl, pollMs: 0 });
    await vi.waitFor(() => expect(doc.querySelector('[data-thread-id="thread-1"]')).not.toBeNull());
    (doc.querySelector('[data-thread-id="thread-1"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(doc.getElementById('detail-subject')!.textContent).toBe('Cut the release'));

    const card = doc.getElementById('resolve-confirm') as HTMLDivElement;
    (doc.getElementById('resolve') as HTMLButtonElement).click();
    expect(card.hidden).toBe(false);
    expect(doc.getElementById('resolve-confirm-text')!.textContent).toContain('“Cut the release”');
    expect(doc.getElementById('resolve-confirm-text')!.textContent).toContain('version 7');
    expect(resolves).toHaveLength(0);

    (doc.getElementById('resolve-cancel') as HTMLButtonElement).click();
    expect(card.hidden).toBe(true);
    expect(resolves).toHaveLength(0);

    (doc.getElementById('resolve') as HTMLButtonElement).click();
    (doc.getElementById('resolve-confirm-btn') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(resolves).toHaveLength(1));
    expect(resolves[0]).toMatchObject({ expectedVersion: 7 });
    expect(card.hidden).toBe(true);
    view.stop();
  });
});
