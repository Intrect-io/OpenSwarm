// ============================================
// OpenSwarm - Orchestration view (rendering + live wiring)
// ============================================
//
// Thin over the pure modules: orchestrationModel aggregates, tierLayout
// places, this file draws SVG and keeps the picture live. Rendering reads the
// full current event set every time — the model is cheap at board scale
// (≤2000 events) and idempotent redraw avoids incremental-DOM drift.

import { buildOrchestrationModel, dominantKind, KIND_COLORS } from './orchestrationModel.mjs';
import { layoutTiers } from './tierLayout.mjs';

export const ROLE_COLORS = {
  worker: '#3b9eff',
  reviewer: '#4cc38a',
  orchestrator: '#e8b339',
  'review-agent': '#9d7cd8',
  daemon: '#6c7086',
  human: '#e5484d',
  agent: '#8b93a5',
};

const PENDING = new Set(['open', 'waiting', 'running']);
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(doc, tag, attrs = {}) {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** Node radius grows with activity but stays readable: 10..26px. */
export function nodeRadius(node) {
  return Math.min(26, 10 + Math.sqrt(node.eventCount) * 2.5);
}

export function renderStats(doc, stats) {
  const holder = doc.getElementById('stats');
  const cells = [
    ['active agents', stats.activeAgents, false],
    ['pending questions', stats.pendingQuestions, stats.pendingQuestions > 0],
    ['open exchanges', stats.pendingTotal, false],
    ['adapter routes', stats.routes, false],
    ['events', stats.totalEvents, false],
  ];
  holder.innerHTML = cells
    .map(([label, value, warn]) => `<span class="stat${warn ? ' warn' : ''}"><b>${value}</b>${label}</span>`)
    .join('');
}

export function renderGraph(doc, model, layout, selected, onSelect) {
  const { positions, bands, labelGutter } = layout;
  const svg = doc.getElementById('graph');
  const width = svg.clientWidth || 900;
  const height = svg.clientHeight || 600;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.innerHTML = '';

  // Hierarchy furniture below everything: alternating band fills, separators,
  // and a tier label with its head-count — the pyramid reading at a glance.
  const bandLayer = el(doc, 'g');
  bands.forEach((band, index) => {
    if (index % 2 === 1) {
      bandLayer.appendChild(el(doc, 'rect', {
        x: 0, y: band.y0, width, height: band.y1 - band.y0,
        fill: '#ffffff', 'fill-opacity': 0.025, 'data-band': band.id,
      }));
    }
    if (index > 0) {
      bandLayer.appendChild(el(doc, 'line', {
        x1: 0, y1: band.y0, x2: width, y2: band.y0,
        stroke: '#1f2633', 'stroke-dasharray': '4 6',
      }));
    }
    const label = el(doc, 'text', {
      x: 12, y: (band.y0 + band.y1) / 2, class: 'tier-label', 'data-tier-label': band.id,
    });
    label.textContent = band.label;
    bandLayer.appendChild(label);
    const count = el(doc, 'text', {
      x: 12, y: (band.y0 + band.y1) / 2 + 13, class: 'tier-count',
    });
    count.textContent = band.count === 0 ? 'none' : `${band.count} placed`;
    bandLayer.appendChild(count);
  });
  bandLayer.appendChild(el(doc, 'line', {
    x1: labelGutter - 14, y1: bands[0].y0, x2: labelGutter - 14, y2: bands[bands.length - 1].y1,
    stroke: '#1f2633',
  }));
  svg.appendChild(bandLayer);

  const neighbors = new Set();
  if (selected) {
    neighbors.add(selected);
    for (const edge of model.edges) {
      if (edge.from === selected) neighbors.add(edge.to);
      if (edge.to === selected) neighbors.add(edge.from);
    }
  }

  const edgeLayer = el(doc, 'g');
  for (const edge of model.edges) {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (!a || !b) continue;
    // A gentle quadratic bend keeps A→B and B→A visually distinct.
    const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.12;
    const my = (a.y + b.y) / 2 + (a.x - b.x) * 0.12;
    const path = el(doc, 'path', {
      d: `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`,
      class: `edge${selected && edge.from !== selected && edge.to !== selected ? ' dimmed' : ''}`,
      stroke: KIND_COLORS[dominantKind(edge)] ?? '#6c7086',
      'stroke-width': Math.min(6, 1 + Math.log2(1 + edge.count)),
    });
    path.appendChild(el(doc, 'title')).textContent =
      `${edge.from} → ${edge.to}: ${edge.count} (${Object.entries(edge.kinds).map(([k, n]) => `${k}×${n}`).join(', ')})`;
    edgeLayer.appendChild(path);
  }
  svg.appendChild(edgeLayer);

  const nodeLayer = el(doc, 'g');
  for (const node of model.nodes) {
    const p = positions.get(node.id);
    if (!p) continue;
    const group = el(doc, 'g', {
      class: `node${selected && !neighbors.has(node.id) ? ' dimmed' : ''}`,
      transform: `translate(${p.x} ${p.y})`,
      'data-node': node.id,
    });
    const radius = nodeRadius(node);
    if (node.pendingCount > 0) {
      group.appendChild(el(doc, 'circle', { r: radius + 6, fill: 'none', stroke: '#e8b339', 'stroke-width': 2, class: 'pulse' }));
    }
    group.appendChild(el(doc, 'circle', {
      r: radius,
      fill: ROLE_COLORS[node.role] ?? ROLE_COLORS.agent,
      'fill-opacity': node.active ? 0.9 : 0.35,
      stroke: node.id === selected ? '#e6e9ef' : 'transparent',
      'stroke-width': 2,
    }));
    const label = el(doc, 'text', { y: radius + 12 });
    label.textContent = node.name;
    group.appendChild(label);
    const roleLabel = el(doc, 'text', { y: radius + 22, class: 'role-label' });
    roleLabel.textContent = node.role;
    group.appendChild(roleLabel);
    group.addEventListener('click', () => onSelect(node.id));
    nodeLayer.appendChild(group);
  }
  svg.appendChild(nodeLayer);
}

export function renderLegend(doc) {
  const rows = [
    ...Object.entries(ROLE_COLORS).filter(([role]) => role !== 'agent')
      .map(([role, color]) => `<div class="row"><span class="swatch" style="background:${color}"></span>${role}</div>`),
    '<div class="row" style="margin-top:6px;border-top:1px solid #1f2633;padding-top:4px">edges</div>',
    `<div class="row"><span class="line" style="background:${KIND_COLORS['advice-request']}"></span>advice / delegation</div>`,
    `<div class="row"><span class="line" style="background:${KIND_COLORS['human-question']}"></span>human question</div>`,
    `<div class="row"><span class="line" style="background:${KIND_COLORS['adapter-route']}"></span>route / mcp</div>`,
  ];
  doc.getElementById('legend').innerHTML = rows.join('');
}

export function renderDetail(doc, model, events, selected) {
  const holder = doc.getElementById('detail');
  const node = model.nodes.find((candidate) => candidate.id === selected);
  if (!node) {
    holder.innerHTML = '<div class="empty">Select a node</div>';
    return;
  }
  const involved = events.filter((event) => event.actor === node.id || event.recipient === node.id);
  const pending = involved.filter((event) => PENDING.has(event.status));
  holder.innerHTML = `
    <div class="name">${escapeHtml(node.name)}</div>
    <div class="meta">${escapeHtml(node.role)} · ${node.eventCount} event(s) · ${node.active ? 'active' : 'idle'}</div>
    <div class="meta">pending: ${pending.length ? escapeHtml(pending.map((event) => event.kind).join(', ')) : 'none'}</div>
    <div class="meta">last seen ${new Date(node.lastSeen).toLocaleTimeString()}</div>`;
}

export function renderFeed(doc, events, selected) {
  const feed = doc.getElementById('feed');
  const shown = (selected
    ? events.filter((event) => event.actor === selected || event.recipient === selected)
    : events
  ).slice(-80).reverse();
  if (shown.length === 0) {
    feed.innerHTML = '<div class="empty">no coordination events</div>';
    return;
  }
  feed.innerHTML = shown.map((event) => {
    const color = PENDING.has(event.status) ? '#e8b339'
      : event.status === 'failed' || event.status === 'expired' ? '#e5484d' : '#4cc38a';
    return `<div class="ev">
      <div class="head"><span class="status" style="color:${color}">${escapeHtml(event.status)}</span>
        <span class="kind">${escapeHtml(event.kind)}</span><span style="color:#6c7086">#${event.seq}</span></div>
      <div class="summary">${escapeHtml(event.summary)}</div>
      <div class="route">${escapeHtml(event.actorName || event.actor)} → ${escapeHtml(event.recipientName || event.recipient || 'all')}</div>
    </div>`;
  }).join('');
}

/** Entry point: fetch, render, then keep live via SSE with a polling backstop. */
export function startOrchestrationView(doc, { fetchImpl, eventSourceImpl, pollMs = 30_000 } = {}) {
  const fetcher = fetchImpl ?? ((url) => fetch(url));
  const byId = new Map();
  let selected = null;

  const redraw = () => {
    const events = [...byId.values()].sort((a, b) => a.seq - b.seq);
    const model = buildOrchestrationModel(events);
    if (selected && !model.nodes.some((node) => node.id === selected)) selected = null;
    const svg = doc.getElementById('graph');
    const layout = layoutTiers(model.nodes, {
      width: svg.clientWidth || 900,
      height: svg.clientHeight || 600,
    });
    renderStats(doc, model.stats);
    renderGraph(doc, model, layout, selected, (id) => {
      selected = selected === id ? null : id;
      redraw();
    });
    renderDetail(doc, model, events, selected);
    renderFeed(doc, events, selected);
  };

  const absorb = (event) => {
    if (event && event.id && !byId.has(event.id)) { byId.set(event.id, event); return true; }
    return false;
  };

  const refresh = async () => {
    try {
      const response = await fetcher('/api/coordination');
      if (!response.ok) return;
      const snapshot = await response.json();
      let changed = false;
      for (const event of snapshot.events ?? []) changed = absorb(event) || changed;
      if (changed || byId.size === 0) redraw();
    } catch { /* transient; the next poll retries */ }
  };

  refresh().then(() => redraw());
  const timer = setInterval(refresh, pollMs);

  let source = null;
  const EventSourceImpl = eventSourceImpl ?? (typeof EventSource !== 'undefined' ? EventSource : null);
  if (EventSourceImpl) {
    source = new EventSourceImpl('/api/events?skipReplay=1');
    source.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data);
        if (parsed.type === 'coordination:event' && absorb(parsed.data)) redraw();
      } catch { /* non-JSON keepalive */ }
    };
  }

  renderLegend(doc);
  doc.defaultView?.addEventListener('resize', redraw);
  return { redraw, stop: () => { clearInterval(timer); source?.close(); } };
}
