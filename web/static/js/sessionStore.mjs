// Cockpit session state, folded from the daemon's SSE events. (INT-3402)
//
// Adapted from vega-agent's session_runtime.mjs: same EventTarget shape and
// phase vocabulary, but this store does NOT own a stream — it fans in events
// from many tasks, so vega's per-stream `generation` guard is replaced by a
// PHASE RANK guard. Applying any event is idempotent and order-tolerant, which
// is what makes the SSE replay buffer safe to re-apply on reconnect.
//
// DOM-free on purpose: this is the testable core the views render from.

/** Terminal phases share the top rank — a session never leaves one. */
const PHASE_RANK = {
  queued: 0,
  running: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
  decomposed: 2,
};

export const TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled', 'decomposed']);

/**
 * The ONLY terminal→terminal move history may make. A decomposition reports
 * `success: true`, so the live event can only say "completed" — history knows
 * it was really a split. Everything else is a genuine outcome disagreement,
 * where the newer live event wins (e.g. an older completed run in history must
 * not overwrite a fresh attempt's failure).
 */
function refinesTerminal(from, to) {
  return from === 'completed' && to === 'decomposed';
}

function rankOf(phase) {
  return PHASE_RANK[phase] ?? -1;
}

/**
 * Repository root for a path that may be a worktree. Stage events report the
 * ACTIVE directory (`{repo}/worktree/{issueId}` in worktree mode), so using it
 * as the repository would scatter one repo's sessions across a tree node per
 * task. Same layout the daemon creates.
 */
export function repoRootFromPath(path) {
  if (typeof path !== 'string' || !path) return path;
  return path.replace(/\/worktree\/[^/]+\/?$/, '');
}

export class SessionStore extends EventTarget {
  #sessions = new Map(); // taskId -> session record

