// @vitest-environment jsdom
//
// DOM-level coverage for the cockpit views (INT-3402): the tree, the
// transcript renderer, and the session panel that binds them. These exercise
// the SAME modules main.mjs loads, so "the Sessions view actually renders" is
// verified in CI rather than by a browser spot-check.

import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — browser ESM assets without type declarations
import { SessionStore } from '../../web/static/js/sessionStore.mjs';
// @ts-expect-error — browser ESM assets without type declarations
import { TranscriptModel } from '../../web/static/js/transcriptModel.mjs';
// @ts-expect-error — browser ESM assets without type declarations
import { TranscriptView } from '../../web/static/js/transcriptView.mjs';
// @ts-expect-error — browser ESM assets without type declarations
import { SessionTree } from '../../web/static/js/sessionTree.mjs';
// @ts-expect-error — browser ESM assets without type declarations
import { SessionPanel } from '../../web/static/js/sessionPanel.mjs';
// @ts-expect-error — browser ESM assets without type declarations
import { Nav, parseHash } from '../../web/static/js/nav.mjs';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.removeAttribute('data-view');
  window.location.hash = '';
});

describe('SessionTree', () => {
  it('groups sessions under their repository with a running count', () => {
    const el = document.createElement('div');
    const store = new SessionStore();
    new SessionTree(el, { store, onSelect: () => {} });

    store.applyEvent('task:started', { taskId: 'a', title: 'Alpha', issueIdentifier: 'INT-1' });
    store.applyEvent('pipeline:stage', { taskId: 'a', stage: 'worker', status: 'start', projectPath: '/repo' });
    store.applyEvent('pipeline:stage', { taskId: 'b', stage: 'worker', status: 'start', projectPath: '/repo', issueIdentifier: 'INT-2' });
    store.applyEvent('task:completed', { taskId: 'b', success: true, duration: 10 });

    expect(el.querySelector('.tree-project')?.textContent).toContain('repo');
    expect(el.querySelector('.tree-badge')?.textContent).toBe('1'); // only 'a' runs
    const rows = [...el.querySelectorAll('.tree-session')];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r as HTMLElement).dataset.phase).sort()).toEqual(['completed', 'running']);
    expect(rows.map((r) => r.querySelector('.label')?.textContent)).toContain('INT-1');
  });

  it('renders an empty state and marks the selected row', () => {
    const el = document.createElement('div');
    const store = new SessionStore();
    const tree = new SessionTree(el, { store, onSelect: () => {} });
    tree.render();
    expect(el.querySelector('.tree-empty')).not.toBeNull();

    store.applyEvent('pipeline:stage', { taskId: 'a', stage: 'worker', status: 'start', projectPath: '/repo' });
    tree.select('a');
    expect(el.querySelector('.tree-session.selected')).not.toBeNull();
  });

  it('reports the clicked task id', () => {
    const el = document.createElement('div');
    const store = new SessionStore();
    const onSelect = vi.fn();
    new SessionTree(el, { store, onSelect });
    store.applyEvent('pipeline:stage', { taskId: 'a', stage: 'worker', status: 'start', projectPath: '/repo' });

    (el.querySelector('.tree-session') as HTMLButtonElement).click();
    expect(onSelect).toHaveBeenCalledWith('a');
  });
});

describe('TranscriptView', () => {
  it('renders stage markers, prose lines, and collapsible tool groups', () => {
    const el = document.createElement('div');
    const model = new TranscriptModel();
    const view = new TranscriptView(el, { model });

    model.append('t1', { stage: 'worker', line: '💭 planning the change' });
    model.append('t1', { stage: 'worker', line: '🔧 read_file: a.ts' });
    model.append('t1', { stage: 'worker', line: '🔧 read_file: b.ts' });
    view.show('t1');

    expect(el.querySelector('.transcript-stage')?.textContent).toBe('── worker ──');
    expect(el.querySelector('.transcript-line.thinking')?.textContent).toBe('💭 planning the change');
    const group = el.querySelector('details.activity-row')!;
    expect(group.querySelector('summary')?.textContent).toBe('read_file ×2');
    expect(group.querySelectorAll('.activity-line')).toHaveLength(2);
  });

  it('appends live lines for the shown task and ignores other tasks', () => {
    const el = document.createElement('div');
    const model = new TranscriptModel();
    const view = new TranscriptView(el, { model });
    model.append('t1', { stage: 'worker', line: 'first' });
    view.show('t1');

    model.append('t1', { stage: 'worker', line: 'second' });
    expect(el.querySelectorAll('.transcript-line')).toHaveLength(2);

    model.append('other', { stage: 'worker', line: 'not mine' });
    expect(el.querySelectorAll('.transcript-line')).toHaveLength(2);
  });

  it('shows an honest empty state rather than a blank pane', () => {
    const el = document.createElement('div');
    const view = new TranscriptView(el, { model: new TranscriptModel() });
    view.show('unknown');
    expect(el.querySelector('.empty')?.textContent).toContain('No output captured');
  });

  it('clear() detaches the current task', () => {
    const el = document.createElement('div');
    const model = new TranscriptModel();
    const view = new TranscriptView(el, { model });
    model.append('t1', { stage: 'worker', line: 'x' });
    view.show('t1');
    view.clear();
    expect(el.childElementCount).toBe(0);
    model.append('t1', { stage: 'worker', line: 'y' }); // must not re-render
    expect(el.childElementCount).toBe(0);
  });
});

