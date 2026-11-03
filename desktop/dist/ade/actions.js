// OpenSwarm ADE workspace — run actions (stop, retry, open PR).
//
// The page only names an action. The shell (`ade_action`, desktop/src/ade_actions.rs)
// asks for a native confirmation, attaches the daemon token the page never
// sees, and builds the request itself. `invoke` is injected so the flow is
// unit-tested (tests/desktop/adeActions.test.ts).

import { safeExternalUrl } from './model.js';

const RETRYABLE_RUN_STATES = new Set(['NEEDS_HUMAN', 'NEEDS_SPEC', 'NEEDS_ENV', 'RETRY_AT', 'WAITING_EXTERNAL', 'CANCELLED', 'READY']);

/**
 * Which actions a run offers right now.
 * - stop: it is running or queued;
 * - retry: it is not live and either failed or parked, and we know its project;
 * - openPr: its durable record carries an http(s) PR link.
 */
export function availableActions(row, run) {
  if (!row) return [];
  const actions = [];
  if (row.live) actions.push({ id: 'stop', label: 'Stop' });
  const parked = run && RETRYABLE_RUN_STATES.has(run.state);
  if (!row.live && row.projectPath && (row.status === 'failed' || parked)) actions.push({ id: 'retry', label: 'Retry' });
  const pr = safeExternalUrl(run?.prUrl);
  if (pr) actions.push({ id: 'openPr', label: 'Open pull request', url: pr });
  return actions;
}

/**
 * Run one action. Resolves to `{ kind, message }`: `done` (refresh the run),
 * `cancelled` (the person declined the dialog), or `error` (the daemon's or
 * the shell's reason, shown as is). Never throws.
 */
export async function performAction(invoke, action, row) {
  try {
    if (action.id === 'openPr') {
      const url = safeExternalUrl(action.url);
      if (!url) return { kind: 'error', message: 'Not a web link.' };
      await invoke('open_url', { url });
      return { kind: 'done', message: '' };
    }
    if (action.id !== 'stop' && action.id !== 'retry') return { kind: 'error', message: `Unknown action: ${action.id}` };
    const outcome = await invoke('ade_action', {
      action: action.id,
      taskId: row.taskId,
      projectPath: action.id === 'retry' ? row.projectPath : null,
    });
    if (outcome?.status === 'cancelled') return { kind: 'cancelled', message: 'Cancelled — nothing was sent.' };
    return { kind: 'done', message: outcome?.detail ?? 'Done.' };
  } catch (error) {
    return { kind: 'error', message: String(error?.message ?? error) };
  }
}
