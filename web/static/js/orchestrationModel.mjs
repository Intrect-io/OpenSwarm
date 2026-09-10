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

/**
 * Roles drawn as shared rails rather than as participants in one task.
 *
 * They are exempt from the liveness filter: the operator rail vanishing
 * because nobody spoke to them for half an hour would read as a broken page,
 * and their whole job is to be the fixed reference the lanes hang from.
 */
export const RAIL_ROLES = new Set(['human', 'daemon', 'orchestrator', 'review-agent']);

function roleOf(id, explicit) {
  if (explicit) return explicit;
  return SYSTEM_ROLES.get(id) ?? 'agent';
}

export function sourceTaskIdOf(event) {
  return event.sourceTaskId ?? event.taskId;
}

export function targetTaskIdOf(event) {
  return event.targetTaskId ?? event.taskId;
}

/** Addresses reused on different tasks need task-scoped graph identities. */
export function collisionAddressesOf(events) {
  const tasks = new Map();
  const rail = new Set();
  const note = (address, taskId, role) => {
    if (!address || !taskId) return;
    if (RAIL_ROLES.has(roleOf(address, role))) rail.add(address);
    const seen = tasks.get(address) ?? new Set();
    seen.add(taskId);
    tasks.set(address, seen);
  };
  for (const event of events) {
    note(event.actor, sourceTaskIdOf(event), event.actorRole);
    // A legacy recipient inherited the sender's task only as a seating hint;
    // treating that hint as identity would split the old graph. An explicit
    // target envelope is a real task claim and may expose a collision.
    if (event.targetTaskId) note(event.recipient, targetTaskIdOf(event), event.recipientRole);
  }
  return new Set([...tasks].filter(([address, taskIds]) => !rail.has(address) && taskIds.size > 1).map(([address]) => address));
}

export function nodeIdForEvent(event, side, collisions) {
  const actor = side === 'actor';
  const address = actor ? event.actor : event.recipient;
  const taskId = actor ? sourceTaskIdOf(event) : targetTaskIdOf(event);
  return address && taskId && collisions.has(address) ? `${taskId}::${address}` : address;
}

/**
 * Build { nodes, edges, stats } from board events.
 *
 * `now` is injected so recency ("active in the last N minutes") is
 * deterministic under test. Latest-event-per-correlation decides pending:
 * an answered question must not keep pulsing as pending because its older
 * waiting event still exists.
 */
/** How long after its last event an identity still counts as active. */
export const ACTIVE_WINDOW_MS = 30 * 60_000;

