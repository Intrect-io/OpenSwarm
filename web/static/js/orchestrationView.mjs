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
import {
  buildThreads, describeEvent, metadataPairs, speakerOf, addresseeOf, taskLabelOf, threadFor,
} from './conversationModel.mjs';

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

export function renderGraph(doc, model, layout, selected, onSelect, spotlight = null) {
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
  // Clicking a feed row asks "who said this": the speaker gets the loud ring,
  // the addressee a quieter one, so a single message reads off the hierarchy.
  const speaking = spotlight?.actor ?? null;
  const spokenTo = spotlight?.recipient ?? null;

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
    if (node.id === speaking) {
      group.setAttribute('data-speaking', 'true');
      group.appendChild(el(doc, 'circle', {
        r: radius + 10, fill: 'none', stroke: '#e6e9ef', 'stroke-width': 2.5, class: 'speaking',
      }));
    } else if (node.id === spokenTo) {
      group.setAttribute('data-spoken-to', 'true');
      group.appendChild(el(doc, 'circle', {
        r: radius + 10, fill: 'none', stroke: '#e6e9ef', 'stroke-width': 1.5,
        'stroke-opacity': 0.45, 'stroke-dasharray': '3 4', class: 'spoken-to',
      }));
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

function statusColor(status) {
  if (PENDING.has(status)) return '#e8b339';
  return status === 'failed' || status === 'expired' ? '#e5484d' : '#4cc38a';
}

function clockOf(timestamp) {
  return new Date(timestamp).toLocaleTimeString();
}

/** Body of one message: the summary, its long form, and any metadata. */
function messageBody(event) {
  const pairs = metadataPairs(event);
  const detail = event.detail && event.detail !== event.summary
    ? `<div class="ev-detail">${escapeHtml(event.detail)}</div>`
    : '';
  const meta = pairs.length
    ? `<div class="ev-meta">${pairs.map(([key, value]) =>
        `<span class="chip"><b>${escapeHtml(key)}</b>${escapeHtml(value)}</span>`).join('')}</div>`
    : '';
  return `<div class="ev-summary">${escapeHtml(event.summary)}</div>${detail}${meta}`;
}

/**
 * The feed. Every row says when it happened, which task it belongs to, who
 * spoke and to whom — the raw summary alone was unreadable for system events.
 */
export function renderFeed(doc, events, selected, focusedEventId, onFocus) {
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
    const task = taskLabelOf(event);
    return `<div class="ev${event.id === focusedEventId ? ' focused' : ''}" data-event="${escapeHtml(event.id)}" role="button" tabindex="0">
      <div class="ev-head">
        <span class="status" style="color:${statusColor(event.status)}">${escapeHtml(event.status)}</span>
        ${task ? `<span class="task-chip">${escapeHtml(task)}</span>` : ''}
        <span class="clock">${escapeHtml(clockOf(event.timestamp))}</span>
      </div>
      <div class="ev-line">${escapeHtml(describeEvent(event))}</div>
      ${messageBody(event)}
    </div>`;
  }).join('');

  if (!onFocus) return;
  for (const row of feed.querySelectorAll('[data-event]')) {
    const id = row.getAttribute('data-event');
    row.addEventListener('click', () => onFocus(id));
    row.addEventListener('keydown', (keyEvent) => {
      if (keyEvent.key === 'Enter' || keyEvent.key === ' ') { keyEvent.preventDefault(); onFocus(id); }
    });
  }
}

/**
 * The conversation the focused event belongs to, rendered as a transcript with
 * a composer. Speaking here is not decoration: the message is addressed to the
 * agent, which picks it up on its next `coordination_read`.
 */
