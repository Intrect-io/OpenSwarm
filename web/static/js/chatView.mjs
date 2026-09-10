// ============================================
// OpenSwarm - Chat room view (one chronological room across every task)
// ============================================
//
// The orchestration page reads one exchange at a time; this page is the whole
// floor at once — every agent utterance on every task, in the order it was
// said, IRC-style. Backfill comes from the durable trace
// (`/api/coordination/history`), live updates from the same SSE channel the
// orchestration view uses, with the board snapshot as a polling backstop.

import { buildChatThreads, latestAddressable, openQuestionFor } from './conversationModel.mjs';
import { ROLE_COLORS } from './orchestrationView.mjs';
import { autogrow, bindDraft, bindEnterToSubmit, setSendEnabled, setSendingState } from './composer.mjs';
import { createScrollFollow } from './scrollFollow.mjs';

// The pin/release rule lives with the other stream-following behaviour now;
// re-exported so the room's callers (and its tests) keep one import.
export { isNearBottom } from './scrollFollow.mjs';

const PENDING = new Set(['open', 'waiting', 'running']);
const DRAFT_KEY = 'openswarm.chat.draft';

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function clockOf(timestamp) {
  return new Date(timestamp).toLocaleTimeString();
}

function mentionMarkup(name, role = '') {
  const classes = `mention${role === 'human' ? ' mention-human' : ''}`;
  return `<span class="${classes}">@&#39;${escapeHtml(name)}&#39;</span>`;
}

/** Canonicalize known participant names inside prose as highlighted @'name' mentions. */
export function renderMentionText(text, targets = []) {
  const byName = new Map();
  for (const target of targets) {
    const name = String(target?.name ?? '').trim();
    if (name.length < 2) continue;
    const current = byName.get(name);
    if (!current || target.role === 'human') byName.set(name, { name, role: target.role ?? '' });
  }
  const names = [...byName.values()].sort((a, b) => b.name.length - a.name.length);
  if (names.length === 0) return escapeHtml(text);

  const source = String(text ?? '');
  let cursor = 0;
  let html = '';
  while (cursor < source.length) {
    let found = null;
    for (const target of names) {
      let index = source.indexOf(target.name, cursor);
      while (index >= 0) {
        const before = source[index - 1] ?? '';
        const after = source[index + target.name.length] ?? '';
        // Callsigns may be followed immediately by a Korean particle (`의`,
        // `에게`), but must not light up inside another ASCII identifier.
        if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) break;
        index = source.indexOf(target.name, index + 1);
      }
      if (index < 0) continue;
      if (!found || index < found.index || (index === found.index && target.name.length > found.target.name.length)) {
        found = { index, target };
      }
    }
    if (!found) {
      html += escapeHtml(source.slice(cursor));
      break;
    }

    let mentionStart = found.index;
    let mentionEnd = found.index + found.target.name.length;
    if (source.slice(Math.max(cursor, mentionStart - 2), mentionStart) === "@'" && source[mentionEnd] === "'") {
      mentionStart -= 2;
      mentionEnd += 1;
    } else if (mentionStart > cursor && source[mentionStart - 1] === '@') {
      mentionStart -= 1;
    }
    html += escapeHtml(source.slice(cursor, mentionStart));
    html += mentionMarkup(found.target.name, found.target.role);
    cursor = mentionEnd;
  }
  return html;
}

