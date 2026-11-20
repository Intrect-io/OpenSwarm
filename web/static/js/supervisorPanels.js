// The Supervisor page's secondary panels: the repo picker, scan paths, the
// folder browser, monitors, processes and the coordination feed.
//
// Split out of supervisor.js (AGT-4868) to keep each file under the 1500 code
// LOC cap. It is a classic script like supervisor.js and shares its global
// scope, so it must load BEFORE supervisor.js: supervisor.js's init code at the
// bottom calls fetchMonitors/fetchProcesses/fetchCoordination synchronously.
// This file only declares; it runs nothing at load, so it may reference
// supervisor.js's globals (escapeHtml, coordinationById, ...) from function
// bodies. Its functions are called from inline `onclick` attributes, which is
// why the linter sees them as unused.
/* eslint-disable no-unused-vars */

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
    "<div class=\"empty\">loading...</div>";
  document.getElementById("repo-search").focus();

  try {
    fetchScanPaths();
    const res = await fetch("/api/local-projects");
    allLocalProjects = await res.json();
    filterRepos("");
  } catch(e) {
    document.getElementById("repo-picker-list").innerHTML =
      "<div class=\"empty\">failed to load: " + escapeHtml(e.message) + "</div>";
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
    list.innerHTML = "<div class=\"empty\">no results</div>";
    return;
  }
  list.innerHTML = filtered.slice(0, 80).map(p => {
    const badge = p.pinned ? "<span class=\"repo-item-badge\">pinned</span>" : "";
    return (
      "<div class=\"repo-item\" data-path=\"" + escapeAttr(p.path) + "\" onclick=\"pickRepo(this)\">" +
      "<div>" +
        "<div class=\"repo-item-name\">" + escapeHtml(p.name) + "</div>" +
        "<div class=\"repo-item-path\">" + escapeHtml(p.path) + "</div>" +
      "</div>" +
      badge +
      "</div>"
    );
  }).join("");
}

