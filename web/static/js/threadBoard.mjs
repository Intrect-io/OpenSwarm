// Durable repository thread board. Dynamic content is written with textContent,
// never HTML, because every message originated with an agent or operator.

function splitCsv(value) {
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function mutationKey(prefix) {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${id}`;
}

async function request(fetchImpl, path, options = {}) {
  const response = await fetchImpl(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  let body = null;
  try { body = await response.json(); } catch { /* an error below still names the status */ }
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body;
}

function text(doc, tag, value, className) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? '');
  return node;
}

function time(value) {
  if (!Number.isFinite(value)) return '';
  return new Date(value).toLocaleString();
}

function appendCode(doc, holder, source) {
  const code = doc.createElement('code');
  // A small DOM-only lexer keeps agent-controlled text inert while making the
  // common code and log fragments materially easier to scan.
  const token = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))|(\b(?:async|await|break|case|class|const|def|else|export|false|for|from|function|if|import|in|let|new|null|return|true|try|catch|throw|while)\b)|(\b\d+(?:\.\d+)?\b)|([{}[\]().,;:=])/g;
  let cursor = 0;
  for (const match of source.matchAll(token)) {
    if (match.index > cursor) code.append(doc.createTextNode(source.slice(cursor, match.index)));
    const className = match[1] ? 'token-comment'
      : match[2] ? 'token-string'
        : match[3] ? 'token-keyword'
          : match[4] ? 'token-number' : 'token-punctuation';
    code.appendChild(text(doc, 'span', match[0], className));
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) code.append(doc.createTextNode(source.slice(cursor)));
  holder.appendChild(code);
}

/** Render prose, inline code, and fenced code without ever interpreting HTML. */
export function renderThreadMessageBody(doc, holder, body) {
  holder.replaceChildren();
  const appendProse = (value) => {
    let cursor = 0;
    for (const match of value.matchAll(/`([^`\n]+)`/g)) {
      if (match.index > cursor) holder.append(doc.createTextNode(value.slice(cursor, match.index)));
      holder.appendChild(text(doc, 'code', match[1], 'inline-code'));
      cursor = match.index + match[0].length;
    }
    if (cursor < value.length) holder.append(doc.createTextNode(value.slice(cursor)));
  };
  const source = String(body ?? '');
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of source.matchAll(fence)) {
    appendProse(source.slice(cursor, match.index));
    const pre = doc.createElement('pre');
    appendCode(doc, pre, match[1]);
    holder.appendChild(pre);
    cursor = match.index + match[0].length;
  }
  appendProse(source.slice(cursor));
}

export function renderThreadList(doc, holder, threads, selectedId, onSelect) {
  holder.replaceChildren();
  if (threads.length === 0) {
    holder.appendChild(text(doc, 'div', 'No threads in this view.', 'empty'));
    return;
  }
  for (const thread of threads) {
    const card = doc.createElement('button');
    card.type = 'button';
    card.className = `thread-card${thread.id === selectedId ? ' selected' : ''}`;
    card.dataset.threadId = thread.id;
    const subject = text(doc, 'div', '', 'subject');
    subject.appendChild(text(doc, 'span', thread.subject));
    subject.appendChild(text(doc, 'span', thread.status, `badge ${thread.status}`));
    if ((thread.unreadCount ?? 0) > 0) subject.appendChild(text(doc, 'span', `${thread.unreadCount} unread`, 'badge open'));
    card.appendChild(subject);
    const tasks = (thread.relatedTaskIds ?? []).join(', ') || 'no related task';
    card.appendChild(text(
      doc,
      'div',
      `${thread.repository} · ${tasks} · ${thread.messageCount} messages · ${thread.participantCount} participants · ${time(thread.updatedAt)}`,
      'meta',
    ));
    card.addEventListener('click', () => onSelect(thread.id));
    holder.appendChild(card);
  }
}

export function renderThreadDetail(doc, detail) {
  doc.getElementById('empty').hidden = true;
  doc.getElementById('detail').classList.add('visible');
  doc.getElementById('detail-subject').textContent = detail.thread.subject;
  doc.getElementById('detail-meta').textContent = [
    detail.thread.repository,
    `v${detail.thread.version}`,
    detail.thread.status,
    `tasks ${(detail.thread.relatedTaskIds ?? []).join(', ')}`,
    `files ${(detail.thread.relatedFiles ?? []).join(', ') || 'none'}`,
    `participants ${(detail.participants ?? []).map((participant) => participant.actorName ?? participant.actor).join(', ')}`,
  ].join(' · ');
  const messages = doc.getElementById('messages');
  messages.replaceChildren();
  if ((detail.messages?.items ?? []).length === 0) {
    messages.appendChild(text(doc, 'div', 'No messages yet.', 'empty'));
  }
  for (const message of detail.messages?.items ?? []) {
    const block = text(doc, 'div', '', 'message');
    block.appendChild(text(
      doc,
      'div',
      `${message.actorName ?? message.actor} · ${message.actorRole ?? 'agent'} · ${message.taskLabel ?? message.taskId} · ${time(message.createdAt)}`,
      'message-head',
    ));
    const body = text(doc, 'div', '', 'message-body');
    renderThreadMessageBody(doc, body, message.body);
    block.appendChild(body);
    messages.appendChild(block);
  }
}