/** Highlight inline code without allowing it to become executable markup. */
export function renderChatText(text, targets = []) {
  return String(text ?? '').split(/(`[^`\n]+`)/g).map((part) => {
    if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
      return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    }
    return renderMentionText(part, targets);
  }).join('');
}

/** `[14:02] name (worker · AGT-1009): message` as one room line. */
export function renderLine(line, mentionTargets = [], { hideTask = false } = {}) {
  const color = ROLE_COLORS[line.role] ?? ROLE_COLORS.agent;
  const tagParts = [line.speakerRole, hideTask ? '' : line.taskLabel].filter(Boolean);
  const tag = tagParts.length ? `<span class="tag">(${escapeHtml(tagParts.join(' · '))})</span> ` : '';
  const statusClass = PENDING.has(line.status) ? ' pending'
    : line.status === 'failed' || line.status === 'expired' ? ' failed' : '';
  const to = line.recipientName
    ? `<span class="to">→ ${mentionMarkup(line.recipientName, line.recipientRole)}</span>`
    : '';
  return `<div class="line${line.isOperator ? ' from-operator' : ''}${statusClass}" data-line="${escapeHtml(line.id)}" style="--speaker-color:${color}">
    <span class="meta"><span class="clock">[${escapeHtml(clockOf(line.timestamp))}]</span>
    <span class="who" style="color:${color}">${escapeHtml(line.speakerName)}</span>
    ${tag}${to}<span class="sep">:</span></span>
    <span class="text">${renderChatText(line.text, mentionTargets)}</span>
  </div>`;
}

function textOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function issueCodeOf(value) {
  const code = textOrEmpty(value);
  return /^[A-Z][A-Z0-9]*-\d+$/.test(code) ? code : '';
}

/** Only canonical Linear card links are allowed to leave the dashboard. */
export function safeLinearUrl(value) {
  try {
    const url = new URL(textOrEmpty(value));
    return url.protocol === 'https:' && url.hostname === 'linear.app' ? url.href : '';
  } catch {
    return '';
  }
}

/**
 * Fold the daemon's already-fetched project/session projections into a lookup.
 * No browser-side Linear request is made: the bulk runner cache remains the
 * authority and recent sessions only fill titles missing from that cache.
 */
export function buildTaskReferenceIndex(projectsPayload, sessionsPayload) {
  const index = new Map();
  const add = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return;
    const taskId = textOrEmpty(candidate.id ?? candidate.taskId);
    const code = issueCodeOf(candidate.issueIdentifier);
    const title = textOrEmpty(candidate.title);
    const url = safeLinearUrl(candidate.issueUrl);
    if (!taskId && !code) return;

    const prior = index.get(taskId) ?? index.get(code) ?? {};
    const reference = {
      taskId: taskId || prior.taskId || '',
      code: code || prior.code || '',
      title: title || prior.title || '',
      url: url || prior.url || '',
    };
    if (reference.taskId) index.set(reference.taskId, reference);
    if (reference.code) index.set(reference.code, reference);
  };

  if (Array.isArray(projectsPayload)) {
    for (const project of projectsPayload) {
      for (const bucket of ['running', 'queued', 'pending']) {
        if (Array.isArray(project?.[bucket])) project[bucket].forEach(add);
      }
    }
  }
  for (const bucket of ['sessions', 'recent']) {
    if (Array.isArray(sessionsPayload?.[bucket])) sessionsPayload[bucket].forEach(add);
  }
  return index;
}

export function renderIssueReference(reference) {
  if (!reference) return '';
  const code = issueCodeOf(reference.code);
  const title = textOrEmpty(reference.title);
  if (!code && !title) return '';
  const contents = [
    code ? `<span class="issue-code">${escapeHtml(code)}</span>` : '',
    title ? `<span class="issue-title">${escapeHtml(title)}</span>` : '',
  ].filter(Boolean).join('<span class="issue-sep">—</span>');
  const url = safeLinearUrl(reference.url);
  return url
    ? `<a class="issue-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${contents}</a>`
    : `<span class="issue-link issue-link-plain">${contents}</span>`;
}

function taskReferenceFor(thread, index) {
  const label = issueCodeOf(thread.taskLabel);
  return index.get(thread.taskId) ?? index.get(label) ?? (label ? { code: label } : null);
}

/** One durable exchange, with its issue context shown once in the header. */
export function renderThread(thread, mentionTargets = [], taskReferences = new Map()) {
  const system = thread.channel === 'system';
  const channel = system ? 'SYSTEM' : 'CHAT';
  const count = thread.lines.length;
  const kind = system
    ? String(thread.events[0]?.kind ?? 'system').replaceAll('-', ' ')
    : `${count} message${count === 1 ? '' : 's'}`;
  const issue = renderIssueReference(taskReferenceFor(thread, taskReferences));
  const lines = thread.lines
    .map((line) => renderLine(line, mentionTargets, { hideTask: true }))
    .join('');
  return `<section class="chat-thread thread-${system ? 'system' : 'chat'}" data-correlation="${escapeHtml(thread.correlationId)}">
    <div class="thread-head">
      <span class="channel-badge">${channel}</span>
      ${issue}<span class="thread-kind">${escapeHtml(kind)}</span>
    </div>
    <div class="thread-lines">${lines}</div>
  </section>`;
}

/** Entry point: backfill from the trace, render, keep live via SSE + polling. */
export function startChatView(doc, { fetchImpl, eventSourceImpl, pollMs = 30_000, storage } = {}) {
  const fetcher = fetchImpl ?? ((url, init) => fetch(url, init));
  const byId = new Map();
  let taskReferences = new Map();
  // Whether the first load has failed and nothing is on screen yet: the empty
  // state then says "unreachable", not "silent" (§7.1 keeps partial results;
  // here there are none to keep, so the message is the whole surface).
  let loadFailed = false;
  let renderedLines = 0;

  const room = doc.getElementById('room');
  const form = doc.getElementById('composer');
  const input = doc.getElementById('composer-text');
  const button = form?.querySelector('button[type="submit"]');
  const fileInput = doc.getElementById('composer-file');
  const attachButton = doc.getElementById('composer-attach');
  const fileRow = doc.getElementById('composer-files');
  // Optional shell affordances — absent in the bare test shell and in older
  // embeds, so every use is guarded.
  const dropOverlay = doc.getElementById('drop-overlay');
  const follow = createScrollFollow(room, {
    button: doc.getElementById('scroll-latest'),
    liveRegion: doc.getElementById('room-live'),
  });
  let sending = false;
  let addressable = false;
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

  /** Recompute whether Send is possible from what the box and the room hold now. */
  const syncSendState = () => {
    setSendEnabled(button, {
      text: input?.value ?? '',
      files: pendingFiles.length,
      addressable,
      sending,
    });
  };

  const renderFiles = () => {
    if (!fileRow) return;
    fileRow.innerHTML = '';
    pendingFiles.forEach((file, index) => {
      const chip = doc.createElement('span');
      chip.className = 'chip';
      const label = doc.createElement('span');
      label.className = 'chip-label';
      label.textContent = `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`;
      chip.appendChild(label);
      const drop = doc.createElement('button');
      drop.type = 'button';
      drop.className = 'chip-remove';
      drop.textContent = '×';
      drop.setAttribute('aria-label', `Remove ${file.name}`);
      drop.title = `Remove ${file.name}`;
      drop.addEventListener('click', () => {
        uploaded.delete(file);
        pendingFiles = pendingFiles.filter((_, i) => i !== index);
        renderFiles();
      });
      chip.appendChild(drop);
      fileRow.appendChild(chip);
    });
    syncSendState();
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
    addressable = !!latestAddressable([...byId.values()]);
    if (input) input.disabled = pending || !addressable;
    setSendingState(button, pending);
    syncSendState();
  };

  const emptyState = () => {
    if (loadFailed) {
      return '<div class="empty" role="status">Could not reach the daemon — retrying…</div>';
    }
    return '<div class="empty">No one has said anything yet.</div>';
  };

  const redraw = () => {
    const events = [...byId.values()];
    const threads = buildChatThreads(events);
    const lines = threads.flatMap((thread) => thread.lines);
    const mentionTargets = [
      // The dashboard user is canonically named Operator even before they have
      // spoken in this retained window, so agents can mention them immediately.
      { name: 'Operator', role: 'human' },
      ...lines.flatMap((line) => [
        { name: line.speakerName, role: line.role },
        ...(line.recipientName ? [{ name: line.recipientName, role: line.recipientRole }] : []),
      ]),
    ];
    room.innerHTML = threads.length
      ? threads.map((thread) => renderThread(thread, mentionTargets, taskReferences)).join('')
      : emptyState();
    // The composer can only address an agent that exists; without one the
    // POST would be unroutable (the API requires repository/taskId/recipient).
    const target = latestAddressable(events);
    addressable = !!target;
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
    syncSendState();
    // One announcement per batch of arrivals, not one per line (§8.5).
    if (lines.length > renderedLines) follow.announce(lines.length - renderedLines);
    renderedLines = lines.length;
    follow.follow();
  };

  const absorb = (event) => {
    if (!event?.id) return false;
    const existing = byId.get(event.id);
    if (!existing) { byId.set(event.id, event); return true; }
    // The SSE channel carries immutable source events, while polling/history
    // carries their locale projection. A late raw copy of the same fingerprint
    // must not downgrade a Korean line that is already on screen.
    if (existing.localizedLocale && !event.localizedLocale
      && existing.fingerprint && existing.fingerprint === event.fingerprint) return false;
    if (existing.summary !== event.summary
      || existing.detail !== event.detail
      || existing.localizedLocale !== event.localizedLocale) {
      byId.set(event.id, event);
      return true;
    }
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
      if (!response.ok) throw new Error(`history ${response.status}`);
      const snapshot = await response.json();
      loadFailed = false;
      let changed = false;
      for (const event of snapshot.events ?? []) changed = absorb(event) || changed;
      if (changed || byId.size === 0) redraw();
    } catch {
      // Transient; the poll below retries via the board. Until something
      // lands, say the daemon is unreachable rather than showing an empty room.
      if (byId.size === 0) { loadFailed = true; redraw(); }
    }
  }

  async function refresh() {
    try {
      const response = await fetcher('/api/coordination');
      if (!response.ok) throw new Error(`board ${response.status}`);
      const snapshot = await response.json();
      const recovered = loadFailed;
      loadFailed = false;
      let changed = false;
      for (const event of snapshot.events ?? []) changed = absorb(event) || changed;
      if (changed || recovered) redraw();
    } catch {
      if (byId.size === 0 && !loadFailed) { loadFailed = true; redraw(); }
    }
  }

  /** Load issue titles/links once from the daemon's local projections. */
  async function loadTaskReferences() {
    const results = await Promise.allSettled([
      fetcher('/api/projects'),
      fetcher('/api/work/sessions?limit=100'),
    ]);
    const payloads = [];
    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value?.ok) {
        payloads.push(null);
        continue;
      }
      try {
        payloads.push(await result.value.json());
      } catch {
        payloads.push(null);
      }
    }
    taskReferences = buildTaskReferenceIndex(payloads[0], payloads[1]);
    redraw();
  }

  loadTaskReferences();
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

  // Drag-and-drop onto the room, the way an operator expects it to work. The
  // overlay says what a drop will do (§2.1); the body class keeps the older
  // outline styling working where the overlay element is absent.
  if (room) {
    const highlight = (on) => {
      doc.body?.classList.toggle('dropping', on);
      if (dropOverlay) dropOverlay.hidden = !on;
    };
    room.addEventListener('dragover', (dragEvent) => { dragEvent.preventDefault(); highlight(true); });
    room.addEventListener('dragleave', () => highlight(false));
    room.addEventListener('drop', (dropEvent) => {
      dropEvent.preventDefault();
      highlight(false);
      stageFiles(dropEvent.dataTransfer?.files);
    });
  }

  // Composer behaviours: grow with the text, Enter sends (never mid-IME),
  // and an unsent draft survives a reload.
  const draft = bindDraft(input, { storage: storage ?? doc.defaultView?.localStorage, key: DRAFT_KEY });
  const regrow = autogrow(input);
  bindEnterToSubmit(input, form);
  input?.addEventListener('input', syncSendState);

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
      if (!failure) {
        input.value = '';
        draft.clear();
        regrow();
        syncSendState();
      }
    });
  }

  return {
    redraw,
    stop: () => {
      clearInterval(timer);
      source?.close();
      follow.stop();
      doc.removeEventListener('dragover', swallowStrayDrop);
      doc.removeEventListener('drop', swallowStrayDrop);
    },
  };
}
