// ============================================
// OpenSwarm - Task-lane layout (pure)
// ============================================
//
// The swarm has a real chain of command AND a real set of conversations, and
// the layout states both. Operator, control plane and the coordination layer
// are shared RAILS across the top — they belong to every task, so they get
// fixed bands. Everything below is one LANE per task: the worker, its reviewer
// and whoever they pulled in sit together, so a reader can see which agents
// are talking about the same thing instead of forty dots in one band.
//
// Positions are fully deterministic — no simulation — and, more importantly,
// stable: a node's slot comes from a hash of its address, and nodes are seated
// oldest-first, so an arriving agent can only take a slot nobody holds. It
// never shoves the agents already on screen sideways.

import { taskLanesOf } from './orchestrationModel.mjs';

export const TIERS = [
  { id: 'operator', label: 'OPERATOR', roles: ['human'] },
  { id: 'control', label: 'CONTROL PLANE', roles: ['daemon'] },
  { id: 'coordination', label: 'COORDINATION', roles: ['orchestrator', 'review-agent'] },
  { id: 'execution', label: 'EXECUTION', roles: ['worker', 'reviewer', 'agent'] },
];

const EXECUTION = TIERS.length - 1;

/** Lane holding execution nodes that never carried a task id. */
const NO_TASK = '~no-task';

export function tierOf(role) {
  const index = TIERS.findIndex((tier) => tier.roles.includes(role));
  return index === -1 ? EXECUTION : index;
}

/** Legacy nodes predate `firstSeen`; fall back rather than sorting on NaN. */
function seenFirst(node) {
  return node.firstSeen ?? node.lastSeen ?? 0;
}

// Codepoint comparison, not localeCompare: the browser's locale must not be
// able to reorder the pyramid.
function byCodepoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * FNV-1a (32-bit) over the node address.
 *
 * The point is not cryptographic spread, it is that the slot is a property of
 * the identity alone: it does not depend on who else is on the board, so a
 * node keeps its column when its neighbours come and go.
 */
export function slotHash(id, slots) {
  if (slots <= 1) return 0;
  let hash = 0x811c9dc5;
  const text = String(id);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % slots;
}

/**
 * Seat one band's members into (row, slot) pairs.
 *
 * Oldest first is what makes this stable. A newly sighted agent has the
 * largest `firstSeen`, so it is seated last, so every probe it makes lands on
 * a slot no incumbent holds — the arrival cannot displace anyone. Seating in
 * name order (what this used to do, via `(index + 0.5) / rowMembers.length`)
 * gave the opposite property: one arrival re-indexed the whole row.
 */
function seat(members, slots) {
  const ordered = [...members].sort((a, b) =>
    seenFirst(a) - seenFirst(b) || byCodepoint(a.id, b.id));
  const seats = new Map();
  const takenByRow = new Map();
  ordered.forEach((node, position) => {
    const row = Math.floor(position / slots);
    let taken = takenByRow.get(row);
    if (!taken) { taken = new Set(); takenByRow.set(row, taken); }
    let slot = slotHash(node.id, slots);
    for (let probe = 0; probe < slots && taken.has(slot); probe += 1) slot = (slot + 1) % slots;
    taken.add(slot);
    seats.set(node.id, { row, slot });
  });
  return seats;
}

/**
 * Split nodes into the rail bands and the per-task lanes.
 *
 * `maxLanes` bounds the number of TASK lanes: past it, the least recently
 * active tasks fold into one overflow lane rather than shrinking every band
 * toward zero. The shared "no task" lane sits outside that budget, since it
 * exists to stop untasked nodes becoming a lane each. Kept lanes are ordered
 * by `firstSeen`, so a new task appends at the bottom instead of re-stacking
 * the ones above it.
 */