  /** All known sessions, most recently updated first. */
  list() {
    return [...this.#sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(taskId) {
    return this.#sessions.get(taskId) ?? null;
  }

  byProject(projectPath) {
    return this.list().filter((session) => session.projectPath === projectPath);
  }

  /**
   * Seed from GET /api/work/sessions. Merges rather than replaces: live events
   * that arrived before the snapshot resolved must not be rolled back.
   */
  seed(payload) {
    for (const entry of payload?.sessions ?? []) {
      this.#upsert(entry.taskId, {
        phase: entry.status === 'queued' ? 'queued' : 'running',
        issueIdentifier: entry.issueIdentifier,
        title: entry.title,
        projectPath: entry.projectPath,
        worktreePath: entry.worktreePath,
        branch: entry.branch,
        currentStage: entry.stage,
        model: entry.model,
        startedAt: entry.startedAt,
      });
    }
    for (const entry of payload?.recent ?? []) {
      // History describes a run that already ENDED, so it may refine one
      // terminal phase into a more specific one ('completed' → 'decomposed'),
      // which the equal-rank guard would otherwise block. It must not, though,
      // overwrite metadata a newer attempt has already reported live.
      this.#upsert(
        entry.taskId,
        {
          phase: entry.status,
          issueIdentifier: entry.issueIdentifier,
          title: entry.title,
          projectPath: entry.projectPath,
          costUsd: entry.costUsd,
          durationMs: entry.durationMs,
          failureCause: entry.failureCause,
          completedAt: entry.completedAt,
        },
        { refineTerminal: true, fillOnly: true },
      );
    }
  }

  /**
   * Apply one hub event. Unknown types are ignored, so new daemon events never
   * break an older page.
   */
  applyEvent(type, data) {
    if (!data || typeof data.taskId !== 'string' || !data.taskId) return;
    const taskId = data.taskId;

    switch (type) {
      case 'task:queued':
        this.#upsert(taskId, {
          phase: 'queued',
          title: data.title,
          projectPath: data.projectPath,
          issueIdentifier: data.issueIdentifier,
        });
        break;

      case 'task:started':
        // The one event that may re-open a finished session: the daemon
        // retries a failed issue under the SAME task id, and without this a
        // retried session would stay "failed" in the cockpit while an agent is
        // demonstrably working on it. Stage events deliberately do NOT get
        // this power — a replayed stage would resurrect finished work.
        this.#upsert(
          taskId,
          {
            phase: 'running',
            title: data.title,
            issueIdentifier: data.issueIdentifier,
            startedAt: data.startedAt,
          },
          { restart: true },
        );
        break;

      case 'pipeline:stage':
        this.#applyStage(taskId, data);
        break;

      case 'pipeline:iteration':
        this.#upsert(taskId, { iteration: data.iteration });
        break;

      case 'pipeline:escalation':
        this.#upsert(taskId, { model: data.toModel });
        break;

      case 'task:completed': {
        const session = this.#sessions.get(taskId);
        // A reviewer stage failure on the way to success must not linger in
        // the metadata strip next to a green result.
        if (data.success && session) session.error = undefined;
        this.#upsert(taskId, {
          phase: data.success ? 'completed' : 'failed',
          durationMs: data.duration,
          completedAt: data.completedAt,
        });
        break;
      }

      case 'task:cost':
        this.#upsert(taskId, {
          costUsd: data.cost?.costUsd,
          inputTokens: data.cost?.inputTokens,
          outputTokens: data.cost?.outputTokens,
        });
        break;

      // 'log' belongs to the transcript model; process:* drives the status bar.
      // Neither participates in session phase.
      default:
        break;
    }
  }

  #applyStage(taskId, data) {
    const patch = {
      // A stage event proves the task is executing even if task:started was
      // evicted from the replay window.
      phase: 'running',
      currentStage: data.stage,
      issueIdentifier: data.issueIdentifier,
      title: data.title,
      // `worktree` is a short NAME (the issue id), not a path — labelling only.
      worktreeName: data.worktree,
      branch: data.branch,
      model: data.model,
    };
    // The stage's projectPath is the active directory, which in worktree mode
    // IS the worktree. Derive the repository for grouping, and only fill the
    // full worktree path when the authoritative seed has not supplied one.
    if (data.projectPath) {
      patch.projectPath = repoRootFromPath(data.projectPath);
      if (data.projectPath !== patch.projectPath) patch.worktreePath = data.projectPath;
    }
    if (data.status === 'fail') {
      // A failed STAGE is not a failed TASK: the pipeline routinely fails a
      // reviewer stage and iterates to success. Only task:completed decides the
      // session's outcome — treating a stage failure as terminal both lied
      // mid-run and let a replayed stage overwrite a finished session's
      // result. Keep the error for display.
      patch.error = data.error;
    }
    const session = this.#upsert(taskId, patch);
    if (!session) return;

    // Stages fold into a map keyed by stage name, so replaying is idempotent.
    const previous = session.stages.get(data.stage);
    session.stages.set(data.stage, {
      stage: data.stage,
      status: data.status,
      durationMs: data.durationMs ?? previous?.durationMs,
      costUsd: data.costUsd ?? previous?.costUsd,
      summary: data.summary ?? previous?.summary,
      decision: data.decision ?? previous?.decision,
      filesChanged: data.filesChanged ?? previous?.filesChanged,
      error: data.error ?? previous?.error,
    });
  }

  #upsert(taskId, patch, { restart = false, refineTerminal = false, fillOnly = false } = {}) {
    let session = this.#sessions.get(taskId);
    const isNew = !session;
    if (!session) {
      session = {
        taskId,
        phase: 'queued',
        title: '',
        stages: new Map(),
        updatedAt: 0,
      };
      this.#sessions.set(taskId, session);
    }

    // A retry is a NEW attempt on the same id: drop the previous attempt's
    // outcome so the panel does not show last run's error next to live work.
    const reopening = restart && !isNew && TERMINAL_PHASES.has(session.phase);
    if (reopening) {
      session.stages = new Map();
      session.error = undefined;
      session.failureCause = undefined;
      session.completedAt = undefined;
      session.durationMs = undefined;
    }

    const previousPhase = session.phase;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null || value === '') continue;
      if (key === 'phase') {
        // Rank guard: a replayed 'started' must not resurrect a finished
        // session, and a late 'queued' must not un-run a running one. Terminal
        // is also final against ANOTHER terminal — equal rank — so a replayed
        // outcome cannot rewrite how a session ended. Two sanctioned
        // exceptions: an explicit restart (task:started), and the daemon's
        // own history refining one terminal into a more specific one.
        if (!reopening) {
          const terminal = TERMINAL_PHASES.has(session.phase);
          const blocked = terminal
            ? !(refineTerminal && refinesTerminal(session.phase, value)) && rankOf(value) <= rankOf(session.phase)
            : rankOf(value) < rankOf(session.phase);
          if (blocked) continue;
        }
        session.phase = value;
        continue;
      }
      // A history seed fills gaps; it never overwrites what a newer attempt
      // already reported live.
      if (fillOnly && session[key] !== undefined && session[key] !== '') continue;
      session[key] = value;
    }
    session.updatedAt = Date.now();

    if (isNew) this.#emit('session:new', session);
    if (session.phase !== previousPhase) {
      this.#emit('session:phase', session, { previousPhase });
    }
    this.#emit('change', session);
    return session;
  }

  #emit(type, session, extra = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail: { session, ...extra } }));
  }
}
