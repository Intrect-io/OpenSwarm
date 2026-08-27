// ============================================
// OpenSwarm - Orchestration graph model (pure)
// ============================================
//
// Coordination events → the graph the orchestration view draws. Pure and
// stateless so the aggregation is unit-testable: nodes are the identities that
// appeared on the board, edges are directed interactions between them,
// aggregated per pair with a per-kind histogram.

/** Terminal statuses fold an exchange out of the pending set. */
const PENDING_STATUSES = new Set(['open', 'waiting', 'running']);

/** Well-known infrastructure identities that are not call-sign agents. */
const SYSTEM_ROLES = new Map([
  ['openswarm-daemon', 'daemon'],
  ['adapter-router', 'daemon'],
  ['orchestrator', 'orchestrator'],
  ['human', 'human'],
]);

function roleOf(id, explicit) {
  if (explicit) return explicit;
  return SYSTEM_ROLES.get(id) ?? 'agent';
}

/**
 * Build { nodes, edges, stats } from board events.
 *
 * `now` is injected so recency ("active in the last N minutes") is
 * deterministic under test. Latest-event-per-correlation decides pending:
 * an answered question must not keep pulsing as pending because its older
 * waiting event still exists.
 */
export function buildOrchestrationModel(events, { now = Date.now(), activeWindowMs = 30 * 60_000 } = {}) {
  const nodes = new Map();
  const edges = new Map();
  const latestByCorrelation = new Map();

  const touch = (id, name, role, timestamp, taskId) => {
    if (!id) return null;
    const existing = nodes.get(id);
    if (!existing) {
      nodes.set(id, {
        id,
        name: name || id,
        role: roleOf(id, role),
        eventCount: 0,
        lastSeen: timestamp,
        pendingCount: 0,
        taskId,
      });
      return nodes.get(id);
    }
    // A named sighting upgrades an address-only one; an explicit role upgrades
    // the generic fallback (legacy events carry no role).
    if (name && existing.name === existing.id) existing.name = name;
    if (role && existing.role === 'agent') existing.role = role;
    if (timestamp > existing.lastSeen) existing.lastSeen = timestamp;
    // >= for task adoption: a node first sighted as a recipient in the same
    // millisecond as its own acting event must still join its task cluster.
    if (taskId && timestamp >= existing.lastSeen) existing.taskId = taskId;
    return existing;
  };

  for (const event of events) {
    // Only the actor is acting inside event.taskId — a recipient may be
    // getting cross-task advice, and adopting the sender's task would drag it
    // into the wrong execution cluster.
    const from = touch(event.actor, event.actorName, event.actorRole, event.timestamp, event.taskId);
    if (from) from.eventCount += 1;
    const to = touch(event.recipient, event.recipientName, event.recipientRole, event.timestamp, undefined);

    if (from && to && from.id !== to.id) {
      const key = `${from.id}→${to.id}`;
      const edge = edges.get(key) ?? { from: from.id, to: to.id, count: 0, kinds: {}, lastSeen: 0 };
      edge.count += 1;
      edge.kinds[event.kind] = (edge.kinds[event.kind] ?? 0) + 1;
      if (event.timestamp > edge.lastSeen) edge.lastSeen = event.timestamp;
      edges.set(key, edge);
    }

    const prev = latestByCorrelation.get(event.correlationId);
    if (!prev || event.seq > prev.seq) latestByCorrelation.set(event.correlationId, event);
  }

  const pending = [...latestByCorrelation.values()].filter((event) => PENDING_STATUSES.has(event.status));
  for (const event of pending) {
    const owner = nodes.get(event.recipient) ?? nodes.get(event.actor);
    if (owner) owner.pendingCount += 1;
  }

  const nodeList = [...nodes.values()].map((node) => ({
    ...node,
    active: now - node.lastSeen <= activeWindowMs,
  }));

  const byRole = {};
  for (const node of nodeList) byRole[node.role] = (byRole[node.role] ?? 0) + 1;

  return {
    nodes: nodeList,
    edges: [...edges.values()],
    stats: {
      totalEvents: events.length,
      agentsByRole: byRole,
      activeAgents: nodeList.filter((node) => node.active && node.role !== 'human').length,
      pendingQuestions: pending.filter((event) => event.kind === 'human-question').length,
      pendingTotal: pending.length,
      routes: events.filter((event) => event.kind === 'adapter-route').length,
      lastSeq: events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0),
    },
  };
}

/** Per-kind edge colors — one hue per interaction family, stable for the legend. */
export const KIND_COLORS = {
  'advice-request': '#e8b339',
  'advice-response': '#4cc38a',
  'delegation-request': '#e8b339',
  'delegation-result': '#4cc38a',
  'human-question': '#e5484d',
  'human-answer': '#3b9eff',
  'adapter-route': '#9d7cd8',
  'review-run': '#4cc38a',
  'mcp-audit': '#9d7cd8',
  'instruction-snapshot': '#6c7086',
};

/** Dominant kind of an edge — the color it is drawn with. */
export function dominantKind(edge) {
  let best = null;
  for (const [kind, count] of Object.entries(edge.kinds)) {
    if (!best || count > best.count) best = { kind, count };
  }
  return best?.kind ?? 'advice-request';
}