describe('SessionPanel', () => {
  function mount(fetchLog = vi.fn(async () => null)) {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const store = new SessionStore();
    const transcripts = new TranscriptModel();
    const view = new TranscriptView(document.createElement('div'), { model: transcripts });
    const panel = new SessionPanel(root, { store, transcripts, transcriptView: view, fetchLog });
    return { root, store, transcripts, panel, fetchLog };
  }

  it('renders the header and usage strip from store state', async () => {
    const { root, store, panel } = mount();
    store.applyEvent('pipeline:stage', {
      taskId: 't1', stage: 'worker', status: 'start',
      issueIdentifier: 'INT-7', title: 'Fix the thing', projectPath: '/repo',
      model: 'gpt-5.5', branch: 'swarm/INT-7', worktree: '/repo/worktree/t1',
    });
    await panel.show('t1');

    expect(root.querySelector('.session-header .identifier')?.textContent).toBe('INT-7');
    expect(root.querySelector('.session-header .title')?.textContent).toBe('Fix the thing');
    expect(root.querySelector('.session-header .phase')?.textContent).toBe('Working — worker');
    const meta = root.querySelector('.session-meta')?.textContent ?? '';
    expect(meta).toContain('gpt-5.5');
    expect(meta).toContain('swarm/INT-7');
  });

  it('updates the header live as the session progresses', async () => {
    const { root, store, panel } = mount();
    store.applyEvent('pipeline:stage', { taskId: 't1', stage: 'worker', status: 'start', title: 'T', projectPath: '/repo' });
    await panel.show('t1');
    store.applyEvent('task:completed', { taskId: 't1', success: false, duration: 4_000 });

    const phase = root.querySelector('.session-header .phase') as HTMLElement;
    expect(phase.textContent).toBe('Failed');
    expect(phase.dataset.phase).toBe('failed');
    expect(root.querySelector('.session-meta')?.textContent).toContain('4s');
  });

  it('seeds transcript history from REST exactly once, replacing live lines', async () => {
    const fetchLog = vi.fn(async () => ({
      taskId: 't1',
      lines: [{ stage: 'worker', line: 'from REST' }],
      truncated: false,
    }));
    const { store, transcripts, panel } = mount(fetchLog);
    store.applyEvent('pipeline:stage', { taskId: 't1', stage: 'worker', status: 'start', title: 'T', projectPath: '/repo' });
    transcripts.append('t1', { stage: 'worker', line: 'live line' });

    await panel.show('t1');
    await flush();

    const texts = transcripts.entries('t1')
      .filter((e: { kind: string }) => e.kind === 'line')
      .map((e: { text: string }) => e.text);
    // REST replaces rather than appends — a line can never render twice.
    expect(texts).toEqual(['from REST']);

    await panel.show('t1'); // re-selection must not refetch and clobber live lines
    expect(fetchLog).toHaveBeenCalledTimes(1);
  });

  it('keeps live lines that stream in WHILE the snapshot request is in flight', async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const fetchLog = vi.fn(async () => {
      await gate;
      return {
        taskId: 't1',
        // Daemon-stamped sequence: the join key both sides share.
        lines: [
          { stage: 'worker', line: 'history 1', ts: 100, seq: 1 },
          { stage: 'worker', line: 'history 2', ts: 100, seq: 2 },
        ],
        truncated: false,
      };
    });
    const { store, transcripts, panel } = mount(fetchLog);
    store.applyEvent('pipeline:stage', { taskId: 't1', stage: 'worker', status: 'start', title: 'T', projectPath: '/repo' });

    const showing = panel.show('t1');
    // These arrive after the server took its snapshot — nothing else can
    // deliver them, so dropping them loses output permanently.
    transcripts.append('t1', { stage: 'worker', line: 'streamed during fetch', ts: 100, seq: 3 });
    transcripts.append('t1', { stage: 'worker', line: 'and another', ts: 100, seq: 4 });
    release(null);
    await showing;
    await flush();

    const texts = transcripts.entries('t1')
      .filter((e: { kind: string }) => e.kind === 'line')
      .map((e: { text: string }) => e.text);
    expect(texts).toEqual(['history 1', 'history 2', 'streamed during fetch', 'and another']);
  });

  it('drops overlapping live lines rather than duplicating when the daemon sends no sequence', async () => {
    const fetchLog = vi.fn(async () => ({
      taskId: 't1',
      lines: [{ stage: 'worker', line: 'history' }], // no seq — older daemon
      truncated: false,
    }));
    const { store, transcripts, panel } = mount(fetchLog);
    store.applyEvent('pipeline:stage', { taskId: 't1', stage: 'worker', status: 'start', title: 'T', projectPath: '/repo' });
    transcripts.append('t1', { stage: 'worker', line: 'history' }); // same line, live

    await panel.show('t1');
    await flush();

    const texts = transcripts.entries('t1')
      .filter((e: { kind: string }) => e.kind === 'line')
      .map((e: { text: string }) => e.text);
    expect(texts).toEqual(['history']); // shown once, not twice
  });

  it('survives a daemon without the transcript endpoint', async () => {
    const fetchLog = vi.fn(async () => { throw new Error('404'); });
    const { store, panel, root } = mount(fetchLog);
    store.applyEvent('pipeline:stage', { taskId: 't1', stage: 'worker', status: 'start', title: 'T', projectPath: '/repo' });
    await expect(panel.show('t1')).resolves.toBeUndefined();
    expect(root.querySelector('.session-header')).not.toBeNull();
  });

  it('showEmpty renders a message and drops the selection', () => {
    const { root, panel } = mount();
    panel.showEmpty('nothing here');
    expect(root.querySelector('.empty')?.textContent).toBe('nothing here');
    expect(panel.taskId).toBeNull();
  });
});

