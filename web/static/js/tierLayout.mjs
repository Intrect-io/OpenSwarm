// ============================================
// OpenSwarm - Hierarchical tier layout (pure)
// ============================================
//
// The swarm has a real chain of command, and the layout states it instead of
// letting a force simulation scatter it: operator on top, control plane under
// them, the coordination/oversight layer next, and the execution tier as the
// wide base of the pyramid. Tier width IS the deployment picture. Positions
// are fully deterministic — sorted placement, no simulation — so a node never
// moves unless the population changes.

export const TIERS = [
  { id: 'operator', label: 'OPERATOR', roles: ['human'] },
  { id: 'control', label: 'CONTROL PLANE', roles: ['daemon'] },
  { id: 'coordination', label: 'COORDINATION', roles: ['orchestrator', 'review-agent'] },
  { id: 'execution', label: 'EXECUTION', roles: ['worker', 'reviewer', 'agent'] },
];

const EXECUTION = TIERS.length - 1;

export function tierOf(role) {
  const index = TIERS.findIndex((tier) => tier.roles.includes(role));
  return index === -1 ? EXECUTION : index;
}

/** Worker before its reviewer inside a task cluster. */
const ROLE_ORDER = { worker: 0, reviewer: 1, agent: 2 };

function executionSortKey(node) {
  // Task first, so a task's worker/reviewer pair sits adjacent — the pair is
  // the unit the operator thinks in.
  return `${node.taskId ?? '~'}\u0000${ROLE_ORDER[node.role] ?? 9}\u0000${node.name}`;
}

/**
 * Place nodes into fixed tier bands.
 *
 * Every tier band is always drawn, populated or not — an empty COORDINATION
 * row saying "nothing is coordinating right now" is information, and a
 * hierarchy that reshuffles its rows as agents come and go is unreadable.
 * Crowded tiers wrap into sub-rows instead of squeezing below `minSpacing`.
 */
export function layoutTiers(nodes, {
  width = 900,
  height = 600,
  labelGutter = 120,
  margin = 24,
  minSpacing = 96,
} = {}) {
  const byTier = TIERS.map(() => []);
  for (const node of nodes) byTier[tierOf(node.role)].push(node);
  // Codepoint comparison, not localeCompare: the browser's locale must not be
  // able to reorder the pyramid.
  const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  byTier[EXECUTION].sort((a, b) => byCodepoint(executionSortKey(a), executionSortKey(b)));
  for (let tier = 0; tier < EXECUTION; tier += 1) {
    byTier[tier].sort((a, b) => byCodepoint(a.name, b.name));
  }

  const usable = Math.max(width - labelGutter - margin, minSpacing);
  const perRow = Math.max(1, Math.floor(usable / minSpacing));
  const subRows = byTier.map((members) => Math.max(1, Math.ceil(members.length / perRow)));
  const totalUnits = subRows.reduce((sum, rows) => sum + rows, 0);
  const unitHeight = (height - margin * 2) / totalUnits;

  const positions = new Map();
  const bands = [];
  let y = margin;
  for (let tier = 0; tier < TIERS.length; tier += 1) {
    const members = byTier[tier];
    const bandHeight = unitHeight * subRows[tier];
    bands.push({ id: TIERS[tier].id, label: TIERS[tier].label, y0: y, y1: y + bandHeight, count: members.length });

    for (let row = 0; row < subRows[tier]; row += 1) {
      const rowMembers = members.slice(row * perRow, (row + 1) * perRow);
      const rowY = y + (row + 0.5) * (bandHeight / subRows[tier]);
      rowMembers.forEach((node, index) => {
        positions.set(node.id, {
          x: labelGutter + ((index + 0.5) / rowMembers.length) * usable,
          y: rowY,
        });
      });
    }
    y += bandHeight;
  }

  return { positions, bands, labelGutter };
}