export function buildOrchestrationModel(events, { now = Date.now(), activeWindowMs = ACTIVE_WINDOW_MS } = {}) {
  const nodes = new Map();
  const edges = new Map();
  const latestByCorrelation = new Map();
  const collisions = collisionAddressesOf(events);

  // Acting inside a task is a claim; being addressed inside one is only a
  // hint. Both are recorded, and `actedTaskId` always wins, so cross-task
  // advice cannot drag a working agent out of its own lane — while an agent
  // that has never acted anywhere still gets seated with the people talking
  // to it instead of stranded in a "no task" lane of one.
  const touch = (id, address, name, role, timestamp, taskId, taskLabel, acting) => {
    if (!id) return null;
    const claim = (node) => {
      if (!taskId) return;
      if (acting) {
        // >= : a node first sighted as a recipient in the same millisecond as
        // its own acting event must still join its task cluster.
        if (timestamp >= node.actedAt) {
          node.actedTaskId = taskId;
          node.actedTaskLabel = taskLabel;
          node.actedAt = timestamp;
        }
        return;
      }
      if (timestamp >= node.addressedAt) {
        node.addressedTaskId = taskId;
        node.addressedTaskLabel = taskLabel;
        node.addressedAt = timestamp;
      }
    };
    const existing = nodes.get(id);
    if (!existing) {
      const created = {
        id,
        address,
        name: name || address,
        role: roleOf(address, role),
        eventCount: 0,
        // `firstSeen` is written once and never updated. The layout places
        // nodes oldest-first so a newcomer can only take a free slot, which is
        // what keeps an arrival from shoving everyone already on screen; a
        // field that moved would destroy that ordering.
        firstSeen: timestamp,
        lastSeen: timestamp,
        pendingCount: 0,
        actedTaskId: undefined,
        actedTaskLabel: undefined,
        actedAt: -Infinity,
        addressedTaskId: undefined,
        addressedTaskLabel: undefined,
        addressedAt: -Infinity,
      };
      nodes.set(id, created);
      claim(created);
      return created;
    }
    // A named sighting upgrades an address-only one; an explicit role upgrades
    // the generic fallback (legacy events carry no role).
    if (name && existing.name === existing.address) existing.name = name;
    if (role && existing.role === 'agent') existing.role = role;
    if (timestamp > existing.lastSeen) existing.lastSeen = timestamp;
    if (timestamp < existing.firstSeen) existing.firstSeen = timestamp;
    claim(existing);
    return existing;
  };

  for (const event of events) {
    const from = touch(
      nodeIdForEvent(event, 'actor', collisions), event.actor,
      event.actorName, event.actorRole, event.timestamp,
      sourceTaskIdOf(event), event.sourceTaskLabel ?? event.taskLabel, true);
    if (from) from.eventCount += 1;
    const to = touch(
      nodeIdForEvent(event, 'recipient', collisions), event.recipient,
      event.recipientName, event.recipientRole, event.timestamp,
      targetTaskIdOf(event), event.targetTaskLabel ?? event.taskLabel, false);

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
    const owner = nodes.get(nodeIdForEvent(event, 'recipient', collisions))
      ?? nodes.get(nodeIdForEvent(event, 'actor', collisions));
    if (owner) owner.pendingCount += 1;
  }

  // Spelled out rather than spread: this is the node shape the layout and the
  // view consume, and the acted/addressed bookkeeping above is private to the
  // aggregation.
  const nodeList = [...nodes.values()].map((node) => ({
    id: node.id,
    address: node.address,
    name: node.name,
    role: node.role,
    eventCount: node.eventCount,
    firstSeen: node.firstSeen,
    lastSeen: node.lastSeen,
    pendingCount: node.pendingCount,
    taskId: node.actedTaskId ?? node.addressedTaskId,
    taskLabel: node.actedTaskId ? node.actedTaskLabel : node.addressedTaskLabel,
    active: now - node.lastSeen <= activeWindowMs,
  }));

  const byRole = {};
  for (const node of nodeList) byRole[node.role] = (byRole[node.role] ?? 0) + 1;

  // Distinct askers, not question count: the operator wants to know how many
  // agents are parked on them, and one agent asking three times is one agent
  // to unblock.
  const awaiting = new Set(
    pending.filter((event) => event.kind === 'human-question')
      .map((event) => nodeIdForEvent(event, 'actor', collisions)).filter(Boolean));

  return {
    nodes: nodeList,
    edges: [...edges.values()],
    collidingAddresses: [...collisions],
    stats: {
      totalEvents: events.length,
      agentsByRole: byRole,
      activeAgents: nodeList.filter((node) => node.active && node.role !== 'human').length,
      idleAgents: nodeList.filter((node) => !node.active && !RAIL_ROLES.has(node.role)).length,
      agentsAwaitingOperator: awaiting.size,
      pendingQuestions: pending.filter((event) => event.kind === 'human-question').length,
      pendingTotal: pending.length,
      routes: events.filter((event) => event.kind === 'adapter-route').length,
      lastSeq: events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0),
    },
  };
}

/**
 * The nodes the graph should actually draw.
 *
 * The client keeps every event the server ring ever handed it, so without this
 * the population only grows: an agent that spoke once at 09:00 is still a dot
 * at 17:00. Idle participants drop out unless `showIdle` asks for them; the
 * task/role/query filters are the operator's way of narrowing a busy board.
 */
