import { EventStream } from './events.mjs';
import { ProjectDrafts, deliveryLabel, draftKey, mergeEntries } from './projectWorkspaceModel.mjs';

const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const count = (v) => v == null ? 'Unavailable' : String(v);
const enc = encodeURIComponent;
const base = (repo) => `/api/coordination/channels/${enc(repo)}`;
const technical = new Set(['mcp-audit', 'adapter-route', 'instruction-snapshot']);
const time = (v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export async function startProjectWorkspace(doc, options = {}) {
  const root = doc.querySelector('[data-project-workspace]');
  if (!root) return;
  const win = doc.defaultView;
  const mode = root.dataset.projectWorkspace;
  let fetchImpl = options.fetchImpl ?? win.fetch.bind(win);
  const scenario = new URL(win.location.href).searchParams.get('demo');
  const demo = Boolean(scenario);
  if (demo) {
    const { createProjectFixture, demoProjectFetch } = await import('./projectFixtures.mjs');
    fetchImpl = demoProjectFetch(createProjectFixture(scenario));
  }
  let storage;
  try { storage = win.sessionStorage; } catch { /* 비공개 모드는 메모리 초안을 사용한다. */ }
  const drafts = new ProjectDrafts(storage);
  const state = { projects: [], projectCursor: null, repo: null, task: null, tasks: [], taskCursor: null,
    thread: null, threadData: null, need: null, entries: [], cursor: null, through: 0,
    detail: null, generation: 0, projectGeneration: 0, threadGeneration: 0, detailGeneration: 0, navigationGeneration: 0, activityGeneration: 0, newActivity: false, needs: [], needsCursor: null,
    selectedNode: null, disposed: false };
  const currentProject = () => state.projects.find((p) => p.repoKey === state.repo);
  const currentScope = () => ({ repoKey: state.repo, threadId: state.thread ?? undefined,
    taskId: state.need?.taskId ?? state.task?.taskId,
    recipient: state.need?.actor ?? doc.querySelector('#workspace-recipient')?.value ?? undefined,
    correlationId: state.need?.correlationId });
  const request = async (url, opts = {}) => {
    const response = await fetchImpl(url, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } });
    let data;
    try { data = await response.json(); } catch { throw new Error(`Invalid server response (${response.status})`); }
    if (!response.ok) { const error = new Error(data?.error ?? `HTTP ${response.status}`); error.status = response.status; throw error; }
    return data;
  };
  const notice = (text, error = false) => {
    const el = doc.querySelector('#workspace-notice');
    el.textContent = text; el.dataset.error = String(error); el.hidden = !text;
  };
  const announce = (text) => { doc.querySelector('#workspace-status').textContent = text; };
  function updateNavigation() {
    const level = state.thread || state.task ? 'detail' : state.repo ? 'conversation' : 'projects';
    root.dataset.level = level;
    const back = doc.querySelector('#workspace-back');
    back.hidden = !state.repo;
    back.textContent = level === 'detail' ? `Back to ${mode === 'chat' ? 'channel' : 'tasks'}` : 'Back to projects';
    const p = currentProject();
    doc.querySelector('#workspace-location').textContent = p ? `${p.name}${state.task ? ` / ${state.task.title}` : ''}` : 'All projects';
    doc.querySelector('#channel-title').textContent = p?.name ?? (mode === 'chat' ? 'Choose a project channel' : 'Choose a project');
    doc.querySelector('#channel-description').textContent = p ? `${p.configured ? 'Project channel' : 'Archived · read only'} · ${p.unread} unread · ${count(p.needsYou)} need you`
      : 'Projects keep their own tasks, decisions and discussions.';
    doc.querySelector('#project-load-more').hidden = !state.projectCursor;
    doc.querySelector('#workspace-refresh').textContent = state.newActivity ? 'New activity · refresh' : 'Refresh';
    doc.querySelector('#workspace-refresh').dataset.new = String(state.newActivity);
  }
  function projectRows() {
    const directory = doc.querySelector('#project-list');
    const scrollTop = directory.scrollTop;
    directory.innerHTML = state.projects.length ? state.projects.map((p) => mode === 'chat'
      ? `<button type="button" class="channel-row${state.repo === p.repoKey ? ' selected' : ''}" data-project="${escape(p.repoKey)}" aria-pressed="${state.repo === p.repoKey}"><span class="project-name">${escape(p.name)}</span><span class="channel-facts"><span data-unread="${escape(p.repoKey)}">${p.unread} unread</span><span data-needs="${escape(p.repoKey)}" class="${p.needsYou > 0 ? 'needs-text' : ''}">${count(p.needsYou)} need you</span></span>${p.configured ? '' : '<span class="meta">Archived · read only</span>'}</button>`
      : `<tr class="${state.repo === p.repoKey ? 'selected' : ''}"><th scope="row"><button type="button" data-project="${escape(p.repoKey)}" aria-pressed="${state.repo === p.repoKey}">${escape(p.name)}</button>${p.configured ? '' : '<span class="meta">Archived · read only</span>'}</th><td>${count(p.runningTasks)}</td><td>${count(p.recentParticipants)}</td><td class="${p.needsYou > 0 ? 'needs-text' : ''}">${count(p.needsYou)}</td></tr>`).join('')
      : mode === 'chat' ? '<p class="empty">No configured projects. Add a repository in Settings.</p>' : '<tr><td colspan="4" class="empty">No configured projects. Add a repository in Settings.</td></tr>';
    directory.scrollTop = scrollTop;
    updateNavigation();
  }
  function signalActivity() {
    state.activityGeneration++; state.newActivity = true; updateNavigation();
  }
  const observedActivity = new Map();
  function observeActivity(repoKey, latestSeq) {
    const project = state.projects.find((p) => p.repoKey === repoKey);
    const known = Math.max(observedActivity.get(repoKey) ?? -1, project?.latestSeq ?? -1,
      repoKey === state.repo ? state.through : -1);
    observedActivity.set(repoKey, Math.max(known, latestSeq));
    if (latestSeq > known) signalActivity();
  }
  async function loadedProjectPages() {
    const missing = new Set(state.projects.map((p) => p.repoKey));
    let page = await request('/api/coordination/projects');
    const result = { ...page, items: [...page.items] };
    for (const p of page.items) missing.delete(p.repoKey);
    while (missing.size && page.nextCursor) {
      page = await request(`/api/coordination/projects?cursor=${enc(page.nextCursor)}`);
      result.items.push(...page.items);
      for (const p of page.items) missing.delete(p.repoKey);
    }
    return { ...result, nextCursor: page.nextCursor };
  }
  async function loadProjects(append = false) {
    const generation = ++state.projectGeneration;
    const result = append ? await request(`/api/coordination/projects${state.projectCursor ? `?cursor=${enc(state.projectCursor)}` : ''}`)
      : await loadedProjectPages();
    if (state.disposed || generation !== state.projectGeneration) return false;
    state.projects = append ? [...state.projects, ...result.items] : result.items;
    state.projectCursor = result.nextCursor;
    doc.querySelector('#workspace-totals').textContent = `${count(result.totals.runningTasks)} running tasks · ${count(result.totals.recentParticipants)} recent participants · 30m`;
    doc.querySelector('#workspace-needs').textContent = `Needs you · ${count(result.totals.needsYou)}`;
    doc.querySelector('#workspace-needs').classList.toggle('has-needs', result.totals.needsYou > 0);
    if (result.partial) notice(`Partial data · ${result.unavailable.join(', ')} unavailable. Refresh to retry.`);
    else notice('');
    projectRows();
    return true;
  }
  const entryMarkup = (e, inThread = false) => {
    const label = deliveryLabel(e, e.delivery?.recipient ? true : currentProject()?.coordinatorAvailable);
    const title = e.actorName ?? e.actor;
    return `<article class="channel-entry" data-entry="${escape(e.sourceId ?? e.id)}"><div class="entry-heading"><strong>${escape(title)}</strong><span class="meta">${escape(e.actorRole ?? 'participant')}</span><time datetime="${new Date(e.createdAt).toISOString()}">${time(e.createdAt)}</time></div><p dir="auto">${escape(e.body)}</p>${e.detail && e.detail !== e.body ? `<details><summary>Details</summary><p dir="auto">${escape(e.detail)}</p></details>` : ''}<div class="entry-actions">${label ? `<span class="delivery-state" data-state="${escape(e.status)}">${escape(label)}</span>` : ''}${!inThread && e.threadId ? `<button type="button" data-thread="${escape(e.threadId)}">Open discussion</button>` : ''}${!inThread && e.kind === 'human-question' && ['open', 'waiting', 'running'].includes(e.status) ? `<button type="button" data-question="${escape(e.correlationId)}">Open question</button>` : ''}${e.delivery && ['failed', 'interrupted'].includes(e.delivery.status) && !demo ? `<button type="button" data-retry="${escape(e.delivery.id)}">Retry delivery</button>` : ''}</div></article>`;
  };
  function renderEntries(keepScroll = false) {
    const list = doc.querySelector('#channel-entries');
    const oldTop = list.scrollTop; const oldHeight = list.scrollHeight;
    const primary = state.entries.filter((e) => !technical.has(e.kind));
    const logs = state.entries.filter((e) => technical.has(e.kind));
    list.innerHTML = (primary.length ? primary.map((e) => entryMarkup(e)).join('')
      : '<p class="empty">No conversation yet. Post a message to the project coordinator.</p>')
      + (logs.length ? `<details class="activity-detail"><summary>Activity details · ${logs.length} loaded</summary>${logs.map((e) => entryMarkup(e)).join('')}</details>` : '');
    list.scrollTop = keepScroll ? oldTop + list.scrollHeight - oldHeight : list.scrollHeight;
    doc.querySelector('#channel-older').hidden = !state.cursor;
    doc.querySelector('#channel-latest').hidden = !keepScroll;
  }
  async function loadEntries(older = false) {
    if (!state.repo) return;
    const repo = state.repo; const generation = state.generation;
    const url = `${base(repo)}/entries${older && state.cursor ? `?cursor=${enc(state.cursor)}` : ''}`;
    const page = await request(url);
    if (repo !== state.repo || generation !== state.generation) return;
    state.entries = older ? mergeEntries(state.entries, page.items) : mergeEntries([], page.items);
    state.cursor = page.nextCursor; state.through = page.scope.throughSeq;
    renderEntries(older);
    if (!older) await markRead();
  }
  async function markRead() {
    const list = doc.querySelector('#channel-entries');
    if (demo || !state.repo || doc.visibilityState !== 'visible' || !doc.hasFocus()
      || (win.matchMedia?.('(max-width: 800px)').matches && root.dataset.level !== 'conversation')
      || list.scrollHeight - list.scrollTop - list.clientHeight > 8) return;
    const repo = state.repo; const through = state.through;
    try {
      const result = await request(`${base(repo)}/read`, { method: 'POST', body: JSON.stringify({ throughSeq: through }) });
      const project = state.projects.find((p) => p.repoKey === repo);
      if (project && result.readSeq >= project.readSeq) {
        project.readSeq = result.readSeq;
        if (result.unread !== undefined) project.unread = result.unread;
        else if (project.readSeq >= project.latestSeq) project.unread = 0;
      }
      if (state.repo === repo) projectRows();
    } catch (error) { if (state.repo === repo) announce(`Read position not saved: ${error.message}`); }
  }
  async function loadTasks(append = false) {
    if (!state.repo) return;
    const repo = state.repo; const generation = state.generation;
    const result = await request(`/api/coordination/projects/${enc(repo)}/tasks${append && state.taskCursor ? `?cursor=${enc(state.taskCursor)}` : ''}`);
    if (state.repo !== repo || generation !== state.generation) return;
    state.tasks = append ? [...state.tasks, ...result.items] : result.items; state.taskCursor = result.nextCursor;
    const list = doc.querySelector('#project-tasks');
    list.innerHTML = state.tasks.length ? state.tasks.map((t) => `<button type="button" class="task-row${state.task?.taskId === t.taskId ? ' selected' : ''}" data-task="${escape(t.taskId)}"><span>${escape(t.title)}</span><span class="meta">${escape(t.status)}${t.stage ? ` · ${escape(t.stage)}` : ''}${t.needs.length ? ` · ${t.needs.length} need you` : ''}</span></button>`).join('') : '<p class="empty">No recorded tasks for this project.</p>';
    doc.querySelector('#task-load-more').hidden = !state.taskCursor;
  }
  function renderComposer() {
    const area = doc.querySelector('#workspace-compose');
    const p = currentProject();
    area.hidden = !p;
    if (!p) return;
    const recipients = doc.querySelector('#workspace-recipient');
    const oldRecipient = recipients.value;
    const participants = (state.task?.participants ?? []).filter((a) => a.canReceive === true);
    recipients.innerHTML = (state.task ? `<option value="">${participants.length ? 'Choose a task recipient' : 'No active recipient'}</option>` : '<option value="">Project coordinator</option>')
      + participants.map((p) => `<option value="${escape(p.address)}">${escape(p.name)} · ${escape(p.role ?? 'agent')} · ${escape(p.address)}</option>`).join('');
    if (state.need?.actor) {
      const option = doc.createElement('option'); option.value = state.need.actor; option.textContent = `Question asker · ${state.need.actor}`; recipients.append(option); recipients.value = state.need.actor;
    } else if (participants.some((p) => p.address === oldRecipient)) recipients.value = oldRecipient;
    else if (participants.length === 1) recipients.value = participants[0].address;
    recipients.disabled = Boolean(state.need);
    const scope = currentScope();
    const draft = drafts.get(scope);
    area.dataset.scope = draftKey(scope);
    doc.querySelector('#compose-scope').textContent = `${p.name} / ${state.need ? `Question · ${state.need.taskLabel ?? state.need.taskId}` : scope.taskId ? state.task.title : state.thread ? 'Discussion' : 'Channel'} / To: ${scope.recipient || (state.task ? 'Choose a task recipient' : 'Project coordinator')}`;
    doc.querySelector('#workspace-message').value = draft.text;
    doc.querySelector('#workspace-message').disabled = demo || !p.configured || draft.sending;
    doc.querySelector('#workspace-files').disabled = demo || !p.configured || draft.sending;
    doc.querySelector('#workspace-send').disabled = demo || !p.configured || draft.sending || !draft.text.trim() || (Boolean(state.task) && !scope.recipient);
    doc.querySelector('#workspace-send').textContent = draft.sending ? 'Saving…' : 'Send message';
    doc.querySelector('#compose-files').textContent = draft.files.map((f) => f.name).join(' · ');
    doc.querySelector('#compose-result').textContent = draft.error || (demo ? 'Demo data · read only' : !p.configured ? 'Archived channel · read only' : state.task && !scope.recipient ? 'Choose an active recipient for this task. Return to the channel to contact its coordinator.' : !scope.recipient && !p.coordinatorAvailable ? 'Messages are saved and queued until the coordinator is available.' : '');
  }
  function effectiveScope() {
    const scope = currentScope();
    return scope;
  }
  async function selectProject(repo, navigation = ++state.navigationGeneration) {
    if (navigation !== state.navigationGeneration) return;
    state.generation++; state.threadGeneration++;
    state.repo = repo; state.task = null; state.thread = null; state.threadData = null; state.need = null;
    state.tasks = []; state.entries = []; state.cursor = null; state.through = 0; state.taskCursor = null; state.selectedNode = null;
    doc.querySelector('#workspace-recipient').value = '';
    doc.querySelector('#thread-content').innerHTML = '<p class="empty">Open a discussion or a task to read its context.</p>';
    doc.querySelector('#channel-entries').innerHTML = '<p class="empty">Loading conversation…</p>';
    projectRows(); renderComposer(); updateNavigation();
    const generation = state.generation;
    try { await Promise.all([loadEntries(), loadTasks()]); }
    catch (error) { if (generation === state.generation) notice(`Project could not load: ${error.message}. Refresh to retry.`, true); }
  }
  async function selectTask(taskId) {
    const task = state.tasks.find((t) => t.taskId === taskId);
    if (!task) return;
    state.navigationGeneration++;
    state.task = task; state.need = null; state.thread = null; state.selectedNode = null;
    state.threadGeneration++;
    renderComposer(); updateNavigation();
    await loadTaskDetail();
  }
  async function loadTaskDetail(search = '', cursor) {
    const repo = state.repo; const task = state.task; const generation = state.threadGeneration;
    const detailGeneration = ++state.detailGeneration;
    if (!task) return;
    const params = new URLSearchParams({ search });
    if (state.selectedNode) params.set('node', state.selectedNode);
    if (cursor) params.set('cursor', cursor);
    try {
      const result = await request(`/api/coordination/projects/${enc(repo)}/tasks/${enc(task.taskId)}?${params}`);
      if (repo !== state.repo || generation !== state.threadGeneration || detailGeneration !== state.detailGeneration) return;
      Object.assign(task, result.task);
      state.detail = result;
      const detail = doc.querySelector('#thread-content');
      detail.innerHTML = `<h3>${escape(task.title)}</h3><p class="meta">${escape(task.status)}${task.stage ? ` · ${escape(task.stage)}` : ''}</p>${task.blockedReason ? `<p dir="auto">${escape(task.blockedReason)}</p>` : ''}${task.needs.map((n) => `<p class="question-context" dir="auto">${escape(n.question ?? 'This run is waiting for the operator.')}</p>${n.correlationId ? `<button type="button" data-need="${escape(n.id)}">Answer this question</button>` : ''}`).join('')}<h3>Task relationships</h3><div id="task-graph"></div><p class="meta">${result.graph.nodes.length} shown · ${result.graph.omittedNodes} participants and ${result.graph.omittedEdges} connections omitted</p><label class="field-label" for="participant-search">Search all participants and connections</label><form id="participant-search-form"><input id="participant-search" type="search" value="${escape(search)}" autocomplete="off"><button type="submit">Search</button></form><div class="participant-list">${result.participants.items.map((n) => `<button type="button" data-node="${escape(n.id)}" aria-pressed="${n.id === state.selectedNode}">${escape(n.name)} <span class="meta">${escape(n.role ?? 'participant')} · ${escape(n.address)}</span></button>`).join('') || '<p class="empty">No matching participants.</p>'}</div>${result.participants.nextCursor ? '<button type="button" id="participant-more">Next participants</button>' : ''}<details><summary>Connections · ${result.relationTotals?.connections ?? result.relationships.items.length} total</summary><div id="connection-list">${result.relationships.items.map((e) => `<p class="meta">${escape(e.sourceLabel ?? e.source)} → ${escape(e.targetLabel ?? e.target)} · ${e.count}</p>`).join('') || '<p>No connections recorded.</p>'}</div><button type="button" id="connection-more"${result.relationships.nextCursor ? '' : ' hidden'}>More connections</button></details>`;
      renderGraph(result.graph);
      renderComposer(); updateNavigation();
    } catch (error) { if (generation === state.threadGeneration) notice(`Task details unavailable: ${error.message}`, true); }
  }
  function renderGraph(graph) {
    const holder = doc.querySelector('#task-graph');
    const ns = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(ns, 'svg');
    const height = Math.max(150, Math.ceil(graph.nodes.length / 4) * 70);
    svg.setAttribute('viewBox', `0 0 600 ${height}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Relationships for the selected task; full searchable list follows');
    const points = new Map(graph.nodes.map((n, i) => [n.id, [75 + (i % 4) * 150, 36 + Math.floor(i / 4) * 70]]));
    for (const edge of graph.edges) {
      const a = points.get(edge.source); const b = points.get(edge.target); if (!a || !b) continue;
      const line = doc.createElementNS(ns, 'line');
      for (const [key, value] of Object.entries({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] })) line.setAttribute(key, value);
      svg.append(line);
    }
    for (const node of graph.nodes) {
      const [x, y] = points.get(node.id); const circle = doc.createElementNS(ns, 'circle');
      circle.setAttribute('cx', x); circle.setAttribute('cy', y); circle.setAttribute('r', node.id === state.selectedNode ? 9 : 6); circle.setAttribute('data-role', node.role ?? 'participant');
      const title = doc.createElementNS(ns, 'title'); title.textContent = `${node.name} · ${node.address}`; circle.append(title); svg.append(circle);
      const text = doc.createElementNS(ns, 'text'); text.setAttribute('x', x); text.setAttribute('y', y + 23); text.textContent = node.name.slice(0, 20); svg.append(text);
    }
    holder.append(svg);
  }
  async function selectThread(threadId) {
    state.navigationGeneration++;
    const repo = state.repo; state.thread = threadId; state.need = null; state.task = null; state.threadGeneration++;
    const generation = state.threadGeneration;
    doc.querySelector('#workspace-recipient').value = '';
    updateNavigation(); renderComposer();
    doc.querySelector('#thread-content').innerHTML = '<p class="empty">Loading discussion…</p>';
    try {
      const result = await request(`/api/coordination/threads/${enc(threadId)}?repository=${enc(repo)}&messageLimit=50`);
      if (repo !== state.repo || generation !== state.threadGeneration) return;
      state.threadData = result;
      renderThread();
    } catch (error) { if (generation === state.threadGeneration) notice(`Discussion unavailable: ${error.message}`, true); }
  }
  function renderThread() {
    const result = state.threadData;
    doc.querySelector('#thread-content').innerHTML = `<h3>${escape(result.thread.subject)}</h3><p class="meta">Existing discussion · ${escape(result.thread.status)} · ${result.thread.relatedTaskIds.length} related tasks</p><a href="/threads?repository=${enc(state.repo)}&threadId=${enc(state.thread)}">Open in Threads</a>${result.messages.items.map((e) => entryMarkup(e, true)).join('')}${result.messages.nextCursor ? '<button type="button" id="thread-more">More discussion messages</button>' : ''}`;
  }
  async function openNeed(id) {
    const navigation = ++state.navigationGeneration;
    const stillCurrent = () => navigation === state.navigationGeneration;
    let need = [...state.needs, ...state.tasks.flatMap((t) => t.needs)].find((n) => n.id === id);
    if (!need) return;
    if (state.repo !== need.repoKey) {
      if (!state.projects.some((p) => p.repoKey === need.repoKey)) {
        while (state.projectCursor) {
          await loadProjects(true); if (!stillCurrent()) return;
          if (state.projects.some((p) => p.repoKey === need.repoKey)) break;
        }
      }
      await selectProject(need.repoKey, navigation);
    }
    if (!stillCurrent() || state.repo !== need.repoKey) return;
    state.need = need; state.task = state.tasks.find((t) => t.taskId === need.taskId) ?? { taskId: need.taskId, title: need.taskLabel ?? need.taskId, participants: [], needs: [need] };
    state.thread = null; state.threadGeneration++;
    doc.querySelector('#needs-inbox').hidden = true;
    doc.querySelector('#thread-content').innerHTML = `<h3>${escape(need.taskLabel ?? need.taskId)}</h3><p class="meta">${escape(currentProject()?.name)} · ${escape(need.actor ?? 'Operator action')}</p><p class="question-context" dir="auto">${escape(need.question ?? 'This run needs an operator decision. Review its session and status.')}</p>${need.correlationId ? '' : `<a href="/app">Open work sessions</a>`}<div id="question-history"></div>`;
    renderComposer(); updateNavigation(); root.dataset.level = 'detail';
    if (need.correlationId) {
      const repo = state.repo; const gen = state.threadGeneration;
      try {
        const result = await request(`${base(repo)}/entries?correlationId=${enc(need.correlationId)}`);
        if (repo === state.repo && gen === state.threadGeneration) doc.querySelector('#question-history').innerHTML = result.items.filter((e) => e.sourceId !== need.id).reverse().map((e) => entryMarkup(e, true)).join('');
      } catch (error) { if (gen === state.threadGeneration) announce(`Question history unavailable: ${error.message}`); }
    }
  }
  async function loadNeeds(append = false) {
    const result = await request(`/api/coordination/needs-you${append && state.needsCursor ? `?cursor=${enc(state.needsCursor)}` : ''}`);
    state.needs = append ? [...state.needs, ...result.items] : result.items; state.needsCursor = result.nextCursor;
    doc.querySelector('#needs-list').innerHTML = state.needs.map((n) => `<button type="button" class="need-row" data-need="${escape(n.id)}"><span>${escape(state.projects.find((p) => p.repoKey === n.repoKey)?.name ?? n.repoKey)} / ${escape(n.taskLabel ?? n.taskId)}</span><span dir="auto">${escape(n.question ?? 'Parked run · operator action')}</span></button>`).join('') || '<p class="empty">Nothing needs you in the available data.</p>';
    doc.querySelector('#needs-more').hidden = !state.needsCursor;
  }
  async function sendMessage(event) {
    event.preventDefault();
    if (demo || !state.repo) return;
    const scope = { ...effectiveScope() }; const key = draftKey(scope); const draft = drafts.get(scope);
    if (draft.sending || !draft.text.trim() || (state.task && !scope.recipient)) return;
    draft.idempotencyKey ??= win.crypto.randomUUID(); drafts.persist(scope);
    const originalText = draft.text; const files = [...draft.files];
    draft.sending = true; draft.error = ''; renderComposer();
    try {
      const uploaded = [];
      for (const file of draft.submittedBody === undefined ? files : []) {
        // 업로드와 결과는 전송 시작 시점의 범위에 귀속된다.
        const query = new URLSearchParams({ taskId: scope.taskId ?? `channel:${scope.repoKey}`, filename: file.name });
        const result = await request(`/api/coordination/attachment?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
        uploaded.push(`Attachment: ${result.filename}\n${result.path}`);
      }
      const body = draft.submittedBody ?? [originalText, ...uploaded].join('\n\n');
      draft.submittedBody = body; drafts.persist(scope);
      const result = await request(`${base(scope.repoKey)}/messages`, { method: 'POST', body: JSON.stringify({ ...scope, body, idempotencyKey: draft.idempotencyKey }) });
      if (draft.text === originalText) { draft.text = ''; draft.files = []; draft.idempotencyKey = undefined; draft.submittedBody = undefined; drafts.persist(scope); }
      draft.error = deliveryLabel(result.delivery, result.coordinatorAvailable);
      if (state.repo === scope.repoKey) signalActivity();
      if (draftKey(effectiveScope()) === key) {
        announce(`Message saved to ${currentProject()?.name}. ${draft.error}`);
        await loadEntries();
        if (scope.threadId && state.thread === scope.threadId) await selectThread(scope.threadId);
      }
    } catch (error) {
      draft.error = `${error.message}${error.status === 429 ? ' · Wait and send again.' : ' · Send again to retry the same request.'}`;
    } finally {
      draft.sending = false;
      if (draftKey(effectiveScope()) === key) renderComposer();
      updateNavigation();
    }
  }
  const safe = (action) => Promise.resolve().then(action).catch((e) => notice(`${e.message}. Refresh to retry.`, true));
  const click = (event) => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.dataset.project) void safe(() => selectProject(target.dataset.project));
    else if (target.dataset.task) void safe(() => selectTask(target.dataset.task));
    else if (target.dataset.thread) void safe(() => selectThread(target.dataset.thread));
    else if (target.dataset.need) void safe(() => openNeed(target.dataset.need));
    else if (target.dataset.question) void safe(async () => { await loadNeeds(); const n = state.needs.find((n) => n.correlationId === target.dataset.question); if (n) await openNeed(n.id); });
    else if (target.dataset.node) { state.selectedNode = target.dataset.node; void loadTaskDetail(doc.querySelector('#participant-search')?.value ?? ''); }
    else if (target.dataset.retry) void safe(async () => {
      const repo = state.repo;
      await request(`${base(repo)}/deliveries/${enc(target.dataset.retry)}/retry`, { method: 'POST', body: '{}' });
      if (repo === state.repo) await loadEntries();
    });
    else if (target.id === 'compose-toggle') {
      root.dataset.composeExpanded = root.dataset.composeExpanded === 'true' ? 'false' : 'true';
      target.setAttribute('aria-expanded', root.dataset.composeExpanded);
      if (root.dataset.composeExpanded === 'true') doc.querySelector('#workspace-message').focus();
    } else if (target.id === 'workspace-back') {
      state.navigationGeneration++;
      if (state.thread || state.task || state.need) {
        state.threadGeneration++; state.thread = null; state.task = null; state.need = null;
        doc.querySelector('#workspace-recipient').value = '';
      } else { state.generation++; state.repo = null; }
      renderComposer(); updateNavigation();
    } else if (target.id === 'workspace-refresh') void safe(async () => {
      const repo = state.repo; const old = currentProject(); const activity = state.activityGeneration;
      if (!await loadProjects()) return;
      if (repo && !state.projects.some((p) => p.repoKey === repo) && old) state.projects.push(old);
      if (repo === state.repo) { await Promise.all([loadEntries(), loadTasks()]); if (state.task) await loadTaskDetail(); }
      if (activity === state.activityGeneration) state.newActivity = false;
      updateNavigation();
    });
    else if (target.id === 'workspace-needs') void safe(async () => { const inbox = doc.querySelector('#needs-inbox'); inbox.hidden = !inbox.hidden; if (!inbox.hidden) await loadNeeds(); });
    else if (target.id === 'needs-close') doc.querySelector('#needs-inbox').hidden = true;
    else if (target.id === 'needs-more') void safe(() => loadNeeds(true));
    else if (target.id === 'project-load-more') void safe(() => loadProjects(true));
    else if (target.id === 'task-load-more') void safe(() => loadTasks(true));
    else if (target.id === 'channel-older') void safe(() => loadEntries(true));
    else if (target.id === 'channel-latest') { const list = doc.querySelector('#channel-entries'); list.scrollTop = list.scrollHeight; target.hidden = true; void markRead(); }
    else if (target.id === 'participant-more') void loadTaskDetail(doc.querySelector('#participant-search').value, state.detail.participants.nextCursor);
    else if (target.id === 'connection-more') void safe(async () => {
      const repo = state.repo; const task = state.task; const gen = state.threadGeneration;
      const params = new URLSearchParams({ part: 'connections', search: doc.querySelector('#participant-search').value,
        cursor: state.detail.relationships.nextCursor });
      const result = await request(`/api/coordination/projects/${enc(repo)}/tasks/${enc(task.taskId)}?${params}`);
      if (repo === state.repo && gen === state.threadGeneration) {
        doc.querySelector('#connection-list').insertAdjacentHTML('beforeend', result.items.map((e) => `<p class="meta">${escape(e.sourceLabel ?? e.source)} → ${escape(e.targetLabel ?? e.target)} · ${e.count}</p>`).join(''));
        state.detail.relationships.nextCursor = result.nextCursor; target.hidden = !result.nextCursor;
      }
    });
    else if (target.id === 'thread-more') void safe(async () => {
      const repo = state.repo; const thread = state.thread; const gen = state.threadGeneration;
      const result = await request(`/api/coordination/threads/${enc(thread)}?repository=${enc(repo)}&messageLimit=50&messageAfterSeq=${enc(state.threadData.messages.nextCursor)}`);
      if (gen === state.threadGeneration && repo === state.repo && thread === state.thread) {
        state.threadData = { ...result, messages: { ...result.messages, items: [...state.threadData.messages.items, ...result.messages.items] } }; renderThread();
      }
    });
  };
  root.addEventListener('click', click);
  doc.querySelector('#workspace-compose').addEventListener('submit', sendMessage);
  doc.querySelector('#workspace-message').addEventListener('input', (e) => { const scope = effectiveScope(); drafts.save(scope, e.target.value); doc.querySelector('#workspace-send').disabled = !e.target.value.trim() || drafts.get(scope).sending || (Boolean(state.task) && !scope.recipient); });
    doc.querySelector('#workspace-files').addEventListener('change', (e) => { const draft = drafts.get(effectiveScope()); draft.files = [...e.target.files]; draft.idempotencyKey = undefined; draft.submittedBody = undefined; drafts.persist(effectiveScope()); e.target.value = ''; renderComposer(); });
  doc.querySelector('#workspace-recipient').addEventListener('change', renderComposer);
  root.addEventListener('submit', (e) => { if (e.target.id === 'participant-search-form') { e.preventDefault(); void loadTaskDetail(doc.querySelector('#participant-search').value); } });
  doc.querySelector('#channel-entries').addEventListener('scroll', () => { const el = doc.querySelector('#channel-entries'); doc.querySelector('#channel-latest').hidden = el.scrollHeight - el.scrollTop - el.clientHeight < 8; void markRead(); });
  const foreground = () => { void markRead(); };
  doc.addEventListener('visibilitychange', foreground); win.addEventListener('focus', foreground);
  let stream;
  if (!demo && options.events !== false) {
    stream = options.eventStream ?? new EventStream();
    const changed = signalActivity;
    for (const name of ['coordination:channel', 'coordination:channel-status', 'coordination:published', 'coordination:event', 'task:started', 'task:completed', 'pipeline:stage', '$open']) stream.on(name, changed);
    stream.connect();
  }
  const poll = !demo && options.pollMs !== 0 ? win.setInterval(async () => {
    try {
      const data = await loadedProjectPages();
      const repo = state.repo; const generation = state.generation;
      if (repo) {
        const position = await request(`${base(repo)}/read`);
        if (repo === state.repo && generation === state.generation && position.latestSeq > state.through) {
          observeActivity(repo, position.latestSeq);
        }
        const project = state.projects.find((p) => p.repoKey === repo);
        if (project && position.readSeq > project.readSeq) {
          project.readSeq = position.readSeq; project.unread = position.unread;
          const label = [...doc.querySelectorAll('[data-unread]')].find((el) => el.dataset.unread === repo);
          if (label) label.textContent = `${position.unread} unread`;
        }
      }
      for (const next of data.items) {
        const project = state.projects.find((p) => p.repoKey === next.repoKey);
        if (project && project.readSeq < next.readSeq) {
          project.readSeq = Math.max(project.readSeq, next.readSeq); project.unread = next.unread;
          const label = [...doc.querySelectorAll('[data-unread]')].find((el) => el.dataset.unread === next.repoKey);
          if (label) label.textContent = `${next.unread} unread`;
        }
      }
      for (const p of data.items) observeActivity(p.repoKey, p.latestSeq);
    } catch { announce('Connection unavailable. Your drafts are preserved; refresh to reconnect.'); }
  }, options.pollMs ?? 15_000) : null;
  if (demo) {
    const banner = doc.querySelector('#workspace-demo'); banner.hidden = false;
    banner.innerHTML = `<span>Demo data · read only · ${scenario === 'stress' ? '100 projects / 1,000 agents' : '10 projects / 100 agents'}</span><label for="demo-scenario">Scenario</label><select id="demo-scenario">${['normal', 'questions', 'busy', 'offline', 'stress'].map((s) => `<option${s === scenario ? ' selected' : ''}>${s}</option>`).join('')}</select>`;
    doc.querySelector('#demo-scenario').addEventListener('change', (e) => { const url = new URL(win.location.href); url.searchParams.set('demo', e.target.value); win.location.href = url.href; });
  }
  try { await loadProjects(); }
  catch (error) { notice(`Project data unavailable: ${error.message}. Refresh to retry.`, true); }
  return { state, drafts, selectProject, selectTask, selectThread, openNeed, refresh: loadProjects,
    dispose() { state.disposed = true; state.generation++; state.threadGeneration++; if (poll) win.clearInterval(poll); stream?.close(); doc.removeEventListener('visibilitychange', foreground); win.removeEventListener('focus', foreground); root.removeEventListener('click', click); } };
}