describe('Nav', () => {
  it('switches body[data-view], marks the active button, and emits the change', () => {
    const sessionsBtn = document.createElement('button');
    sessionsBtn.dataset.view = 'sessions';
    const issuesBtn = document.createElement('button');
    issuesBtn.dataset.view = 'issues';
    document.body.append(sessionsBtn, issuesBtn);

    const nav = new Nav({ buttons: [sessionsBtn, issuesBtn] });
    const seen: Array<{ view: string; taskId: string | null }> = [];
    nav.addEventListener('change', (e: Event) => seen.push((e as CustomEvent).detail));

    nav.start();
    expect(document.body.dataset.view).toBe('issues'); // default

    nav.show('sessions', 'task-1');
    expect(parseHash(window.location.hash)).toEqual({ view: 'sessions', taskId: 'task-1' });
    expect(document.body.dataset.view).toBe('sessions');
    expect(sessionsBtn.classList.contains('active')).toBe(true);
    expect(issuesBtn.getAttribute('aria-current')).toBe('false');
    expect(seen.at(-1)).toEqual({ view: 'sessions', taskId: 'task-1' });
  });

  it('survives a malformed escape in the hash instead of killing the bootstrap', () => {
    // decodeURIComponent throws on '%' / '%zz'; parseHash runs during startup.
    expect(parseHash('#/sessions/%')).toEqual({ view: 'sessions', taskId: '%' });
    expect(parseHash('#/sessions/%zz')).toEqual({ view: 'sessions', taskId: '%zz' });

    window.location.hash = '#/sessions/%';
    const nav = new Nav({ buttons: [] });
    expect(() => nav.start()).not.toThrow();
    expect(document.body.dataset.view).toBe('sessions');
  });

  it('re-emits when asked to show the hash it is already on', () => {
    const nav = new Nav({ buttons: [] });
    nav.show('sessions', 'x');
    let emitted = 0;
    nav.addEventListener('change', () => emitted++);
    nav.show('sessions', 'x');
    expect(emitted).toBe(1);
  });
});
