// Bounded holding area for log lines whose work card does not exist yet.
// (INT-3397)
//
// After a reload, the SSE replay and the /api/stages snapshot race, and a
// task's stage events can fall out of both windows while its recent log lines
// survive — so an unknown-task line cannot simply be dropped. It cannot create
// a card either (the hub broadcasts every task the daemon runs, not just ones
// this user deployed). Parking is the middle ground: lines wait here, bounded,
// until the task's card materializes.
//
// DOM-free on purpose: this is the unit-testable half of the console recovery
// path, and the seed of the session cockpit's transcript model.

export class PendingLogBuffer {
  #queues = new Map(); // taskId -> [{stage, line}] in arrival order
  #maxTasks;
  #maxLines;

  constructor({ maxTasks = 20, maxLines = 100 } = {}) {
    this.#maxTasks = maxTasks;
    this.#maxLines = maxLines;
  }

  /** Park one line for a task that has no card yet. */
  park(taskId, entry) {
    let queue = this.#queues.get(taskId);
    if (!queue) {
      if (this.#queues.size >= this.#maxTasks) {
        // Map iteration order is insertion order — evict the oldest task, so
        // daemon work that never materializes a card cannot grow memory.
        const oldest = this.#queues.keys().next().value;
        this.#queues.delete(oldest);
      }
      queue = [];
      this.#queues.set(taskId, queue);
    }
    queue.push(entry);
    if (queue.length > this.#maxLines) queue.shift();
  }

  /**
   * Remove and return the parked lines for a task (empty array when none).
   * Moving — not copying — is what guarantees a flushed line can never be
   * delivered twice.
   */
  takeFor(taskId) {
    const queue = this.#queues.get(taskId);
    if (!queue) return [];
    this.#queues.delete(taskId);
    return queue;
  }

  get taskCount() {
    return this.#queues.size;
  }
}
