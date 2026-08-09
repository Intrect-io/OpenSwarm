// @vitest-environment jsdom
//
// Worktree diff rendering (INT-3402): the parser is pure, and the panel's
// states — loading, empty, clean, unavailable, error — must each say what is
// actually true rather than defaulting to "no changes".

import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error — browser ESM asset without type declarations
import { DiffPanel, parseUnifiedDiff, summarizeFiles } from '../../web/static/js/diffPanel.mjs';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' const unchanged = 1;',
  '-const removed = 2;',
  '+const added = 3;',
  '',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('classifies file headers, hunks, metadata, and +/- lines', () => {
    const rows = parseUnifiedDiff(DIFF);
    expect(rows.map((r: { type: string }) => r.type)).toEqual([
      'file', 'file', 'meta', 'meta', 'hunk', 'context', 'del', 'add',
    ]);
    expect(rows.at(-1).text).toBe('+const added = 3;');
  });

  it('does not mistake --- / +++ headers for removed/added lines', () => {
    const rows = parseUnifiedDiff('--- a/x\n+++ b/x');
    expect(rows.map((r: { type: string }) => r.type)).toEqual(['meta', 'meta']);
  });

  it('handles empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff(undefined)).toEqual([]);
  });
});

describe('summarizeFiles', () => {
  it('totals the per-file counts and pluralizes', () => {
    expect(summarizeFiles([{ file: 'a', added: 40, deleted: 5 }, { file: 'b', added: 2, deleted: 2 }]))
      .toBe('2 files · +42 −7');
    expect(summarizeFiles([{ file: 'a', added: 1, deleted: 0 }])).toBe('1 file · +1 −0');
    expect(summarizeFiles([])).toBe('No file changes');
  });
});

describe('DiffPanel', () => {
  const mount = (fetchDiff: () => Promise<unknown>) => {
    const el = document.createElement('div');
    return { el, panel: new DiffPanel(el, { fetchDiff }) };
  };

  it('renders the summary, file list, and colored diff rows', async () => {
    const { el, panel } = mount(async () => ({
      taskId: 't1',
      worktreePath: '/repo/worktree/t1',
      branch: 'swarm/INT-1',
      files: [{ file: 'src/a.ts', added: 1, deleted: 1, isNew: false }],
      diff: DIFF,
      truncated: false,
    }));
    await panel.load('t1');

    expect(el.querySelector('.diff-summary')?.textContent).toBe('1 file · +1 −1 · swarm/INT-1');
    expect(el.querySelector('.diff-file')?.textContent).toContain('src/a.ts');
    expect(el.querySelectorAll('.diff-line.add')).toHaveLength(1);
    expect(el.querySelectorAll('.diff-line.del')).toHaveLength(1);
  });

  it('flags truncation and new files', async () => {
    const { el, panel } = mount(async () => ({
      files: [{ file: 'new.ts', added: 9, deleted: 0, isNew: true }],
      diff: DIFF,
      truncated: true,
    }));
    await panel.load('t1');
    expect(el.querySelector('.diff-summary')?.textContent).toContain('truncated');
    expect(el.querySelector('.diff-file')?.textContent).toContain('new new.ts');
  });

  it('says the tree is clean rather than showing nothing', async () => {
    const { el, panel } = mount(async () => ({ files: [], diff: '', truncated: false }));
    await panel.load('t1');
    expect(el.querySelector('.empty')?.textContent).toBe('Working tree is clean.');
  });

  it('distinguishes "files but no patch text" from a clean tree', async () => {
    const { el, panel } = mount(async () => ({
      files: [{ file: 'image.png', added: 0, deleted: 0, isNew: true }],
      diff: '',
    }));
    await panel.load('t1');
    expect(el.querySelector('.empty')?.textContent).toBe('No patch text for these changes.');
  });

  it('reports an unavailable endpoint instead of an empty diff', async () => {
    const { el, panel } = mount(async () => null); // api.workDiff maps 404 → null
    await panel.load('t1');
    expect(el.querySelector('.empty')?.textContent).toContain('does not expose worktree diffs');
  });

  it('surfaces a git failure verbatim rather than claiming no changes', async () => {
    const { el, panel } = mount(async () => {
      throw new Error('Worktree for task t1 is no longer a valid git repository');
    });
    await panel.load('t1');
    expect(el.querySelector('.empty')?.textContent).toContain('no longer a valid git repository');
  });

  it('does not let a stale FAILED request overwrite a newer render of the same task', async () => {
    let failFirst: (reason: unknown) => void = () => {};
    let call = 0;
    const fetchDiff = vi.fn(() => {
      call += 1;
      return call === 1
        ? new Promise((_, reject) => { failFirst = reject; })
        : Promise.resolve({ files: [{ file: 'fresh.ts', added: 2, deleted: 0 }], diff: DIFF });
    });
    const { el, panel } = mount(fetchDiff as unknown as () => Promise<unknown>);

    const stale = panel.load('t1');
    await panel.load('t1'); // same task, re-opened — supersedes the first
    failFirst(new Error('stale failure'));
    await stale;

    expect(el.querySelector('.diff-file')?.textContent).toContain('fresh.ts');
    expect(el.querySelector('.empty')).toBeNull();
  });

  it('does not paint after clear()', async () => {
    let release: (value: unknown) => void = () => {};
    const fetchDiff = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const { el, panel } = mount(fetchDiff as unknown as () => Promise<unknown>);

    const pending = panel.load('t1');
    panel.clear();
    release({ files: [{ file: 'late.ts', added: 1, deleted: 0 }], diff: DIFF });
    await pending;

    expect(el.childElementCount).toBe(0);
  });

  it('ignores a response for a task the user already navigated away from', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    const fetchDiff = vi.fn((taskId: string) =>
      taskId === 'slow'
        ? new Promise((resolve) => { resolveFirst = resolve; })
        : Promise.resolve({ files: [{ file: 'fast.ts', added: 1, deleted: 0 }], diff: DIFF }),
    );
    const { el, panel } = mount(fetchDiff as unknown as () => Promise<unknown>);

    const slow = panel.load('slow');
    await panel.load('fast');
    resolveFirst({ files: [{ file: 'stale.ts', added: 99, deleted: 0 }], diff: DIFF });
    await slow;

    expect(el.querySelector('.diff-file')?.textContent).toContain('fast.ts');
  });
});
