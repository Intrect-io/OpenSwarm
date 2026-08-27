// ============================================
// OpenSwarm - Deterministic force layout (pure)
// ============================================
//
// A small force-directed layout with NO randomness: initial positions are
// hashed from node ids, and the simulation runs a fixed number of synchronous
// steps. The same graph therefore always lands in the same picture — a node
// keeps its place across refreshes, which matters more here than an optimal
// embedding.

function hash(text) {
  let value = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** Seeded initial position on a ring, angle from the id hash. */
export function seedPosition(id, width, height) {
  const angle = (hash(id) % 3600) / 3600 * 2 * Math.PI;
  const radius = Math.min(width, height) * 0.28 + (hash(`${id}#r`) % 40);
  return {
    x: width / 2 + Math.cos(angle) * radius,
    y: height / 2 + Math.sin(angle) * radius,
  };
}

/**
 * Run the layout to completion and return positions keyed by node id.
 *
 * Forces: pairwise repulsion, spring along edges, weak centering. Velocities
 * are damped each step; a fixed iteration count bounds the cost, and clamping
 * keeps every node inside the viewport with a margin.
 */
export function layoutGraph(nodes, edges, { width = 900, height = 600, iterations = 220, margin = 48 } = {}) {
  const positions = new Map();
  for (const node of nodes) {
    positions.set(node.id, { ...seedPosition(node.id, width, height), vx: 0, vy: 0 });
  }
  const springLength = Math.min(width, height) / 3.2;

  for (let step = 0; step < iterations; step += 1) {
    // Repulsion between every pair.
    const list = nodes.map((node) => ({ node, p: positions.get(node.id) }));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i].p; const b = list[j].p;
        let dx = a.x - b.x; let dy = a.y - b.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 1) { dx = 0.5; dy = 0.5; dist2 = 0.5; }
        const force = 5200 / dist2;
        const dist = Math.sqrt(dist2);
        a.vx += (dx / dist) * force; a.vy += (dy / dist) * force;
        b.vx -= (dx / dist) * force; b.vy -= (dy / dist) * force;
      }
    }
    // Springs along edges.
    for (const edge of edges) {
      const a = positions.get(edge.from); const b = positions.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x; const dy = b.y - a.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
      const stretch = (dist - springLength) * 0.02;
      a.vx += (dx / dist) * stretch; a.vy += (dy / dist) * stretch;
      b.vx -= (dx / dist) * stretch; b.vy -= (dy / dist) * stretch;
    }
    // Centering + integrate with damping.
    for (const { p } of list) {
      p.vx += (width / 2 - p.x) * 0.005;
      p.vy += (height / 2 - p.y) * 0.005;
      p.x += p.vx * 0.35; p.y += p.vy * 0.35;
      p.vx *= 0.6; p.vy *= 0.6;
      p.x = Math.min(width - margin, Math.max(margin, p.x));
      p.y = Math.min(height - margin, Math.max(margin, p.y));
    }
  }

  const result = new Map();
  for (const [id, p] of positions) result.set(id, { x: p.x, y: p.y });
  return result;
}
