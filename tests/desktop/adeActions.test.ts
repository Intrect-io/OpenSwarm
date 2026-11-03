// ADE run actions (desktop/dist/ade/actions.js). The confirmation dialog and the
// daemon token live in the shell (desktop/src/ade_actions.rs, Rust-tested);
// this covers what the page asks for and how it reports each outcome.

import { describe, expect, it, vi } from 'vitest';
// Plain JS module shipped as-is in the app bundle (tests/ is not typechecked).
import { availableActions, performAction } from '../../desktop/dist/ade/actions.js';

const running = { taskId: 'INT-1', status: 'running', live: true, projectPath: '/home/u/dev/repo' };
const failed = { taskId: 'INT-2', status: 'failed', live: false, projectPath: '/home/u/dev/repo' };

describe('ADE actions', () => {
  it('offers stop while live, retry when failed or parked, and the PR when there is one', () => {
    expect(availableActions(running, { state: 'EXECUTING' }).map((a: { id: string }) => a.id)).toEqual(['stop']);
    expect(availableActions(failed, null).map((a: { id: string }) => a.id)).toEqual(['retry']);
    expect(availableActions({ ...failed, status: 'completed' }, { state: 'NEEDS_HUMAN', prUrl: 'https://github.com/o/r/pull/3' })
      .map((a: { id: string }) => a.id)).toEqual(['retry', 'openPr']);
    // Done and approved: nothing to stop or retry.
    expect(availableActions({ ...failed, status: 'completed' }, { state: 'DONE' })).toEqual([]);
    // Retry needs the project; a link must be http(s).
    expect(availableActions({ ...failed, projectPath: '' }, null)).toEqual([]);
    expect(availableActions(running, { state: 'EXECUTING', prUrl: 'javascript:alert(1)' }).map((a: { id: string }) => a.id)).toEqual(['stop']);
    expect(availableActions(undefined, null)).toEqual([]);
  });

  it('confirm flow: the page names the action; the shell confirms, and a decline sends nothing', async () => {
    const invoke = vi.fn(async () => ({ status: 'cancelled', detail: 'Nothing was sent.' }));
    const result = await performAction(invoke, { id: 'stop', label: 'Stop' }, running);

    // Only the action and the task travel — no path, method, body or token.
    expect(invoke).toHaveBeenCalledWith('ade_action', { action: 'stop', taskId: 'INT-1', projectPath: null });
    expect(result).toEqual({ kind: 'cancelled', message: 'Cancelled — nothing was sent.' });
  });

  it('confirm flow: an accepted retry reports what the daemon did', async () => {
    const invoke = vi.fn(async () => ({ status: 'done', detail: 'INT-2 dispatched again.' }));
    const result = await performAction(invoke, { id: 'retry', label: 'Retry' }, failed);

    expect(invoke).toHaveBeenCalledWith('ade_action', { action: 'retry', taskId: 'INT-2', projectPath: '/home/u/dev/repo' });
    expect(result).toEqual({ kind: 'done', message: 'INT-2 dispatched again.' });
  });

  it('shows the daemon or shell refusal as the error, without throwing', async () => {
    const refused = vi.fn(async () => { throw 'daemon answered 403: the daemon refused the token'; });
    expect(await performAction(refused, { id: 'stop', label: 'Stop' }, running))
      .toEqual({ kind: 'error', message: 'daemon answered 403: the daemon refused the token' });

    const noToken = vi.fn(async () => { throw new Error('no daemon token: set "web_token" in the desktop config.json (mode 0600)'); });
    expect((await performAction(noToken, { id: 'retry', label: 'Retry' }, failed)).message).toContain('mode 0600');

    expect(await performAction(vi.fn(), { id: 'kill', label: 'Kill' }, running)).toEqual({ kind: 'error', message: 'Unknown action: kill' });
  });

  it('opens the PR through the shell, and only a web link', async () => {
    const invoke = vi.fn(async () => undefined);
    expect(await performAction(invoke, { id: 'openPr', label: 'Open', url: 'https://github.com/o/r/pull/3' }, failed))
      .toEqual({ kind: 'done', message: '' });
    expect(invoke).toHaveBeenCalledWith('open_url', { url: 'https://github.com/o/r/pull/3' });

    invoke.mockClear();
    expect((await performAction(invoke, { id: 'openPr', label: 'Open', url: 'file:///etc/passwd' }, failed)).kind).toBe('error');
    expect(invoke).not.toHaveBeenCalled();
  });
});
