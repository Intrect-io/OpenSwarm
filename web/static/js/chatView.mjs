// ============================================
// OpenSwarm - Chat room view (one chronological room across every task)
// ============================================
//
// The orchestration page reads one exchange at a time; this page is the whole
// floor at once — every agent utterance on every task, in the order it was
// said, IRC-style. Backfill comes from the durable trace
// (`/api/coordination/history`), live updates from the same SSE channel the
// orchestration view uses, with the board snapshot as a polling backstop.

import { buildChatLines, latestAddressable } from './conversationModel.mjs';
import { ROLE_COLORS } from './orchestrationView.mjs';

const PENDING = new Set(['open', 'waiting', 'running']);

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function clockOf(timestamp) {
  return new Date(timestamp).toLocaleTimeString();
}

/**
 * Whether the room should stay pinned to the newest line. Reading scrollback
 * must survive a redraw, so the pin releases as soon as the operator scrolls
 * meaningfully away from the bottom.
 */
export function isNearBottom({ scrollHeight, scrollTop, clientHeight }, slack = 40) {
  return scrollHeight - scrollTop - clientHeight <= slack;
}

/** `[14:02] name (worker · AGT-1009): message` as one room line. */
export function renderLine(line) {
  const color = ROLE_COLORS[line.role] ?? ROLE_COLORS.agent;
  const tagParts = [line.speakerRole, line.taskLabel].filter(Boolean);
  const tag = tagParts.length ? `<span class="tag">(${escapeHtml(tagParts.join(' · '))})</span> ` : '';
  const statusClass = PENDING.has(line.status) ? ' pending'
    : line.status === 'failed' || line.status === 'expired' ? ' failed' : '';
  const to = line.recipientName ? `<span class="to">→ ${escapeHtml(line.recipientName)}</span>` : '';
  return `<div class="line${line.isOperator ? ' from-operator' : ''}${statusClass}" data-line="${escapeHtml(line.id)}">
    <span class="clock">[${escapeHtml(clockOf(line.timestamp))}]</span>
    <span class="who" style="color:${color}">${escapeHtml(line.speakerName)}</span>
    ${tag}${to}<span class="sep">:</span> <span class="text">${escapeHtml(line.text)}</span>
  </div>`;
}

/** Entry point: backfill from the trace, render, keep live via SSE + polling. */
export function startChatView(doc, { fetchImpl, eventSourceImpl, pollMs = 30_000 } = {}) {
  const fetcher = fetchImpl ?? ((url, init) => fetch(url, init));
  const byId = new Map();
  let stick = true;

  const room = doc.getElementById('room');
  const form = doc.getElementById('composer');
  const input = doc.getElementById('composer-text');
  const button = form?.querySelector('button');

  room.addEventListener('scroll', () => { stick = isNearBottom(room); });

  const redraw = () => {
    const events = [...byId.values()];
    const lines = buildChatLines(events);
    room.innerHTML = lines.length
      ? lines.map(renderLine).join('')
      : '<div class="empty">No one has said anything yet.</div>';
    // The composer can only address an agent that exists; without one the
    // POST would be unroutable (the API requires repository/taskId/recipient).
    const target = latestAddressable(events);
    if (input) {
      input.disabled = !target;
      input.placeholder = target
        ? `Message ${target.actorName || target.actor}…`
        : 'No agent to address yet';
    }
    if (button) button.disabled = !target;
    if (stick) room.scrollTop = room.scrollHeight;
  };

  const absorb = (event) => {
    if (event && event.id && !byId.has(event.id)) { byId.set(event.id, event); return true; }
    return false;
  };

  // Interjections join the newest exchange: the message is addressed to the
  // last agent that spoke, exactly like replying in a busy room. Same POST
  // contract (and same bare-fetch auth posture) as the orchestration composer.
  const send = async (text) => {
    const target = latestAddressable([...byId.values()]);
    if (!target) return;
    try {
      await fetcher('/api/coordination/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          correlationId: target.correlationId,
          recipient: target.actor,
          repository: target.repository,
          taskId: target.taskId,
          text,
        }),
      });
    } catch { /* the next poll shows whether it landed */ }
    // Re-read rather than echoing locally: the board decides what was published.
    await refresh();
  };

  /** The durable trace reaches back past the board's ring-buffer window. */
  async function backfill() {
    try {
      const response = await fetcher('/api/coordination/history?limit=500');
      if (!response.ok) return;
      const snapshot = await response.json();
      let changed = false;
      for (const event of snapshot.events ?? []) changed = absorb(event) || changed;
      if (changed || byId.size === 0) redraw();
    } catch { /* transient; the poll below retries via the board */ }
  }

  async function refresh() {
    try {
      const response = await fetcher('/api/coordination');
      if (!response.ok) return;
      const snapshot = await response.json();
      let changed = false;
      for (const event of snapshot.events ?? []) changed = absorb(event) || changed;
      if (changed) redraw();
    } catch { /* transient; the next poll retries */ }
  }

  backfill().then(() => refresh()).then(() => redraw());
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

  if (form) {
    form.addEventListener('submit', (submitEvent) => {
      submitEvent.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      send(text);
    });
  }

  return { redraw, stop: () => { clearInterval(timer); source?.close(); } };
}
