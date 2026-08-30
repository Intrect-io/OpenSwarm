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
      `${tasks} · ${thread.messageCount} messages · ${thread.participantCount} participants · ${time(thread.updatedAt)}`,
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
    block.appendChild(text(doc, 'div', message.body, 'message-body'));
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
  const state = { repository: '', threads: [], selectedId: null, detail: null, stopped: false, generation: 0 };

  const say = (message, error = false) => {
    status.textContent = message;
    status.className = error ? 'error' : '';
  };

  const repositoryQuery = () => `repository=${encodeURIComponent(state.repository)}`;

  async function loadDetail(threadId = state.selectedId) {
    if (!state.repository || !threadId || state.stopped) return;
    try {
      const detail = await request(fetchImpl, `/api/coordination/threads/${encodeURIComponent(threadId)}?${repositoryQuery()}&messageLimit=200`);
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
          method: 'POST', body: JSON.stringify({ repository: state.repository }),
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
    if (!state.repository || state.stopped) return;
    const generation = ++state.generation;
    try {
      const statusValue = statusFilter.value;
      const query = new URLSearchParams({ repository: state.repository, limit: '200' });
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
    if (!path) {
      holder.replaceChildren(text(doc, 'div', 'No repository selected.', 'empty'));
      say('Choose a repository to open its durable board.');
      return;
    }
    try {
      doc.defaultView?.history?.replaceState({}, '', `/threads?repository=${encodeURIComponent(path)}`);
    } catch { /* embedded hosts may not expose history */ }
    say('Loading durable threads…');
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
      if (requested) {
        repo.value = requested;
        await chooseRepository(requested);
      }
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
          repository: state.repository, body, idempotencyKey: mutationKey('operator-reply'),
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
        method: following ? 'DELETE' : 'POST', body: JSON.stringify({ repository: state.repository }),
      });
      await loadDetail();
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    }
  });

  resolve.addEventListener('click', async () => {
    if (!state.selectedId || !state.detail) return;
    try {
      await request(fetchImpl, `/api/coordination/threads/${encodeURIComponent(state.selectedId)}/resolve`, {
        method: 'POST', body: JSON.stringify({
          repository: state.repository, expectedVersion: state.detail.thread.version,
        }),
      });
      await loadThreads();
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    }
  });

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