export function filterGraphNodes(nodes, { showIdle = false, taskId = null, role = null, query = '' } = {}) {
  const needle = query.trim().toLowerCase();
  return nodes.filter((node) => {
    const isRail = RAIL_ROLES.has(node.role);
    if (!showIdle && !node.active && !isRail) return false;
    // Rails belong to every task and every role view — filtering them out
    // would strand the lanes with nothing above them to hang from.
    if (taskId && !isRail && node.taskId !== taskId) return false;
    if (role && node.role !== role) return false;
    if (needle && !isRail) {
      const haystack = `${node.name} ${node.address ?? node.id} ${node.id} ${node.taskLabel ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

/**
 * The task lanes present in a node set, oldest task first.
 *
 * Ordering by `firstSeen` and not by recency is deliberate: recency ordering
 * would re-stack every lane the moment any task spoke, which is the vertical
 * version of the sliding-row defect this view had.
 *
 * A lane's `firstSeen` is the minimum over the members it was handed, so it
 * moves if the earliest member is not in that set. Callers that filter their
 * nodes must therefore derive the ORDER from the unfiltered model and pass it
 * to the layout — see `laneOrder` in tierLayout — or hiding one idle agent
 * would re-stack every lane below it.
 */
export function taskLanesOf(nodes) {
  const lanes = new Map();
  for (const node of nodes) {
    if (!node.taskId || RAIL_ROLES.has(node.role)) continue;
    // Legacy nodes predate `firstSeen`; falling back beats propagating NaN
    // into the comparator, where it would make the order arbitrary.
    const first = node.firstSeen ?? node.lastSeen ?? 0;
    const last = node.lastSeen ?? node.firstSeen ?? 0;
    const lane = lanes.get(node.taskId);
    if (!lane) {
      lanes.set(node.taskId, {
        taskId: node.taskId,
        label: node.taskLabel || shortTaskLabel(node.taskId),
        firstSeen: first,
        lastSeen: last,
        count: 1,
      });
      continue;
    }
    if (node.taskLabel && lane.label !== node.taskLabel) lane.label = node.taskLabel;
    lane.firstSeen = Math.min(lane.firstSeen, first);
    lane.lastSeen = Math.max(lane.lastSeen, last);
    lane.count += 1;
  }
  return [...lanes.values()].sort((a, b) =>
    a.firstSeen - b.firstSeen || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
}

/** Task ids are issue UUIDs; a lane header has room for a stub, not all of it. */
export function shortTaskLabel(taskId) {
  if (!taskId) return '';
  return taskId.length > 12 ? `${taskId.slice(0, 8)}…` : taskId;
}

/** Per-kind edge colors — one hue per interaction family, stable for the legend. */
export const KIND_COLORS = {
  // Token references, not colours: the theme (tokens.css) decides what an
  // exchange kind looks like, and the light palette gets its own values.
  'advice-request': 'var(--kind-request)',
  'advice-response': 'var(--kind-response)',
  'delegation-request': 'var(--kind-request)',
  'delegation-result': 'var(--kind-response)',
  'human-question': 'var(--kind-human-question)',
  'human-answer': 'var(--kind-human-answer)',
  'adapter-route': 'var(--kind-route)',
  'review-run': 'var(--kind-response)',
  'mcp-audit': 'var(--kind-route)',
  'thread-update': 'var(--kind-human-answer)',
  'instruction-snapshot': 'var(--kind-plumbing)',
};

/** Dominant kind of an edge — the color it is drawn with. */
export function dominantKind(edge) {
  let best = null;
  for (const [kind, count] of Object.entries(edge.kinds)) {
    if (!best || count > best.count) best = { kind, count };
  }
  return best?.kind ?? 'advice-request';
}