export function renderThread(doc, thread, onSend) {
  const holder = doc.getElementById('thread');
  if (!holder) return;
  if (!thread) {
    holder.innerHTML = '<div class="empty">Select an event to read its conversation</div>';
    return;
  }
  const task = thread.taskLabel ? `<span class="task-chip">${escapeHtml(thread.taskLabel)}</span>` : '';
  const waiting = thread.awaitingOperator
    ? '<span class="await-chip">awaiting your answer</span>'
    : '';
  const transcript = thread.events.map((event) => `
    <div class="msg${event.actorRole === 'human' ? ' from-operator' : ''}">
      <div class="msg-head">
        <span class="who" style="color:${ROLE_COLORS[event.actorRole] ?? ROLE_COLORS.agent}">${escapeHtml(speakerOf(event))}</span>
        ${addresseeOf(event) ? `<span class="to">to ${escapeHtml(addresseeOf(event))}</span>` : ''}
        <span class="clock">${escapeHtml(clockOf(event.timestamp))}</span>
      </div>
      ${messageBody(event)}
    </div>`).join('');

  const target = thread.replyTo ? escapeHtml(thread.replyTo.name) : null;
  const composer = target
    ? `<form class="composer" id="composer">
        <input id="composer-text" type="text" autocomplete="off"
          placeholder="Reply to ${target}…" aria-label="Reply to ${target}" />
        <button type="submit">Send</button>
       </form>`
    : '<div class="empty">No agent in this exchange can be addressed</div>';

  holder.innerHTML = `
    <div class="thread-head">${task}${waiting}
      <span class="participants">${escapeHtml(thread.participants.map((p) => p.name).join(' · '))}</span>
    </div>
    <div class="transcript">${transcript}</div>
    ${composer}`;

  const form = doc.getElementById('composer');
  if (!form || !onSend) return;
  form.addEventListener('submit', (submitEvent) => {
    submitEvent.preventDefault();
    const input = doc.getElementById('composer-text');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    onSend(thread, text);
  });
}

/** Entry point: fetch, render, then keep live via SSE with a polling backstop. */
export function startOrchestrationView(doc, { fetchImpl, eventSourceImpl, pollMs = 30_000 } = {}) {
  const fetcher = fetchImpl ?? ((url) => fetch(url));
  const byId = new Map();
  let selected = null;
  let focusedEventId = null;

  const send = async (thread, text) => {
    try {
      await fetcher('/api/coordination/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          correlationId: thread.correlationId,
          recipient: thread.replyTo?.address,
          repository: thread.events[0]?.repository,
          taskId: thread.taskId,
          text,
        }),
      });
    } catch { /* the next poll shows whether it landed */ }
    // Re-read rather than echoing locally: the board decides what was actually
    // published (an answer to a blocking question looks different from a note).
    await refresh();
  };

  const redraw = () => {
    const events = [...byId.values()].sort((a, b) => a.seq - b.seq);
    const model = buildOrchestrationModel(events);
    if (selected && !model.nodes.some((node) => node.id === selected)) selected = null;
    const focused = focusedEventId ? byId.get(focusedEventId) ?? null : null;
    if (focusedEventId && !focused) focusedEventId = null;
    const threads = buildThreads(events);
    const svg = doc.getElementById('graph');
    const layout = layoutTiers(model.nodes, {
      width: svg.clientWidth || 900,
      height: svg.clientHeight || 600,
    });
    renderStats(doc, model.stats);
    renderGraph(doc, model, layout, selected, (id) => {
      selected = selected === id ? null : id;
      redraw();
    }, focused ? { actor: focused.actor, recipient: focused.recipient ?? null } : null);
    renderDetail(doc, model, events, selected);
    renderFeed(doc, events, selected, focusedEventId, (id) => {
      focusedEventId = focusedEventId === id ? null : id;
      redraw();
    });
    renderThread(doc, threadFor(threads, focused), send);
  };

  const absorb = (event) => {
    if (event && event.id && !byId.has(event.id)) { byId.set(event.id, event); return true; }
    return false;
  };

  async function refresh() {
    try {
      const response = await fetcher('/api/coordination');
      if (!response.ok) return;
      const snapshot = await response.json();
      let changed = false;
      for (const event of snapshot.events ?? []) changed = absorb(event) || changed;
      if (changed || byId.size === 0) redraw();
    } catch { /* transient; the next poll retries */ }
  }

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
