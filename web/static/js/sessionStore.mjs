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

function rankOf(phase) {
  return PHASE_RANK[phase] ?? -1;
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
      this.#upsert(entry.taskId, {
        phase: entry.status,
        issueIdentifier: entry.issueIdentifier,
        title: entry.title,
        projectPath: entry.projectPath,
        costUsd: entry.costUsd,
        durationMs: entry.durationMs,
        failureCause: entry.failureCause,
        completedAt: entry.completedAt,
      });
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

      case 'task:completed':
        this.#upsert(taskId, {
          phase: data.success ? 'completed' : 'failed',
          durationMs: data.duration,
          completedAt: data.completedAt,
        });
        break;

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
      projectPath: data.projectPath,
      worktreePath: data.worktree,
      branch: data.branch,
      model: data.model,
    };
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

  #upsert(taskId, patch, { restart = false } = {}) {
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
        // outcome cannot rewrite how a session ended. An explicit restart (see
        // task:started) is the one sanctioned exception.
        if (!reopening) {
          const blocked = TERMINAL_PHASES.has(session.phase)
            ? rankOf(value) <= rankOf(session.phase)
            : rankOf(value) < rankOf(session.phase);
          if (blocked) continue;
        }
        session.phase = value;
        continue;
      }
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
