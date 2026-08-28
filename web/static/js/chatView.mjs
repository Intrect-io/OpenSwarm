// ============================================
// OpenSwarm - Chat room view (one chronological room across every task)
// ============================================
//
// The orchestration page reads one exchange at a time; this page is the whole
// floor at once — every agent utterance on every task, in the order it was
// said, IRC-style. Backfill comes from the durable trace
// (`/api/coordination/history`), live updates from the same SSE channel the
// orchestration view uses, with the board snapshot as a polling backstop.

import { buildChatLines, latestAddressable, openQuestionFor } from './conversationModel.mjs';
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
  const button = form?.querySelector('button[type="submit"]');
  const fileInput = doc.getElementById('composer-file');
  const attachButton = doc.getElementById('composer-attach');
  const fileRow = doc.getElementById('composer-files');
  let sending = false;
  // Files the operator has staged but not yet sent. Held until the message goes
  // out so a refused send does not silently discard them (AGT-4026's rule,
  // applied to attachments).
  let pendingFiles = [];
  // Where each staged file landed, once it has, and which task it landed under.
  // Keyed by the File itself, which survives a failed send because the staging
  // list does — but the operator can switch exchanges between the failure and
  // the retry, and a path carrying the old task must not ride a message going to
  // a new one.
  const uploaded = new Map();

  const renderFiles = () => {
    if (!fileRow) return;
    fileRow.innerHTML = '';
    pendingFiles.forEach((file, index) => {
      const chip = doc.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`;
      const drop = doc.createElement('button');
      drop.type = 'button';
      drop.textContent = '×';
      drop.title = `Remove ${file.name}`;
      drop.addEventListener('click', () => {
        uploaded.delete(file);
        pendingFiles = pendingFiles.filter((_, i) => i !== index);
        renderFiles();
      });
      chip.appendChild(drop);
      fileRow.appendChild(chip);
    });
  };

  const stageFiles = (list) => {
    pendingFiles = [...pendingFiles, ...Array.from(list ?? [])];
    renderFiles();
  };

  /**
   * Upload the staged files and return the lines that tell the agent where they
   * landed. The daemon writes them under its own state directory and hands back
   * an absolute path, so the agent opens them with the file tools it already
   * has — no new tool contract.
   */
  const uploadFiles = async (taskId, files) => {
    const lines = [];
    for (const file of files) {
      // A file that already landed keeps its line. Publishing can fail after the
      // uploads succeed — an unaddressable message, an answer that arrived
      // first — and re-uploading on the retry would duplicate the bytes; the
      // orphans then count against the store's ceiling and make the retry more
      // likely to be refused than the attempt that failed.
      const landed = uploaded.get(file);
      if (landed && landed.taskId === taskId) {
        lines.push(landed.line);
        continue;
      }
      const query = `?taskId=${encodeURIComponent(taskId)}&filename=${encodeURIComponent(file.name)}`;
      const response = await fetcher(`/api/coordination/attachment${query}`, { method: 'POST', body: file });
      if (!response?.ok) {
        let reason = `upload failed (${response?.status ?? 'no status'})`;
        try {
          const failure = await response.json();
          if (failure?.error) reason = failure.error;
        } catch { /* a refusal without a body still has its status */ }
        throw new Error(`${file.name}: ${reason}`);
      }
      const stored = await response.json();
      const line = `- ${stored.filename} → ${stored.path}`;
      uploaded.set(file, { taskId, line });
      lines.push(line);
    }
    return lines;
  };

  // One line under the composer carrying the send's outcome. Created on demand
  // so the shell markup does not have to know about it.
  const setComposerStatus = (message, { pending = false } = {}) => {
    if (!form) return;
    let line = doc.getElementById('composer-status');
    if (!line) {
      line = doc.createElement('div');
      line.id = 'composer-status';
      line.className = 'composer-status';
      form.insertAdjacentElement('afterend', line);
    }
    sending = pending;
    line.textContent = pending ? 'Sending…' : message;
    line.classList.toggle('is-error', !pending && !!message);
    const addressable = !!latestAddressable([...byId.values()]);
    if (input) input.disabled = pending || !addressable;
    if (button) button.disabled = pending || !addressable;
  };

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
    const question = target
      ? openQuestionFor(events, target.actor, { repository: target.repository, taskId: target.taskId })
      : null;
    if (input) {
      // A send takes seconds under load (AGT-4027) and agent events keep
      // arriving, so a redraw lands mid-flight — it must not re-enable the box
      // the send just locked.
      input.disabled = !target || sending;
      // Say which of the two things the next message will do: unpark an agent
      // that is waiting, or just speak into the room.
      input.placeholder = !target
        ? 'No agent to address yet'
        : question
          ? `Answer ${target.actorName || target.actor}: ${(question.summary || '').slice(0, 60)}…`
          : `Message ${target.actorName || target.actor}…`;
    }
    if (button) button.disabled = !target || sending;
    if (stick) room.scrollTop = room.scrollHeight;
  };

  const absorb = (event) => {
    if (event && event.id && !byId.has(event.id)) { byId.set(event.id, event); return true; }
    return false;
  };

  // Interjections join the newest exchange: the message is addressed to the
  // last agent that spoke, exactly like replying in a busy room. Same POST
  // contract (and same bare-fetch auth posture) as the orchestration composer.
  // Returns the failure reason, or null when the message was accepted. The
  // caller keeps the operator's text until it hears null: a refusal that
  // silently ate the message is worse than no composer at all, and `fetch`
  // resolves happily on 400/409 — the server's own "cannot address this" and
  // "already answered" both arrive that way (AGT-4026).
  const send = async (text) => {
    const events = [...byId.values()];
    const target = latestAddressable(events);
    if (!target) return 'No agent is addressable yet.';
    // Answering beats chatting: if this agent is parked on a question, the
    // message has to ride that exchange or the daemon files it as a note and
    // the agent stays blocked (AGT-4030).
    const question = openQuestionFor(events, target.actor, { repository: target.repository, taskId: target.taskId });
    const exchange = question ?? target;

    // Upload before publishing: the message has to carry paths that already
    // exist, or the agent reads it and finds nothing there.
    // Snapshot what is being sent. A publish takes seconds under load
    // (AGT-4027) and the operator can stage another file meanwhile — clearing
    // the live list on success would throw that one away unsent.
    const sendingFiles = [...pendingFiles];
    let body = text;
    if (sendingFiles.length > 0) {
      let attached;
      try {
        attached = await uploadFiles(exchange.taskId, sendingFiles);
      } catch (error) {
        return error?.message ? `Could not attach: ${error.message}` : 'Could not attach the files.';
      }
      body = `${text}\n\nAttached files (read them at these paths):\n${attached.join('\n')}`;
    }
    let response;
    try {
      response = await fetcher('/api/coordination/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          correlationId: exchange.correlationId,
          recipient: target.actor,
          repository: exchange.repository,
          taskId: exchange.taskId,
          text: body,
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
    // Sent: drop exactly what went out, keeping anything staged since.
    pendingFiles = pendingFiles.filter((file) => !sendingFiles.includes(file));
    sendingFiles.forEach((file) => uploaded.delete(file));
    renderFiles();
    // Re-read rather than echoing locally: the board decides what was published.
    await refresh();
    return null;
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

  if (attachButton && fileInput) {
    attachButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      stageFiles(fileInput.files);
      fileInput.value = '';
    });
  }

  // A drop that misses the room lands on the document, where the browser's
  // default is to navigate to the file — abandoning the page, the composer text
  // and every staged file with it. Swallow those before they get that far.
  const swallowStrayDrop = (event) => event.preventDefault();
  doc.addEventListener('dragover', swallowStrayDrop);
  doc.addEventListener('drop', swallowStrayDrop);

  // Drag-and-drop onto the room, the way an operator expects it to work.
  if (room) {
    const highlight = (on) => doc.body?.classList.toggle('dropping', on);
    room.addEventListener('dragover', (dragEvent) => { dragEvent.preventDefault(); highlight(true); });
    room.addEventListener('dragleave', () => highlight(false));
    room.addEventListener('drop', (dropEvent) => {
      dropEvent.preventDefault();
      highlight(false);
      stageFiles(dropEvent.dataTransfer?.files);
    });
  }

  if (form) {
    form.addEventListener('submit', async (submitEvent) => {
      submitEvent.preventDefault();
      const text = input.value.trim();
      // A file with no words is still a message worth sending.
      if (!text && pendingFiles.length === 0) return;
      // The publish queues behind the agents' own board traffic and has been
      // measured at seconds under load (AGT-4027), so say it is in flight
      // rather than looking dead — and hold the text until it lands.
      setComposerStatus('', { pending: true });
      const failure = await send(text);
      setComposerStatus(failure ?? '', { pending: false });
      if (!failure) input.value = '';
    });
  }

  return {
    redraw,
    stop: () => {
      clearInterval(timer);
      source?.close();
      doc.removeEventListener('dragover', swallowStrayDrop);
      doc.removeEventListener('drop', swallowStrayDrop);
    },
  };
}
