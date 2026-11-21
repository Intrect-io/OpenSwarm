// ============================================
// OpenSwarm - Linear active-issue delta cursor (AGT-4607)
// ============================================
//
// The heartbeat fetched every active issue on every cycle ("[Linear] Fetching
// issues for all:true"), even when nothing had changed for days. This cursor
// keeps the last full result per fetch key and, on later cycles, asks Linear
// only for issues with `updatedAt > cursor`, merging them into the cached set:
//
// - The delta query carries no state filter, so an issue that left the active
//   states (Done, Canceled, ...) comes back with its new state and is evicted.
//   Its other filters (team, agent label, milestone) stay, so an issue that
//   lost the label or milestone is not seen by the delta; the periodic full
//   refresh catches it, along with archived/deleted issues.
// - Full refresh: on the first fetch for a key, every `fullRefreshMs`
//   (default 30 min), and every `fullRefreshEveryCycles` deltas (default 12).
// - The cursor is the fetch START time minus `overlapMs` (default 5 min), so
//   clock skew and writes racing the previous fetch are re-read, never lost.
//   Re-reading an issue is harmless: merges are upserts by id.
// - Fail-safe: any delta error drops the cursor and falls through to a full
//   fetch in the same cycle. A delta is applied to a copy and swapped in only
//   once complete, so a failure never leaves a half-merged set.

export interface DeltaIssueNode {
  id: string;
  state?: { name?: string } | null;
}

export interface IssueDeltaCursorOptions {
  fullRefreshMs?: number;
  fullRefreshEveryCycles?: number;
  overlapMs?: number;
  maxKeys?: number;
  now?: () => number;
  log?: (line: string) => void;
}

interface CursorEntry<N> {
  groupsSignature: string;
  cursorAt: number;
  lastFullAt: number;
  deltaCycles: number;
  nodes: Map<string, { node: N; group: number }>;
}

export class IssueDeltaCursor<N extends DeltaIssueNode> {
  private readonly entries = new Map<string, CursorEntry<N>>();
  private readonly fullRefreshMs: number;
  private readonly fullRefreshEveryCycles: number;
  private readonly overlapMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(options: IssueDeltaCursorOptions = {}) {
    this.fullRefreshMs = options.fullRefreshMs ?? 30 * 60_000;
    this.fullRefreshEveryCycles = options.fullRefreshEveryCycles ?? 12;
    this.overlapMs = options.overlapMs ?? 5 * 60_000;
    this.maxKeys = options.maxKeys ?? 20;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(line));
  }

  /** Forget every cursor (new client / credential / team, or tests). */
  reset(): void {
    this.entries.clear();
  }

  /**
   * Fetch issues for each state group, by delta when a fresh cursor exists.
   * `fetchGroup(states)` is the full per-group query; `fetchChanged(sinceIso)`
   * returns issues of ANY state updated after `sinceIso` under the same
   * non-state filters. Results come back in `groups` order.
   */
  async fetchGroups(
    key: string,
    groups: string[][],
    fetchGroup: (states: string[]) => Promise<{ nodes: N[] }>,
    fetchChanged: (sinceIso: string) => Promise<{ nodes: N[] }>,
  ): Promise<Array<{ nodes: N[] }>> {
    const startedAt = this.now();
    const groupsSignature = JSON.stringify(groups);
    const entry = this.entries.get(key);
    if (
      entry
      && entry.groupsSignature === groupsSignature
      && startedAt - entry.lastFullAt < this.fullRefreshMs
      && entry.deltaCycles < this.fullRefreshEveryCycles
    ) {
      try {
        const since = new Date(entry.cursorAt).toISOString();
        const changed = await fetchChanged(since);
        const next = new Map(entry.nodes);
        for (const node of changed.nodes) {
          const group = groups.findIndex((states) => states.includes(node.state?.name ?? ''));
          if (group < 0) next.delete(node.id);
          else next.set(node.id, { node, group });
        }
        this.store(key, { ...entry, nodes: next, cursorAt: startedAt - this.overlapMs, deltaCycles: entry.deltaCycles + 1 });
        this.log(`[Linear] Delta fetch for ${key}: ${changed.nodes.length} issue(s) updated since ${since}`);
        return splitGroups(next, groups.length);
      } catch (error) {
        this.log(`[Linear] Delta fetch for ${key} failed, falling back to a full fetch: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.entries.delete(key);
    const results = await Promise.all(groups.map((states) => fetchGroup(states)));
    const nodes = new Map<string, { node: N; group: number }>();
    results.forEach((result, group) => {
      for (const node of result.nodes) nodes.set(node.id, { node, group });
    });
    this.store(key, { groupsSignature, cursorAt: startedAt - this.overlapMs, lastFullAt: startedAt, deltaCycles: 0, nodes });
    return results;
  }

  private store(key: string, entry: CursorEntry<N>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxKeys) this.entries.delete(this.entries.keys().next().value!);
  }
}

function splitGroups<N>(nodes: Map<string, { node: N; group: number }>, count: number): Array<{ nodes: N[] }> {
  const out = Array.from({ length: count }, () => ({ nodes: [] as N[] }));
  for (const { node, group } of nodes.values()) out[group].nodes.push(node);
  return out;
}
