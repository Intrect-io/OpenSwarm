// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser modules
import { startProjectWorkspace } from '../../web/static/js/projectWorkspace.mjs';
// @ts-expect-error browser modules
import { boundedGraph, ProjectDrafts, draftKey, mergeEntries } from '../../web/static/js/projectWorkspaceModel.mjs';
// @ts-expect-error browser modules
import { createProjectFixture, demoProjectFetch } from '../../web/static/js/projectFixtures.mjs';

const handles: any[] = [];
const shell = (mode = 'chat') => {
  const html = readFileSync(resolve(`web/static/${mode}.html`), 'utf8');
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  return document;
};
const response = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data });
const deferred = () => { let done: (v: any) => void = () => {}; const promise = new Promise((r) => { done = r; }); return { promise, done }; };
const settle = () => new Promise((r) => setTimeout(r, 0));
beforeEach(() => { sessionStorage.clear(); vi.spyOn(document, 'hasFocus').mockReturnValue(false); });
afterEach(() => { handles.splice(0).forEach((h) => h?.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); window.history.replaceState({}, '', '/'); });
const start = async (fetchImpl: any, mode = 'chat', more = {}) => {
  const h = await startProjectWorkspace(shell(mode), { fetchImpl, pollMs: 0, events: false, ...more }); handles.push(h); return h;
};

