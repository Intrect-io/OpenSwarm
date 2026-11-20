// ============================================
// OpenSwarm - `now` pause fence for a claimed run (AGT-4808)
// ============================================
//
// `openswarm pause --now` cancels in-flight runs. The daemon cancels its own
// through the scheduler, but a run claimed by another process (`openswarm
// work`) would keep renewing its lease and publish. The coordinator's lease
// renewal asks this fence on every tick; when a `now` pause blocks the run's
// repository it aborts the executor, and the cancelled result lands in
// RETRY_AT (`factory_paused`) instead of a tracker cancel, so the issue keeps
// its state and resumes after `openswarm unpause`.

import type { FactoryPause } from './factoryPause.js';
import { normalizeProjectPath } from '../orchestration/taskScheduler.js';

export class PauseNowFence {
  /** Set once the fence has aborted this run because of a `now` pause. */
  tripped = false;
  private readonly scope: string;

  constructor(
    private readonly ledger: { getBlockingPause(normalizedProjectPath: string): FactoryPause | undefined },
    projectPath: string,
  ) {
    this.scope = normalizeProjectPath(projectPath);
  }

  /** True exactly once: the first tick a `now` pause blocks this repository. Never throws. */
  check(): boolean {
    if (this.tripped) return false;
    try {
      this.tripped = this.ledger.getBlockingPause(this.scope)?.mode === 'now';
    } catch {
      // An unreadable table is not proof of a pause; claim checks fail closed elsewhere.
      return false;
    }
    return this.tripped;
  }
}