// Re-read the Repositories panel and the local picker list. githubConnect.js
// calls this after a clone registers a new repository (AGT-4005).
async function reloadProjectList() {
  const res = await fetch("/api/projects");
  projects = await res.json();
  renderProjects();
  if (pickerOpen) {
    const local = await fetch("/api/local-projects");
    allLocalProjects = await local.json();
    filterRepos(document.getElementById("repo-search").value);
  }
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
      "<div class=\"scan-path-row\">" +
        "<span class=\"path\">" + escapeHtml(p) + "</span>" +
        "<button class=\"scan-path-remove\" aria-label=\"Remove scan path\" title=\"Remove scan path\" onclick=\"removeScanPath(" + escapeJsArgAttr(p) + ")\"><svg viewBox=\"0 0 16 16\" width=\"12\" height=\"12\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"><path d=\"M4 4l8 8M12 4l-8 8\"/></svg></button>" +
      "</div>"
    );
  }
  for (const p of (data.customPaths || [])) {
    rows.push(
      "<div class=\"scan-path-row\">" +
        "<span class=\"path\">" + escapeHtml(p) + "</span>" +
        "<button class=\"scan-path-remove\" aria-label=\"Remove scan path\" title=\"Remove scan path\" onclick=\"removeScanPath(" + escapeJsArgAttr(p) + ")\"><svg viewBox=\"0 0 16 16\" width=\"12\" height=\"12\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"><path d=\"M4 4l8 8M12 4l-8 8\"/></svg></button>" +
      "</div>"
    );
  }
  list.innerHTML = rows.length > 0 ? rows.join("") : "<div style=\"color:var(--fg-muted);font-size:12px\">no scan paths configured</div>";
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
  list.innerHTML = "<div style=\"padding:18px;color:var(--fg-muted);font-size:12px;text-align:center\">Loading…</div>";
  try {
    const res = await fetch("/api/fs/list?path=" + encodeURIComponent(path));
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      list.innerHTML = "<div style=\"padding:18px;color:var(--danger);font-size:12px;text-align:center\">" + escapeHtml(err.error || ("HTTP " + res.status)) + "</div>";
      return;
    }
    const data = await res.json();
    folderBrowserCurrent = data.path;
    folderBrowserParent = data.parent;
    pathEl.value = data.path;
    if (upBtn) upBtn.disabled = !data.parent;
    if (selectBtn) selectBtn.textContent = "Select \"" + (data.name || data.path) + "\"";

    const dirs = (data.entries || []).filter(function(e) { return e.isDir; });
    if (dirs.length === 0) {
      list.innerHTML = "<div style=\"padding:18px;color:var(--fg-muted);font-size:12px;text-align:center\">No subfolders</div>";
      return;
    }
    list.innerHTML = dirs.map(function(e) {
      return "<div class=\"fb-row\" data-name=\"" + escapeAttr(e.name) + "\" onclick=\"folderBrowserEnter(this.getAttribute('data-name'))\"" +
        " style=\"padding:7px 18px;cursor:pointer;font-size:13px;color:var(--fg-primary);display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border);transition:background .12s\"" +
        " onmouseover=\"this.style.background='var(--bg-elevated)'\" onmouseout=\"this.style.background=''\">" +
        "<span>" + escapeHtml(e.name) + "/</span>" +
        "</div>";
    }).join("");
  } catch (e) {
    list.innerHTML = "<div style=\"padding:18px;color:var(--danger);font-size:12px;text-align:center\">" + escapeHtml(String(e)) + "</div>";
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
async function stopProcess(btn, id, isPipeline) {
  if (armButton(btn, isPipeline ? "Cancel " + id + "?" : "Kill " + id + "?")) return;
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
  if (ago < 10) return "\u26A1";
  if (ago < 60) return "\u23F8";
  return "\u2757";
}
function renderMonitorsAndProcesses() {
  var panel = document.getElementById("monitor-panel");
  var el = document.getElementById("monitor-list");
  var countEl = document.getElementById("monitor-count");
  var hasMonitors = monitorsData.length > 0;
  var hasProcesses = processesData.length > 0;
  if (!hasMonitors && !hasProcesses) {
    el.innerHTML = "<div class=\"empty\">no monitors or processes</div>";
    var counts = [];
    if (countEl) countEl.textContent = "process table";
    return;
  }
  var parts = [];
  if (processesData.length) parts.push(processesData.length + " process" + (processesData.length === 1 ? "" : "es"));
  if (monitorsData.length) parts.push(monitorsData.length + " monitor" + (monitorsData.length === 1 ? "" : "s"));
  if (countEl) countEl.textContent = "process table · " + parts.join(" · ");
  var html = "";
  // Processes section
  if (hasProcesses) {
    html += "<div class=\"issue-sec-label\">processes</div>";
    html += processesData.map(function(p) {
      var dur = fmtDur(Date.now() - p.spawnedAt);
      var isPipeline = p.kind === "pipeline";
      var act = isPipeline ? "\u2699" : procActivityIcon(p.lastActivityAt);
      var modelStr = p.model ? shortModel(p.model) : "";
      var projName = p.project || (p.projectPath ? p.projectPath.split("/").pop() : "");
      // In-process pipeline tasks have no OS PID — show the issue id instead, and
      // a CANCEL button (aborts the pipeline + its in-flight adapter call).
      var lead = isPipeline ? escapeHtml(p.taskId || "task") : p.pid;
      var btn = isPipeline
        ? '<button class="proc-kill" onclick="stopProcess(this, ' + escapeJsArgAttr(String(p.id)) + ', true)">Cancel</button>'
        : '<button class="proc-kill" onclick="stopProcess(this, ' + escapeJsArgAttr(String(p.id)) + ', false)">Kill</button>';
      return '<div class="proc-row">' +
        '<span class="proc-pid">' + lead + '</span>' +
        '<span class="proc-stage">' + escapeHtml(p.stage) + '</span>' +
        '<span class="proc-model">' + escapeHtml(modelStr) + '</span>' +
        '<span class="proc-proj" title="' + escapeAttr(p.projectPath || "") + '">' + escapeHtml(projName) + '</span>' +
        '<span class="proc-activity">' + act + '</span>' +
        '<span class="proc-dur">' + dur + '</span>' +
        btn +
      '</div>';
    }).join("");
  }
  // Monitors section
  if (hasMonitors) {
    html += "<div class=\"issue-sec-label\">monitors</div>";
    html += monitorsData.map(function(m) {
      var stateColor = m.state === "running" ? "var(--accent)" : m.state === "completed" ? "var(--info)" : m.state === "failed" || m.state === "timeout" ? "var(--danger)" : "var(--fg-muted)";
      var elapsed = m.registeredAt ? fmtDur(Date.now() - m.registeredAt) : "-";
      var lastOut = m.lastOutput ? escapeHtml(m.lastOutput.slice(0, 80)) : "-";
      return '<div style="padding:4px 6px;border-bottom:1px solid var(--border);font-size:11px">' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          '<span style="color:' + stateColor + ';font-weight:bold">[' + m.state.toUpperCase() + ']</span>' +
          '<span style="color:var(--accent)">' + escapeHtml(m.name) + '</span>' +
          '<span style="margin-left:auto;color:var(--fg-muted)">' + elapsed + '</span>' +
        '</div>' +
        '<div style="color:var(--fg-muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeAttr(m.lastOutput || "") + '">' + lastOut + '</div>' +
        (m.issueId ? '<div style="color:var(--accent-subtle);font-size:12px;margin-top:1px">' + escapeHtml(m.issueId) + ' | checks: ' + m.checkCount + '</div>' : '') +
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
  setText("coordination-count", "coordination board" + (events.length ? " · " + events.length + " events" : ""));
  renderNotice();
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
    '<div class="coord-summary">' +
    '<div class="coord-placed"><b>' + Object.keys(agents).length + '</b> agents placed <span class="muted">(' + roleLine + ')</span></div>' +
    // Questions are the one thing here that waits on the operator: a yellow
    // fill, never yellow text (Yellow Means You).
    '<div class="coord-pending">' +
      (questions > 0 ? '<span class="needs-tag">' + plural(questions, 'question') + ' waiting on you</span>' : '0 questions waiting on you') +
      ' · ' + plural(pending.length, 'open exchange') + '</div>' +
    '</div>';
}

function plural(count, noun) {
  return count + ' ' + noun + (count === 1 ? '' : 's');
}

async function fetchCoordination() {
  try {
    const response = await fetch("/api/coordination");
    if (!response.ok) return;
    const snapshot = await response.json();
    for (const event of snapshot.events || []) addCoordinationEvent(event);
  } catch {}
}
