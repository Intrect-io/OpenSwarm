// ============================================
// OpenSwarm - Issue Board HTML Template
// Created: 2026-04-03
// Purpose: 칸반 보드 + 이슈 생성/편집 웹 UI
// ============================================

export const ISSUE_BOARD_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenSwarm :: Issues</title>
  <script src="/static/js/themeBoot.js"></script>
  <link rel="stylesheet" href="/static/css/tokens.css">
  <style>
    /* Colour comes from /static/css/tokens.css (AGT-4201); the legacy names
       below are indirections so this board follows the shared palette and
       the light/dark switch. No colour literal lives in this file. */
    :root {
      --bg:        var(--bg-app);
      --bg2:       var(--bg-surface);
      --bg3:       var(--bg-elevated);
      --green:     var(--accent);
      --green-dim: var(--accent-subtle);
      --green-mid: var(--accent);
      --green-lo:  var(--border);
      --cyan:      var(--info);
      --cyan-dim:  var(--accent-subtle);
      --amber:     var(--warning);
      --red:       var(--danger);
      --white:     var(--fg-primary);
      --dim:       var(--fg-muted);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-sans);
      background: var(--bg);
      color: var(--white);
      font-size: 13px;
      line-height: 1.4;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Header */
    header {
      height: 38px;
      background: var(--bg2);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      padding: 0 1rem;
      gap: 0.75rem;
      flex-shrink: 0;
    }
    .hdr-logo { color: var(--green); font-weight: bold; font-size: 14px; letter-spacing: 0.15em; text-decoration: none; }
    .hdr-sep { color: var(--dim); margin: 0 0.5rem; }
    .hdr-sub { color: var(--cyan); font-size: 12px; letter-spacing: 0.1em; }
    .hdr-right { margin-left: auto; display: flex; align-items: center; gap: 0.5rem; }

    /* Toolbar */
    .toolbar {
      background: var(--bg2);
      border-bottom: 1px solid var(--border);
      padding: 6px 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
    }
    .btn {
      background: var(--bg3);
      color: var(--green);
      border: 1px solid var(--green-dim);
      padding: 3px 10px;
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      border-radius: 3px;
    }
    .btn:hover { background: var(--green-dim); }
    .btn-primary { color: var(--cyan); border-color: var(--cyan-dim); }
    .btn-primary:hover { background: var(--cyan-dim); }
    .filter-select {
      background: var(--bg3);
      color: var(--white);
      border: 1px solid var(--border);
      padding: 3px 6px;
      font-family: inherit;
      font-size: 11px;
      border-radius: 3px;
    }
    .search-input {
      background: var(--bg3);
      color: var(--white);
      border: 1px solid var(--border);
      padding: 3px 8px;
      font-family: inherit;
      font-size: 11px;
      width: 200px;
      border-radius: 3px;
    }
    .search-input::placeholder { color: var(--dim); }
    .stats-bar { margin-left: auto; color: var(--dim); font-size: 11px; }
    .stats-bar span { margin: 0 0.5rem; }
    .stats-val { color: var(--green); }

    /* Kanban Board */
    .board {
      flex: 1;
      display: flex;
      gap: 2px;
      padding: 8px;
      overflow-x: auto;
      min-height: 0;
    }
    .column {
      flex: 1;
      min-width: 220px;
      max-width: 320px;
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 4px;
      display: flex;
      flex-direction: column;
    }
    .col-header {
      padding: 6px 10px;
      background: var(--bg3);
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      letter-spacing: 0.1em;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .col-header .count {
      background: var(--green-dim);
      color: var(--green);
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 10px;
    }
    .col-body {
      flex: 1;
      overflow-y: auto;
      padding: 4px;
    }

    /* Issue Card */
    .card {
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 8px;
      margin-bottom: 4px;
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .card:hover { border-color: var(--green-lo); }
    .card-title { font-size: 12px; color: var(--white); margin-bottom: 4px; }
    .card-meta { font-size: 10px; color: var(--dim); display: flex; gap: 6px; flex-wrap: wrap; }
    .card-priority {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin-right: 4px;
    }
    .p-urgent { background: var(--red); }
    .p-high { background: var(--amber); }
    .p-medium { background: var(--cyan); }
    .p-low { background: var(--dim); }
    .p-none { background: transparent; border: 1px solid var(--dim); }
    .card-label {
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 2px;
      background: var(--green-dim);
      color: var(--green-mid);
    }
    .card-id { color: var(--dim); font-size: 9px; }

    /* Modal */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 100;
      justify-content: center;
      align-items: center;
    }
    .modal-overlay.active { display: flex; }
    .modal {
      background: var(--bg2);
      border: 1px solid var(--green-dim);
      border-radius: 6px;
      width: 90%;
      max-width: 600px;
      max-height: 85vh;
      overflow-y: auto;
      padding: 1.5rem;
    }
    .modal h3 { color: var(--green); font-size: 14px; margin-bottom: 1rem; letter-spacing: 0.1em; }
    .form-group { margin-bottom: 0.75rem; }
    .form-group label { display: block; color: var(--dim); font-size: 10px; margin-bottom: 3px; letter-spacing: 0.05em; }
    .form-group input, .form-group textarea, .form-group select {
      width: 100%;
      background: var(--bg3);
      color: var(--white);
      border: 1px solid var(--border);
      padding: 6px 8px;
      font-family: inherit;
      font-size: 12px;
      border-radius: 3px;
    }
    .form-group textarea { min-height: 80px; resize: vertical; }
    .form-actions { display: flex; gap: 0.5rem; margin-top: 1rem; justify-content: flex-end; }
    .form-actions .btn { padding: 5px 16px; }

    /* Detail panel */
    .detail-panel {
      display: none;
      position: fixed;
      top: 0;
      right: 0;
      width: 420px;
      height: 100%;
      background: var(--bg2);
      border-left: 1px solid var(--green-dim);
      z-index: 90;
      overflow-y: auto;
      padding: 1rem;
    }
    .detail-panel.active { display: block; }
    .detail-close { float: right; cursor: pointer; color: var(--dim); font-size: 16px; }
    .detail-title { color: var(--green); font-size: 14px; margin-bottom: 0.5rem; margin-right: 2rem; }
    .detail-section { margin-top: 1rem; }
    .detail-section h4 { color: var(--cyan); font-size: 11px; letter-spacing: 0.05em; margin-bottom: 0.25rem; }
    .detail-section p, .detail-section ul { color: var(--white); font-size: 12px; }
    .detail-section ul { padding-left: 1rem; }
    .event-item { font-size: 11px; color: var(--dim); padding: 3px 0; border-bottom: 1px solid var(--border); }
    .event-item .ev-type { color: var(--amber); }
  </style>
</head>
<body>
  <header>
    <a href="/" class="hdr-logo">OpenSwarm</a>
    <span class="hdr-sep">::</span>
    <span class="hdr-sub">ISSUE TRACKER</span>
    <div class="hdr-right">
      <span id="stats-summary" style="color:var(--dim);font-size:11px"></span>
      <button class="btn" id="theme-toggle" type="button" aria-label="Switch theme" aria-pressed="false">◐ THEME</button>
    </div>
  </header>

  <div class="toolbar">
    <button class="btn btn-primary" onclick="openCreateModal()">+ NEW ISSUE</button>
    <select class="filter-select" id="filter-project" onchange="applyFilter()">
      <option value="">all projects</option>
    </select>
    <select class="filter-select" id="filter-priority" onchange="applyFilter()">
      <option value="">all priorities</option>
      <option value="urgent">urgent</option>
      <option value="high">high</option>
      <option value="medium">medium</option>
      <option value="low">low</option>
    </select>
    <input type="text" class="search-input" id="search-input" placeholder="search issues..." oninput="debounceSearch()">
    <div class="stats-bar">
      <span>total: <span class="stats-val" id="stat-total">0</span></span>
      <span>open: <span class="stats-val" id="stat-open">0</span></span>
      <span>done: <span class="stats-val" id="stat-done">0</span></span>
    </div>
  </div>

  <div class="board" id="board">
    <!-- 칸반 칼럼은 JS에서 동적 생성 -->
  </div>

  <!-- 이슈 생성 모달 -->
  <div class="modal-overlay" id="create-modal">
    <div class="modal">
      <h3>NEW ISSUE</h3>
      <div class="form-group">
        <label>PROJECT</label>
        <select id="new-project"></select>
      </div>
      <div class="form-group">
        <label>TITLE</label>
        <input type="text" id="new-title" placeholder="이슈 제목">
      </div>
      <div class="form-group">
        <label>DESCRIPTION</label>
        <textarea id="new-desc" placeholder="상세 설명..."></textarea>
      </div>
      <div style="display:flex;gap:0.75rem">
        <div class="form-group" style="flex:1">
          <label>PRIORITY</label>
          <select id="new-priority">
            <option value="medium">medium</option>
            <option value="urgent">urgent</option>
            <option value="high">high</option>
            <option value="low">low</option>
            <option value="none">none</option>
          </select>
        </div>
        <div class="form-group" style="flex:1">
          <label>STATUS</label>
          <select id="new-status">
            <option value="backlog">backlog</option>
            <option value="todo">todo</option>
            <option value="in_progress">in_progress</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>LABELS (comma separated)</label>
        <input type="text" id="new-labels" placeholder="bug, feature, ...">
      </div>
      <div class="form-group">
        <label>RELEVANT FILES (comma separated)</label>
        <input type="text" id="new-files" placeholder="src/foo.ts, src/bar.ts">
      </div>
      <div class="form-actions">
        <button class="btn" onclick="closeCreateModal()">CANCEL</button>
        <button class="btn btn-primary" onclick="createIssue()">CREATE</button>
      </div>
    </div>
  </div>

  <!-- 이슈 상세 패널 -->
  <div class="detail-panel" id="detail-panel">
    <span class="detail-close" onclick="closeDetail()">&times;</span>
    <div id="detail-content"></div>
  </div>

  <script>
    const COLUMNS = [
      { status: 'backlog', label: 'BACKLOG', color: 'var(--dim)' },
      { status: 'todo', label: 'TODO', color: 'var(--white)' },
      { status: 'in_progress', label: 'IN PROGRESS', color: 'var(--amber)' },
      { status: 'in_review', label: 'IN REVIEW', color: 'var(--cyan)' },
      { status: 'done', label: 'DONE', color: 'var(--green)' },
      { status: 'cancelled', label: 'CANCELLED', color: 'var(--red)' },
    ];

    let allIssues = [];
    let projects = new Set();
    let loadSequence = 0;

    // GraphQL helper
    async function gql(query, variables = {}) {
      const res = await fetch('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      const json = await res.json();
      if (json.errors) {
        console.error('GraphQL errors:', json.errors);
        throw new Error(json.errors[0].message);
      }
      return json.data;
    }

    // 이슈 목록 로드
    async function loadIssues() {
      const sequence = ++loadSequence;
      const projectId = document.getElementById('filter-project').value || undefined;
      const priority = document.getElementById('filter-priority').value || undefined;
      const search = document.getElementById('search-input').value || undefined;

      const filter = {};
      if (projectId) filter.projectId = projectId;
      if (priority) filter.priority = [priority];
      if (search) filter.search = search;

      try {
      const data = await gql(\`
        query ListIssues($filter: IssueFilterInput) {
          issues(filter: $filter) {
            issues {
              id projectId title description status priority source
              labels assignee relevantFiles dependencies childIds
              linearIdentifier memoryIds createdAt updatedAt closedAt
            }
            total
          }
          issueStats {
            total
            byStatus { status count }
          }
        }
      \`, { filter: Object.keys(filter).length > 0 ? filter : null });
      if (sequence !== loadSequence) return;

      allIssues = data.issues.issues;

      // 프로젝트 목록 갱신
      for (const iss of allIssues) projects.add(iss.projectId);
      updateProjectFilter();

      // 통계 갱신
      const stats = data.issueStats;
      document.getElementById('stat-total').textContent = stats.total;
      const openCount = stats.byStatus
        .filter(s => !['done', 'cancelled'].includes(s.status))
        .reduce((a, s) => a + s.count, 0);
      const doneCount = stats.byStatus.find(s => s.status === 'done')?.count || 0;
      document.getElementById('stat-open').textContent = openCount;
      document.getElementById('stat-done').textContent = doneCount;

      renderBoard();
      } catch (error) {
        if (sequence !== loadSequence) return;
        console.error('Issue board refresh failed:', error);
        document.getElementById('stat-total').textContent = 'error';
      }
    }

    function updateProjectFilter() {
      const sel = document.getElementById('filter-project');
      const current = sel.value;
      const opts = ['<option value="">all projects</option>'];
      for (const p of projects) {
        opts.push('<option value="' + escAttr(p) + '"' + (p === current ? ' selected' : '') + '>' + escHtml(p) + '</option>');
      }
      sel.innerHTML = opts.join('');
    }

    // 칸반 보드 렌더링
    function renderBoard() {
      const board = document.getElementById('board');
      board.innerHTML = '';

      for (const col of COLUMNS) {
        const issues = allIssues.filter(i => i.status === col.status);
        const colEl = document.createElement('div');
        colEl.className = 'column';
        colEl.innerHTML = \`
          <div class="col-header">
            <span style="color:\${col.color}">\${col.label}</span>
            <span class="count">\${issues.length}</span>
          </div>
          <div class="col-body" data-status="\${col.status}"></div>
        \`;

        const body = colEl.querySelector('.col-body');
        for (const iss of issues) {
          body.appendChild(createCard(iss));
        }

        // 드래그 드롭 수신
        body.addEventListener('dragover', e => { e.preventDefault(); body.style.background = 'var(--green-dim)'; });
        body.addEventListener('dragleave', () => { body.style.background = ''; });
        body.addEventListener('drop', async e => {
          e.preventDefault();
          body.style.background = '';
          const issueId = e.dataTransfer.getData('text/plain');
          if (issueId && col.status) {
            await gql(\`mutation($id:ID!,$s:IssueStatus!){changeIssueStatus(id:$id,status:$s){id}}\`,
              { id: issueId, s: col.status });
            loadIssues();
          }
        });

        board.appendChild(colEl);
      }
    }

    function createCard(iss) {
      const card = document.createElement('div');
      card.className = 'card';
      card.draggable = true;
      card.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', iss.id); });
      card.addEventListener('click', () => openDetail(iss.id));

      const priorityClass = 'p-' + iss.priority;
      const labels = (iss.labels || []).map(l => '<span class="card-label">' + escHtml(l) + '</span>').join('');
      const timeAgo = formatTimeAgo(iss.updatedAt);

      card.innerHTML = \`
        <div class="card-title"><span class="card-priority \${escAttr(priorityClass)}"></span>\${escHtml(iss.title)}</div>
        <div class="card-meta">
          <span class="card-id">\${escHtml(iss.id.slice(0, 6))}</span>
          <span>\${escHtml(iss.projectId)}</span>
          \${iss.assignee ? '<span>' + escHtml(iss.assignee) + '</span>' : ''}
          <span>\${escHtml(timeAgo)}</span>
        </div>
        \${labels ? '<div class="card-meta" style="margin-top:3px">' + labels + '</div>' : ''}
      \`;
      return card;
    }

    // 이슈 상세 패널
    async function openDetail(id) {
      const data = await gql(\`
        query IssueDetail($id:ID!) {
          issue(id:$id) {
            id projectId title description status priority source
            labels assignee relevantFiles acceptanceCriteria
            dependencies childIds memoryIds createdAt updatedAt closedAt
            linearIdentifier linearUrl
          }
          issueEvents(issueId:$id, limit:20) {
            id type oldValue newValue content actor createdAt
          }
        }
      \`, { id });

      const iss = data.issue;
      if (!iss) return;
      const events = data.issueEvents;

      const panel = document.getElementById('detail-panel');
      const content = document.getElementById('detail-content');

      const statusOptions = COLUMNS.map(c =>
        '<option value="' + escAttr(c.status) + '"' + (c.status === iss.status ? ' selected' : '') + '>' + escHtml(c.label) + '</option>'
      ).join('');
      const linearLink = iss.linearIdentifier && iss.linearUrl
        ? ' | <a href="' + escAttr(safeUrl(iss.linearUrl)) + '" style="color:var(--cyan)" target="_blank" rel="noopener noreferrer">' + escHtml(iss.linearIdentifier) + '</a>'
        : '';

      content.innerHTML = \`
        <div class="detail-title">\${escHtml(iss.title)}</div>
        <div style="color:var(--dim);font-size:10px;margin-bottom:1rem">
          \${escHtml(iss.id)} | \${escHtml(iss.projectId)}
          \${linearLink}
        </div>

        <div class="detail-section">
          <h4>STATUS</h4>
          <select class="filter-select" onchange="changeStatus('\${escJsArg(iss.id)}', this.value)" style="width:100%">
            \${statusOptions}
          </select>
        </div>

        <div class="detail-section">
          <h4>DESCRIPTION</h4>
          <p style="white-space:pre-wrap">\${escHtml(iss.description) || '<span style="color:var(--dim)">no description</span>'}</p>
        </div>

        \${iss.relevantFiles.length ? '<div class="detail-section"><h4>RELEVANT FILES</h4><ul>' + iss.relevantFiles.map(f => '<li>' + escHtml(f) + '</li>').join('') + '</ul></div>' : ''}

        \${iss.acceptanceCriteria.length ? '<div class="detail-section"><h4>ACCEPTANCE CRITERIA</h4><ul>' + iss.acceptanceCriteria.map(c => '<li>' + escHtml(c) + '</li>').join('') + '</ul></div>' : ''}

        \${iss.dependencies.length ? '<div class="detail-section"><h4>DEPENDENCIES</h4><p>' + iss.dependencies.map(d => escHtml(d)).join(', ') + '</p></div>' : ''}

        <div class="detail-section">
          <h4>ACTIVITY (\${events.length})</h4>
          \${events.map(ev => \`
            <div class="event-item">
              <span class="ev-type">\${escHtml(ev.type)}</span>
              \${ev.content ? ': ' + escHtml(ev.content).slice(0, 100) : ''}
              \${ev.oldValue && ev.newValue ? ': ' + escHtml(ev.oldValue) + ' → ' + escHtml(ev.newValue) : ''}
              <span style="float:right">\${escHtml(formatTimeAgo(ev.createdAt))}</span>
            </div>
          \`).join('')}
        </div>

        <div class="detail-section" style="margin-top:1.5rem">
          <h4>ADD COMMENT</h4>
          <textarea id="comment-input" style="width:100%;background:var(--bg3);color:var(--white);border:1px solid var(--border);padding:6px;font-family:inherit;font-size:12px;min-height:60px;border-radius:3px" placeholder="코멘트 입력..."></textarea>
          <button class="btn btn-primary" style="margin-top:4px" onclick="addComment('\${escJsArg(iss.id)}')">COMMENT</button>
        </div>

        <div class="form-actions" style="margin-top:1.5rem;justify-content:flex-start">
          <button class="btn" style="color:var(--red);border-color:var(--red)" onclick="deleteIssue('\${escJsArg(iss.id)}')">DELETE</button>
        </div>
      \`;

      panel.classList.add('active');
    }

    function closeDetail() {
      document.getElementById('detail-panel').classList.remove('active');
    }

    async function changeStatus(id, status) {
      await gql(\`mutation($id:ID!,$s:IssueStatus!){changeIssueStatus(id:$id,status:$s){id}}\`, { id, s: status });
      loadIssues();
    }

    async function addComment(id) {
      const input = document.getElementById('comment-input');
      const content = input.value.trim();
      if (!content) return;
      await gql(\`mutation($id:ID!,$c:String!){addComment(issueId:$id,content:$c){id}}\`, { id, c: content });
      input.value = '';
      openDetail(id);
    }

    async function deleteIssue(id) {
      if (!confirm('Delete this issue?')) return;
      await gql(\`mutation($id:ID!){deleteIssue(id:$id)}\`, { id });
      closeDetail();
      loadIssues();
    }

    // 이슈 생성
    function openCreateModal() {
      const sel = document.getElementById('new-project');
      sel.innerHTML = [...projects].map(p => '<option value="' + escAttr(p) + '">' + escHtml(p) + '</option>').join('');
      if (sel.options.length === 0) {
        sel.innerHTML = '<option value="default">default</option>';
      }
      document.getElementById('create-modal').classList.add('active');
      document.getElementById('new-title').focus();
    }

    function closeCreateModal() {
      document.getElementById('create-modal').classList.remove('active');
    }

    async function createIssue() {
      const title = document.getElementById('new-title').value.trim();
      if (!title) { alert('Title required'); return; }

      const input = {
        projectId: document.getElementById('new-project').value || 'default',
        title,
        description: document.getElementById('new-desc').value,
        priority: document.getElementById('new-priority').value,
        status: document.getElementById('new-status').value,
        labels: document.getElementById('new-labels').value.split(',').map(s => s.trim()).filter(Boolean),
        relevantFiles: document.getElementById('new-files').value.split(',').map(s => s.trim()).filter(Boolean),
      };

      await gql(\`
        mutation CreateIssue($input: CreateIssueInput!) {
          createIssue(input: $input) { id }
        }
      \`, { input });

      closeCreateModal();
      // 폼 초기화
      document.getElementById('new-title').value = '';
      document.getElementById('new-desc').value = '';
      document.getElementById('new-labels').value = '';
      document.getElementById('new-files').value = '';
      loadIssues();
    }

    // 유틸
    function escHtml(s) {
      if (!s) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function escAttr(s) {
      return escHtml(s);
    }

    function escJsArg(s) {
      return escAttr(String(s).replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"));
    }

    function safeUrl(url) {
      try {
        const parsed = new URL(url, window.location.origin);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '#';
      } catch {
        return '#';
      }
    }

    function formatTimeAgo(iso) {
      if (!iso) return '';
      const diff = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      return days + 'd ago';
    }

    let searchTimer;
    function debounceSearch() {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadIssues, 300);
    }

    function applyFilter() {
      loadIssues();
    }

    // 키보드 단축키
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeCreateModal();
        closeDetail();
      }
      if (e.key === 'n' && !e.target.closest('input,textarea,select')) {
        e.preventDefault();
        openCreateModal();
      }
    });

    // 초기 로드
    loadIssues();
    // 30초 간격 자동 새로고침
    setInterval(loadIssues, 30000);
  </script>
  <script type="module">
    import { installThemeToggle } from '/static/js/theme.mjs';
    installThemeToggle(document, document.getElementById('theme-toggle'));
  </script>
</body>
</html>`;
