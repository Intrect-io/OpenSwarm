// ============================================
// OpenSwarm - Orchestration view (rendering + live wiring)
// ============================================
//
// Thin over the pure modules: orchestrationModel aggregates, tierLayout
// places, this file draws SVG and keeps the picture live. Rendering reads the
// full current event set every time — the model is cheap at board scale
// (≤2000 events) and idempotent redraw avoids incremental-DOM drift.

import {
  ACTIVE_WINDOW_MS, buildOrchestrationModel, collisionAddressesOf, dominantKind, filterGraphNodes, KIND_COLORS,
  nodeIdForEvent, RAIL_ROLES, taskLanesOf,
} from './orchestrationModel.mjs';
import { layoutTiers } from './tierLayout.mjs';
import {
  buildThreads, chatLineOf, isUtterance, metadataPairs, openQuestionFor, taskLabelOf, threadFor,
} from './conversationModel.mjs';
import { autogrow, bindEnterToSubmit, setSendEnabled, setSendingState } from './composer.mjs';

// Token references, not colours (AGT-4201): every role's paint is declared
// once in tokens.css, so the light theme and the chat room agree with the graph.
export const ROLE_COLORS = {
  worker: 'var(--role-worker)',
  reviewer: 'var(--role-reviewer)',
  orchestrator: 'var(--role-orchestrator)',
  'review-agent': 'var(--role-review-agent)',
  daemon: 'var(--role-daemon)',
  human: 'var(--role-human)',
  agent: 'var(--role-agent)',
};

const PENDING = new Set(['open', 'waiting', 'running']);
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Apply an SVG paint. A custom-property reference in a presentation attribute
 * resolves in current engines, but the inline style is what the cascade is
 * guaranteed to read — so a token is written to both, and the attribute stays
 * inspectable.
 */
function paint(node, key, value) {
  const text = String(value);
  node.setAttribute(key, text);
  if (text.startsWith('var(') && typeof node.style?.setProperty === 'function') node.style.setProperty(key, text);
}

function el(doc, tag, attrs = {}) {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'fill' || key === 'stroke') paint(node, key, value);
    else node.setAttribute(key, String(value));
  }
  return node;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/**
 * A drawing layer that survives redraws.
 *
 * The view used to open every render with `svg.innerHTML = ''`, throwing the
 * previous picture away wholesale — so any position change, however small,
 * arrived as a hard jump with no chance of a transition. Keeping the layers
 * and reconciling their children by key is what lets CSS animate a move.
 */
