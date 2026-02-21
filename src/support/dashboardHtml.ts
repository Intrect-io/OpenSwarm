// Auto-generated: Dashboard HTML template for VEGA Supervisor
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VEGA :: Supervisor</title>
  <style>
    :root {
      --bg:        #0a0c0a;
      --bg2:       #0d100d;
      --bg3:       #111411;
      --green:     #00ff41;
      --green-dim: #003a00;
      --green-mid: #00aa00;
      --green-lo:  #005500;
      --cyan:      #00ccdd;
      --cyan-dim:  #003344;
      --amber:     #ffaa00;
      --red:       #ff3333;
      --white:     #ccddcc;
      --dim:       #445544;
      --border:    #1a2a1a;
      --border2:   #0d1a0d;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
      background: var(--bg);
      color: var(--white);
      font-size: 13px;
      line-height: 1.4;
    }

    /* ===== SCROLLBAR ===== */
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-track { background: var(--bg); }
    ::-webkit-scrollbar-thumb { background: var(--green-lo); border-radius: 2px; }

    /* ===== HEADER ===== */
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
    .hdr-logo {
      color: var(--green);
      font-weight: bold;
      font-size: 14px;
      letter-spacing: 0.15em;
    }
    .hdr-fullname { color: var(--dim); font-size: 11px; letter-spacing: 0.05em; margin-left: 0.25rem; }
    .hdr-sep { color: var(--dim); margin-left: 0.5rem; }
    .hdr-sub { color: var(--dim); font-size: 11px; letter-spacing: 0.1em; }
    .hdr-right { margin-left: auto; display: flex; align-items: center; gap: 0.5rem; }
    #sse-status {
      font-size: 10px;
      padding: 1px 6px;
      border: 1px solid var(--dim);
      color: var(--dim);
      letter-spacing: 0.1em;
    }
    #sse-status.connected { border-color: var(--green); color: var(--green); }
    #sse-status.disconnected { border-color: var(--red); color: var(--red); }
    .btn {
      font-family: inherit;
      font-size: 10px;
      padding: 2px 10px;
      background: transparent;
      border: 1px solid var(--green-lo);
      color: var(--green-mid);
      cursor: pointer;
      letter-spacing: 0.1em;
      transition: all 0.15s;
    }
    .btn:hover:not(:disabled) { border-color: var(--green); color: var(--green); background: var(--green-dim); }
    .btn:disabled { opacity: 0.4; cursor: default; }
    .btn-active { border-color: var(--amber); color: var(--amber); }
    .btn-active:hover:not(:disabled) { background: #332200; border-color: var(--amber); }

    /* ===== STATS BAR ===== */
    .stats-bar {
      height: 36px;
      background: var(--bg2);
      border-bottom: 1px solid var(--border2);
      display: flex;
      align-items: center;
      padding: 0 1rem;
      gap: 1.5rem;
      flex-shrink: 0;
    }
    .stat {
      display: flex;
      align-items: baseline;
      gap: 0.4rem;
    }
    .stat-label { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.1em; }
    .stat-val { font-size: 15px; font-weight: bold; color: var(--green); }
    .stat-val.amber { color: var(--amber); }
    .stat-val.cyan { color: var(--cyan); }
    .stat-divider { color: var(--border); }

    /* ===== MAIN GRID ===== */
    .main-grid {
      display: grid;
      grid-template-columns: 290px 1fr 340px;
      height: calc(100vh - 74px);
      overflow: hidden;
    }
    .col {
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--border);
      overflow: hidden;
    }
    .col:last-child { border-right: none; }

    /* ===== PANEL ===== */
    .panel { display: flex; flex-direction: column; overflow: hidden; flex: 1; }
    .panel + .panel { border-top: 1px solid var(--border); }
    .panel-hdr {
      height: 28px;
      padding: 0 0.75rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--bg3);
      border-bottom: 1px solid var(--border2);
      flex-shrink: 0;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--dim);
    }
    .panel-hdr-title { color: var(--green-mid); }
    .panel-hdr-badge {
      margin-left: auto;
      font-size: 9px;
      color: var(--dim);
    }
    .panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 0.5rem;
    }
    .empty { color: var(--dim); font-size: 11px; text-align: center; padding: 1.5rem 0.5rem; }

    /* ===== PROJECTS ===== */
    .proj-card {
      border: 1px solid var(--border);
      margin-bottom: 4px;
      background: var(--bg2);
    }
    .proj-card.disabled { opacity: 0.45; }
    .proj-hdr {
      display: flex;
      align-items: center;
      padding: 5px 7px;
      gap: 6px;
      cursor: pointer;
      user-select: none;
    }
    .proj-hdr:hover { background: var(--green-dim); }
    .proj-arrow { color: var(--dim); font-size: 9px; width: 10px; flex-shrink: 0; }
    .proj-card.expanded .proj-arrow::before { content: "▼"; }
    .proj-card:not(.expanded) .proj-arrow::before { content: "▶"; }
    .proj-info { flex: 1; min-width: 0; }
    .proj-name { color: var(--green); font-size: 12px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .proj-path { color: var(--dim); font-size: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .proj-counts { display: flex; gap: 3px; }
    .cnt { font-size: 9px; padding: 1px 4px; font-weight: bold; }
    .cnt-run { color: var(--green); border: 1px solid var(--green-lo); }
    .cnt-que { color: var(--amber); border: 1px solid #332200; }
    .cnt-pnd { color: var(--cyan); border: 1px solid var(--cyan-dim); }
    .proj-toggle { flex-shrink: 0; }
    .toggle { position: relative; display: inline-block; width: 30px; height: 16px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background: #111; border: 1px solid var(--dim);
      border-radius: 16px; transition: 0.2s;
    }
    .slider:before {
      position: absolute; content: "";
      height: 10px; width: 10px;
      left: 2px; bottom: 2px;
      background: var(--dim); border-radius: 50%; transition: 0.2s;
    }
    input:checked + .slider { background: var(--green-dim); border-color: var(--green-lo); }
    input:checked + .slider:before { background: var(--green); transform: translateX(14px); }
    .proj-issues { border-top: 1px solid var(--border2); padding: 4px 7px; }
    .issue-sec-label {
      font-size: 9px; color: var(--dim); text-transform: uppercase;
      letter-spacing: 0.1em; margin: 4px 0 2px;
    }
    .issue-row {
      display: flex; align-items: center; gap: 4px;
      padding: 2px 0; font-size: 11px;
      border-bottom: 1px solid var(--border2);
    }
    .issue-row:last-child { border-bottom: none; }
    .idot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
    .idot-run { background: var(--green); }
    .idot-que { background: var(--amber); }
    .idot-pnd { background: var(--dim); }
    .prio { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
    .prio-1 { background: var(--red); }
    .prio-2 { background: var(--amber); }
    .prio-3 { background: var(--green-mid); }
    .prio-4 { background: var(--dim); }
    .issue-id { color: var(--cyan); font-size: 9px; min-width: 50px; }
    .issue-title { flex: 1; color: var(--white); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* ===== PIPELINE ===== */
    .stage-row {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 0; border-bottom: 1px solid var(--border2);
      font-size: 11px;
    }
    .sdot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--dim); }
    .sdot.start  { background: var(--amber); }
    .sdot.complete { background: var(--green); }
    .sdot.fail   { background: var(--red); }
    .sname { color: var(--white); min-width: 70px; }
    .stask { color: var(--cyan); font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sstatus { margin-left: auto; font-size: 9px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.06em; flex-shrink: 0; }

    /* ===== LOG ===== */
    .log-area { font-size: 11px; line-height: 1.6; }
    .log-line { padding: 2px 0; border-bottom: 1px solid var(--border2); display: flex; gap: 4px; align-items: flex-start; }
    .ltag { color: var(--green-lo); min-width: 44px; flex-shrink: 0; padding-top: 1px; }
    .lstage { color: var(--cyan); min-width: 55px; flex-shrink: 0; font-size: 10px; padding-top: 1px; }
    .ltext { color: var(--dim); word-break: break-word; white-space: pre-wrap; flex: 1; min-width: 0; }

    /* ===== CHAT ===== */
    .chat-col { display: flex; flex-direction: column; height: 100%; }
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 0.5rem;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .chat-line { display: flex; gap: 6px; font-size: 12px; line-height: 1.5; }
    .chat-prefix {
      flex-shrink: 0;
      font-weight: bold;
    }
    .chat-user .chat-prefix { color: var(--amber); }
    .chat-agent .chat-prefix { color: var(--cyan); }
    .chat-text { color: var(--white); white-space: pre-wrap; word-break: break-word; flex: 1; }
    .chat-agent .chat-text { color: var(--white); }
    .chat-user .chat-text { color: var(--amber); }
    .chat-ts { color: var(--dim); font-size: 9px; flex-shrink: 0; align-self: flex-start; padding-top: 2px; }
    .chat-thinking { animation: blink 1s infinite; color: var(--cyan); }
    @keyframes blink { 0%,100% { opacity:1; } 50% { opacity:0.3; } }

    .chat-input-area {
      border-top: 1px solid var(--border);
      padding: 6px 8px;
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--bg3);
      flex-shrink: 0;
    }
    .chat-prompt { color: var(--green); font-size: 12px; flex-shrink: 0; }
    .chat-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      font-family: inherit;
      font-size: 12px;
      color: var(--green);
      caret-color: var(--green);
    }
    .chat-input::placeholder { color: var(--dim); }
    .chat-send {
      font-family: inherit;
      font-size: 10px;
      padding: 2px 8px;
      background: transparent;
      border: 1px solid var(--green-lo);
      color: var(--green-mid);
      cursor: pointer;
    }
    .chat-send:hover { border-color: var(--green); color: var(--green); }
    .chat-send:disabled { opacity: 0.3; cursor: default; }

    /* ===== REPO PICKER ===== */
    .repo-item {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 12px; cursor: pointer; font-size: 11px;
    }
    .repo-item:hover { background: var(--green-dim); }
    .repo-item-name { color: var(--green); font-weight: bold; }
    .repo-item-path { color: var(--dim); font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .repo-item-badge { font-size: 9px; padding: 1px 5px; border: 1px solid var(--green-lo); color: var(--green-mid); flex-shrink: 0; }
  </style>
</head>
<body>
  <!-- HEADER -->
  <header>
    <span class="hdr-logo">VEGA</span>
    <span class="hdr-fullname">: Vector-Encoded General Agent</span>
    <span class="hdr-sep">::</span>
    <span class="hdr-sub">SUPERVISOR</span>
    <div class="hdr-right">
      <span id="sse-status">CONNECTING</span>
      <button class="btn btn-active" id="hb-btn" onclick="triggerHeartbeat()">▶ HEARTBEAT</button>
    </div>
  </header>

  <!-- STATS BAR -->
  <div class="stats-bar">
    <div class="stat"><span class="stat-label">RUN</span><span class="stat-val" id="stat-running">0</span></div>
    <span class="stat-divider">│</span>
    <div class="stat"><span class="stat-label">QUEUE</span><span class="stat-val amber" id="stat-queued">0</span></div>
    <span class="stat-divider">│</span>
    <div class="stat"><span class="stat-label">DONE</span><span class="stat-val" id="stat-completed">0</span></div>
    <span class="stat-divider">│</span>
    <div class="stat"><span class="stat-label">SSE</span><span class="stat-val cyan" id="stat-sse">-</span></div>
    <span class="stat-divider">│</span>
    <div class="stat"><span class="stat-label">UPTIME</span><span class="stat-val" id="stat-uptime">-</span></div>
  </div>

  <!-- MAIN GRID -->
  <div class="main-grid">

    <!-- LEFT: REPOSITORIES -->
    <div class="col">
      <div class="panel">
        <div class="panel-hdr">
          <span class="panel-hdr-title">REPOSITORIES</span>
          <span class="panel-hdr-badge" id="proj-summary"></span>
          <button class="btn" style="margin-left:auto;font-size:9px;padding:1px 6px" onclick="openRepoPicker()">+ ADD</button>
        </div>
        <div class="panel-body" id="project-list">
          <div class="empty">loading...</div>
        </div>
      </div>
    </div>

    <!-- REPO PICKER OVERLAY -->
    <div id="repo-picker" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:100;align-items:center;justify-content:center">
      <div style="background:#0d100d;border:1px solid #1a2a1a;width:500px;max-height:70vh;display:flex;flex-direction:column">
        <div style="padding:8px 12px;border-bottom:1px solid #1a2a1a;display:flex;align-items:center;gap:8px">
          <span style="color:#00aa00;font-size:11px;text-transform:uppercase;letter-spacing:.1em">ADD REPOSITORY</span>
          <button onclick="closeRepoPicker()" style="margin-left:auto;background:transparent;border:none;color:#445544;cursor:pointer;font-size:14px">✕</button>
        </div>
        <div style="padding:6px 12px;border-bottom:1px solid #1a2a1a">
          <input id="repo-search" type="text" placeholder="filter repositories..."
            style="width:100%;background:transparent;border:none;outline:none;font-family:inherit;font-size:12px;color:#00ff41;caret-color:#00ff41"
            oninput="filterRepos(this.value)" onkeydown="if(event.key==='Escape')closeRepoPicker()">
        </div>
        <div id="repo-picker-list" style="overflow-y:auto;flex:1;padding:4px 0"></div>
      </div>
    </div>

    <!-- MIDDLE: PIPELINE + LOG -->
    <div class="col">
      <div class="panel" style="flex: 0 0 38%">
        <div class="panel-hdr">
          <span class="panel-hdr-title">PIPELINE</span>
          <span class="panel-hdr-badge" id="stage-count"></span>
        </div>
        <div class="panel-body" id="stage-list">
          <div class="empty">no pipeline events</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-hdr">
          <span class="panel-hdr-title">LIVE LOG</span>
          <span class="panel-hdr-badge" id="log-count"></span>
        </div>
        <div class="panel-body log-area" id="log-list">
          <div class="empty">no log output</div>
        </div>
      </div>
    </div>

    <!-- RIGHT: CHAT -->
    <div class="col">
      <div class="panel-hdr">
        <span class="panel-hdr-title">AGENT CHAT</span>
        <span class="panel-hdr-badge" id="chat-status"></span>
      </div>
      <div class="chat-col">
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-input-area">
          <span class="chat-prompt">&gt;</span>
          <input
            class="chat-input" id="chat-input"
            type="text" placeholder="message VEGA..."
            onkeydown="if(event.key==='Enter')sendChat()"
          >
          <button class="chat-send" id="chat-send" onclick="sendChat()">SEND</button>
        </div>
      </div>
    </div>

  </div>

  <script>
    const MAX_LOG = 200;
    const MAX_STAGE = 100;

    let projects = [];
    let expandedProjects = new Set();
    let logLines = [];
    let stageRows = [];
    let chatBusy = false;
    const taskProjectMap = new Map();
    // taskId → { title, issueIdentifier } for pipeline display
    const taskTitleMap = new Map();

    // ---- SSE ----
    function connectSSE() {
      const es = new EventSource("/api/events");
      const statusEl = document.getElementById("sse-status");
      es.onopen = () => { statusEl.textContent = "LIVE"; statusEl.className = "connected"; };
      es.onmessage = e => {
        let ev; try { ev = JSON.parse(e.data); } catch { return; }
        handleEvent(ev);
      };
      es.onerror = () => {
        statusEl.textContent = "RECONNECTING"; statusEl.className = "disconnected";
        es.close(); setTimeout(connectSSE, 3000);
      };
    }

    function handleEvent(ev) {
      switch (ev.type) {
        case "stats": updateStats(ev.data); break;
        case "task:queued":
          taskProjectMap.set(ev.data.taskId, ev.data.projectPath);
          taskTitleMap.set(ev.data.taskId, { title: ev.data.title, issueIdentifier: ev.data.issueIdentifier });
          updateProjectTask(ev.data.projectPath, ev.data.taskId, ev.data.title, ev.data.priority, "queued");
          break;
        case "task:started": {
          const p = taskProjectMap.get(ev.data.taskId);
          if (ev.data.title) taskTitleMap.set(ev.data.taskId, { title: ev.data.title, issueIdentifier: ev.data.issueIdentifier });
          if (p) updateProjectTask(p, ev.data.taskId, ev.data.title, null, "running");
          break;
        }
        case "task:completed": {
          const p = taskProjectMap.get(ev.data.taskId);
          if (p) removeProjectTask(p, ev.data.taskId);
          break;
        }
        case "pipeline:stage": addStageRow(ev.data); break;
        case "pipeline:iteration":
          addStageRow({ taskId: ev.data.taskId, stage: "iter #" + ev.data.iteration, status: "start" });
          break;
        case "log": addLogLine(ev.data); break;
        case "project:toggled": {
          const p = projects.find(x => x.path === ev.data.projectPath);
          if (p) { p.enabled = ev.data.enabled; renderProjects(); }
          break;
        }
        case "chat:agent": appendChatMsg("agent", ev.data.text, null, ev.data.ts); break;
        case "heartbeat": {
          const btn = document.getElementById("hb-btn");
          btn.disabled = false; btn.textContent = "▶ HEARTBEAT";
          break;
        }
      }
    }

    // ---- Stats ----
    function updateStats(data) {
      document.getElementById("stat-running").textContent = data.runningTasks ?? 0;
      document.getElementById("stat-queued").textContent = data.queuedTasks ?? 0;
      document.getElementById("stat-completed").textContent = data.completedToday ?? 0;
      if (data.uptime != null) {
        const s = Math.floor(data.uptime / 1000);
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
        document.getElementById("stat-uptime").textContent =
          (h ? h + "h " : "") + (m ? m + "m " : "") + ss + "s";
      }
    }

    // ---- Heartbeat trigger ----
    async function triggerHeartbeat() {
      const btn = document.getElementById("hb-btn");
      btn.disabled = true; btn.textContent = "⟳ RUNNING";
      addLogLine({ taskId: "system", stage: "manual", line: "Heartbeat triggered by user" });
      try {
        await fetch("/api/heartbeat", { method: "POST" });
      } catch(e) {
        addLogLine({ taskId: "system", stage: "error", line: "Heartbeat failed: " + e.message });
        btn.disabled = false; btn.textContent = "▶ HEARTBEAT";
      }
    }

    // ---- Project task updates ----
    function updateProjectTask(projectPath, taskId, title, priority, status) {
      const p = projects.find(x => x.path === projectPath);
      if (!p) return;
      if (status === "running") {
        p.queued = p.queued.filter(t => t.id !== taskId);
        if (!p.running.find(t => t.id === taskId)) p.running.push({ id: taskId, title, priority });
      } else {
        if (!p.queued.find(t => t.id === taskId)) p.queued.push({ id: taskId, title, priority });
      }
      renderProjects();
    }
    function removeProjectTask(projectPath, taskId) {
      const p = projects.find(x => x.path === projectPath);
      if (!p) return;
      p.running = p.running.filter(t => t.id !== taskId);
      p.queued  = p.queued.filter(t => t.id !== taskId);
      renderProjects();
    }

    // ---- Toggle project ----
    async function toggleProject(projectPath, enabled) {
      const p = projects.find(x => x.path === projectPath);
      if (p) p.enabled = enabled;
      renderProjects();
      try {
        await fetch("/api/projects/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectPath, enabled }),
        });
      } catch(e) {
        if (p) p.enabled = !enabled;
        renderProjects();
      }
    }

    // ---- Render Projects ----
    function renderProjects() {
      const el = document.getElementById("project-list");
      const sumEl = document.getElementById("proj-summary");
      if (!projects.length) { el.innerHTML = "<div class=\\"empty\\">no repositories</div>"; return; }
      const on = projects.filter(p => p.enabled).length;
      if (sumEl) sumEl.textContent = on + "/" + projects.length;

      el.innerHTML = projects.map(p => {
        // Use path as key, fall back to __n:name for unmapped projects
        const key     = p.path || ("__n:" + p.name);
        const expanded = expandedProjects.has(key);
        const checked  = p.enabled ? "checked" : "";
        const dCls     = p.enabled ? "" : " disabled";
        const eCls     = expanded  ? " expanded" : "";
        let issuesHtml = "";
        if (expanded) {
          const secs = [];
          if (p.running.length) secs.push(
            "<div class=\\"issue-sec-label\\">running</div>" +
            p.running.map(t => issueRow(t, "idot-run")).join("")
          );
          if (p.queued.length) secs.push(
            "<div class=\\"issue-sec-label\\">queued</div>" +
            p.queued.map(t => issueRow(t, "idot-que")).join("")
          );
          if (p.pending.length) secs.push(
            "<div class=\\"issue-sec-label\\">linear (" + p.pending.length + ")</div>" +
            p.pending.map(t => issueRow(t, "idot-pnd")).join("")
          );
          if (!secs.length) secs.push("<div class=\\"empty\\" style=\\"padding:4px\\">no issues</div>");
          issuesHtml = "<div class=\\"proj-issues\\">" + secs.join("") + "</div>";
        }

        return (
          "<div class=\\"proj-card" + dCls + eCls + "\\" data-key=\\"" + escapeAttr(key) + "\\">" +
          "<div class=\\"proj-hdr\\" data-key=\\"" + escapeAttr(key) + "\\" onclick=\\"handleToggleExpand(this)\\">" +
            "<span class=\\"proj-arrow\\"></span>" +
            "<div class=\\"proj-info\\">" +
              "<div class=\\"proj-name\\">" + escapeHtml(p.name) + "</div>" +
              "<div class=\\"proj-path\\">" + escapeHtml(p.path) + "</div>" +
            "</div>" +
            "<div class=\\"proj-counts\\">" +
              (p.running.length ? "<span class=\\"cnt cnt-run\\">" + p.running.length + "r</span>" : "") +
              (p.queued.length  ? "<span class=\\"cnt cnt-que\\">" + p.queued.length  + "q</span>" : "") +
              (p.pending.length ? "<span class=\\"cnt cnt-pnd\\">" + p.pending.length + "p</span>" : "") +
            "</div>" +
            "<div class=\\"proj-toggle\\" onclick=\\"event.stopPropagation()\\" style=\\"display:flex;align-items:center;gap:4px\\">" +
              "<button class=\\"btn\\" style=\\"font-size:8px;padding:1px 4px;opacity:.5\\" data-path=\\"" + escapeAttr(p.path) + "\\" onclick=\\"handleUnpin(this)\\">✕</button>" +
              "<label class=\\"toggle\\">" +
                "<input type=\\"checkbox\\" " + checked + " data-path=\\"" + escapeAttr(p.path) + "\\" onchange=\\"handleToggleProject(this)\\">" +
                "<span class=\\"slider\\"></span>" +
              "</label>" +
            "</div>" +
          "</div>" +
          issuesHtml +
          "</div>"
        );
      }).join("");
    }

    function issueRow(t, dotClass) {
      const prio = t.priority || 3;
      return (
        "<div class=\\"issue-row\\">" +
        "<span class=\\"idot " + dotClass + "\\"></span>" +
        "<span class=\\"prio prio-" + Math.min(4, prio) + "\\"></span>" +
        (t.issueIdentifier ? "<span class=\\"issue-id\\">" + escapeHtml(t.issueIdentifier) + "</span>" : "") +
        "<span class=\\"issue-title\\" title=\\"" + escapeAttr(t.title) + "\\">" + escapeHtml(t.title) + "</span>" +
        "</div>"
      );
    }

    function toggleExpand(key) {
      if (expandedProjects.has(key)) expandedProjects.delete(key);
      else expandedProjects.add(key);
      renderProjects();
    }
    function handleToggleExpand(el) {
      const key = el.getAttribute("data-key");
      if (key) toggleExpand(key);
    }
    function handleToggleProject(el) {
      const path = el.getAttribute("data-path");
      if (path) toggleProject(path, el.checked);
    }
    async function handleUnpin(el) {
      const path = el.getAttribute("data-path");
      if (!path) return;
      el.disabled = true;
      try {
        await fetch("/api/projects/unpin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectPath: path }),
        });
        const res = await fetch("/api/projects");
        projects = await res.json();
        renderProjects();
      } catch(e) { el.disabled = false; }
    }

    // ---- Pipeline Stages ----
    function addStageRow(data) {
      stageRows.push(data);
      if (stageRows.length > MAX_STAGE) stageRows = stageRows.slice(-MAX_STAGE);
      renderStages();
    }
    function renderStages() {
      const el = document.getElementById("stage-list");
      const cnt = document.getElementById("stage-count");
      if (!stageRows.length) { el.innerHTML = "<div class=\\"empty\\">no pipeline events</div>"; return; }
      if (cnt) cnt.textContent = stageRows.length + "/" + MAX_STAGE;
      el.innerHTML = stageRows.slice().reverse().map(r => {
        const info = r.taskId ? taskTitleMap.get(r.taskId) : null;
        let taskLabel = "";
        if (info) {
          // issueIdentifier 있으면 우선 표시, 없으면 title 앞 25자
          taskLabel = info.issueIdentifier
            ? info.issueIdentifier + (info.title ? " " + info.title.slice(0, 22) : "")
            : (info.title ? info.title.slice(0, 30) : "");
        } else if (r.taskId) {
          // fallback: 짧은 해시
          taskLabel = r.taskId.slice(0, 8);
        }
        return (
          "<div class=\\"stage-row\\">" +
          "<div class=\\"sdot " + (r.status || "") + "\\"></div>" +
          "<div class=\\"sname\\">" + escapeHtml(r.stage) + "</div>" +
          "<div class=\\"stask\\" title=\\"" + escapeAttr(r.taskId || "") + "\\">" + escapeHtml(taskLabel) + "</div>" +
          "<div class=\\"sstatus\\">" + (r.status || "") + "</div>" +
          "</div>"
        );
      }).join("");
      el.scrollTop = 0;
    }

    // ---- Log ----
    function addLogLine(data) {
      logLines.push(data);
      if (logLines.length > MAX_LOG) logLines = logLines.slice(-MAX_LOG);
      renderLog();
    }
    function renderLog() {
      const el = document.getElementById("log-list");
      const cnt = document.getElementById("log-count");
      if (!logLines.length) { el.innerHTML = "<div class=\\"empty\\">no log output</div>"; if (cnt) cnt.textContent = ""; return; }
      if (cnt) cnt.textContent = logLines.length + "/" + MAX_LOG;
      const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50;
      el.innerHTML = logLines.map(l => {
        // taskId가 UUID면 issueIdentifier 조회, 아니면 그대로
        const info = l.taskId ? taskTitleMap.get(l.taskId) : null;
        const tag = info?.issueIdentifier
          ? info.issueIdentifier
          : (l.taskId || "").slice(0, 8);
        return (
          "<div class=\\"log-line\\">" +
          "<span class=\\"ltag\\" title=\\"" + escapeAttr(l.taskId || "") + "\\">[" + escapeHtml(tag) + "]</span>" +
          "<span class=\\"lstage\\">" + escapeHtml(l.stage || "") + "</span>" +
          "<span class=\\"ltext\\">" + escapeHtml(l.line || "") + "</span>" +
          "</div>"
        );
      }).join("");
      if (atBottom) el.scrollTop = el.scrollHeight;
    }

    // ---- Chat ----
    function fmtTime(ts) {
      const d = new Date(ts);
      return d.getHours().toString().padStart(2,"0") + ":" +
             d.getMinutes().toString().padStart(2,"0");
    }

    function appendChatMsg(role, text, id, ts) {
      const container = document.getElementById("chat-messages");
      const line = document.createElement("div");
      line.className = "chat-line chat-" + role;
      if (id) line.id = id;
      const prefix = role === "user"
        ? "<span class=\\"chat-prefix\\">YOU &gt;</span>"
        : "<span class=\\"chat-prefix\\">VEGA&gt;</span>";
      const tsStr = ts ? "<span class=\\"chat-ts\\">" + fmtTime(ts) + "</span>" : "";
      line.innerHTML = prefix + " <span class=\\"chat-text\\">" + escapeHtml(text) + "</span>" + tsStr;
      container.appendChild(line);
      container.scrollTop = container.scrollHeight;
    }

    async function sendChat() {
      if (chatBusy) return;
      const input  = document.getElementById("chat-input");
      const sendBtn = document.getElementById("chat-send");
      const msg = input.value.trim();
      if (!msg) return;
      input.value = "";
      chatBusy = true;
      sendBtn.disabled = true;

      appendChatMsg("user", msg, null, Date.now());

      const thinkId = "think-" + Date.now();
      const thinkEl = document.createElement("div");
      thinkEl.id = thinkId;
      thinkEl.className = "chat-line chat-agent";
      thinkEl.innerHTML = "<span class=\\"chat-prefix\\">VEGA&gt;</span> <span class=\\"chat-text chat-thinking\\">thinking...</span>";
      document.getElementById("chat-messages").appendChild(thinkEl);
      document.getElementById("chat-messages").scrollTop = 99999;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg }),
        });
        const data = await res.json();
        document.getElementById(thinkId)?.remove();
        appendChatMsg("agent", data.response || data.error || "(no response)", null, Date.now());
      } catch(e) {
        document.getElementById(thinkId)?.remove();
        appendChatMsg("agent", "[ERROR] " + e.message, null, Date.now());
      }

      chatBusy = false;
      sendBtn.disabled = false;
      input.focus();
    }

    // ---- Utils ----
    function escapeHtml(text) {
      const d = document.createElement("div"); d.textContent = String(text || ""); return d.innerHTML;
    }
    function escapeAttr(text) {
      return String(text || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    }

    // ---- Repo Picker ----
    let allLocalProjects = [];
    let pickerOpen = false;

    async function openRepoPicker() {
      if (pickerOpen) return;
      pickerOpen = true;
      const overlay = document.getElementById("repo-picker");
      overlay.style.display = "flex";
      document.getElementById("repo-search").value = "";
      document.getElementById("repo-picker-list").innerHTML =
        "<div class=\\"empty\\">loading...</div>";
      document.getElementById("repo-search").focus();

      try {
        const res = await fetch("/api/local-projects");
        allLocalProjects = await res.json();
        filterRepos("");
      } catch(e) {
        document.getElementById("repo-picker-list").innerHTML =
          "<div class=\\"empty\\">failed to load: " + escapeHtml(e.message) + "</div>";
      }
    }

    function closeRepoPicker() {
      pickerOpen = false;
      document.getElementById("repo-picker").style.display = "none";
    }

    function filterRepos(q) {
      const list = document.getElementById("repo-picker-list");
      const filtered = q
        ? allLocalProjects.filter(p =>
            p.name.toLowerCase().includes(q.toLowerCase()) ||
            p.path.toLowerCase().includes(q.toLowerCase()))
        : allLocalProjects;

      if (!filtered.length) {
        list.innerHTML = "<div class=\\"empty\\">no results</div>";
        return;
      }
      list.innerHTML = filtered.slice(0, 80).map(p => {
        const badge = p.pinned ? "<span class=\\"repo-item-badge\\">pinned</span>" : "";
        return (
          "<div class=\\"repo-item\\" data-path=\\"" + escapeAttr(p.path) + "\\" onclick=\\"pickRepo(this)\\">" +
          "<div>" +
            "<div class=\\"repo-item-name\\">" + escapeHtml(p.name) + "</div>" +
            "<div class=\\"repo-item-path\\">" + escapeHtml(p.path) + "</div>" +
          "</div>" +
          badge +
          "</div>"
        );
      }).join("");
    }

    async function pickRepo(el) {
      const path = el.getAttribute("data-path");
      if (!path) return;
      el.style.opacity = "0.4";
      try {
        await fetch("/api/projects/pin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectPath: path }),
        });
        // Refresh project list
        const res = await fetch("/api/projects");
        projects = await res.json();
        renderProjects();
        // Mark as pinned in local picker list
        const item = allLocalProjects.find(p => p.path === path);
        if (item) item.pinned = true;
        filterRepos(document.getElementById("repo-search").value);
      } catch(e) {
        console.error("Pin failed:", e);
      }
      el.style.opacity = "1";
    }

    // ---- Init ----
    async function loadInitial() {
      try {
        const [statsRes, projectsRes, chatRes] = await Promise.all([
          fetch("/api/stats"),
          fetch("/api/projects"),
          fetch("/api/chat/history"),
        ]);
        const stats = await statsRes.json();
        updateStats(stats);
        document.getElementById("stat-sse").textContent = stats.sseClients ?? "-";

        projects = await projectsRes.json();
        renderProjects();

        const history = await chatRes.json();
        for (const msg of history) appendChatMsg(msg.role, msg.text, null, msg.ts);
      } catch(e) {
        console.error("Init failed:", e);
      }
    }

    // Periodic refresh (stats + projects every 30s)
    setInterval(async () => {
      try {
        const [sRes, pRes] = await Promise.all([fetch("/api/stats"), fetch("/api/projects")]);
        const stats = await sRes.json();
        document.getElementById("stat-sse").textContent = stats.sseClients ?? "-";
        updateStats(stats);
        const fresh = await pRes.json();
        fresh.forEach(p => {
          const local = projects.find(l => l.path === p.path);
          if (local) p.enabled = local.enabled;
        });
        projects = fresh;
        renderProjects();
      } catch {}
    }, 30000);

    loadInitial();
    connectSSE();
  </script>
</body>
</html>`;


export { DASHBOARD_HTML };
