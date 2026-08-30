// Auto-generated: Dashboard HTML template for OpenSwarm Supervisor
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenSwarm :: Supervisor</title>
  <style>
    /*
     * Design tokens — adapted from VEGA (GitHub Dark inspired).
     * Legacy variable names are preserved so the rest of the stylesheet keeps
     * working unchanged; only the values shifted to a calmer, more readable
     * palette while keeping the semantic intent (--green = primary action,
     * --amber = warning, --red = destructive, --dim = secondary text).
     */
    :root {
      --bg:        #0d1117;   /* page background */
      --bg2:       #161b22;   /* surface (cards, header) */
      --bg3:       #1c2128;   /* surface raised (hover) */
      --green:     #58a6ff;   /* primary accent (was matrix green) */
      --green-dim: rgba(88, 166, 255, 0.12);
      --green-mid: #58a6ff;
      --green-lo:  #30363d;
      --cyan:      #79c0ff;
      --cyan-dim:  rgba(121, 192, 255, 0.14);
      --amber:     #d29922;
      --red:       #f85149;
      --white:     #c9d1d9;   /* primary text */
      --dim:       #8b949e;   /* muted text */
      --border:    #30363d;
      --border2:   rgba(48, 54, 61, 0.55);
      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--white);
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    /* Monospace contexts (logs, paths, IDs) still use a mono stack */
    code, pre, .mono, .log-line, .repo-item-path, .scan-path-row .path, .issue-id {
      font-family: "SF Mono", "JetBrains Mono", "Fira Code", Consolas, monospace;
    }

    /* ===== SCROLLBAR ===== */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--dim); }

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
      font-size: 11px;
      font-weight: 500;
      padding: 4px 12px;
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--white);
      cursor: pointer;
      letter-spacing: 0.04em;
      transition: border-color 0.15s, background 0.15s, color 0.15s;
    }
    .btn:hover:not(:disabled) { border-color: var(--green); color: var(--green); background: var(--green-dim); }
    .btn:disabled { opacity: 0.4; cursor: default; }
    .btn.primary { background: var(--green); border-color: var(--green); color: #0d1117; font-weight: 600; }
    .btn.primary:hover:not(:disabled) { opacity: 0.88; background: var(--green); color: #0d1117; }
    .btn-active { border-color: var(--amber); color: var(--amber); }
    .btn-active:hover:not(:disabled) { background: #332200; border-color: var(--amber); }
    .btn-danger { border-color: #551111; color: var(--red); }
    .btn-danger:hover:not(:disabled) { background: #220000; border-color: var(--red); }
    .move-to-todo-btn {
      font-family: inherit;
      font-size: 9px;
      padding: 1px 6px;
      background: transparent;
      border: 1px solid var(--cyan-dim);
      color: var(--cyan);
      cursor: pointer;
      margin-left: auto;
      flex-shrink: 0;
      transition: all 0.15s;
    }
    .move-to-todo-btn:hover:not(:disabled) { border-color: var(--cyan); background: var(--cyan-dim); }
    .move-to-todo-btn:disabled { opacity: 0.4; cursor: default; }
    .svc-group { display: flex; align-items: center; gap: 4px; margin-right: 8px; }
    .svc-status {
      font-size: 9px; padding: 1px 6px;
      border: 1px solid var(--dim); color: var(--dim);
      letter-spacing: 0.1em; text-transform: uppercase;
    }
    .svc-status.active { border-color: var(--green); color: var(--green); }
    .svc-status.inactive { border-color: var(--red); color: var(--red); }
    .svc-sep { color: var(--border); margin: 0 2px; }

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
    .stat-val { font-size: 13px; font-weight: 500; color: var(--green); }
    .stat-val.amber { color: var(--amber); }
    .stat-val.cyan { color: var(--cyan); }
    .stat-val.red { color: #ff5555; }
    #stat-adapter, #stat-pair-adapters {
      font-size: 10px;
      font-weight: 400;
      letter-spacing: 0.02em;
    }
    .provider-toggle {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
      max-width: 420px;
      padding: 2px;
      border: 1px solid var(--border);
      background: var(--bg3);
    }
    .provider-btn {
      font-family: inherit;
      font-size: 9px;
      line-height: 1;
      padding: 4px 8px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--dim);
      cursor: pointer;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .provider-btn:hover:not(:disabled) {
      color: var(--white);
      border-color: var(--border);
    }
    .provider-btn.active {
      color: var(--green);
      border-color: var(--green-lo);
      background: var(--green-dim);
    }
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
    .git-info { color: var(--dim); font-size: 9px; display: flex; gap: 6px; align-items: center; }
    .git-branch-name { color: var(--cyan); }
    .git-dirty { color: var(--amber); }
    .git-sync { color: var(--dim); }
    .pr-row { display: flex; align-items: center; gap: 4px; padding: 2px 0; font-size: 11px; border-bottom: 1px solid var(--border2); }
    .pr-row:last-child { border-bottom: none; }
    .pr-num { color: var(--cyan); font-size: 9px; min-width: 32px; }
    .pr-branch { color: var(--green-lo); font-size: 9px; max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pr-title { flex: 1; color: var(--white); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pr-age { color: var(--dim); font-size: 9px; flex-shrink: 0; }
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
    .issue-row.issue-backlog { opacity: 0.45; }

    /* ===== PROCESS ROW ===== */
    .proc-row {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 6px; border-bottom: 1px solid var(--border2);
      font-size: 11px;
    }
    .proc-pid { color: var(--cyan); font-size: 10px; min-width: 42px; font-variant-numeric: tabular-nums; }
    .proc-stage { color: var(--green); min-width: 56px; font-weight: bold; text-transform: uppercase; font-size: 10px; }
    .proc-model { color: var(--dim); font-size: 9px; min-width: 56px; }
    .proc-dur { color: var(--amber); font-size: 9px; min-width: 42px; text-align: right; font-variant-numeric: tabular-nums; }
    .proc-activity { font-size: 10px; min-width: 16px; text-align: center; }
    .proc-kill {
      font-family: inherit; font-size: 9px; padding: 1px 5px;
      background: transparent; border: 1px solid #551111; color: var(--red);
      cursor: pointer; margin-left: auto;
    }
    .proc-kill:hover { background: #220000; border-color: var(--red); }

    /* ===== PIPELINE ===== */
    .stage-block {
      border-bottom: 1px solid var(--border2);
    }
    .stage-row {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 8px;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.12s;
    }
    .stage-row:hover { background: var(--bg3); }
    .stage-row.has-details::after {
      content: "›"; color: var(--dim); margin-left: 4px;
      transition: transform 0.15s;
    }
    .stage-block.expanded .stage-row.has-details::after {
      transform: rotate(90deg); display: inline-block;
    }
    .sdot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--dim); }
    .sdot.start  { background: var(--amber); }
    .sdot.complete { background: var(--green); }
    .sdot.fail   { background: var(--red); }
    .sname { color: var(--white); min-width: 70px; }
    .srepo { color: var(--dim); font-size: 10px; min-width: 50px; max-width: 90px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stask { color: var(--cyan); font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ssummary {
      color: var(--white); font-size: 11px; flex: 2;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      opacity: 0.85;
    }
    .selapsed { color: var(--amber); font-size: 9px; flex-shrink: 0; min-width: 36px; text-align: right; }
    .smodel { color: var(--dim); font-size: 9px; flex-shrink: 0; min-width: 56px; text-align: right; }
    .stokens { color: var(--amber); font-size: 9px; flex-shrink: 0; min-width: 80px; text-align: right; white-space: nowrap; }
    .sstatus { font-size: 9px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.06em; flex-shrink: 0; }
    /* Expanded details */
    .stage-details {
      display: none;
      padding: 8px 14px 10px 22px;
      background: rgba(0,0,0,0.18);
      font-size: 11px;
      color: var(--white);
      border-top: 1px dashed var(--border2);
    }
    .stage-block.expanded .stage-details { display: block; }
    .stage-details .sd-line { display: flex; gap: 8px; padding: 1px 0; align-items: baseline; }
    .stage-details .sd-key { color: var(--dim); font-size: 10px; min-width: 70px; text-transform: uppercase; letter-spacing: 0.06em; }
    .stage-details .sd-val { color: var(--white); font-size: 11px; flex: 1; word-break: break-all; }
    .stage-details ul { margin: 2px 0 4px 14px; padding: 0; }
    .stage-details li { font-family: "SF Mono", "JetBrains Mono", monospace; font-size: 10px; color: var(--cyan); padding: 1px 0; }
    .sd-decision-approve { color: var(--green); font-weight: 600; }
    .sd-decision-revise  { color: var(--amber); font-weight: 600; }
    .sd-decision-reject  { color: var(--red); font-weight: 600; }

    /* ===== LOG TAB BAR ===== */
    .log-tab-bar {
      display: flex; gap: 0; border-bottom: 1px solid #1a2a1a;
      padding: 0 4px; overflow-x: auto; flex-shrink: 0;
    }
    .log-tab {
      background: transparent; border: none; border-bottom: 2px solid transparent;
      color: var(--dim); font-family: inherit; font-size: 10px;
      padding: 4px 8px; cursor: pointer; white-space: nowrap;
      text-transform: uppercase; letter-spacing: .05em;
    }
    .log-tab:hover { color: var(--green-mid); }
    .log-tab.active { color: var(--green); border-bottom-color: var(--green); }

    /* ===== LOG ===== */
    .log-area { font-size: 11px; line-height: 1.5; padding: 4px 0; }
    .log-line { padding: 3px 8px; display: flex; gap: 6px; align-items: flex-start; border-radius: 2px; margin: 1px 0; }
    .log-line:hover { background: rgba(255,255,255,0.03); }
    .log-line.log-success .ltext { color: var(--green); }
    .log-line.log-fail .ltext { color: var(--red); }
    .log-line.log-warn .ltext { color: var(--amber); }
    .log-line.log-system { opacity: 0.6; }
    .log-line.log-heading { border-top: 1px solid var(--border2); margin-top: 6px; padding-top: 8px; }
    .ltime { color: var(--dim); font-size: 9px; flex-shrink: 0; min-width: 36px; opacity: 0.7; padding-top: 2px; font-variant-numeric: tabular-nums; }
    .licon { flex-shrink: 0; min-width: 14px; text-align: center; font-size: 11px; padding-top: 1px; }
    .ltag { color: var(--green-lo); min-width: 52px; flex-shrink: 0; padding-top: 1px; font-size: 10px; font-weight: 500; }
    .lstage { color: var(--cyan); min-width: 60px; flex-shrink: 0; font-size: 10px; padding-top: 1px; text-transform: uppercase; letter-spacing: 0.03em; opacity: 0.8; }
    .ltext { color: #99aa99; word-break: break-word; white-space: pre-wrap; flex: 1; min-width: 0; }
    .ltext .lhighlight { color: var(--white); font-weight: 500; }
    .ltext .lcost { color: var(--amber); font-size: 10px; }
    .ltext .lfiles { color: var(--cyan); font-size: 10px; }
    .log-line.log-spacer { height: 6px; padding: 0; margin: 0; min-height: 6px; }
    .log-line.log-separator { opacity: 0.2; padding: 0 8px; margin: 4px 0; }
    .log-line.log-separator .ltext { color: var(--dim); }
    .log-line.log-code .ltext { font-family: 'JetBrains Mono', 'Fira Code', monospace; color: var(--cyan); opacity: 0.8; font-size: 10px; }
    .log-line.log-heading2 .ltext { color: var(--white); font-weight: 600; font-size: 12px; }
    .log-line.log-tool .ltext { color: var(--dim); font-style: italic; font-size: 10px; }

    /* ===== CHAT ===== */
    .chat-col { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
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

    .scan-path-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; font-size: 11px; }
    .scan-path-row .path { color: var(--dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .scan-path-badge { font-size: 9px; padding: 1px 5px; border: 1px solid #333; color: #556655; flex-shrink: 0; }
    .scan-path-remove { background: transparent; border: none; color: #553333; cursor: pointer; font-size: 12px; padding: 0 2px; flex-shrink: 0; }
    .scan-path-remove:hover { color: var(--red); }

    /* ===== TAB BAR (hidden on desktop) ===== */
    .tab-bar { display: none; }

    /* ===== MOBILE RESPONSIVE ===== */
    @media (max-width: 768px) {
      html, body { overflow: auto; }

      /* Header */
      header {
        height: auto;
        min-height: 38px;
        flex-wrap: wrap;
        padding: 6px 0.75rem;
        gap: 4px;
      }
      .hdr-fullname { display: none; }
      .hdr-right { width: 100%; justify-content: flex-end; }
      .svc-group .btn { font-size: 0; padding: 4px 8px; min-height: 32px; }
      .svc-group #svc-stop-btn::after { content: "\\23F8"; font-size: 12px; }
      .svc-group #svc-restart-btn::after { content: "\\21BB"; font-size: 12px; }
      #hb-btn { min-height: 32px; }

      /* Stats bar */
      .stats-bar {
        height: auto;
        min-height: 32px;
        flex-wrap: wrap;
        padding: 4px 0.75rem;
        gap: 0.5rem;
        font-size: 11px;
      }
      .stat-divider { display: none; }

      /* Tab bar */
      .tab-bar {
        display: flex;
        background: var(--bg2);
        border-bottom: 1px solid var(--border);
      }
      .tab {
        flex: 1;
        font-family: inherit;
        font-size: 11px;
        letter-spacing: 0.1em;
        padding: 10px 0;
        min-height: 44px;
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--dim);
        cursor: pointer;
        text-align: center;
        transition: all 0.15s;
      }
      .tab.active {
        color: var(--green);
        border-bottom-color: var(--green);
      }

      /* Main grid → single column */
      .main-grid {
        display: flex;
        flex-direction: column;
        height: auto;
        min-height: calc(100vh - 160px);
        overflow: visible;
      }
      .col {
        display: none;
        border-right: none;
        overflow: visible;
        min-height: calc(100vh - 200px);
      }
      .col.mob-active {
        display: flex;
        flex: 1;
      }

      /* Repo picker → fullscreen */
      #repo-picker > div {
        width: 100% !important;
        max-height: 90vh !important;
        margin: 5vh 0 0;
      }
      .repo-item { min-height: 44px; }

      /* Chat input → sticky bottom */
      .chat-input-area {
        position: sticky;
        bottom: 0;
        z-index: 10;
        min-height: 44px;
      }
      .chat-input { min-height: 32px; font-size: 14px; }
      .chat-send { min-height: 36px; padding: 4px 12px; }

      /* Touch targets */
      .btn { min-height: 36px; padding: 4px 10px; }
      .proj-hdr { min-height: 44px; padding: 8px 7px; }
      .toggle { width: 40px; height: 22px; }
      .slider:before { height: 14px; width: 14px; left: 3px; bottom: 3px; }
      input:checked + .slider:before { transform: translateX(18px); }
    }
  </style>
</head>
<body>
  <!-- HEADER -->
  <header>
    <span class="hdr-logo">OpenSwarm</span>
    <span class="hdr-fullname">: Vector-Encoded General Agent</span>
    <span class="hdr-sep">::</span>
    <span class="hdr-sub">SUPERVISOR</span>
    <a href="/issues" style="color:var(--cyan);font-size:11px;text-decoration:none;margin-left:1rem;letter-spacing:0.1em;border:1px solid var(--cyan-dim);padding:2px 8px;border-radius:3px">ISSUES</a>
    <div class="hdr-right">
      <div class="svc-group">
        <span class="svc-status" id="svc-status">...</span>
        <span class="svc-sep">│</span>
        <div class="provider-toggle" id="provider-toggle">
          <!--PROVIDER_BUTTONS-->
        </div>
        <span class="svc-sep">│</span>
        <button class="btn btn-danger" id="svc-stop-btn" onclick="svcAction('stop')">⏸ STOP</button>
        <button class="btn" id="svc-restart-btn" onclick="svcAction('restart')">↻ RESTART</button>
      </div>
      <span id="sse-status">CONNECTING</span>
      <button class="btn btn-active" id="hb-btn" onclick="triggerHeartbeat()">▶ HEARTBEAT</button>
      <button class="btn" id="pr-proc-btn" onclick="triggerPRProcessor()">↻ PR REVIEW</button>
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
    <div class="stat"><span class="stat-label">PACE</span><span class="stat-val" id="stat-pace">-</span></div>
    <span class="stat-divider">│</span>
    <div class="stat"><span class="stat-label">SSE</span><span class="stat-val cyan" id="stat-sse">-</span></div>
    <span class="stat-divider">│</span>
    <div class="stat"><span class="stat-label">CLI</span><span class="stat-val cyan" id="stat-adapter">-</span></div>
    <span class="stat-divider">│</span>
    <div class="stat"><span class="stat-label">PAIR</span><span class="stat-val cyan" id="stat-pair-adapters">-</span></div>
    <span class="stat-divider">│</span>
    <div class="stat"><span class="stat-label">UPTIME</span><span class="stat-val" id="stat-uptime">-</span></div>
    <span class="stat-divider">│</span>
    <div class="stat"><span class="stat-label">COST</span><span class="stat-val cyan" id="stat-cost">$0.00</span></div>
  </div>

  <!-- TAB BAR (mobile only) -->
  <div class="tab-bar">
    <button class="tab active" data-tab="0">REPOS</button>
    <button class="tab" data-tab="1">PIPELINE</button>
    <button class="tab" data-tab="2">CHAT</button>
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
      <div class="panel" id="monitor-panel">
        <div class="panel-hdr">
          <span class="panel-hdr-title">MONITORS & PROCESSES</span>
          <span class="panel-hdr-badge" id="monitor-count"></span>
        </div>
        <div class="panel-body" id="monitor-list">
          <div class="empty">no monitors or processes</div>
        </div>
      </div>
      <div class="panel" id="coordination-panel">
        <div class="panel-hdr">
          <span class="panel-hdr-title">AGENT COORDINATION</span>
          <span class="panel-hdr-badge" id="coordination-count"></span>
        </div>
        <div class="panel-body" id="coordination-summary">
          <div class="empty">no coordination events</div>
        </div>
        <a href="/orchestration" style="display:block;text-align:center;padding:8px;color:var(--cyan);font-size:11px;text-decoration:none;border-top:1px solid var(--border2)">⚙ Open orchestration graph →</a>
      </div>
    </div>

    <!-- REPO PICKER OVERLAY -->
    <div id="repo-picker" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(4px);z-index:100;align-items:center;justify-content:center">
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);width:560px;max-height:75vh;display:flex;flex-direction:column;box-shadow:0 10px 32px rgba(0,0,0,0.5)">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
          <span style="color:var(--white);font-size:13px;font-weight:600;letter-spacing:.04em">Add repository</span>
          <button onclick="closeRepoPicker()" style="margin-left:auto;background:transparent;border:none;color:var(--dim);cursor:pointer;font-size:18px;line-height:1;padding:0 4px;border-radius:4px" onmouseover="this.style.color='var(--white)'" onmouseout="this.style.color='var(--dim)'">✕</button>
        </div>
        <div style="padding:10px 18px;border-bottom:1px solid var(--border2)">
          <input id="repo-search" type="text" placeholder="Filter repositories…"
            style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);outline:none;font-family:inherit;font-size:13px;color:var(--white);padding:7px 10px;caret-color:var(--green)"
            oninput="filterRepos(this.value)" onkeydown="if(event.key==='Escape')closeRepoPicker()">
        </div>
        <div id="repo-picker-list" style="overflow-y:auto;flex:1;padding:6px 0"></div>
        <div id="scan-paths-section" style="border-top:1px solid var(--border);padding:12px 18px;background:rgba(13,17,23,0.4)">
          <div style="color:var(--dim);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Scan paths</div>
          <div id="scan-paths-list"></div>
          <div style="display:flex;gap:6px;margin-top:10px">
            <button class="btn" style="flex:1;justify-content:center" onclick="openFolderBrowser()">📁 Browse for folder…</button>
            <button class="btn" style="font-size:11px" onclick="toggleManualPathInput()" title="Type a path manually">⌨</button>
          </div>
          <div id="manual-path-row" style="display:none;gap:6px;margin-top:6px">
            <input id="scan-path-input" type="text" placeholder="/absolute/path/to/scan"
              style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);outline:none;font-family:inherit;font-size:12px;color:var(--white);padding:5px 8px;caret-color:var(--green)"
              onkeydown="if(event.key==='Enter')addScanPath()">
            <button class="btn primary" style="font-size:11px" onclick="addScanPath()">Add</button>
          </div>
        </div>
      </div>
    </div>

    <!-- FOLDER BROWSER OVERLAY (native-style picker, server-side fs) -->
    <div id="folder-browser" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.65);backdrop-filter:blur(4px);z-index:110;align-items:center;justify-content:center">
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);width:620px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 10px 32px rgba(0,0,0,0.5)">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
          <span style="color:var(--white);font-size:13px;font-weight:600;letter-spacing:.04em">Choose folder to scan</span>
          <button onclick="closeFolderBrowser()" style="margin-left:auto;background:transparent;border:none;color:var(--dim);cursor:pointer;font-size:18px;line-height:1;padding:0 4px;border-radius:4px" onmouseover="this.style.color='var(--white)'" onmouseout="this.style.color='var(--dim)'">✕</button>
        </div>
        <div style="padding:10px 18px;border-bottom:1px solid var(--border2);display:flex;align-items:center;gap:6px">
          <button class="btn" id="fb-up" style="font-size:11px;padding:3px 10px" onclick="folderBrowserUp()" title="Parent directory">↑ Up</button>
          <input id="fb-path" type="text" readonly
            style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);outline:none;font-family:'SF Mono',monospace;font-size:12px;color:var(--white);padding:5px 10px">
        </div>
        <div id="fb-list" style="overflow-y:auto;flex:1;padding:4px 0"></div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" onclick="closeFolderBrowser()">Cancel</button>
          <button class="btn primary" id="fb-select" onclick="folderBrowserSelect()">Select this folder</button>
        </div>
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
        <div class="log-tab-bar" id="log-tab-bar">
          <button class="log-tab active" data-task="all" onclick="selectLogTab(null)">ALL</button>
        </div>
        <div class="panel-body log-area" id="log-list">
          <div class="empty">no log output</div>
        </div>
      </div>
    </div>

    <!-- RIGHT: CHAT -->
    <div class="col">
      <!-- PR PROCESSOR -->
      <div class="panel" style="flex: 0 0 auto;">
        <div class="panel-hdr">
          <span class="panel-hdr-title">PR PROCESSOR</span>
          <span class="panel-hdr-badge" id="pr-proc-badge"></span>
        </div>
        <div class="panel-body" style="font-size: 11px; line-height: 1.5;">
          <div id="pr-proc-body" style="color: var(--dim);">Loading...</div>
        </div>
      </div>

      <!-- STUCK/FAILED ISSUES -->
      <div class="panel" style="flex: 0 0 auto; max-height: 200px;">
        <div class="panel-hdr">
          <span class="panel-hdr-title">⚠ STUCK/FAILED</span>
          <span class="panel-hdr-badge" id="stuck-badge">0</span>
          <button class="btn" style="margin-left: 0.5rem; font-size: 9px; padding: 1px 6px;" onclick="restartStuckIssues()" id="restart-stuck-btn">↻ RESTART ALL</button>
        </div>
        <div class="panel-body" style="font-size: 10px; line-height: 1.4; overflow-y: auto;">
          <div id="stuck-list" style="color: var(--dim);">Loading...</div>
        </div>
      </div>

      <!-- AGENT CHAT -->
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
            type="text" placeholder="message OpenSwarm..."
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
    let knowledgeCache = {};
    let logLines = [];
    let selectedLogTaskId = null;  // null = ALL, string = specific taskId
    let stageRows = [];
    let chatBusy = false;
    let totalCostUsd = 0;
    const coordinationById = new Map();
    const taskProjectMap = new Map();
    // taskId → { title, issueIdentifier } for pipeline display
    const taskTitleMap = new Map();
    // taskId → start timestamp for elapsed time
    const taskStartMap = new Map();

    // ---- SSE ----
    function connectSSE(skipReplay) {
      const url = skipReplay ? "/api/events?skipReplay=1" : "/api/events";
      const es = new EventSource(url);
      const statusEl = document.getElementById("sse-status");
      es.onopen = () => { statusEl.textContent = "LIVE"; statusEl.className = "connected"; };
      es.onmessage = e => {
        let ev; try { ev = JSON.parse(e.data); } catch { return; }
        handleEvent(ev);
      };
      es.onerror = () => {
        statusEl.textContent = "RECONNECTING"; statusEl.className = "disconnected";
        es.close(); setTimeout(function() { connectSSE(false); }, 3000);
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
          taskStartMap.set(ev.data.taskId, Date.now());
          if (p) updateProjectTask(p, ev.data.taskId, ev.data.title, null, "running");
          break;
        }
        case "task:completed": {
          const p = taskProjectMap.get(ev.data.taskId);
          if (p) removeProjectTask(p, ev.data.taskId);
          break;
        }
        case "pipeline:stage": addStageRow(ev.data); break;
        case "coordination:event": addCoordinationEvent(ev.data); break;
        case "pipeline:fanout":
          addStageRow({
            taskId: ev.data.taskId,
            stage: "fanout",
            status: "complete",
            summary: ev.data.enabled
              ? ((ev.data.shouldFanOut ? "fan-out recommended" : "single-worker path") + " (score " + ev.data.score + "/" + ev.data.threshold + ")")
              : "fan-out disabled",
            issues: ev.data.reasons || [],
            issuesCount: (ev.data.reasons || []).length,
          });
          break;
        case "pipeline:iteration":
          addStageRow({ taskId: ev.data.taskId, stage: "iter #" + ev.data.iteration, status: "start" });
          break;
        case "log": addLogLine(ev.data); break;
        case "project:toggled": {
          const p = projects.find(x => x.path === ev.data.projectPath);
          if (p) { p.enabled = ev.data.enabled; renderProjects(); }
          break;
        }
        case "task:cost": {
          totalCostUsd += ev.data.cost?.costUsd ?? 0;
          document.getElementById("stat-cost").textContent = "$" + totalCostUsd.toFixed(2);
          break;
        }
        case "chat:agent": appendChatMsg("agent", ev.data.text, null, ev.data.ts); break;
        case "monitor:checked":
        case "monitor:stateChange":
          fetchMonitors();
          break;
        case "process:spawn":
          fetchProcesses();
      fetchCoordination();
          addLogLine({ taskId: ev.data.taskId || "system", stage: ev.data.stage || "spawn", line: "Process spawned PID=" + ev.data.pid + " stage=" + ev.data.stage + (ev.data.model ? " model=" + ev.data.model : "") });
          break;
        case "process:exit":
          fetchProcesses();
          addLogLine({ taskId: "system", stage: "exit", line: "Process exited PID=" + ev.data.pid + " code=" + ev.data.exitCode + " duration=" + (ev.data.durationMs / 1000).toFixed(1) + "s" });
          break;
        case "heartbeat": {
          const btn = document.getElementById("hb-btn");
          btn.disabled = false; btn.textContent = "▶ HEARTBEAT";
          break;
        }
        case "pr_processor_start":
        case "pr_processor_end":
        case "pr_processor_pr":
          fetchPRProcessorStatus();
          break;
      }
    }

    // ---- Stats ----
    function updateStats(data) {
      function shortModel(model) {
        if (!model) return "-";
        return model.length > 18 ? model.slice(0, 15) + "..." : model;
      }

      document.getElementById("stat-running").textContent = data.runningTasks ?? 0;
      document.getElementById("stat-queued").textContent = data.queuedTasks ?? 0;
      document.getElementById("stat-completed").textContent = data.completedToday ?? 0;
      const defaultAdapter = data.adapters?.defaultAdapter ?? "-";
      const workerAdapter = data.adapters?.worker?.adapter ?? "-";
      const workerModel = shortModel(data.adapters?.worker?.model);
      const reviewerAdapter = data.adapters?.reviewer?.adapter ?? "-";
      const reviewerModel = shortModel(data.adapters?.reviewer?.model);
      const chatModel = workerModel || "-";
      document.getElementById("stat-adapter").textContent = defaultAdapter;
      document.getElementById("stat-pair-adapters").textContent =
        "W " + workerAdapter + ":" + workerModel + " / R " + reviewerAdapter + ":" + reviewerModel;
      document.getElementById("chat-status").textContent = defaultAdapter + ":" + chatModel;
      document.querySelectorAll(".provider-btn").forEach(btn => {
        const name = btn.id.slice("provider-".length);
        btn.classList.toggle("active", defaultAdapter === name);
      });
      if (data.uptime != null) {
        const s = Math.floor(data.uptime / 1000);
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
        document.getElementById("stat-uptime").textContent =
          (h ? h + "h " : "") + (m ? m + "m " : "") + ss + "s";
      }
      // Daily pace (informational count of tasks completed today; not an enforced cap)
      const paceEl = document.getElementById("stat-pace");
      if (paceEl && data.dailyPace) {
        paceEl.textContent = data.dailyPace.completedToday + " today";
        paceEl.className = "stat-val";
      }
    }

    // ---- Service control ----
    async function fetchSvcStatus() {
      try {
        const res = await fetch("/api/service/status");
        const data = await res.json();
        const el = document.getElementById("svc-status");
        const status = data.status || "unknown";
        el.textContent = status;
        el.className = "svc-status " + (status === "active" ? "active" : "inactive");
      } catch {
        const el = document.getElementById("svc-status");
        el.textContent = "unknown";
        el.className = "svc-status inactive";
      }
    }

    // ---- Stuck/Failed Issues ----
    async function fetchStuckIssues() {
      try {
        const res = await fetch("/api/stuck-issues");
        const data = await res.json();
        const list = document.getElementById("stuck-list");
        const badge = document.getElementById("stuck-badge");

        const totalStuck = data.stuckIssues?.length ?? 0;
        const totalFailed = data.failedIssues?.length ?? 0;
        const total = totalStuck + totalFailed;

        badge.textContent = total;
        badge.style.color = total > 0 ? "var(--red)" : "var(--dim)";

        if (total === 0) {
          list.innerHTML = '<div style="color: var(--green-mid); padding: 4px;">✓ All issues healthy</div>';
          return;
        }

        let html = '';

        // Stuck issues (In Progress for >7 days)
        if (totalStuck > 0) {
          html += '<div style="color: var(--amber); font-weight: bold; margin-bottom: 4px; font-size: 9px; text-transform: uppercase;">⏱ Stuck (' + totalStuck + ')</div>';
          data.stuckIssues.forEach(issue => {
            const priorityColor = issue.priority === 1 ? 'var(--red)' : issue.priority === 2 ? 'var(--amber)' : 'var(--dim)';
            html += '<div style="margin-bottom: 6px; padding: 4px; border-left: 2px solid ' + priorityColor + '; background: rgba(255, 170, 0, 0.05);">';
            const title = String(issue.title || '');
            html += '<div style="color: var(--white); font-size: 10px; margin-bottom: 2px;">' + escapeHtml(issue.identifier) + ': ' + escapeHtml(title.substring(0, 40)) + (title.length > 40 ? '...' : '') + '</div>';
            html += '<div style="color: var(--amber); font-size: 9px;">' + escapeHtml(issue.reason) + '</div>';
            if (issue.project?.name) {
              html += '<div style="color: var(--dim); font-size: 9px; margin-top: 2px;">📁 ' + escapeHtml(issue.project.name) + '</div>';
            }
            html += '</div>';
          });
        }

        // Failed issues (retry, failed, blocked labels)
        if (totalFailed > 0) {
          if (totalStuck > 0) html += '<div style="height: 8px;"></div>';
          html += '<div style="color: var(--red); font-weight: bold; margin-bottom: 4px; font-size: 9px; text-transform: uppercase;">✖ Failed (' + totalFailed + ')</div>';
          data.failedIssues.forEach(issue => {
            const priorityColor = issue.priority === 1 ? 'var(--red)' : issue.priority === 2 ? 'var(--amber)' : 'var(--dim)';
            html += '<div style="margin-bottom: 6px; padding: 4px; border-left: 2px solid ' + priorityColor + '; background: rgba(255, 51, 51, 0.05);">';
            const title = String(issue.title || '');
            html += '<div style="color: var(--white); font-size: 10px; margin-bottom: 2px;">' + escapeHtml(issue.identifier) + ': ' + escapeHtml(title.substring(0, 40)) + (title.length > 40 ? '...' : '') + '</div>';
            html += '<div style="color: var(--red); font-size: 9px;">' + escapeHtml(issue.reason) + '</div>';
            if (issue.project?.name) {
              html += '<div style="color: var(--dim); font-size: 9px; margin-top: 2px;">📁 ' + escapeHtml(issue.project.name) + '</div>';
            }
            html += '</div>';
          });
        }

        list.innerHTML = html;
      } catch (err) {
        console.error("Failed to fetch stuck issues:", err);
        document.getElementById("stuck-list").innerHTML = '<div style="color: var(--red);">Error loading</div>';
      }
    }

    // ---- PR Processor Status ----
    async function fetchPRProcessorStatus() {
      try {
        const res = await fetch("/api/pr-processor-status");
        const data = await res.json();
        const body = document.getElementById("pr-proc-body");
        const badge = document.getElementById("pr-proc-badge");

        if (!data) {
          body.innerHTML = '<div style="color: var(--dim);">Not configured</div>';
          badge.textContent = "OFF";
          badge.style.color = "var(--dim)";
          return;
        }

        const status = data.processing ? "RUNNING" : "IDLE";
        badge.textContent = status;
        badge.style.color = data.processing ? "var(--green)" : "var(--cyan)";

        const formatTime = (ts) => {
          if (!ts) return "N/A";
          const d = new Date(ts);
          return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
        };

        let html = '<div style="display: flex; flex-direction: column; gap: 6px;">';
        html += '<div><span style="color: var(--dim);">Schedule:</span> <span style="color: var(--text);">' + escapeHtml(data.schedule || "N/A") + '</span></div>';
        html += '<div><span style="color: var(--dim);">Repos:</span> <span style="color: var(--text);">' + (data.repos?.length || 0) + '</span></div>';

        if (data.currentPR) {
          html += '<div><span style="color: var(--amber);">Processing:</span> <span style="color: var(--text); font-family: monospace; font-size: 10px;">' + escapeHtml(data.currentPR) + '</span></div>';
        }

        html += '<div><span style="color: var(--dim);">Last run:</span> <span style="color: var(--text);">' + formatTime(data.lastRun) + '</span></div>';
        html += '<div><span style="color: var(--dim);">Next run:</span> <span style="color: var(--text);">' + formatTime(data.nextRun) + '</span></div>';

        if (data.conflictResolverEnabled) {
          html += '<div style="color: var(--green); font-size: 10px; margin-top: 4px;">✓ Conflict Resolver: ON</div>';
        }

        html += '</div>';
        body.innerHTML = html;
      } catch (e) {
        const body = document.getElementById("pr-proc-body");
        body.innerHTML = '<div style="color: var(--red);">Error: ' + escapeHtml(e.message) + '</div>';
      }
    }

    async function svcAction(action) {
      const label = action === "stop" ? "STOP" : "RESTART";
      if (!confirm("Are you sure you want to " + label + " the service?")) return;
      const btnId = action === "stop" ? "svc-stop-btn" : "svc-restart-btn";
      const btn = document.getElementById(btnId);
      btn.disabled = true;
      try {
        await fetch("/api/service/" + action, { method: "POST" });
        addLogLine({ taskId: "system", stage: "service", line: "Service " + action + " requested" });
      } catch(e) {
        addLogLine({ taskId: "system", stage: "error", line: "Service " + action + " failed: " + e.message });
      }
      btn.disabled = false;
      setTimeout(fetchSvcStatus, 2000);
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

    async function switchProvider(provider) {
      try {
        const res = await fetch("/api/provider", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to switch provider");
        }
        addLogLine({ taskId: "system", stage: "provider", line: "Provider switched to " + provider });
        const stats = await fetch("/api/stats").then(r => r.json());
        updateStats(stats);
      } catch (e) {
        addLogLine({ taskId: "system", stage: "error", line: "Provider switch failed: " + e.message });
      }
    }

    // ---- PR Processor trigger ----
    async function triggerPRProcessor() {
      const btn = document.getElementById("pr-proc-btn");
      btn.disabled = true; btn.textContent = "⟳ PROCESSING";
      addLogLine({ taskId: "system", stage: "manual", line: "PR Processor triggered by user" });
      try {
        const res = await fetch("/api/trigger-pr-processor", { method: "POST" });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to trigger PR processor");
        }
        addLogLine({ taskId: "system", stage: "manual", line: "PR Processor started successfully" });
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = "↻ PR REVIEW";
        }, 3000);
      } catch(e) {
        addLogLine({ taskId: "system", stage: "error", line: "PR Processor failed: " + e.message });
        btn.disabled = false; btn.textContent = "↻ PR REVIEW";
      }
    }

    // ---- Restart stuck issues ----
    async function restartStuckIssues() {
      if (!confirm("Move all stuck/failed issues to Todo?")) return;
      const btn = document.getElementById("restart-stuck-btn");
      btn.disabled = true;
      btn.textContent = "⟳ PROCESSING...";

      try {
        const res = await fetch("/api/stuck-issues");
        const data = await res.json();
        const allIssues = [...data.stuckIssues, ...data.failedIssues];

        let success = 0;
        let failed = 0;

        for (const issue of allIssues) {
          try {
            const moveRes = await fetch("/api/issue/move-to-todo", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ issueId: issue.id })
            });

            if (moveRes.ok) {
              success++;
              addLogLine({ taskId: "system", stage: "stuck", line: "Moved " + issue.identifier + " to Todo" });
            } else {
              failed++;
            }
          } catch (e) {
            failed++;
          }
        }

        addLogLine({ taskId: "system", stage: "stuck", line: "Restart complete: " + success + " moved, " + failed + " failed" });
        setTimeout(fetchStuckIssues, 1000);
      } catch (e) {
        addLogLine({ taskId: "system", stage: "error", line: "Failed to restart stuck issues: " + e.message });
      }

      btn.disabled = false;
      btn.textContent = "↻ RESTART ALL";
    }

    // ---- Project task updates ----
    function updateProjectTask(projectPath, taskId, title, priority, status) {
      const p = projects.find(x => x.path === projectPath);
      if (!p) return;

      // Get issueIdentifier from taskTitleMap
      const taskInfo = taskTitleMap.get(taskId);
      const issueIdentifier = taskInfo?.issueIdentifier;

      if (status === "running") {
        p.queued = p.queued.filter(t => t.id !== taskId);
        if (!p.running.find(t => t.id === taskId)) {
          p.running.push({ id: taskId, title, priority, issueIdentifier });
        }
      } else {
        if (!p.queued.find(t => t.id === taskId)) {
          p.queued.push({ id: taskId, title, priority, issueIdentifier });
        }
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
        // PRs always visible (not gated by expand)
        let prsHtml = "";
        if (p.prs && p.prs.length) {
          prsHtml = "<div class=\\"proj-issues\\">" +
            "<div class=\\"issue-sec-label\\">open PRs (" + p.prs.length + ")</div>" +
            p.prs.map(function(pr) {
              return "<div class=\\"pr-row\\">" +
                "<span class=\\"pr-num\\">#" + pr.number + "</span>" +
                "<span class=\\"pr-branch\\" title=\\"" + escapeAttr(pr.branch) + "\\">" + escapeHtml(pr.branch) + "</span>" +
                "<span class=\\"pr-title\\" title=\\"" + escapeAttr(pr.title) + "\\">" + escapeHtml(pr.title) + "</span>" +
                "<span class=\\"pr-age\\">" + fmtAge(pr.updatedAt) + "</span>" +
              "</div>";
            }).join("") +
          "</div>";
        }
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
          if (p.pending.length) {
            var stateOrder = ["In Review", "In Progress", "Todo", "Backlog"];
            var byState = {};
            for (var ti = 0; ti < p.pending.length; ti++) {
              var st = p.pending[ti].linearState || "Todo";
              if (!byState[st]) byState[st] = [];
              byState[st].push(p.pending[ti]);
            }
            for (var si = 0; si < stateOrder.length; si++) {
              var sn = stateOrder[si];
              if (!byState[sn] || !byState[sn].length) continue;
              secs.push(
                "<div class=\\"issue-sec-label\\">" + sn.toLowerCase() + " (" + byState[sn].length + ")</div>" +
                byState[sn].map(t => issueRow(t, "idot-pnd")).join("")
              );
            }
            var otherKeys = Object.keys(byState);
            for (var oi = 0; oi < otherKeys.length; oi++) {
              if (stateOrder.indexOf(otherKeys[oi]) === -1) {
                secs.push(
                  "<div class=\\"issue-sec-label\\">" + otherKeys[oi].toLowerCase() + " (" + byState[otherKeys[oi]].length + ")</div>" +
                  byState[otherKeys[oi]].map(t => issueRow(t, "idot-pnd")).join("")
                );
              }
            }
          }
          if (!secs.length) secs.push("<div class=\\"empty\\" style=\\"padding:4px\\">no issues</div>");
          // Knowledge graph health info (if cached)
          var kgData = knowledgeCache[p.name] || knowledgeCache[p.path];
          if (kgData && kgData.summary) {
            var s = kgData.summary;
            secs.push(
              "<div class=\\"issue-sec-label\\">code health</div>" +
              "<div style=\\"padding:2px 8px;font-size:10px;color:#88aa88\\">" +
                "modules:" + s.totalModules + " tests:" + s.totalTestFiles +
                " untested:" + s.untestedModules.length +
                " churn:" + (s.avgChurnScore || 0).toFixed(2) +
                (s.hotModules.length ? " hot:" + s.hotModules.slice(0,3).map(function(m){return m.split("/").pop()}).join(",") : "") +
              "</div>"
            );
          }
          issuesHtml = "<div class=\\"proj-issues\\">" + secs.join("") + "</div>";
        }

        return (
          "<div class=\\"proj-card" + dCls + eCls + "\\" data-key=\\"" + escapeAttr(key) + "\\">" +
          "<div class=\\"proj-hdr\\" data-key=\\"" + escapeAttr(key) + "\\" onclick=\\"handleToggleExpand(this)\\">" +
            "<span class=\\"proj-arrow\\"></span>" +
            "<div class=\\"proj-info\\">" +
              "<div class=\\"proj-name\\">" + escapeHtml(p.name) + "</div>" +
              "<div class=\\"proj-path\\">" + escapeHtml(p.path) + "</div>" +
              (p.git ? "<div class=\\"git-info\\">" +
                "\\u2387 <span class=\\"git-branch-name\\">" + escapeHtml(p.git.branch) + "</span>" +
                (p.git.hasChanges ? " <span class=\\"git-dirty\\">\\u25CF " + p.git.uncommittedFiles + "</span>" : "") +
                ((p.git.ahead || p.git.behind) ? " <span class=\\"git-sync\\">" +
                  (p.git.ahead ? "\\u2191" + p.git.ahead : "") +
                  (p.git.behind ? " \\u2193" + p.git.behind : "") +
                "</span>" : "") +
              "</div>" : "") +
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
          prsHtml +
          issuesHtml +
          "</div>"
        );
      }).join("");
    }

    function issueRow(t, dotClass) {
      const prio = t.priority || 3;
      const extraCls = t.linearState === "Backlog" ? " issue-backlog" : "";
      const moveBtn = t.linearState === "Backlog" && t.linearId
        ? "<button class=\\"move-to-todo-btn\\" data-issue-id=\\"" + escapeAttr(t.linearId) + "\\" onclick=\\"handleMoveToTodo(this)\\">→ Todo</button>"
        : "";
      return (
        "<div class=\\"issue-row" + extraCls + "\\">" +
        "<span class=\\"idot " + dotClass + "\\"></span>" +
        "<span class=\\"prio prio-" + Math.min(4, prio) + "\\"></span>" +
        (t.issueIdentifier ? "<span class=\\"issue-id\\">" + escapeHtml(t.issueIdentifier) + "</span>" : "") +
        "<span class=\\"issue-title\\" title=\\"" + escapeAttr(t.title) + "\\">" + escapeHtml(t.title) + "</span>" +
        moveBtn +
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
        // Update picker state so re-adding works correctly
        const item = allLocalProjects.find(function(p) { return p.path === path; });
        if (item) item.pinned = false;
      } catch(e) { el.disabled = false; }
    }
    async function handleMoveToTodo(el) {
      const issueId = el.getAttribute("data-issue-id");
      if (!issueId) return;

      const originalText = el.textContent;
      el.disabled = true;
      el.textContent = "Moving...";

      try {
        const response = await fetch("/api/issue/move-to-todo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ issueId }),
        });

        if (!response.ok) {
          throw new Error("Failed to move issue");
        }

        // Refresh projects to show updated state
        const res = await fetch("/api/projects");
        projects = await res.json();
        renderProjects();
      } catch(e) {
        el.disabled = false;
        el.textContent = originalText;
        alert("Failed to move issue to Todo: " + e.message);
      }
    }

    // ---- Pipeline Stages ----
    function addStageRow(data) {
      stageRows.push(data);
      if (stageRows.length > MAX_STAGE) stageRows = stageRows.slice(-MAX_STAGE);
      renderStages();
    }
    function shortModel(name) {
      if (!name) return "";
      // Order matters: most specific suffix first so 'sonnet-4-6' isn't
      // captured by the generic 'sonnet-4' fallback below.
      if (name.includes("opus-4-7")) return "opus-4.7";
      if (name.includes("opus-4-6")) return "opus-4.6";
      if (name.includes("sonnet-4-6")) return "sonnet-4.6";
      if (name.includes("sonnet-4-5")) return "sonnet-4.5";
      if (name.includes("haiku-4-5")) return "haiku-4.5";
      if (name.includes("opus-4")) return "opus-4";
      if (name.includes("sonnet-4")) return "sonnet-4";
      var parts = name.split("-");
      return parts[parts.length - 1];
    }
    function fmtTokens(n) {
      if (n == null) return "";
      if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
      if (n >= 1000) return (n / 1000).toFixed(1) + "k";
      return String(n);
    }
    function buildStageDetails(r) {
      // Builds the expanded "what did the worker actually do" panel for
      // a pipeline:stage payload. Returns "" when there's nothing to show.
      const lines = [];
      function addLine(key, valHtml) {
        lines.push(
          "<div class=\\"sd-line\\"><div class=\\"sd-key\\">" + escapeHtml(key) + "</div>" +
          "<div class=\\"sd-val\\">" + valHtml + "</div></div>"
        );
      }
      function addList(key, items) {
        const ul = items.map(function(s) { return "<li>" + escapeHtml(String(s)) + "</li>"; }).join("");
        lines.push(
          "<div class=\\"sd-line\\"><div class=\\"sd-key\\">" + escapeHtml(key) + "</div>" +
          "<div class=\\"sd-val\\"><ul>" + ul + "</ul></div></div>"
        );
      }

      if (r.summary) addLine("Summary", escapeHtml(r.summary));
      if (r.decision) {
        const cls = "sd-decision-" + r.decision;
        addLine("Decision", "<span class=\\"" + cls + "\\">" + escapeHtml(r.decision.toUpperCase()) + "</span>");
      }
      if (r.feedback) addLine("Feedback", escapeHtml(r.feedback));
      if (Array.isArray(r.filesChanged) && r.filesChanged.length > 0) {
        const label = "Files (" + (r.filesChangedCount || r.filesChanged.length) + ")";
        addList(label, r.filesChanged);
      }
      if (Array.isArray(r.commands) && r.commands.length > 0) {
        const label = "Commands (" + (r.commandsCount || r.commands.length) + ")";
        addList(label, r.commands);
      }
      if (Array.isArray(r.issues) && r.issues.length > 0) {
        const label = "Issues (" + (r.issuesCount || r.issues.length) + ")";
        addList(label, r.issues);
      }
      if (Array.isArray(r.failedTests) && r.failedTests.length > 0) {
        addList("Failed tests", r.failedTests);
      }
      if (r.passed != null || r.failed != null) {
        addLine("Tests", escapeHtml((r.passed || 0) + " passed, " + (r.failed || 0) + " failed" + (r.coverage != null ? " — coverage " + r.coverage + "%" : "")));
      }
      if (r.confidencePercent != null) addLine("Confidence", escapeHtml(r.confidencePercent + "%"));
      if (r.haltReason) addLine("Halt", escapeHtml(r.haltReason));
      if (r.bsScore != null) addLine("BS score", escapeHtml(String(r.bsScore)));
      if (r.criticalCount || r.warningCount) {
        addLine("Audit", escapeHtml((r.criticalCount || 0) + " critical, " + (r.warningCount || 0) + " warnings"));
      }
      if (r.changelogEntry) addLine("Changelog", escapeHtml(r.changelogEntry));
      if (r.durationMs != null) addLine("Duration", escapeHtml((r.durationMs / 1000).toFixed(1) + "s"));
      if (r.error) {
        addLine("Error", "<span style=\\"color:var(--red)\\">" + escapeHtml(r.error) + "</span>");
      }
      return lines.join("");
    }

    function toggleStageDetails(idx) {
      const block = document.querySelector("[data-stage-idx=\\"" + idx + "\\"]");
      if (block) block.classList.toggle("expanded");
    }

    function renderStages() {
      const el = document.getElementById("stage-list");
      const cnt = document.getElementById("stage-count");
      if (!stageRows.length) { el.innerHTML = "<div class=\\"empty\\">no pipeline events</div>"; return; }
      if (cnt) cnt.textContent = stageRows.length + "/" + MAX_STAGE;
      el.innerHTML = stageRows.slice().reverse().map((r, i) => {
        const info = r.taskId ? taskTitleMap.get(r.taskId) : null;
        let taskLabel = "";
        if (info) {
          taskLabel = info.issueIdentifier
            ? info.issueIdentifier + (info.title ? " " + info.title.slice(0, 22) : "")
            : (info.title ? info.title.slice(0, 30) : "");
        } else if (r.taskId) {
          taskLabel = r.taskId.slice(0, 8);
        }
        const projPath = r.taskId ? taskProjectMap.get(r.taskId) : null;
        const repoName = projPath ? projPath.split("/").pop() : "";
        const startTs = r.taskId ? taskStartMap.get(r.taskId) : null;
        let elapsed = "";
        if (startTs) {
          const sec = Math.floor((Date.now() - startTs) / 1000);
          if (sec < 60) elapsed = sec + "s";
          else if (sec < 3600) elapsed = Math.floor(sec / 60) + "m" + (sec % 60) + "s";
          else elapsed = Math.floor(sec / 3600) + "h" + Math.floor((sec % 3600) / 60) + "m";
        }
        const modelStr = r.model ? shortModel(r.model) : "";
        let tokenStr = "";
        if (r.inputTokens || r.outputTokens) {
          tokenStr = fmtTokens(r.inputTokens) + "/" + fmtTokens(r.outputTokens);
          if (r.costUsd != null) tokenStr += " $" + r.costUsd.toFixed(2);
        }

        // Inline summary on the row itself, so the user sees *what* happened
        // without having to expand.
        let inlineSummary = "";
        if (r.decision) {
          const cls = "sd-decision-" + r.decision;
          inlineSummary = "<span class=\\"" + cls + "\\">" + escapeHtml(r.decision.toUpperCase()) + "</span>" +
            (r.feedback ? " · " + escapeHtml(r.feedback.slice(0, 80)) : "");
        } else if (r.summary) {
          inlineSummary = escapeHtml(r.summary);
          if (r.filesChangedCount > 0) inlineSummary += " · " + r.filesChangedCount + " files";
        } else if (r.passed != null || r.failed != null) {
          inlineSummary = "✓ " + (r.passed || 0) + "  ✗ " + (r.failed || 0);
        } else if (r.error) {
          inlineSummary = "<span style=\\"color:var(--red)\\">" + escapeHtml(r.error.slice(0, 120)) + "</span>";
        }

        const detailsHtml = buildStageDetails(r);
        const hasDetails = detailsHtml.length > 0;
        const rowClass = "stage-row" + (hasDetails ? " has-details" : "");
        const onclick = hasDetails ? " onclick=\\"toggleStageDetails(" + i + ")\\"" : "";

        return (
          "<div class=\\"stage-block\\" data-stage-idx=\\"" + i + "\\">" +
            "<div class=\\"" + rowClass + "\\"" + onclick + ">" +
              "<div class=\\"sdot " + (r.status || "") + "\\"></div>" +
              "<div class=\\"srepo\\">" + escapeHtml(repoName) + "</div>" +
              "<div class=\\"sname\\">" + escapeHtml(r.stage) + "</div>" +
              "<div class=\\"stask\\" title=\\"" + escapeAttr(r.taskId || "") + "\\">" + escapeHtml(taskLabel) + "</div>" +
              "<div class=\\"ssummary\\">" + inlineSummary + "</div>" +
              "<div class=\\"smodel\\">" + escapeHtml(modelStr) + "</div>" +
              "<div class=\\"stokens\\">" + escapeHtml(tokenStr) + "</div>" +
              "<div class=\\"selapsed\\">" + elapsed + "</div>" +
              "<div class=\\"sstatus\\">" + (r.status || "") + "</div>" +
            "</div>" +
            (hasDetails ? "<div class=\\"stage-details\\">" + detailsHtml + "</div>" : "") +
          "</div>"
        );
      }).join("");
      el.scrollTop = 0;
    }

    // ---- Log Tab ----
    function selectLogTab(taskId) {
      selectedLogTaskId = taskId;
      document.querySelectorAll('.log-tab').forEach(t =>
        t.classList.toggle('active', t.dataset.task === (taskId ?? 'all'))
      );
      renderLog();
    }

    function updateLogTabs() {
      const bar = document.getElementById('log-tab-bar');
      const taskIds = [...new Set(logLines.map(l => l.taskId).filter(id => id && id !== 'system'))];
      // Sort by most recent start time
      taskIds.sort((a, b) => (taskStartMap.get(b) || 0) - (taskStartMap.get(a) || 0));

      let html = '<button class="log-tab' + (selectedLogTaskId === null ? ' active' : '')
        + '" data-task="all" onclick="selectLogTab(null)">ALL</button>';

      for (const tid of taskIds) {
        const info = taskTitleMap.get(tid);
        const label = info?.issueIdentifier || tid.slice(0, 8);
        const isActive = selectedLogTaskId === tid;
        html += '<button class="log-tab' + (isActive ? ' active' : '')
          + '" data-task="' + tid + '" onclick="selectLogTab(\\'' + tid + '\\')">'
          + escapeHtml(label) + '</button>';
      }
      bar.innerHTML = html;
    }

    // ---- Log ----
    function addLogLine(data) {
      data._ts = Date.now();
      logLines.push(data);
      if (logLines.length > MAX_LOG) logLines = logLines.slice(-MAX_LOG);
      updateLogTabs();
      renderLog();
    }

    function classifyLog(line) {
      if (!line) return { cls: "log-spacer", icon: "" };
      if (line === "───") return { cls: "log-separator", icon: "" };
      if (/^■ /.test(line)) return { cls: "log-heading2", icon: "■" };
      if (/^[┌└│]/.test(line)) return { cls: "log-code", icon: "" };
      if (/^▸ /.test(line)) return { cls: "log-tool", icon: "▸" };
      if (/^▶|Heartbeat started|Stage started|Iteration [0-9]/.test(line)) return { cls: "log-heading", icon: "▶" };
      if (/^✓|success=true|approved|completed|Done|Created sub-issue/.test(line)) return { cls: "log-success", icon: "✓" };
      if (/^✗|success=false|failed|error|Error|rejected|exceeded/.test(line)) return { cls: "log-fail", icon: "✗" };
      if (/^⟳|Fetching|Decomposing|Running|Scheduling|Spawning/.test(line)) return { cls: "", icon: "⟳" };
      if (/^⛔|Blocked|Time window|blocked/.test(line)) return { cls: "log-warn", icon: "⛔" };
      if (/^—|No task|already completed|no log/.test(line)) return { cls: "log-system", icon: "—" };
      if (/Cost:|\\$[\\.0-9]/.test(line)) return { cls: "", icon: "💲" };
      if (/Git detected|files changed|filesChanged/.test(line)) return { cls: "", icon: "📁" };
      if (/Selected [0-9]+ tasks/.test(line)) return { cls: "", icon: "🎯" };
      if (/Enqueued|executePipeline/.test(line)) return { cls: "", icon: "📋" };
      if (/Direct path|Project|path found/.test(line)) return { cls: "log-system", icon: "📂" };
      return { cls: "", icon: "·" };
    }

    function formatLogText(raw) {
      if (!raw) return "";
      // Detect and humanize raw JSON that slipped through
      const trimmed = raw.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const obj = JSON.parse(trimmed);
          if (obj.needsDecomposition === false) {
            const r = obj.reason ? obj.reason.slice(0, 120) : "";
            raw = "\\u2713 No decomposition needed (" + (obj.totalEstimatedMinutes || "?") + "min) " + r;
          } else if (obj.needsDecomposition === true && obj.subTasks) {
            raw = "\\uD83D\\uDD00 Decomposed into " + obj.subTasks.length + " sub-tasks (total " + (obj.totalEstimatedMinutes || "?") + "min)";
          } else if (obj.success !== undefined) {
            raw = (obj.success ? "\\u2713 " : "\\u2717 ") + (obj.summary || obj.error || JSON.stringify(obj).slice(0, 120));
          }
        } catch { /* not valid JSON */ }
      }
      let t = escapeHtml(raw);
      // inline bold: **text** → highlighted
      t = t.replace(/\\*\\*([^*]+)\\*\\*/g, '<span class="lhighlight">$1</span>');
      // highlight cost figures
      t = t.replace(/(\\$[\\d.]+)/g, '<span class="lcost">$1</span>');
      // highlight file counts
      t = t.replace(/(\\d+ files? changed)/g, '<span class="lfiles">$1</span>');
      // highlight durations
      t = t.replace(/(\\d+\\.\\d+s|\\d+ms)/g, '<span class="lcost">$1</span>');
      // highlight task titles in quotes
      t = t.replace(/(&quot;[^&]+&quot;)/g, '<span class="lhighlight">$1</span>');
      // highlight issue identifiers
      t = t.replace(/(INT-\\d+)/g, '<span class="lhighlight">$1</span>');
      return t;
    }

    function fmtLogTime(ts) {
      if (!ts) return "";
      const d = new Date(ts);
      return d.getHours().toString().padStart(2,"0") + ":" +
             d.getMinutes().toString().padStart(2,"0") + ":" +
             d.getSeconds().toString().padStart(2,"0");
    }

    function renderLog() {
      const el = document.getElementById("log-list");
      const cnt = document.getElementById("log-count");
      const filtered = selectedLogTaskId === null
        ? logLines
        : logLines.filter(l => l.taskId === selectedLogTaskId);
      if (!filtered.length) {
        el.innerHTML = "<div class=\\"empty\\">" + (selectedLogTaskId ? "no logs for this task" : "no log output") + "</div>";
        if (cnt) cnt.textContent = selectedLogTaskId ? filtered.length + "/" + logLines.length : "";
        return;
      }
      if (cnt) cnt.textContent = (selectedLogTaskId ? filtered.length + "/" : "") + logLines.length + "/" + MAX_LOG;
      const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50;
      el.innerHTML = filtered.map(l => {
        const info = l.taskId ? taskTitleMap.get(l.taskId) : null;
        const tag = info?.issueIdentifier
          ? info.issueIdentifier
          : (l.taskId === "system" ? "SYS" : (l.taskId || "").slice(0, 8));
        const { cls, icon } = classifyLog(l.line);
        // spacer/separator use minimal rendering
        if (cls === "log-spacer") return "<div class=\\"log-line log-spacer\\"></div>";
        if (cls === "log-separator") return "<div class=\\"log-line log-separator\\"><span class=\\"ltext\\">───────────────────</span></div>";
        const time = fmtLogTime(l._ts);
        const stage = l.stage && l.stage !== "heartbeat" ? l.stage : "";
        // heading2: strip ■ prefix (icon handles it)
        const displayLine = cls === "log-heading2" ? (l.line || "").replace(/^■ /, "") : l.line;
        // tool: strip ▸ prefix
        const displayLine2 = cls === "log-tool" ? (displayLine || "").replace(/^▸ /, "") : displayLine;
        return (
          "<div class=\\"log-line " + cls + "\\">" +
          "<span class=\\"ltime\\">" + time + "</span>" +
          "<span class=\\"licon\\">" + icon + "</span>" +
          "<span class=\\"ltag\\" title=\\"" + escapeAttr(l.taskId || "") + "\\">" + escapeHtml(tag) + "</span>" +
          (stage ? "<span class=\\"lstage\\">" + escapeHtml(stage) + "</span>" : "") +
          "<span class=\\"ltext\\">" + formatLogText(displayLine2) + "</span>" +
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
        : "<span class=\\"chat-prefix\\">OpenSwarm&gt;</span>";
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
      thinkEl.innerHTML = "<span class=\\"chat-prefix\\">OpenSwarm&gt;</span> <span class=\\"chat-text chat-thinking\\">thinking...</span>";
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
    function fmtAge(isoDate) {
      if (!isoDate) return "";
      var diff = Math.max(0, Date.now() - new Date(isoDate).getTime());
      var sec = Math.floor(diff / 1000);
      if (sec < 60) return sec + "s";
      var min = Math.floor(sec / 60);
      if (min < 60) return min + "m";
      var hr = Math.floor(min / 60);
      if (hr < 24) return hr + "h";
      var day = Math.floor(hr / 24);
      if (day < 7) return day + "d";
      var wk = Math.floor(day / 7);
      return wk + "w";
    }
    function escapeHtml(text) {
      const d = document.createElement("div"); d.textContent = String(text || ""); return d.innerHTML;
    }
    function escapeAttr(text) {
      return String(text || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function escapeJsArgAttr(text) {
      return escapeAttr(JSON.stringify(String(text || "")));
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
        fetchScanPaths();
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

    // ---- Scan Paths ----
    async function fetchScanPaths() {
      try {
        const res = await fetch("/api/scan-paths");
        if (res.ok) {
          const data = await res.json();
          renderScanPaths(data);
        }
      } catch(e) {
        console.error("fetchScanPaths error:", e);
      }
    }

    function renderScanPaths(data) {
      const list = document.getElementById("scan-paths-list");
      if (!list) return;
      const rows = [];
      for (const p of (data.configPaths || [])) {
        rows.push(
          "<div class=\\"scan-path-row\\">" +
            "<span class=\\"path\\">" + escapeHtml(p) + "</span>" +
            "<button class=\\"scan-path-remove\\" title=\\"remove\\" onclick=\\"removeScanPath(" + escapeJsArgAttr(p) + ")\\">✕</button>" +
          "</div>"
        );
      }
      for (const p of (data.customPaths || [])) {
        rows.push(
          "<div class=\\"scan-path-row\\">" +
            "<span class=\\"path\\">" + escapeHtml(p) + "</span>" +
            "<button class=\\"scan-path-remove\\" onclick=\\"removeScanPath(" + escapeJsArgAttr(p) + ")\\">✕</button>" +
          "</div>"
        );
      }
      list.innerHTML = rows.length > 0 ? rows.join("") : "<div style=\\"color:#334433;font-size:10px\\">no scan paths configured</div>";
    }

    async function addScanPath(explicitPath) {
      const input = document.getElementById("scan-path-input");
      const path = (explicitPath ?? input.value).trim();
      if (!path) return;
      if (!explicitPath) input.value = "";
      try {
        await fetch("/api/scan-paths", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        await fetchScanPaths();
        // Refresh project list in picker
        const res = await fetch("/api/local-projects");
        allLocalProjects = await res.json();
        filterRepos(document.getElementById("repo-search").value);
      } catch(e) {
        console.error("addScanPath error:", e);
      }
    }

    function toggleManualPathInput() {
      const row = document.getElementById("manual-path-row");
      if (!row) return;
      if (row.style.display === "none" || row.style.display === "") {
        row.style.display = "flex";
        const input = document.getElementById("scan-path-input");
        if (input) input.focus();
      } else {
        row.style.display = "none";
      }
    }

    // ---- Folder Browser (native-style picker via /api/fs/list) ----
    var folderBrowserCurrent = null;
    var folderBrowserParent = null;

    async function openFolderBrowser(startPath) {
      const modal = document.getElementById("folder-browser");
      if (!modal) return;
      modal.style.display = "flex";
      await loadFolderBrowser(startPath || "~/dev");
    }

    function closeFolderBrowser() {
      const modal = document.getElementById("folder-browser");
      if (modal) modal.style.display = "none";
    }

    async function loadFolderBrowser(path) {
      const list = document.getElementById("fb-list");
      const pathEl = document.getElementById("fb-path");
      const upBtn = document.getElementById("fb-up");
      const selectBtn = document.getElementById("fb-select");
      if (!list || !pathEl) return;
      list.innerHTML = "<div style=\\"padding:18px;color:var(--dim);font-size:12px;text-align:center\\">Loading…</div>";
      try {
        const res = await fetch("/api/fs/list?path=" + encodeURIComponent(path));
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          list.innerHTML = "<div style=\\"padding:18px;color:var(--red);font-size:12px;text-align:center\\">" + escapeHtml(err.error || ("HTTP " + res.status)) + "</div>";
          return;
        }
        const data = await res.json();
        folderBrowserCurrent = data.path;
        folderBrowserParent = data.parent;
        pathEl.value = data.path;
        if (upBtn) upBtn.disabled = !data.parent;
        if (selectBtn) selectBtn.textContent = "Select \\"" + (data.name || data.path) + "\\"";

        const dirs = (data.entries || []).filter(function(e) { return e.isDir; });
        if (dirs.length === 0) {
          list.innerHTML = "<div style=\\"padding:18px;color:var(--dim);font-size:12px;text-align:center\\">No subfolders</div>";
          return;
        }
        list.innerHTML = dirs.map(function(e) {
          return "<div class=\\"fb-row\\" data-name=\\"" + escapeAttr(e.name) + "\\" onclick=\\"folderBrowserEnter(this.getAttribute('data-name'))\\"" +
            " style=\\"padding:7px 18px;cursor:pointer;font-size:13px;color:var(--white);display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border2);transition:background .12s\\"" +
            " onmouseover=\\"this.style.background='var(--bg3)'\\" onmouseout=\\"this.style.background=''\\">" +
            "<span style=\\"color:var(--green)\\">📁</span>" +
            "<span>" + escapeHtml(e.name) + "</span>" +
            "</div>";
        }).join("");
      } catch (e) {
        list.innerHTML = "<div style=\\"padding:18px;color:var(--red);font-size:12px;text-align:center\\">" + escapeHtml(String(e)) + "</div>";
      }
    }

    function folderBrowserEnter(name) {
      if (!folderBrowserCurrent || !name) return;
      // Join via the server side by sending the absolute path of the child
      const sep = folderBrowserCurrent.endsWith("/") ? "" : "/";
      loadFolderBrowser(folderBrowserCurrent + sep + name);
    }

    function folderBrowserUp() {
      if (folderBrowserParent) loadFolderBrowser(folderBrowserParent);
    }

    async function folderBrowserSelect() {
      if (!folderBrowserCurrent) return;
      const picked = folderBrowserCurrent;
      closeFolderBrowser();
      await addScanPath(picked);
    }

    async function removeScanPath(path) {
      try {
        await fetch("/api/scan-paths/" + encodeURIComponent(path), {
          method: "DELETE",
        });
        await fetchScanPaths();
        // Refresh project list in picker
        const res = await fetch("/api/local-projects");
        allLocalProjects = await res.json();
        filterRepos(document.getElementById("repo-search").value);
      } catch(e) {
        console.error("removeScanPath error:", e);
      }
    }

    // ---- Monitors ----
    var monitorsData = [];
    async function fetchMonitors() {
      try {
        const res = await fetch("/api/monitors");
        if (res.ok) { monitorsData = await res.json(); renderMonitors(); }
      } catch {}
    }
    function renderMonitors() {
      renderMonitorsAndProcesses();
    }
    function fmtDur(ms) {
      var s = Math.floor(ms / 1000);
      var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
      if (h >= 24) return Math.floor(h / 24) + "d " + (h % 24) + "h";
      if (h > 0) return h + "h " + m + "m";
      return m + "m";
    }

    // ---- Processes ----
    var processesData = [];
    async function fetchProcesses() {
      try {
        const res = await fetch("/api/processes");
        if (res.ok) { processesData = await res.json(); renderMonitorsAndProcesses(); }
      } catch {}
    }
    async function stopProcess(id, isPipeline) {
      var verb = isPipeline ? "Cancel task" : "Kill process";
      if (!confirm(verb + " " + id + "?")) return;
      try {
        await fetch("/api/processes/" + encodeURIComponent(id), { method: "DELETE" });
        processesData = processesData.filter(p => String(p.id) !== String(id));
        renderMonitorsAndProcesses();
      } catch(e) {
        addLogLine({ taskId: "system", stage: "error", line: "Stop failed: " + e.message });
      }
    }
    function procActivityIcon(lastActivityAt) {
      var ago = (Date.now() - lastActivityAt) / 1000;
      if (ago < 10) return "\\u26A1";
      if (ago < 60) return "\\u23F8";
      return "\\u2757";
    }
    function renderMonitorsAndProcesses() {
      var panel = document.getElementById("monitor-panel");
      var el = document.getElementById("monitor-list");
      var countEl = document.getElementById("monitor-count");
      var hasMonitors = monitorsData.length > 0;
      var hasProcesses = processesData.length > 0;
      if (!hasMonitors && !hasProcesses) {
        el.innerHTML = "<div class=\\"empty\\">no monitors or processes</div>";
        var counts = [];
        if (countEl) countEl.textContent = "";
        return;
      }
      var parts = [];
      if (processesData.length) parts.push(processesData.length + "p");
      if (monitorsData.length) parts.push(monitorsData.length + "m");
      if (countEl) countEl.textContent = parts.join(" ");
      var html = "";
      // Processes section
      if (hasProcesses) {
        html += "<div class=\\"issue-sec-label\\">processes</div>";
        html += processesData.map(function(p) {
          var dur = fmtDur(Date.now() - p.spawnedAt);
          var isPipeline = p.kind === "pipeline";
          var act = isPipeline ? "\\u2699" : procActivityIcon(p.lastActivityAt);
          var modelStr = p.model ? shortModel(p.model) : "";
          var projName = p.project || (p.projectPath ? p.projectPath.split("/").pop() : "");
          // In-process pipeline tasks have no OS PID — show the issue id instead, and
          // a CANCEL button (aborts the pipeline + its in-flight adapter call).
          var lead = isPipeline ? escapeHtml(p.taskId || "task") : p.pid;
          var btn = isPipeline
            ? '<button class="proc-kill" onclick="stopProcess(' + escapeJsArgAttr(String(p.id)) + ', true)">CANCEL</button>'
            : '<button class="proc-kill" onclick="stopProcess(' + escapeJsArgAttr(String(p.id)) + ', false)">KILL</button>';
          return '<div class="proc-row">' +
            '<span class="proc-pid">' + lead + '</span>' +
            '<span class="proc-stage">' + escapeHtml(p.stage) + '</span>' +
            '<span class="proc-model">' + escapeHtml(modelStr) + '</span>' +
            '<span style="color:var(--dim);font-size:9px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeAttr(p.projectPath || "") + '">' + escapeHtml(projName) + '</span>' +
            '<span class="proc-activity">' + act + '</span>' +
            '<span class="proc-dur">' + dur + '</span>' +
            btn +
          '</div>';
        }).join("");
      }
      // Monitors section
      if (hasMonitors) {
        html += "<div class=\\"issue-sec-label\\">monitors</div>";
        html += monitorsData.map(function(m) {
          var stateColor = m.state === "running" ? "var(--green)" : m.state === "completed" ? "var(--cyan)" : m.state === "failed" || m.state === "timeout" ? "var(--red)" : "var(--dim)";
          var elapsed = m.registeredAt ? fmtDur(Date.now() - m.registeredAt) : "-";
          var lastOut = m.lastOutput ? escapeHtml(m.lastOutput.slice(0, 80)) : "-";
          return '<div style="padding:4px 6px;border-bottom:1px solid var(--border);font-size:11px">' +
            '<div style="display:flex;align-items:center;gap:6px">' +
              '<span style="color:' + stateColor + ';font-weight:bold">[' + m.state.toUpperCase() + ']</span>' +
              '<span style="color:var(--green)">' + escapeHtml(m.name) + '</span>' +
              '<span style="margin-left:auto;color:var(--dim)">' + elapsed + '</span>' +
            '</div>' +
            '<div style="color:var(--dim);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeAttr(m.lastOutput || "") + '">' + lastOut + '</div>' +
            (m.issueId ? '<div style="color:var(--cyan-dim);font-size:10px;margin-top:1px">' + escapeHtml(m.issueId) + ' | checks: ' + m.checkCount + '</div>' : '') +
          '</div>';
        }).join("");
      }
      el.innerHTML = html;
    }

    function addCoordinationEvent(event) {
      if (!event || typeof event.id !== "string") return;
      const previous = coordinationById.get(event.id);
      if (!previous || Number(event.seq || 0) >= Number(previous.seq || 0)) coordinationById.set(event.id, event);
      renderCoordination();
    }

    function renderCoordination() {
      // The per-event list lives on /orchestration now; this card answers one
      // question at a glance — how many agents are placed and what is waiting.
      var el = document.getElementById("coordination-summary");
      var events = Array.from(coordinationById.values());
      document.getElementById("coordination-count").textContent = events.length ? String(events.length) : "";
      if (!events.length) { el.innerHTML = '<div class="empty">no coordination events</div>'; return; }
      var agents = {};
      var latestByCorrelation = {};
      events.forEach(function(ev) {
        if (ev.actor && ev.actor !== 'human') agents[ev.actor] = ev.actorRole || 'agent';
        var prev = latestByCorrelation[ev.correlationId];
        if (!prev || Number(ev.seq || 0) > Number(prev.seq || 0)) latestByCorrelation[ev.correlationId] = ev;
      });
      var pending = Object.values(latestByCorrelation).filter(function(ev) { return ["open", "waiting", "running"].includes(ev.status); });
      var questions = pending.filter(function(ev) { return ev.kind === "human-question"; }).length;
      var roles = {};
      Object.values(agents).forEach(function(role) { roles[role] = (roles[role] || 0) + 1; });
      var roleLine = Object.keys(roles).sort().map(function(role) { return roles[role] + " " + escapeHtml(role); }).join(" · ");
      el.innerHTML =
        '<div style="padding:8px 6px;font-size:11px">' +
        '<div style="color:var(--white)"><b style="font-size:15px">' + Object.keys(agents).length + '</b> agents placed <span style="color:var(--dim)">(' + roleLine + ')</span></div>' +
        '<div style="margin-top:4px;color:' + (questions > 0 ? 'var(--amber)' : 'var(--dim)') + '">' + questions + ' question(s) waiting on you · ' + pending.length + ' open exchange(s)</div>' +
        '</div>';
    }

    async function fetchCoordination() {
      try {
        const response = await fetch("/api/coordination");
        if (!response.ok) return;
        const snapshot = await response.json();
        for (const event of snapshot.events || []) addCoordinationEvent(event);
      } catch {}
    }

    // ---- Init ----
    async function loadInitial() {
      try {
        // 1단계: 필수 데이터 먼저 로드 (성능 개선)
        const [statsRes, projectsRes] = await Promise.all([
          fetch("/api/stats"),
          fetch("/api/projects"),
        ]);
        const stats = await statsRes.json();
        updateStats(stats);
        document.getElementById("stat-sse").textContent = stats.sseClients ?? "-";

        projects = await projectsRes.json();
        renderProjects();

        // 2단계: 추가 데이터는 비동기로 지연 로드 (브라우저 렌더링 블로킹 제거)
        loadSupplementalData();
      } catch(e) {
        console.error("Init failed:", e);
      }
    }

    // 추가 데이터 지연 로드 (초기 렌더링을 방해하지 않음)
    async function loadSupplementalData() {
      try {
        const [chatRes, logsRes, stagesRes] = await Promise.all([
          fetch("/api/chat/history"),
          fetch("/api/logs"),
          fetch("/api/stages"),
        ]);

        const history = await chatRes.json();
        for (const msg of history) appendChatMsg(msg.role, msg.text, null, msg.ts);

        // Restore logs
        const logs = await logsRes.json();
        for (const ev of logs) addLogLine(ev.data);

        // Restore pipeline/task events
        const stages = await stagesRes.json();
        for (const ev of stages) handleEvent(ev);
        await fetchCoordination();
      } catch(e) {
        console.error("Supplemental data load failed:", e);
      }
    }

    // 성능 최적화: stats + projects 폴링을 60초로 증가 (변화 빈도 낮음)
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
    }, 60000);

    // ---- Mobile Tab Navigation ----
    function switchTab(idx) {
      const cols = document.querySelectorAll(".main-grid > .col");
      const tabs = document.querySelectorAll(".tab-bar .tab");
      cols.forEach((c, i) => c.classList.toggle("mob-active", i === idx));
      tabs.forEach((t, i) => t.classList.toggle("active", i === idx));
    }
    document.querySelector(".tab-bar").addEventListener("click", e => {
      const tab = e.target.closest(".tab");
      if (!tab) return;
      switchTab(parseInt(tab.dataset.tab, 10));
    });
    // Activate first tab on load
    switchTab(0);

    // Knowledge graph data fetcher
    async function fetchKnowledgeData() {
      try {
        const res = await fetch("/api/knowledge");
        if (res.ok) {
          const data = await res.json();
          for (const item of data) {
            knowledgeCache[item.slug] = item;
            // Also cache by last segment for name-based lookup
            const parts = item.slug.split("-");
            knowledgeCache[parts[parts.length - 1]] = item;
          }
          renderProjects();
        }
      } catch {}
    }

    // 성능 최적화: 초기 로드 후 2단계 페칭 (렌더링 블로킹 방지)
    loadInitial().then(function() { connectSSE(true); });

    // 1단계: 초기화 후 즉시 필수 폴링만 시작
    setInterval(fetchSvcStatus, 15000);
    setInterval(fetchPRProcessorStatus, 60000);  // 성능 최적화: 30초 → 60초 (변화 빈도 낮음)
    setInterval(fetchStuckIssues, 60000);        // 성능 최적화: 30초 → 60초 (Linear API 부하 감소)
    setInterval(fetchKnowledgeData, 60000);
    setInterval(fetchMonitors, 60000);
    setInterval(fetchProcesses, 30000);
    setInterval(fetchCoordination, 30000);

    // 2단계: 렌더링 안정화 후 비필수 데이터 로드 (3초 지연)
    setTimeout(function() {
      fetchSvcStatus();
      fetchPRProcessorStatus();
      fetchStuckIssues();
      fetchKnowledgeData();
      fetchMonitors();
      fetchProcesses();
    }, 3000);

    // 렌더링 성능: 스테이지 업데이트 폴링 제거 (SSE 이벤트 활용)
    // setInterval(() => { if (stageRows.length) renderStages(); }, 10000);
  </script>
</body>
</html>`;

/** Short labels for the header toggle — registry names stay on id/onclick. */
const PROVIDER_BUTTON_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  'codex-responses': 'Codex-R',
  gpt: 'GPT',
  openrouter: 'OpenRouter',
  atlascloud: 'Atlas',
  lmstudio: 'LM Studio',
  local: 'Local',
};

/**
 * Inject registry-backed provider buttons so the dashboard toggle cannot
 * drift from `isKnownAdapter` / POST /api/provider validation. (INT-3284)
 */
export function buildDashboardHtml(providers: readonly string[]): string {
  const buttons = providers.map((name) => {
    const label = PROVIDER_BUTTON_LABELS[name] ?? name;
    return `<button class="provider-btn" id="provider-${name}" onclick="switchProvider('${name}')">${label}</button>`;
  }).join('\n          ');
  return DASHBOARD_HTML.replace('<!--PROVIDER_BUTTONS-->', buttons);
}

export { DASHBOARD_HTML };
