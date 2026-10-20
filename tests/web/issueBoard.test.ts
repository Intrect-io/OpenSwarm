// @vitest-environment jsdom
//
// Cockpit first run (redesign step 9): a daemon without Linear works from the
// local tracker, and Cockpit's issue list used to answer that with a bare
// "Linear is not configured on this daemon". It now explains where the local
// issues live.
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { IssueBoard } from '../../web/static/js/issueBoard.mjs';

function mount(fetchIssues: (path: string) => Promise<unknown>) {
  document.body.innerHTML = `
    <span id="count"></span><div id="list"><div class="empty">Select a repository to load its issues.</div></div>
    <span id="summary"></span><button id="deploy"></button>`;
  const board = new IssueBoard({
    listEl: document.getElementById('list'),
    countEl: document.getElementById('count'),
    summaryEl: document.getElementById('summary'),
    deployBtn: document.getElementById('deploy'),
    fetchIssues,
    dispatch: vi.fn(),
  });
  return { board, list: document.getElementById('list')! };
}

function linearMissing() {
  return Object.assign(new Error('Linear is not configured on this daemon'), { status: 503 });
}

describe('issue board on a local-tracker daemon', () => {
  it('explains the local tracker up front instead of asking for a repository', () => {
    const { board, list } = mount(vi.fn());
    board.setTracker('local');
    expect(list.querySelector('.tracker-help strong')!.textContent).toMatch(/local tracker/);
    expect(list.querySelector<HTMLAnchorElement>('.tracker-help a')!.getAttribute('href')).toBe('/issues');
    expect(list.textContent).toContain('LINEAR_API_KEY');
  });

  it('keeps the repository prompt when the daemon works from Linear', () => {
    const { board, list } = mount(vi.fn());
    board.setTracker('linear');
    expect(list.querySelector('.tracker-help')).toBeNull();
    expect(list.textContent).toContain('Select a repository');
  });

  it('turns the 503 into the same explanation rather than the raw error', async () => {
    const { board, list } = mount(vi.fn(async () => { throw linearMissing(); }));
    await board.loadFor('/repo');
    expect(list.querySelector('.tracker-help')).not.toBeNull();
    expect(list.textContent).not.toContain('Linear is not configured on this daemon');
  });

  it('still shows other failures as they are', async () => {
    const { board, list } = mount(vi.fn(async () => {
      throw Object.assign(new Error('Repository not found'), { status: 404 });
    }));
    await board.loadFor('/repo');
    expect(list.querySelector('.tracker-help')).toBeNull();
    expect(list.textContent).toBe('Repository not found');
  });
});