function layerOf(doc, svg, name) {
  const existing = svg.querySelector(`g[data-layer="${name}"]`);
  if (existing) return existing;
  const layer = el(doc, 'g', { 'data-layer': name });
  svg.appendChild(layer);
  return layer;
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Enter/update/exit one keyed layer.
 *
 * `create` builds a fresh element for a key it has never seen, `paint`
 * refreshes one already on screen. Keys that vanished are removed, so the DOM
 * tracks the model rather than accumulating orphans.
 */
function reconcile(layer, keyAttr, items, create, paint) {
  const alive = new Set();
  const existing = new Map();
  for (const child of layer.children) {
    const key = child.getAttribute(keyAttr);
    if (key !== null) existing.set(key, child);
  }
  for (const item of items) {
    alive.add(item.key);
    let node = existing.get(item.key);
    if (!node) {
      node = create(item);
      node.setAttribute(keyAttr, item.key);
      layer.appendChild(node);
    }
    paint(node, item);
  }
  for (const [key, node] of existing) {
    if (!alive.has(key)) node.remove();
  }
}

/**
 * Reconciliation key for one directed edge, safe to carry in an attribute.
 *
 * The two addresses have to be joined by something that cannot occur inside
 * either of them, or `a→b` and `a→b` built from different pairs could collide.
 * Percent-encoding guarantees that: `>` always encodes to `%3E`, so the `->`
 * separator can never appear within an encoded address. An out-of-band
 * delimiter such as NUL would do the same job but makes the served asset a
 * binary file to every tool that touches it.
 */
export function edgeKey(from, to) {
  return `${encodeURIComponent(from)}->${encodeURIComponent(to)}`;
}

/**
 * The click handler in force for one graph, looked up at click time.
 *
 * Node groups are created once and then reused across redraws, but `onSelect`
 * closes over the current redraw and is a different function each time. Adding
 * a listener per render would stack them; keeping the live handler here lets a
 * group bind exactly one listener for its whole lifetime.
 */
const selectHandlers = new WeakMap();

/** Node radius grows with activity but stays readable: 10..26px. */
export function nodeRadius(node) {
  return Math.min(26, 10 + Math.sqrt(node.eventCount) * 2.5);
}

export function renderStats(doc, stats) {
  const holder = doc.getElementById('stats');
  const cells = [
    ['waiting on you', stats.agentsAwaitingOperator ?? 0, (stats.agentsAwaitingOperator ?? 0) > 0],
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

/**
 * The one line on this screen the operator can act on.
 *
 * `pendingTotal` was already computed and already rendered as a stat chip, but
 * a chip among six chips is not the same as being told. An agent parked on a
 * question is blocked until somebody answers, so the count of *agents* — not
 * of questions — gets its own banner above the graph.
 */
export function renderWaitingBanner(doc, stats) {
  const holder = doc.getElementById('waiting');
  if (!holder) return;
  const waiting = stats.agentsAwaitingOperator ?? 0;
  const open = stats.pendingTotal ?? 0;
  if (waiting > 0) {
    holder.className = 'waiting is-blocking';
    holder.textContent = waiting === 1
      ? '1 agent is waiting on you'
      : `${waiting} agents are waiting on you`;
    return;
  }
  holder.className = 'waiting';
  holder.textContent = open > 0
    ? `${open} exchange${open === 1 ? '' : 's'} open · nothing needs you`
    : 'nothing is waiting on you';
}

export function renderGraph(doc, model, layout, selected, onSelect, spotlight = null) {
  const { positions, bands, labelGutter } = layout;
  const svg = doc.getElementById('graph');
  const width = svg.clientWidth || 900;
  const height = svg.clientHeight || 600;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  selectHandlers.set(svg, onSelect);

  // Layers are created once and kept. Order of first creation is paint order:
  // furniture under edges under nodes.
  const bandLayer = layerOf(doc, svg, 'bands');
  const edgeLayer = layerOf(doc, svg, 'edges');
  const nodeLayer = layerOf(doc, svg, 'nodes');

  // Band furniture is redrawn wholesale — it is static decoration that carries
  // no transition and no listener, so keying it would buy nothing.
  clearChildren(bandLayer);
  bands.forEach((band, index) => {
    if (index % 2 === 1) {
      bandLayer.appendChild(el(doc, 'rect', {
        x: 0, y: band.y0, width, height: band.y1 - band.y0,
        class: 'band-stripe', 'data-band': band.id,
      }));
    }
    if (index > 0) {
      bandLayer.appendChild(el(doc, 'line', {
        x1: 0, y1: band.y0, x2: width, y2: band.y0,
        class: 'band-rule', 'stroke-dasharray': band.kind === 'lane' ? '2 4' : '4 6',
      }));
    }
    const label = el(doc, 'text', {
      x: 12,
      y: (band.y0 + band.y1) / 2,
      class: band.kind === 'lane' ? 'tier-label lane-label' : 'tier-label',
      'data-tier-label': band.id,
    });
    label.textContent = band.label;
    bandLayer.appendChild(label);
    const count = el(doc, 'text', {
      x: 12, y: (band.y0 + band.y1) / 2 + 13, class: 'tier-count',
    });
    count.textContent = band.count === 0
      ? 'none'
      : `${band.count} ${band.kind === 'lane' ? 'in task' : 'placed'}`;
    bandLayer.appendChild(count);
  });
  bandLayer.appendChild(el(doc, 'line', {
    x1: labelGutter - 14, y1: bands[0].y0, x2: labelGutter - 14, y2: bands[bands.length - 1].y1,
    class: 'gutter-rule',
  }));

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
  // Agents now carry assigned handles (AGT-4064). A tooltip that prints the
  // routing address instead is naming something the operator never sees
  // anywhere else on the page.
  const displayName = new Map(model.nodes.map((node) => [node.id, node.name]));
  const nameOf = (id) => displayName.get(id) ?? id;

  const drawnEdges = model.edges
    .filter((edge) => positions.has(edge.from) && positions.has(edge.to))
    .map((edge) => ({ key: edgeKey(edge.from, edge.to), edge }));
  reconcile(edgeLayer, 'data-edge', drawnEdges,
    () => {
      const path = el(doc, 'path', {});
      path.appendChild(el(doc, 'title'));
      return path;
    },
    (path, { edge }) => {
      const a = positions.get(edge.from);
      const b = positions.get(edge.to);
      // A gentle quadratic bend keeps A→B and B→A visually distinct.
      const mx = (a.x + b.x) / 2 + (b.y - a.y) * 0.12;
      const my = (a.y + b.y) / 2 + (a.x - b.x) * 0.12;
      path.setAttribute('d', `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`);
      path.setAttribute('class', `edge${selected && edge.from !== selected && edge.to !== selected ? ' dimmed' : ''}`);
      paint(path, 'stroke', KIND_COLORS[dominantKind(edge)] ?? 'var(--kind-plumbing)');
      path.setAttribute('stroke-width', String(Math.min(6, 1 + Math.log2(1 + edge.count))));
      path.querySelector('title').textContent =
        `${nameOf(edge.from)} → ${nameOf(edge.to)}: ${edge.count} (${Object.entries(edge.kinds).map(([k, n]) => `${k}×${n}`).join(', ')})`;
    });

  const drawnNodes = model.nodes
    .filter((node) => positions.has(node.id))
    .map((node) => ({ key: node.id, node }));
  reconcile(nodeLayer, 'data-node', drawnNodes,
    ({ node }) => {
      const group = el(doc, 'g', {});
      // Bound once for the group's whole life; the live handler is looked up
      // through `selectHandlers` so redraws cannot stack listeners here.
      group.addEventListener('click', () => selectHandlers.get(svg)?.(node.id));
      return group;
    },
    (group, { node }) => {
      const p = positions.get(node.id);
      group.setAttribute('class', `node${selected && !neighbors.has(node.id) ? ' dimmed' : ''}`);
      group.setAttribute('transform', `translate(${p.x} ${p.y})`);
      group.removeAttribute('data-speaking');
      group.removeAttribute('data-spoken-to');
      clearChildren(group);

      const radius = nodeRadius(node);
      if (node.pendingCount > 0) {
        group.appendChild(el(doc, 'circle', { r: radius + 6, fill: 'none', stroke: 'var(--warning)', 'stroke-width': 2, class: 'pulse' }));
      }
      if (node.id === speaking) {
        group.setAttribute('data-speaking', 'true');
        group.appendChild(el(doc, 'circle', {
          r: radius + 10, fill: 'none', stroke: 'var(--fg-primary)', 'stroke-width': 2.5, class: 'speaking',
        }));
      } else if (node.id === spokenTo) {
        group.setAttribute('data-spoken-to', 'true');
        group.appendChild(el(doc, 'circle', {
          r: radius + 10, fill: 'none', stroke: 'var(--fg-primary)', 'stroke-width': 1.5,
          'stroke-opacity': 0.45, 'stroke-dasharray': '3 4', class: 'spoken-to',
        }));
      }
      group.appendChild(el(doc, 'circle', {
        r: radius,
        fill: ROLE_COLORS[node.role] ?? ROLE_COLORS.agent,
        'fill-opacity': node.active ? 0.9 : 0.35,
        stroke: node.id === selected ? 'var(--fg-primary)' : 'transparent',
        'stroke-width': 2,
      }));
      const label = el(doc, 'text', { y: radius + 12 });
      label.textContent = node.name;
      group.appendChild(label);
      const roleLabel = el(doc, 'text', { y: radius + 22, class: 'role-label' });
      roleLabel.textContent = node.role;
      group.appendChild(roleLabel);
    });
}

export function renderLegend(doc) {
  const rows = [
    ...Object.entries(ROLE_COLORS).filter(([role]) => role !== 'agent')
      .map(([role, color]) => `<div class="row"><span class="swatch" style="background:${color}"></span>${role}</div>`),
    '<div class="row legend-section">edges</div>',
    `<div class="row"><span class="line" style="background:${KIND_COLORS['advice-request']}"></span>advice / delegation</div>`,
    `<div class="row"><span class="line" style="background:${KIND_COLORS['human-question']}"></span>human question</div>`,
    `<div class="row"><span class="line" style="background:${KIND_COLORS['adapter-route']}"></span>route / mcp</div>`,
  ];
  doc.getElementById('legend').innerHTML = rows.join('');
}

/**
 * Refresh the filter controls from the current model.
 *
 * Deliberately does NOT touch the search box or rebuild a select whose options
 * are unchanged: this runs on every SSE event, and replacing an input the
 * operator is typing into would eat the caret. Only the task options and the
 * idle count actually change with the data.
 */
export function renderControls(doc, model, filters) {
  const taskSelect = doc.getElementById('filter-task');
  if (taskSelect) {
    const lanes = taskLanesOf(model.nodes);
    const signature = lanes.map((lane) => `${lane.taskId}:${lane.label}`).join('|');
    if (taskSelect.getAttribute('data-options') !== signature) {
      taskSelect.setAttribute('data-options', signature);
      taskSelect.innerHTML = ['<option value="">all tasks</option>', ...lanes.map((lane) =>
        `<option value="${escapeHtml(lane.taskId)}">${escapeHtml(lane.label)}</option>`)].join('');
    }
    // The selected task can be evicted with its lane; fall back to "all" so the
    // control never points at something that is no longer on the board.
    const wanted = filters.taskId ?? '';
    const known = wanted === '' || lanes.some((lane) => lane.taskId === wanted);
    if (!known) filters.taskId = null;
    const value = filters.taskId ?? '';
    if (taskSelect.value !== value) taskSelect.value = value;
  }

  const roleSelect = doc.getElementById('filter-role');
  if (roleSelect && roleSelect.value !== (filters.role ?? '')) roleSelect.value = filters.role ?? '';

  const idleToggle = doc.getElementById('filter-idle');
  if (idleToggle && idleToggle.checked !== filters.showIdle) idleToggle.checked = filters.showIdle;
  const idleCount = doc.getElementById('idle-count');
  if (idleCount) {
    const idle = model.stats.idleAgents ?? 0;
    idleCount.textContent = idle === 0 ? '' : `(${idle})`;
  }
}

/**
 * Bind the controls once.
 *
 * Attaching these inside the render would add a listener per redraw, and a
 * redraw happens on every coordination event — the toggle would eventually
 * fire dozens of times per click.
 */
export function wireControls(doc, filters, onChange) {
  const bind = (id, type, read) => {
    const node = doc.getElementById(id);
    if (!node || node.getAttribute('data-bound') === 'true') return;
    node.setAttribute('data-bound', 'true');
    node.addEventListener(type, () => { read(node); onChange(); });
  };
  bind('filter-search', 'input', (node) => { filters.query = node.value; });
  bind('filter-task', 'change', (node) => { filters.taskId = node.value || null; });
  bind('filter-role', 'change', (node) => { filters.role = node.value || null; });
  bind('filter-idle', 'change', (node) => { filters.showIdle = node.checked; });
}

export function renderDetail(doc, model, events, selected) {
  const holder = doc.getElementById('detail');
  const node = model.nodes.find((candidate) => candidate.id === selected);
  if (!node) {
    holder.innerHTML = '<div class="empty">Select a node</div>';
    return;
  }
  const collisions = new Set(model.collidingAddresses ?? []);
  const involved = events.filter((event) =>
    nodeIdForEvent(event, 'actor', collisions) === node.id
    || nodeIdForEvent(event, 'recipient', collisions) === node.id);
  const pending = involved.filter((event) => PENDING.has(event.status));
  holder.innerHTML = `
    <div class="name">${escapeHtml(node.name)}</div>
    <div class="meta">${escapeHtml(node.role)} · ${node.eventCount} event(s) · ${node.active ? 'active' : 'idle'}</div>
    <div class="meta">pending: ${pending.length ? escapeHtml(pending.map((event) => event.kind).join(', ')) : 'none'}</div>
    <div class="meta">last seen ${new Date(node.lastSeen).toLocaleTimeString()}</div>`;
}

function statusColor(status) {
  if (PENDING.has(status)) return 'var(--status-pending)';
  return status === 'failed' || status === 'expired' ? 'var(--status-failed)' : 'var(--status-done)';
}

function clockOf(timestamp) {
  return new Date(timestamp).toLocaleTimeString();
}

/** Metadata chips: long opaque tokens truncate visually, tooltip keeps them whole. */
function metadataChips(event) {
  const pairs = metadataPairs(event);
  return pairs.length
    ? `<div class="ev-meta">${pairs.map(([key, value]) =>
        `<span class="chip" title="${escapeHtml(`${key}: ${value}`)}"><b>${escapeHtml(key)}</b>${escapeHtml(value)}</span>`).join('')}</div>`
    : '';
}

/** Feed rows carry a preview, not the whole speech — the thread has the rest. */
function clip(text, max = 140) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `Speaker → Recipient: words` — one utterance as a line of dialogue. */
/**
 * Paint the composer's send state: the outcome line, the in-flight lock, and
 * the text still waiting to be accepted. Called on every render so a redraw
 * mid-send cannot quietly re-enable the box or drop the operator's words.
 */
function applyComposerState(doc, form, pending) {
  let line = doc.getElementById('composer-status');
  if (!line) {
    line = doc.createElement('div');
    line.id = 'composer-status';
    line.className = 'composer-status';
    form.insertAdjacentElement('afterend', line);
  }
  const input = doc.getElementById('composer-text');
  const button = form.querySelector('button');
  const active = !!pending?.active;
  line.textContent = active ? 'Sending…' : (pending?.message ?? '');
  line.classList.toggle('is-error', !active && !!pending?.message);
  if (input) {
    input.disabled = active;
    if (pending?.text !== undefined) input.value = pending.text;
  }
  setSendingState(button, active);
  setSendEnabled(button, { text: input?.value ?? '', addressable: true, sending: active });
}

function dialogueLine(event, max = 140) {
  const line = chatLineOf(event);
  const to = line.recipientName ? ` → <span class="who">${escapeHtml(line.recipientName)}</span>` : '';
  return `<span class="who">${escapeHtml(line.speakerName)}</span>${to}: ${escapeHtml(clip(line.text, max))}`;
}

/**
 * The feed, read as a conversation. Every row says when it happened, which
 * task it belongs to, and who said what to whom; plumbing events that are not
 * speech (instruction snapshots) stay off the surface entirely.
 */
export function renderFeed(doc, events, selected, focusedEventId, onFocus) {
  const collisions = collisionAddressesOf(events);
  const feed = doc.getElementById('feed');
  const shown = (selected
    ? events.filter((event) =>
      nodeIdForEvent(event, 'actor', collisions) === selected
      || nodeIdForEvent(event, 'recipient', collisions) === selected)
    : events
  ).filter(isUtterance).slice(-80).reverse();
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
      <div class="ev-line">${dialogueLine(event)}</div>
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
export function renderThread(doc, thread, onSend, pending = null) {
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
  // Chat bubbles: the speaker addressing the recipient, then the words said.
  // The role rides along as a small tag; the operator's bubbles are set apart.
  const transcript = thread.events.filter(isUtterance).map((event) => {
    const line = chatLineOf(event);
    return `
    <div class="msg${line.isOperator ? ' from-operator' : ''}">
      <div class="msg-head">
        <span class="who" style="color:${ROLE_COLORS[event.actorRole] ?? ROLE_COLORS.agent}">${escapeHtml(line.speakerName)}</span>
        ${line.recipientName ? `<span class="to">→ ${escapeHtml(line.recipientName)}</span>` : ''}
        ${line.speakerRole ? `<span class="role-tag">${escapeHtml(line.speakerRole)}</span>` : ''}
        <span class="clock">${escapeHtml(clockOf(event.timestamp))}</span>
      </div>
      <div class="msg-text">${escapeHtml(line.text)}</div>
      ${metadataChips(event)}
    </div>`;
  }).join('');

  const target = thread.replyTo ? escapeHtml(thread.replyTo.name) : null;
  const composer = target
    ? `<form class="composer" id="composer">
        <textarea id="composer-text" class="textarea" rows="1" autocomplete="off"
          placeholder="Reply to ${target}…" aria-label="Reply to ${target}"></textarea>
        <button type="submit" class="btn btn-primary">Send</button>
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
  // A send takes seconds under load (AGT-4027) and agent events keep arriving,
  // so a redraw lands mid-flight and replaces this very form. The pending state
  // therefore lives in the caller and is re-applied on every render below,
  // rather than being held in DOM nodes this handler captured.
  applyComposerState(doc, form, pending);
  // The box is rebuilt on every render, so its behaviours are re-bound here:
  // grow with the reply, Enter sends (never mid-IME), Send lights up with text.
  const box = doc.getElementById('composer-text');
  autogrow(box);
  bindEnterToSubmit(box, form);
  box?.addEventListener('input', () => {
    setSendEnabled(form.querySelector('button'), { text: box.value, addressable: true, sending: !!pending?.active });
  });

  form.addEventListener('submit', (submitEvent) => {
    submitEvent.preventDefault();
    const input = doc.getElementById('composer-text');
    const text = input.value.trim();
    if (!text) return;
    onSend(thread, text);
  });
}

/** Entry point: fetch, render, then keep live via SSE with a polling backstop. */
export function startOrchestrationView(doc, { fetchImpl, eventSourceImpl, pollMs = 30_000 } = {}) {
  // Forward the init: every send passes {method:'POST', headers, body} as the
  // second argument, and dropping it turned each one into a GET — a path with
  // no GET route, so the daemon answered 404 and the operator's reply never
  // left the browser (AGT-4029).
  const fetcher = fetchImpl ?? ((url, init) => fetch(url, init));
  const byId = new Map();
  let selected = null;
  let focusedEventId = null;
  const composerStates = new Map();
  const filters = { showIdle: false, taskId: null, role: null, query: '' };

  // Returns the failure reason, or null when the message was accepted. `fetch`
  // resolves on 400/409, so the server's "cannot address this" and "already
  // answered" both look like success unless `ok` is checked — and an operator
  // whose reply is silently dropped is the one person who must never be lied
  // to, since a parked agent is waiting on it (AGT-4026).
  const send = async (thread, text) => {
    // Kept per exchange, not in the form and not in one slot: a redraw can
    // replace the composer while this awaits, the operator can move to another
    // exchange mid-send and start a second one there, and neither send may
    // land its text or its verdict on the other's composer.
    const correlationId = thread?.correlationId ?? null;
    composerStates.set(correlationId, { active: true, message: '', text });
    redraw();
    const failure = await publish(thread, text);
    if (failure) {
      composerStates.set(correlationId, { active: false, message: failure, text });
    } else {
      // Accepted: nothing left to say, and keeping the entry would grow the map
      // one exchange at a time for the life of the page.
      composerStates.delete(correlationId);
    }
    redraw();
  };

  const publish = async (thread, text) => {
    // Answering beats chatting: an agent parked on a question needs the message
    // on THAT exchange, or the daemon files it as a note and it stays blocked
    // (AGT-4030).
    const question = openQuestionFor([...byId.values()], thread.replyTo?.address, {
      repository: thread.events[0]?.repository,
      taskId: thread.taskId,
    });
    let response;
    try {
      response = await fetcher('/api/coordination/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          correlationId: question?.correlationId ?? thread.correlationId,
          recipient: thread.replyTo?.address,
          repository: question?.repository ?? thread.events[0]?.repository,
          taskId: question?.taskId ?? thread.taskId,
          text,
        }),
      });
    } catch (error) {
      return error?.message ? `Could not reach the daemon: ${error.message}` : 'Could not reach the daemon.';
    }
    if (!response?.ok) {
      let reason = `The daemon refused the message (${response?.status ?? 'no status'}).`;
      try {
        const body = await response.json();
        if (body?.error) reason = body.error;
      } catch { /* a refusal without a JSON body still has its status */ }
      return reason;
    }
    // Re-read rather than echoing locally: the board decides what was actually
    // published (an answer to a blocking question looks different from a note).
    await refresh();
    return null;
  };

  // Every path back into the DOM funnels through `redraw`, so one guard here
  // covers them all: a fetch that was already in flight when `stop()` was
  // called, a late SSE frame, a resize, a control change. Without it the
  // resolving fetch would rebuild the graph and arm a fresh liveness timer
  // that nothing is left to clear.
  let stopped = false;

  const redraw = () => {
    if (stopped) return;
    const events = [...byId.values()].sort((a, b) => a.seq - b.seq);
    const model = buildOrchestrationModel(events);
    // Only what is drawn can be selected: a node hidden by the liveness filter
    // would otherwise stay selected invisibly and keep the feed narrowed to it
    // with nothing on screen explaining why.
    const visible = filterGraphNodes(model.nodes, filters);
    if (selected && !visible.some((node) => node.id === selected)) selected = null;
    const focused = focusedEventId ? byId.get(focusedEventId) ?? null : null;
    if (focusedEventId && !focused) focusedEventId = null;
    const threads = buildThreads(events);
    const svg = doc.getElementById('graph');
    const layout = layoutTiers(visible, {
      width: svg.clientWidth || 900,
      height: svg.clientHeight || 600,
      // Derived from the FULL board, not the filtered set: a lane's age is a
      // property of the task, and hiding one idle member must not restack the
      // conversations above and below it.
      laneOrder: taskLanesOf(model.nodes).map((lane) => lane.taskId),
    });
    renderStats(doc, model.stats);
    renderWaitingBanner(doc, model.stats);
    renderControls(doc, model, filters);
    renderGraph(doc, model, layout, selected, (id) => {
      selected = selected === id ? null : id;
      redraw();
    }, focused ? {
      actor: nodeIdForEvent(focused, 'actor', new Set(model.collidingAddresses)),
      recipient: nodeIdForEvent(focused, 'recipient', new Set(model.collidingAddresses)) ?? null,
    } : null);
    renderDetail(doc, model, events, selected);
    renderFeed(doc, events, selected, focusedEventId, (id) => {
      focusedEventId = focusedEventId === id ? null : id;
      redraw();
    });
    const shownThread = threadFor(threads, focused);
    renderThread(doc, shownThread, send, composerStates.get(shownThread?.correlationId ?? null) ?? null);
    scheduleLivenessSweep(model.nodes);
  };

  // Liveness is measured against wall time, but only an event, a poll change,
  // a resize or a control action redraws — so on a quiet board an agent that
  // went idle stayed on screen indefinitely, which is exactly the unbounded
  // population this change exists to remove. Wake once, at the moment the next
  // still-active agent crosses the window, rather than polling for it.
  let livenessTimer = null;
  const scheduleLivenessSweep = (nodes) => {
    if (livenessTimer) clearTimeout(livenessTimer);
    livenessTimer = null;
    // Rails never age out of the picture, so their expiry is not a wake reason.
    const expiries = nodes
      .filter((node) => node.active && !RAIL_ROLES.has(node.role))
      .map((node) => node.lastSeen + ACTIVE_WINDOW_MS);
    if (expiries.length === 0) return;
    const due = Math.min(...expiries) - Date.now();
    // A small margin past the boundary: waking exactly on it can still read as
    // active by a millisecond and schedule the same wake again.
    livenessTimer = setTimeout(redraw, Math.max(250, due + 250));
  };

  // The server ring drops coordination events at 2000; this map used to keep
  // every one it was ever handed, so a dashboard left open for a shift held
  // more history than the daemon does and every agent that ever spoke stayed a
  // node forever.
  //
  // `MAX_EVENTS` is a ceiling, not an average: pruning triggers the moment the
  // map exceeds it, so `byId.size <= MAX_EVENTS` holds after every absorb. The
  // batch is what makes it cheap — each prune frees `PRUNE_BATCH` slots, so the
  // sort is paid for once per batch of arrivals rather than once per event.
  const MAX_EVENTS = 2000;
  const PRUNE_BATCH = 256;
  const prune = () => {
    if (byId.size <= MAX_EVENTS) return;
    const ordered = [...byId.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const target = Math.max(0, MAX_EVENTS - PRUNE_BATCH);
    for (const event of ordered.slice(0, byId.size - target)) byId.delete(event.id);
  };

  const absorb = (event) => {
    if (event && event.id) {
      const previous = byId.get(event.id);
      const changed = !previous
        || previous.summary !== event.summary
        || previous.detail !== event.detail
        || previous.localizedLocale !== event.localizedLocale;
      if (!changed) return false;
      byId.set(event.id, event);
      prune();
      return true;
    }
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
  wireControls(doc, filters, redraw);
  // Removed on stop with the same reference it was added with. Leaving it
  // attached kept a stopped view repainting the graph — and holding the whole
  // event map and its closures — for as long as the page lived.
  doc.defaultView?.addEventListener('resize', redraw);
  return {
    redraw,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      if (livenessTimer) clearTimeout(livenessTimer);
      source?.close();
      doc.defaultView?.removeEventListener('resize', redraw);
    },
  };
}