export function planBands(nodes, { maxLanes = 12, laneOrder = null } = {}) {
  const rails = TIERS.slice(0, EXECUTION).map((tier) => ({
    id: tier.id, label: tier.label, kind: 'rail', taskId: null, members: [],
  }));
  const execution = [];
  for (const node of nodes) {
    // The tier table is the layout's own authority on what is a rail; the
    // model's RAIL_ROLES answers a different question (who survives the
    // liveness filter), and conflating them would couple two decisions.
    const tier = tierOf(node.role);
    if (tier < EXECUTION) rails[tier].members.push(node);
    else execution.push(node);
  }

  let lanes = taskLanesOf(execution);
  // A lane's own `firstSeen` is the minimum over the members it can see, so it
  // rises when the earliest one is filtered away — and every lane below it
  // would shift. `laneOrder`, derived once from the unfiltered board, pins the
  // stack so hiding an idle agent cannot re-order the conversations.
  if (laneOrder) {
    const rank = new Map(laneOrder.map((taskId, index) => [taskId, index]));
    lanes = [...lanes].sort((a, b) =>
      (rank.get(a.taskId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.taskId) ?? Number.MAX_SAFE_INTEGER)
      || a.firstSeen - b.firstSeen
      || byCodepoint(a.taskId, b.taskId));
  }
  let overflow = new Set();
  if (lanes.length > maxLanes) {
    const keep = [...lanes].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, maxLanes - 1);
    const kept = new Set(keep.map((lane) => lane.taskId));
    overflow = new Set(lanes.filter((lane) => !kept.has(lane.taskId)).map((lane) => lane.taskId));
    lanes = lanes.filter((lane) => kept.has(lane.taskId));
  }

  const laneBands = lanes.map((lane) => ({
    id: `lane:${lane.taskId}`, label: lane.label, kind: 'lane', taskId: lane.taskId, members: [],
  }));
  const byTask = new Map(laneBands.map((band) => [band.taskId, band]));
  const spillover = [];
  const untasked = [];
  for (const node of execution) {
    const band = node.taskId ? byTask.get(node.taskId) : null;
    if (band) band.members.push(node);
    else if (node.taskId && overflow.has(node.taskId)) spillover.push(node);
    else untasked.push(node);
  }
  if (spillover.length) {
    laneBands.push({
      id: `lane:${NO_TASK}-overflow`, label: `${overflow.size} OLDER TASKS`, kind: 'lane',
      taskId: null, members: spillover,
    });
  }
  if (untasked.length) {
    laneBands.push({ id: `lane:${NO_TASK}`, label: 'NO TASK', kind: 'lane', taskId: null, members: untasked });
  }
  // An empty execution area still gets one band: a hierarchy whose bottom half
  // silently disappears when the swarm goes quiet reads as a broken page.
  if (laneBands.length === 0) {
    laneBands.push({ id: `lane:${NO_TASK}`, label: 'TASKS', kind: 'lane', taskId: null, members: [] });
  }
  return [...rails, ...laneBands];
}

/**
 * Place nodes into rail bands and task lanes.
 *
 * Every rail band is always drawn, populated or not — an empty COORDINATION
 * row saying "nothing is coordinating right now" is information. Crowded bands
 * wrap into sub-rows instead of squeezing below `minSpacing`.
 */
export function layoutTiers(nodes, {
  width = 900,
  height = 600,
  labelGutter = 120,
  margin = 24,
  minSpacing = 96,
  maxLanes = 12,
  laneOrder = null,
} = {}) {
  const planned = planBands(nodes, { maxLanes, laneOrder });

  const usable = Math.max(width - labelGutter - margin, minSpacing);
  const perRow = Math.max(1, Math.floor(usable / minSpacing));
  const subRows = planned.map((band) => Math.max(1, Math.ceil(band.members.length / perRow)));
  const totalUnits = subRows.reduce((sum, rows) => sum + rows, 0);
  const unitHeight = (height - margin * 2) / totalUnits;

  const positions = new Map();
  const bands = [];
  let y = margin;
  planned.forEach((band, index) => {
    const bandHeight = unitHeight * subRows[index];
    bands.push({
      id: band.id,
      label: band.label,
      kind: band.kind,
      taskId: band.taskId,
      y0: y,
      y1: y + bandHeight,
      count: band.members.length,
    });
    const rowHeight = bandHeight / subRows[index];
    for (const [id, place] of seat(band.members, perRow)) {
      positions.set(id, {
        x: labelGutter + ((place.slot + 0.5) / perRow) * usable,
        y: y + (place.row + 0.5) * rowHeight,
      });
    }
    y += bandHeight;
  });

  return { positions, bands, labelGutter };
}
