// What the Sessions view should show, given the URL and what is known. (INT-3402)
//
// Pure so the decision is testable: the tricky part is that the hash is read
// at startup while the authoritative session list arrives asynchronously, so
// the same question gets asked again later with more knowledge.

export const EMPTY_MESSAGE = 'Deploy issues to start a session. Live agent output appears here.';

/**
 * @returns {{ taskId: string } | { message: string }}
 *   taskId → show that session; message → show this placeholder instead.
 */
export function resolveSelection({ hashTaskId, sessions, snapshotLoaded = false }) {
  if (hashTaskId) {
    if (sessions.some((session) => session.taskId === hashTaskId)) return { taskId: hashTaskId };
    // Before the snapshot lands, an unknown id is simply not-known-YET — the
    // deep link is probably valid and reconciling later will find it. Claiming
    // it does not exist would be a guess presented as fact.
    return snapshotLoaded
      ? { message: `Session ${hashTaskId} is not in this daemon's recent history.` }
      : { message: 'Loading session…' };
  }
  const first = sessions[0];
  return first ? { taskId: first.taskId } : { message: EMPTY_MESSAGE };
}