describe('project collaboration workspace', () => {
  it('uses the real SSE transport across reconnect without replaying or replacing channel contents', async () => {
    vi.useFakeTimers();
    const sources: any[] = [];
    vi.stubGlobal('EventSource', class {
      close = vi.fn(); onopen: any; onmessage: any; onerror: any;
      constructor(public url: string) { sources.push(this); }
    });
    const h = await start(demoProjectFetch(createProjectFixture()), 'chat', { events: true });
    await h.selectProject('demo:000'); const ids = h.state.entries.map((e: any) => e.sourceId);
    sources[0].onmessage({ data: 'invalid JSON' }); sources[0].onmessage({ data: '{"type":"unrelated"}' });
    sources[0].onmessage({ data: '{"type":"coordination:channel","data":{"repoKey":"demo:000"}}' });
    expect(h.state.newActivity).toBe(true); expect(h.state.entries.map((e: any) => e.sourceId)).toEqual(ids);
    sources[0].onerror(); expect(sources[0].close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); expect(sources[1].url).toBe('/api/events?skipReplay=1');
    sources[1].onopen(); expect(h.state.repo).toBe('demo:000');
    h.dispose(); sources[1].onerror(); await vi.advanceTimersByTimeAsync(30000);
    expect(sources).toHaveLength(2);
  });
  it('labels URL-selected demo data and disables writes without using the supplied live fetcher', async () => {
    window.history.replaceState({}, '', '/chat?demo=offline'); const live = vi.fn();
    const h = await start(live); await h.selectProject('demo:000');
    expect(live).not.toHaveBeenCalled(); expect(document.querySelector('#workspace-demo')!.textContent).toContain('Demo data · read only');
    expect((document.querySelector('#workspace-message') as HTMLTextAreaElement).disabled).toBe(true);
    expect((document.querySelector('#workspace-send') as HTMLButtonElement).disabled).toBe(true);
    (document.querySelector('#workspace-compose') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    expect(live).not.toHaveBeenCalled();
  });
  it('paginates the Needs-you inbox and opens a parked project beyond the first channel page', async () => {
    const fixture = createProjectFixture('stress');
    fixture.needs = Array.from({ length: 60 }, (_, i) => ({ id: `park-${i}`, repoKey: 'demo:075', taskId: 'task-2', taskLabel: 'PARKED-75', kind: 'parked' }));
    const h = await start(demoProjectFetch(fixture));
    (document.querySelector('#workspace-needs') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.state.needs).toHaveLength(50));
    (document.querySelector('#needs-more') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.state.needs).toHaveLength(60));
    await h.openNeed('park-59'); expect(h.state.repo).toBe('demo:075'); expect(h.state.projects).toHaveLength(100);
    expect(document.querySelector('#thread-content a')!.getAttribute('href')).toBe('/app');
    expect((document.querySelector('#workspace-recipient') as HTMLSelectElement).disabled).toBe(true);
    (document.querySelector('#workspace-needs') as HTMLButtonElement).click();
    await settle(); (document.querySelector('#needs-close') as HTMLButtonElement).click();
    expect((document.querySelector('#needs-inbox') as HTMLElement).hidden).toBe(true);
  });
  it('reports invalid/project/detail/discussion responses and recovers explicitly without losing a draft', async () => {
    const original = demoProjectFetch(createProjectFixture()); let failure = 'invalid';
    const h = await start(async (path: string, opts: any) => {
      if (failure === 'invalid') return { ok: false, status: 502, json: async () => { throw new Error('not JSON'); } };
      if (failure === 'project' && path.includes('/entries')) return response({ error: 'Storage unavailable' }, 503);
      if (failure === 'task' && path.includes('/tasks/')) return response({ error: 'Session unavailable' }, 503);
      if (failure === 'thread' && path.includes('/threads/')) return response({ error: 'Discussion unavailable' }, 503);
      return original(path, opts);
    });
    expect(document.querySelector('#workspace-notice')!.textContent).toContain('Invalid server response (502)');
    failure = 'project'; await h.refresh(); await h.selectProject('demo:000');
    expect(document.querySelector('#workspace-notice')!.textContent).toContain('Storage unavailable');
    const input = document.querySelector('#workspace-message') as HTMLTextAreaElement;
    input.value = 'Keep this channel draft'; input.dispatchEvent(new Event('input'));
    failure = ''; (document.querySelector('#workspace-refresh') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.state.entries).toHaveLength(12)); expect(input.value).toBe('Keep this channel draft');
    failure = 'task'; await h.selectTask('task-1'); expect(document.querySelector('#workspace-notice')!.textContent).toContain('Task details unavailable');
    failure = 'thread'; await h.selectThread('topic-0'); expect(document.querySelector('#workspace-notice')!.textContent).toContain('Discussion unavailable');
    failure = ''; await h.selectProject('demo:009');
    expect((document.querySelector('#workspace-message') as HTMLTextAreaElement).disabled).toBe(true);
    expect(document.querySelector('#compose-result')!.textContent).toContain('Archived channel');
  });
  it('retains exact question scope when history fails and never advances a failed read write', async () => {
    const fixture = createProjectFixture('questions'); const original = demoProjectFetch(fixture);
    const h = await start(async (path: string, opts: any) => {
      if (path.includes('correlationId=')) return response({ error: 'History offline' }, 503);
      if (path.endsWith('/read')) return response({ error: 'Read store offline' }, 503);
      return original(path, opts);
    });
    await h.selectProject('demo:000');
    (document.querySelector('[data-question]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('#workspace-status')!.textContent).toContain('Question history unavailable'));
    expect(h.state.need.correlationId).toBe('corr-0-0');
    expect((document.querySelector('#workspace-recipient') as HTMLSelectElement).value).toBe('agent-0');
    vi.mocked(document.hasFocus).mockReturnValue(true);
    document.querySelector('#channel-entries')!.dispatchEvent(new Event('scroll'));
    await vi.waitFor(() => expect(document.querySelector('#workspace-status')!.textContent).toContain('Read position not saved'));
    expect(h.state.projects[0].readSeq).toBe(5); expect(h.state.projects[0].unread).toBe(4);
  });
  it('drives project → task → exact recipient and mobile back without leaking task scope', async () => {
    const fixture = createProjectFixture(); const original = demoProjectFetch(fixture); const sent: any[] = [];
    const fetcher = async (path: string, opts: any) => {
      if (path.endsWith('/messages')) { sent.push(JSON.parse(opts.body)); return response({ delivery: { status: 'queued', recipient: 'agent-3' } }, 202); }
      return original(path, opts);
    };
    const h = await start(fetcher, 'orchestration');
    (document.querySelector('[data-project="demo:000"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.state.tasks).toHaveLength(2));
    (document.querySelector('[data-task="task-1"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('#task-graph svg')).not.toBeNull());
    expect(document.querySelectorAll('#task-graph circle')).toHaveLength(10);
    expect(document.querySelectorAll('#task-graph line')).toHaveLength(9);
    const recipient = document.querySelector('#workspace-recipient') as HTMLSelectElement;
    expect([...recipient.options].map((o) => o.value)).toEqual(['', 'agent-0', 'agent-3', 'agent-6', 'agent-9']);
    recipient.value = 'agent-3'; recipient.dispatchEvent(new Event('change'));
    const input = document.querySelector('#workspace-message') as HTMLTextAreaElement;
    input.value = 'For the reviewer on this task'; input.dispatchEvent(new Event('input'));
    (document.querySelector('#workspace-compose') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ repoKey: 'demo:000', taskId: 'task-1', recipient: 'agent-3', body: 'For the reviewer on this task' });
    await vi.waitFor(() => expect(input.value).toBe(''));
    (document.querySelector('#workspace-back') as HTMLButtonElement).click();
    expect(h.state.task).toBeNull(); expect(document.querySelector('#compose-scope')!.textContent).toContain('Project coordinator');
    (document.querySelector('#compose-toggle') as HTMLButtonElement).click();
    expect(document.querySelector('#compose-toggle')!.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(input);
    (document.querySelector('#workspace-back') as HTMLButtonElement).click();
    expect(h.state.repo).toBeNull(); expect(document.querySelector('[data-project-workspace]')!.getAttribute('data-level')).toBe('projects');
  });
  it('pages task inventory and prevents routing a reply to a queued task with no active recipient', async () => {
    const fixture = createProjectFixture(); const original = demoProjectFetch(fixture);
    const fetcher = async (path: string, opts: any) => {
      const url = new URL(path, 'http://test');
      if (url.pathname.endsWith('/tasks')) return response({ items: fixture.tasks.filter((t: any) => t.repoKey === 'demo:000').slice(url.searchParams.has('cursor') ? 1 : 0, url.searchParams.has('cursor') ? 2 : 1), nextCursor: url.searchParams.has('cursor') ? undefined : 'next-task' });
      return original(path, opts);
    };
    const h = await start(fetcher, 'orchestration'); await h.selectProject('demo:000');
    (document.querySelector('#task-load-more') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.state.tasks).toHaveLength(2)); await h.selectTask('task-2');
    expect(document.querySelector('#workspace-recipient')!.textContent).toContain('No active recipient');
    expect(document.querySelector('#compose-result')!.textContent).toContain('Choose an active recipient');
    const input = document.querySelector('#workspace-message') as HTMLTextAreaElement;
    input.value = 'A task without a running worker'; input.dispatchEvent(new Event('input'));
    expect((document.querySelector('#workspace-send') as HTMLButtonElement).disabled).toBe(true);
  });
  it('searches and pages complete participants and connections independently of the graph', async () => {
    const fixture = createProjectFixture(); const original = demoProjectFetch(fixture); const calls: string[] = [];
    const fetcher = async (path: string, opts: any) => {
      const url = new URL(path, 'http://test');
      if (url.pathname.endsWith('/tasks/task-1')) {
        calls.push(path); const detail = await (await original(path, opts)).json();
        if (url.searchParams.get('part') === 'connections') return response({ items: [{ source: 'later', target: 'connection', count: 1 }], scope: { limit: 50 } });
        const none = url.searchParams.get('search') === 'missing';
        return response({ ...detail, relationTotals: { participants: 10, connections: 9 },
          participants: { items: none ? [] : detail.participants.items.slice(url.searchParams.has('cursor') ? 5 : 0, url.searchParams.has('cursor') ? 10 : 5), nextCursor: !none && !url.searchParams.has('cursor') ? 'participants-next' : undefined },
          relationships: { items: none ? [] : detail.relationships.items.slice(0, 1), nextCursor: none ? undefined : 'connections-next' } });
      }
      return original(path, opts);
    };
    const h = await start(fetcher, 'orchestration'); await h.selectProject('demo:000'); await h.selectTask('task-1');
    const selected = h.state.detail.participants.items[0].id;
    (document.querySelector('[data-node]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-node][aria-pressed="true"]')).not.toBeNull());
    expect(h.state.selectedNode).toBe(selected);
    (document.querySelector('#participant-more') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('#participant-more')).toBeNull());
    expect(calls.some((p) => p.includes('cursor=participants-next'))).toBe(true);
    (document.querySelector('#connection-more') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('#connection-list')!.textContent).toContain('later'));
    expect(calls.some((p) => p.includes('part=connections') && p.includes('cursor=connections-next'))).toBe(true);
    const search = document.querySelector('#participant-search') as HTMLInputElement; search.value = 'missing';
    (document.querySelector('#participant-search-form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('.participant-list')!.textContent).toContain('No matching participants'));
    expect(document.querySelector('#connection-list')!.textContent).toContain('No connections recorded');
    expect(document.querySelectorAll('#task-graph circle')).toHaveLength(10);
  });
  it('opens the canonical discussion, pages its messages, and keeps the multi-task Threads link', async () => {
    const fixture = createProjectFixture(); const original = demoProjectFetch(fixture);
    const fetcher = async (path: string, opts: any) => {
      const result = await original(path, opts);
      if (!path.includes('/threads/')) return result;
      const data = await result.json(); const later = path.includes('messageAfterSeq=2');
      return response({ ...data, messages: { items: data.messages.items.slice(later ? 2 : 0, later ? 4 : 2), nextCursor: later ? undefined : 2 } });
    };
    const h = await start(fetcher); await h.selectProject('demo:000');
    (document.querySelector('[data-thread]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.state.threadData?.messages.items).toHaveLength(2));
    expect(document.querySelector('#thread-content a')!.getAttribute('href')).toBe('/threads?repository=demo%3A000&threadId=topic-0');
    expect(document.querySelector('#thread-content')!.textContent).toContain('2 related tasks');
    (document.querySelector('#thread-more') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.state.threadData.messages.items).toHaveLength(4));
    expect(document.querySelector('#thread-more')).toBeNull();
    (document.querySelector('#workspace-back') as HTMLButtonElement).click(); expect(h.state.thread).toBeNull();
  });
  it('pages old channel history without losing the current reading position and returns to latest explicitly', async () => {
    const h = await start(demoProjectFetch(createProjectFixture('busy'))); await h.selectProject('demo:000');
    const list = document.querySelector('#channel-entries')!;
    Object.defineProperty(list, 'scrollHeight', { get: () => list.querySelectorAll('article').length * 40 }); list.scrollTop = 100;
    expect(h.state.entries[0].seq).toBe(101);
    (document.querySelector('#channel-older') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.state.entries).toHaveLength(100));
    expect(h.state.entries[0].seq).toBe(51); expect(list.scrollTop).toBe(2100);
    (document.querySelector('#channel-older') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.state.entries).toHaveLength(150));
    expect(new Set(h.state.entries.map((e: any) => e.sourceId)).size).toBe(150);
    (document.querySelector('#channel-latest') as HTMLButtonElement).click(); expect(list.scrollTop).toBe(6000);
  });
  it('retries an interrupted delivery in its channel and safely folds technical details', async () => {
    const fixture = createProjectFixture(); const entries = fixture.entries.get('demo:000'); const first = entries[0];
    first.body = '<img src=x onerror=alert(1)> 한글'; first.detail = 'تفاصيل'; first.delivery = { id: 'delivery-1', status: 'interrupted' };
    entries[1].kind = 'adapter-route'; const original = demoProjectFetch(fixture); const retries: string[] = [];
    const h = await start(async (path: string, opts: any) => {
      if (path.includes('/deliveries/')) { retries.push(path); first.delivery.status = 'queued'; return response({ delivery: first.delivery }, 202); }
      return original(path, opts);
    });
    await h.selectProject('demo:000');
    expect(document.querySelector('#channel-entries img')).toBeNull(); expect(document.querySelector('#channel-entries')!.textContent).toContain('<img');
    expect(document.querySelector('.activity-detail')!.textContent).toContain('Tool activity');
    (document.querySelector('[data-retry]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-retry]')).toBeNull());
    expect(retries).toEqual(['/api/coordination/channels/demo%3A000/deliveries/delivery-1/retry']);
    expect(document.querySelector('#channel-entries')!.textContent).toContain('Saved · queued');
  });
  it('syncs reads beyond the first project page and preserves drafts across a failed reconnect poll', async () => {
    const fixture = createProjectFixture('stress'); const original = demoProjectFetch(fixture); let tick: any; let offline = false;
    vi.spyOn(window, 'setInterval').mockImplementation((callback: any) => { tick = callback; return 123; });
    const h = await start(async (path: string, opts: any) => {
      if (offline) return response({ error: 'Disconnected' }, 503);
      if (path.endsWith('/read')) return response({ readSeq: 12, unread: 0, latestSeq: 12 });
      return original(path, opts);
    }, 'chat', { pollMs: 1000 });
    (document.querySelector('#project-load-more') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.state.projects).toHaveLength(100)); await h.selectProject('demo:075');
    const input = document.querySelector('#workspace-message') as HTMLTextAreaElement;
    input.value = 'Preserved across reconnect'; input.dispatchEvent(new Event('input'));
    await tick(); expect(h.state.projects.find((p: any) => p.repoKey === 'demo:075').readSeq).toBe(12);
    expect(document.querySelector('[data-unread="demo:075"]')!.textContent).toBe('0 unread');
    offline = true; await tick(); expect(document.querySelector('#workspace-status')!.textContent).toContain('Connection unavailable');
    expect(input.value).toBe('Preserved across reconnect'); expect(h.state.repo).toBe('demo:075');
  });
  it('does not attach a delayed Needs-you selection to a different project chosen while it loads', async () => {
    const fixture = createProjectFixture('questions'); const original = demoProjectFetch(fixture); const slow = deferred();
    const fetcher = async (path: string, opts: any) => path.includes('/demo%3A001/entries') ? slow.promise : original(path, opts);
    const h = await start(fetcher);
    (document.querySelector('#workspace-needs') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.state.needs.length).toBe(30));
    const opening = h.openNeed('question-1-0'); await settle();
    await h.selectProject('demo:002');
    slow.done(response({ items: fixture.entries.get('demo:001'), scope: { throughSeq: 12 } })); await opening;
    expect(h.state.repo).toBe('demo:002'); expect(h.state.need).toBeNull(); expect(h.state.task).toBeNull();
    expect(document.querySelector('#compose-scope')!.textContent).toBe('NeuralSound / Channel / To: Project coordinator');
  });
  it('starts with the project table and names measured scopes, without a fleet-wide graph', async () => {
    const fixture = createProjectFixture('stress'); const h = await start(demoProjectFetch(fixture), 'orchestration');
    expect(document.querySelectorAll('#project-list tr')).toHaveLength(50);
    expect(document.querySelector('#workspace-totals')!.textContent).toContain('1000 recent participants · 30m');
    expect(document.querySelector('#task-graph')).toBeNull(); expect(h.state.repo).toBeNull();
    (document.querySelector('#project-load-more') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelectorAll('#project-list tr')).toHaveLength(100));
  });
  it('shows unavailable sources rather than deriving running state from recent utterances', async () => {
    await start(demoProjectFetch(createProjectFixture('offline')), 'orchestration');
    expect(document.querySelector('#project-list')!.textContent).toContain('Unavailable');
    expect(document.querySelector('#workspace-notice')!.textContent).toContain('Partial data');
  });
  it('keeps text drafts per project/thread and preserves a late request in its original channel', async () => {
    const fixture = createProjectFixture(); const original = demoProjectFetch(fixture); const slow = deferred();
    const fetcher = vi.fn(async (path, opts) => path.includes('/demo%3A000/entries') ? slow.promise : original(path, opts));
    const h = await start(fetcher);
    const first = h.selectProject('demo:000'); await settle();
    await h.selectProject('demo:001');
    slow.done(response({ items: fixture.entries.get('demo:000'), scope: { throughSeq: 12 }, partial: false })); await first;
    expect(h.state.repo).toBe('demo:001'); expect(h.state.entries.every((e: any) => e.repoKey === 'demo:001')).toBe(true);
    const input = document.querySelector('#workspace-message') as HTMLTextAreaElement;
    input.value = 'Draft for project two'; input.dispatchEvent(new Event('input'));
    await h.selectProject('demo:000'); expect(input.value).toBe('');
    await h.selectProject('demo:001'); expect(input.value).toBe('Draft for project two');
    expect(new ProjectDrafts(sessionStorage).get({ repoKey: 'demo:001' }).text).toBe('Draft for project two');
  });
  it('does not move selection or scroll on duplicate/reconnected/out-of-order SSE notifications', async () => {
    const callbacks = new Map(); const stream = { on: vi.fn((n, f) => { callbacks.set(n, f); return stream; }), connect: vi.fn(), close: vi.fn() };
    const h = await start(demoProjectFetch(createProjectFixture()), 'chat', { events: true, eventStream: stream });
    await h.selectProject('demo:000'); const entries = document.querySelector('#channel-entries')!; entries.scrollTop = 35;
    const ids = h.state.entries.map((e: any) => e.sourceId);
    callbacks.get('coordination:event')({ seq: 100 }); callbacks.get('coordination:event')({ seq: 100 }); callbacks.get('$open')({}); callbacks.get('coordination:event')({ seq: 90 });
    expect(h.state.entries.map((e: any) => e.sourceId)).toEqual(ids); expect(entries.scrollTop).toBe(35);
    expect(h.state.repo).toBe('demo:000'); expect(document.querySelector('#workspace-refresh')!.textContent).toContain('New activity');
  });
  it('opens the exact project/task/question and keeps unread separate from Needs you', async () => {
    const h = await start(demoProjectFetch(createProjectFixture('questions')));
    (document.querySelector('#workspace-needs') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(h.state.needs.length).toBe(30));
    await h.openNeed('question-1-2');
    expect(h.state.repo).toBe('demo:001'); expect(h.state.need.correlationId).toBe('corr-1-2');
    expect(document.querySelector('#compose-scope')!.textContent).toContain('DEMO-2');
    expect((document.querySelector('#workspace-recipient') as HTMLSelectElement).value).toBe('agent-0');
    expect(document.querySelector('#thread-content')!.textContent).toContain('هل نعتمد');
    expect(document.querySelector('[data-project="demo:001"]')!.textContent).toContain('1 unread');
  });
  it('keeps a pending send and its late response from replacing a different project draft', async () => {
    const fixture = createProjectFixture(); const original = demoProjectFetch(fixture); const slow = deferred();
    const requests: any[] = [];
    const fetcher = async (path: string, opts: any) => {
      if (path.endsWith('/messages') && opts?.method === 'POST') { requests.push({ path, body: JSON.parse(opts.body) }); return slow.promise; }
      return original(path, opts);
    };
    const h = await start(fetcher); await h.selectProject('demo:000');
    const input = document.querySelector('#workspace-message') as HTMLTextAreaElement; input.value = 'Message for zero'; input.dispatchEvent(new Event('input'));
    (document.querySelector('#workspace-compose') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true })); await settle();
    expect(requests[0].body).toMatchObject({ repoKey: 'demo:000', body: 'Message for zero' });
    await h.selectProject('demo:001'); input.value = 'Untouched new draft'; input.dispatchEvent(new Event('input'));
    slow.done(response({ delivery: { status: 'queued' }, coordinatorAvailable: false }, 202)); await settle();
    expect(h.state.repo).toBe('demo:001'); expect(input.value).toBe('Untouched new draft');
    expect(h.drafts.get({ repoKey: 'demo:000' }).text).toBe('');
    expect(document.querySelector('#compose-result')!.textContent).not.toContain('coordinator unavailable');
  });
  it('retains the same idempotency key and uploaded body after response loss and 429', async () => {
    const fixture = createProjectFixture(); const original = demoProjectFetch(fixture); const payloads: any[] = []; let uploads = 0;
    const fetcher = async (path: string, opts: any) => {
      if (path.includes('/attachment')) { uploads++; return response({ filename: 'proof.txt', path: '/isolated/proof.txt' }, 201); }
      if (path.endsWith('/messages') && opts?.method === 'POST') {
        payloads.push(JSON.parse(opts.body)); if (payloads.length === 1) throw new Error('Response lost');
        if (payloads.length === 2) return response({ error: 'Rate limited' }, 429);
        return response({ delivery: { status: 'queued' }, coordinatorAvailable: false }, 202);
      }
      return original(path, opts);
    };
    const h = await start(fetcher); await h.selectProject('demo:000');
    const input = document.querySelector('#workspace-message') as HTMLTextAreaElement; input.value = 'Inspect attached proof'; input.dispatchEvent(new Event('input'));
    h.drafts.get({ repoKey: 'demo:000' }).files = [new File(['real proof'], 'proof.txt')];
    const submit = () => (document.querySelector('#workspace-compose') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    submit(); await vi.waitFor(() => expect(document.querySelector('#compose-result')!.textContent).toContain('Response lost'));
    submit(); await vi.waitFor(() => expect(document.querySelector('#compose-result')!.textContent).toContain('Wait and send again'));
    submit(); await vi.waitFor(() => expect(input.value).toBe(''));
    expect(uploads).toBe(1); expect(payloads).toHaveLength(3); expect(payloads[1]).toEqual(payloads[0]); expect(payloads[2]).toEqual(payloads[0]);
  });
  it('preserves attachment selections in memory per scope and never serializes file bytes', async () => {
    const fixture = createProjectFixture(); const h = await start(demoProjectFetch(fixture)); await h.selectProject('demo:000');
    const file = new File(['private contents'], 'context.txt'); h.drafts.get({ repoKey: 'demo:000' }).files = [file];
    h.drafts.save({ repoKey: 'demo:000' }, 'Text only'); await h.selectProject('demo:001'); await h.selectProject('demo:000');
    expect(h.drafts.get({ repoKey: 'demo:000' }).files[0]).toBe(file); expect(document.querySelector('#compose-files')!.textContent).toContain('context.txt');
    expect(JSON.stringify(sessionStorage)).not.toContain('private contents');
  });
  it('does not mark a channel read in the background or while reading older history', async () => {
    const fixture = createProjectFixture(); const original = demoProjectFetch(fixture); const reads: any[] = [];
    const fetcher = async (path: string, opts: any) => { if (path.endsWith('/read')) { reads.push(JSON.parse(opts.body)); return response({ readSeq: 12 }); } return original(path, opts); };
    const h = await start(fetcher); await h.selectProject('demo:000'); expect(reads).toHaveLength(0);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    const list = document.querySelector('#channel-entries')!;
    Object.defineProperty(list, 'scrollHeight', { value: 2000 }); Object.defineProperty(list, 'clientHeight', { value: 400 }); list.scrollTop = 500;
    list.dispatchEvent(new Event('scroll')); await settle(); expect(reads).toHaveLength(0);
    list.scrollTop = 1600; list.dispatchEvent(new Event('scroll')); await vi.waitFor(() => expect(reads).toHaveLength(1));
    expect(reads[0]).toEqual({ throughSeq: 12 });
  });
  it('bounds graph nodes and edges while retaining selection; full totals stay separate', () => {
    const nodes = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
    const edges = Array.from({ length: 100 }, (_, i) => ({ source: String(i % 19), target: String((i + 1) % 19) }));
    const graph = boundedGraph(nodes, edges, '999'); expect(graph.nodes).toHaveLength(20); expect(graph.edges).toHaveLength(40);
    expect(graph.nodes[0].id).toBe('999'); expect(graph.omittedNodes).toBe(980); expect(graph.omittedEdges).toBe(60);
    expect(nodes).toHaveLength(1000);
  });
  it('deduplicates entries by original source identity and orders out-of-order pages', () => {
    const item = (seq: number, repoKey = 'p') => ({ repoKey, sourceKind: 'trace', sourceId: String(seq), seq });
    expect(mergeEntries([item(5), item(1)], [item(5), item(3), item(3, 'other')])).toHaveLength(4);
    expect(mergeEntries([item(5)], [item(1), item(3)]).map((e: any) => e.seq)).toEqual([1, 3, 5]);
    expect(draftKey({ repoKey: 'p', taskId: 'same', recipient: 'sable' })).not.toBe(draftKey({ repoKey: 'other', taskId: 'same', recipient: 'sable' }));
  });
});