function selectedValue(form, name) {
  return form.querySelector(`[name="${name}"]`)?.value ?? '';
}

export function startThreadBoard(doc, { fetchImpl = globalThis.fetch, pollMs = 5_000 } = {}) {
  const repo = doc.getElementById('repo');
  const statusFilter = doc.getElementById('thread-status');
  const holder = doc.getElementById('threads');
  const status = doc.getElementById('status');
  const refresh = doc.getElementById('refresh');
  const newThread = doc.getElementById('new-thread');
  const reply = doc.getElementById('reply-form');
  const follow = doc.getElementById('follow');
  const resolve = doc.getElementById('resolve');
  // Optional in-page confirmation for resolving (§3.2). Shells without it
  // (older embeds, the bare test shell) resolve on the first click.
  const confirmCard = doc.getElementById('resolve-confirm');
  const confirmText = doc.getElementById('resolve-confirm-text');
  const confirmButton = doc.getElementById('resolve-confirm-btn');
  const cancelButton = doc.getElementById('resolve-cancel');
  const state = { repository: '', threads: [], selectedId: null, detail: null, stopped: false, generation: 0 };

  const say = (message, error = false) => {
    status.textContent = message;
    status.className = error ? 'status-line threads-status is-error error' : 'status-line threads-status';
  };

  const hideConfirm = () => { if (confirmCard) confirmCard.hidden = true; };

  const repositoryForThread = (threadId = state.selectedId) => state.threads
    .find((thread) => thread.id === threadId)?.repository ?? state.repository;
  const repositoryQuery = (threadId) => `repository=${encodeURIComponent(repositoryForThread(threadId))}`;

  async function loadDetail(threadId = state.selectedId) {
    if (!threadId || state.stopped) return;
    // A pending "resolve X?" must not outlive the thread it named.
    if (threadId !== state.detail?.thread?.id) hideConfirm();
    try {
      const detail = await request(fetchImpl, `/api/coordination/threads/${encodeURIComponent(threadId)}?${repositoryQuery(threadId)}&messageLimit=200`);
      if (state.stopped || threadId !== state.selectedId) return;
      state.detail = detail;
      renderThreadDetail(doc, detail);
      const subscribed = detail.participants.some((participant) =>
        participant.actor === 'operator-dashboard' && participant.taskId === 'operator');
      follow.textContent = subscribed ? 'following' : 'follow';
      follow.dataset.following = subscribed ? 'true' : 'false';
      resolve.disabled = detail.thread.status !== 'open';
      reply.querySelector('button').disabled = detail.thread.status !== 'open';
      reply.querySelector('textarea').disabled = detail.thread.status !== 'open';
      if (subscribed) {
        await request(fetchImpl, `/api/coordination/threads/${encodeURIComponent(threadId)}/read`, {
          method: 'POST', body: JSON.stringify({ repository: repositoryForThread(threadId) }),
        });
      }
      say(`${detail.thread.messageCount} durable messages · version ${detail.thread.version}`);
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    }
  }

  async function selectThread(threadId) {
    state.selectedId = threadId;
    renderThreadList(doc, holder, state.threads, state.selectedId, (id) => { void selectThread(id); });
    await loadDetail(threadId);
  }

  async function loadThreads({ refreshDetail = true } = {}) {
    if (state.stopped) return;
    const generation = ++state.generation;
    try {
      const statusValue = statusFilter.value;
      const query = new URLSearchParams({ limit: '200' });
      if (state.repository) query.set('repository', state.repository);
      if (statusValue) query.set('status', statusValue);
      const page = await request(fetchImpl, `/api/coordination/threads?${query}`);
      if (state.stopped || generation !== state.generation) return;
      state.threads = page.items ?? [];
      if (state.selectedId && !state.threads.some((thread) => thread.id === state.selectedId)) {
        state.selectedId = null;
        state.detail = null;
        doc.getElementById('detail').classList.remove('visible');
        doc.getElementById('empty').hidden = false;
      }
      renderThreadList(doc, holder, state.threads, state.selectedId, (threadId) => { void selectThread(threadId); });
      say(`${state.threads.length} ${statusValue || 'total'} thread${state.threads.length === 1 ? '' : 's'}`);
      if (refreshDetail && state.selectedId) await loadDetail(state.selectedId);
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    }
  }

  async function chooseRepository(path) {
    state.repository = path;
    state.selectedId = null;
    state.detail = null;
    if (!path) say('Loading durable threads across all repositories…');
    try {
      doc.defaultView?.history?.replaceState({}, '', path ? `/threads?repository=${encodeURIComponent(path)}` : '/threads');
    } catch { /* embedded hosts may not expose history */ }
    if (path) say('Loading durable threads…');
    await loadThreads({ refreshDetail: false });
  }

  async function loadRepositories() {
    try {
      const response = await request(fetchImpl, '/api/work/projects');
      const projects = Array.isArray(response) ? response : response?.projects ?? [];
      const requested = new URL(doc.defaultView?.location?.href ?? 'http://localhost/threads')
        .searchParams.get('repository') ?? '';
      for (const project of projects) {
        const path = typeof project === 'string' ? project : project.path;
        if (!path) continue;
        const option = doc.createElement('option');
        option.value = path;
        option.textContent = typeof project === 'object' && project.name ? `${project.name} — ${path}` : path;
        repo.appendChild(option);
      }
      if (requested && ![...repo.options].some((option) => option.value === requested)) {
        const option = doc.createElement('option');
        option.value = requested;
        option.textContent = requested;
        repo.appendChild(option);
      }
      repo.value = requested;
      await chooseRepository(requested);
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    }
  }

  repo.addEventListener('change', () => { void chooseRepository(repo.value); });
  statusFilter.addEventListener('change', () => { void loadThreads({ refreshDetail: false }); });
  refresh.addEventListener('click', () => { void loadThreads(); });

  newThread.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.repository) return say('Select a repository first.', true);
    try {
      const created = await request(fetchImpl, '/api/coordination/threads', {
        method: 'POST',
        body: JSON.stringify({
          repository: state.repository,
          taskId: selectedValue(newThread, 'taskId'),
          subject: selectedValue(newThread, 'subject'),
          body: selectedValue(newThread, 'body') || undefined,
          relatedTaskIds: splitCsv(selectedValue(newThread, 'relatedTaskIds')),
          relatedFiles: splitCsv(selectedValue(newThread, 'relatedFiles')),
          idempotencyKey: mutationKey('operator-thread'),
        }),
      });
      newThread.reset();
      statusFilter.value = 'open';
      state.selectedId = created.thread.id;
      await loadThreads();
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    }
  });

  reply.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.selectedId) return;
    const body = selectedValue(reply, 'body');
    try {
      await request(fetchImpl, `/api/coordination/threads/${encodeURIComponent(state.selectedId)}/messages`, {
        method: 'POST', body: JSON.stringify({
          repository: repositoryForThread(), body, idempotencyKey: mutationKey('operator-reply'),
        }),
      });
      reply.reset();
      await loadThreads();
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    }
  });

  follow.addEventListener('click', async () => {
    if (!state.selectedId) return;
    const following = follow.dataset.following === 'true';
    try {
      await request(fetchImpl, `/api/coordination/threads/${encodeURIComponent(state.selectedId)}/follow`, {
        method: following ? 'DELETE' : 'POST', body: JSON.stringify({ repository: repositoryForThread() }),
      });
      await loadDetail();
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    }
  });

  const performResolve = async () => {
    if (!state.selectedId || !state.detail) return;
    hideConfirm();
    try {
      await request(fetchImpl, `/api/coordination/threads/${encodeURIComponent(state.selectedId)}/resolve`, {
        method: 'POST', body: JSON.stringify({
          repository: repositoryForThread(), expectedVersion: state.detail.thread.version,
        }),
      });
      await loadThreads();
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    }
  };

  resolve.addEventListener('click', () => {
    if (!state.selectedId || !state.detail) return;
    // Resolving is one-way for the agents on the thread, so the card names
    // the thread and the version and asks once — in the page, since the
    // Tauri WebView has no window.confirm.
    if (!confirmCard || !confirmButton) { void performResolve(); return; }
    const { subject, version } = state.detail.thread;
    if (confirmText) confirmText.textContent = `Resolve “${subject}” at version ${version}? Agents can no longer post to it.`;
    confirmCard.hidden = false;
    confirmButton.focus();
  });
  confirmButton?.addEventListener('click', () => { void performResolve(); });
  cancelButton?.addEventListener('click', () => { hideConfirm(); resolve.focus(); });

  void loadRepositories();
  const timer = pollMs > 0 ? setInterval(() => { void loadThreads(); }, pollMs) : null;
  return {
    state,
    refresh: loadThreads,
    stop() {
      state.stopped = true;
      state.generation += 1;
      if (timer) clearInterval(timer);
    },
  };
}
