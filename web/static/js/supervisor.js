// The Supervisor page (served at `/`): the Departure Board.
//
// Top to bottom it answers, in order, what an operator glancing at a phone
// needs: what waits on me (the notice band), how the fleet is doing (counts),
// what I can do (routine controls apart from the daemon service), and what is
// running right now (the board). References sit beside it, each naming its
// source. It is a classic script because its markup calls these functions from
// inline `onclick` attributes, which is also why the linter sees them as unused.
/* eslint-disable no-unused-vars */

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
// The board: the scheduler's running/queued snapshot plus runs that ended
// while this page was open (or are still in the event buffer it replays).
let boardTasks = { running: [], queued: [] };
const endedRuns = [];
const MAX_ENDED = 8;
// Same source as the shell status line, so the two never disagree.
let shellStatus = null;
let streamLive = false;

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ---- SSE ----
function connectSSE(skipReplay) {
  const url = skipReplay ? "/api/events?skipReplay=1" : "/api/events";
  const es = new EventSource(url);
  es.onopen = () => { streamLive = true; renderBoardSource(); };
  es.onmessage = e => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    handleEvent(ev);
  };
  es.onerror = () => {
    streamLive = false; renderBoardSource();
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
      scheduleTasksRefresh();
      break;
    case "task:started": {
      const p = taskProjectMap.get(ev.data.taskId);
      if (ev.data.title) taskTitleMap.set(ev.data.taskId, { title: ev.data.title, issueIdentifier: ev.data.issueIdentifier });
      taskStartMap.set(ev.data.taskId, Date.now());
      if (p) updateProjectTask(p, ev.data.taskId, ev.data.title, null, "running");
      scheduleTasksRefresh();
      break;
    }
    case "task:completed": {
      const p = taskProjectMap.get(ev.data.taskId);
      if (p) removeProjectTask(p, ev.data.taskId);
      recordEndedRun(ev.data);
      scheduleTasksRefresh();
      break;
    }
    case "pipeline:stage": addStageRow(ev.data); renderBoard(); break;
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
      setText("stat-cost", "$" + totalCostUsd.toFixed(2));
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
      const spawnLine = "Process spawned PID=" + ev.data.pid + " stage=" + ev.data.stage +
        (ev.data.model ? " model=" + ev.data.model : "");
      addLogLine({ taskId: ev.data.taskId || "system", stage: ev.data.stage || "spawn", line: spawnLine });
      break;
    case "process:exit":
      fetchProcesses();
      addLogLine({ taskId: "system", stage: "exit", line: "Process exited PID=" + ev.data.pid + " code=" + ev.data.exitCode + " duration=" + (ev.data.durationMs / 1000).toFixed(1) + "s" });
      break;
    case "heartbeat":
      // Fired when a heartbeat starts, scheduled or manual: the start
      // signal a manual trigger is waiting for.
      resetHeartbeatButton();
      break;
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

  setText("stat-running", data.runningTasks ?? 0);
  setText("stat-queued", data.queuedTasks ?? 0);
  setText("stat-completed", data.completedToday ?? 0);
  const adapters = data.adapters || {};
  const defaultAdapter = adapters.defaultAdapter ?? "";
  // Say which model each role runs, in words: "Pair W/R" meant nothing.
  const role = (name, r) => r && r.adapter
    ? name + " " + shortModel(r.model) + " (" + r.adapter + ")"
    : "";
  setText("fleet-models", [role("Worker", adapters.worker), role("Reviewer", adapters.reviewer)].filter(Boolean).join(" · "));
  setText("chat-status", defaultAdapter ? "supervisor agent · " + defaultAdapter : "supervisor agent");
  const select = document.getElementById("provider-select");
  if (select && defaultAdapter) {
    select.dataset.applied = defaultAdapter;
    // Do not yank a staged choice out from under the operator.
    if (document.getElementById("provider-confirm").hidden) select.value = defaultAdapter;
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
    // A 500 carries { error }, which would otherwise read as "nothing stuck".
    if (!res.ok) throw new Error((await failureOf(res)) || "HTTP " + res.status);
    const data = await res.json();
    const list = document.getElementById("stuck-list");
    const badge = document.getElementById("stuck-badge");

    const totalStuck = data.stuckIssues?.length ?? 0;
    const totalFailed = data.failedIssues?.length ?? 0;
    const total = totalStuck + totalFailed;

    badge.textContent = total;
    stuckData = data;
    renderNotice();
    if (total === 0) { list.innerHTML = ""; return; }

    const row = function(issue, kind) {
      const title = String(issue.title || "");
      return "<div class=\"nrow\">" +
        "<span class=\"tag " + (kind === "failed" ? "tag-f" : "tag-s") + "\">" + (kind === "failed" ? "Failed" : "Stuck") + "</span>" +
        "<span class=\"mono\">" + escapeHtml(issue.identifier) + "</span>" +
        "<span class=\"nrow-repo\">" + escapeHtml(issue.project && issue.project.name || "") + "</span>" +
        "<span class=\"msg\" title=\"" + escapeAttr(title) + "\">" + escapeHtml(title) + "</span>" +
        "<span class=\"when\">" + escapeHtml(issue.reason || "") + "</span>" +
        "<span class=\"acts\">" + (/^https?:\/\//.test(issue.url || "") ? "<a class=\"nb-outline\" href=\"" + escapeAttr(issue.url) + "\" target=\"_blank\" rel=\"noopener\">Open issue</a>" : "") + "</span>" +
      "</div>";
    };
    list.innerHTML = (data.failedIssues || []).map(function(i) { return row(i, "failed"); }).join("")
      + (data.stuckIssues || []).map(function(i) { return row(i, "stuck"); }).join("");
  } catch (err) {
    console.error("Failed to fetch stuck issues:", err);
    const list = document.getElementById("stuck-list");
    list.innerHTML = "<div class=\"nrow\"><span class=\"tag tag-f\">Error</span><span class=\"msg nrow-wide\">The tracker did not answer, so stuck and failed issues are unknown.</span></div>";
    document.getElementById("notice-tracker").hidden = false;
    document.getElementById("notice").hidden = false;
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
      body.innerHTML = '<div style="color: var(--fg-muted);">Not configured</div>';
      badge.textContent = "config · off";
      return;
    }

    badge.textContent = "config · " + (data.processing ? "running" : "idle");

    const formatTime = (ts) => {
      if (!ts) return "N/A";
      const d = new Date(ts);
      return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    };

    let html = '<div style="display: flex; flex-direction: column; gap: 6px;">';
    html += '<div><span style="color: var(--fg-muted);">Schedule:</span> <span style="color: var(--text);">' + escapeHtml(data.schedule || "N/A") + '</span></div>';
    html += '<div><span style="color: var(--fg-muted);">Repos:</span> <span style="color: var(--text);">' + (data.repos?.length || 0) + '</span></div>';

    if (data.currentPR) {
      const prValue = '<span style="color: var(--text); font-family: var(--font-mono); font-size:12px;">' + escapeHtml(data.currentPR) + '</span>';
      html += '<div><span style="color: var(--warning);">Processing:</span> ' + prValue + '</div>';
    }

    html += '<div><span style="color: var(--fg-muted);">Last run:</span> <span style="color: var(--text);">' + formatTime(data.lastRun) + '</span></div>';
    html += '<div><span style="color: var(--fg-muted);">Next run:</span> <span style="color: var(--text);">' + formatTime(data.nextRun) + '</span></div>';

    if (data.conflictResolverEnabled) {
      html += '<div style="color: var(--accent); font-size:12px; margin-top: 4px;">✓ Conflict Resolver: ON</div>';
    }

    html += '</div>';
    body.innerHTML = html;
  } catch (e) {
    const body = document.getElementById("pr-proc-body");
    body.innerHTML = '<div style="color: var(--danger);">Error: ' + escapeHtml(e.message) + '</div>';
  }
}

// In-page consent for a destructive click (§3.2): the first press turns the
// button into the question, the second press answers it. There is no
// window.confirm in the Tauri WebView, and a dialog would hide what is
// about to happen anyway. Returns true when the caller should stop and
// wait for the second press.
function armButton(btn, question) {
  if (!btn) return false;
  if (btn.classList.contains("is-armed")) {
    btn.classList.remove("is-armed", "btn-danger");
    btn.textContent = btn.dataset.idleLabel || btn.textContent;
    return false;
  }
  btn.dataset.idleLabel = btn.textContent;
  btn.classList.add("is-armed", "btn-danger");
  btn.textContent = question;
  setTimeout(function() {
    if (btn.classList.contains("is-armed") && !btn.disabled) {
      btn.classList.remove("is-armed", "btn-danger");
      btn.textContent = btn.dataset.idleLabel || btn.textContent;
    }
  }, 6000);
  return true;
}

// The outcome of an action, said on the button that was pressed. The live
// log also records it, but on a phone the log is in another tab, and a
// button that just returns to its label reads as success.
function flashButton(btn, label, failed, restLabel, reason) {
  clearTimeout(btn._flashTimer);
  btn.textContent = label;
  btn.classList.add("is-flashing");
  btn.classList.toggle("is-failed", !!failed);
  if (reason) btn.title = reason;
  btn._flashTimer = setTimeout(function() {
    btn.textContent = restLabel;
    btn.classList.remove("is-flashing", "is-failed");
    btn.removeAttribute("title");
  }, 5000);
}

// fetch() resolves on 4xx/5xx, so an awaited call that did not throw is not
// an accepted one. Returns the server's reason, or null when it accepted.
async function failureOf(res) {
  if (res.ok) return null;
  try {
    const data = await res.json();
    if (data && data.error) return data.error;
  } catch {}
  return "HTTP " + res.status;
}

async function svcAction(action) {
  const btnId = action === "stop" ? "svc-stop-btn" : "svc-restart-btn";
  const btn = document.getElementById(btnId);
  if (armButton(btn, action === "stop" ? "Stop the daemon?" : "Restart the daemon?")) return;
  const restLabel = btn.textContent;
  const verb = action === "stop" ? "Stop" : "Restart";
  btn.disabled = true;
  let failure = null;
  try {
    failure = await failureOf(await fetch("/api/service/" + action, { method: "POST" }));
  } catch(e) {
    failure = e.message;
  }
  btn.disabled = false;
  if (failure) {
    addLogLine({ taskId: "system", stage: "error", line: "Service " + action + " failed: " + failure });
    flashButton(btn, verb + " failed", true, restLabel, failure);
  } else {
    addLogLine({ taskId: "system", stage: "service", line: "Service " + action + " requested" });
    flashButton(btn, verb + " sent", false, restLabel);
  }
  setTimeout(fetchSvcStatus, 2000);
}

// ---- Heartbeat trigger ----
// POST /api/heartbeat answers 202 before the run starts; the run announces
// itself with a "heartbeat" SSE event. Without a deadline on that signal a
// run that never started (one already in flight, a dropped stream) left
// the button on "Running…" with nothing to say it was stuck.
const HEARTBEAT_START_TIMEOUT_MS = 15000;
const HEARTBEAT_LABEL = "Heartbeat";
let heartbeatStartTimer = null;

function resetHeartbeatButton() {
  clearTimeout(heartbeatStartTimer);
  heartbeatStartTimer = null;
  const btn = document.getElementById("hb-btn");
  if (!btn) return;
  btn.disabled = false;
  if (!btn.classList.contains("is-flashing")) btn.textContent = HEARTBEAT_LABEL;
}

async function triggerHeartbeat() {
  const btn = document.getElementById("hb-btn");
  btn.disabled = true; btn.textContent = "Starting…";
  addLogLine({ taskId: "system", stage: "manual", line: "Heartbeat triggered by user" });
  let failure = null;
  try {
    failure = await failureOf(await fetch("/api/heartbeat", { method: "POST" }));
  } catch(e) {
    failure = e.message;
  }
  if (failure) {
    resetHeartbeatButton();
    addLogLine({ taskId: "system", stage: "error", line: "Heartbeat failed: " + failure });
    flashButton(btn, "Heartbeat failed", true, HEARTBEAT_LABEL, failure);
    return;
  }
  clearTimeout(heartbeatStartTimer);
  heartbeatStartTimer = setTimeout(function() {
    const reason = "The daemon accepted the request but no heartbeat started within "
      + (HEARTBEAT_START_TIMEOUT_MS / 1000) + "s. One may already be running.";
    resetHeartbeatButton();
    addLogLine({ taskId: "system", stage: "error", line: "Heartbeat: no response. " + reason });
    flashButton(btn, "No response", true, HEARTBEAT_LABEL, reason);
  }, HEARTBEAT_START_TIMEOUT_MS);
}

// Switching the default provider re-routes every agent, so, like Thinking,
// picking one only stages it; a confirm button beside the select applies it.
let providerStageTimer = null;
function stageProvider(value) {
  const select = document.getElementById("provider-select");
  const confirmBtn = document.getElementById("provider-confirm");
  clearTimeout(providerStageTimer);
  if (value === (select.dataset.applied || "")) {
    confirmBtn.hidden = true;
    return;
  }
  confirmBtn.textContent = "Switch fleet to " + select.options[select.selectedIndex].textContent + "?";
  confirmBtn.hidden = false;
  providerStageTimer = setTimeout(function() {
    confirmBtn.hidden = true;
    select.value = select.dataset.applied || "";
  }, 6000);
}

function confirmProvider() {
  clearTimeout(providerStageTimer);
  document.getElementById("provider-confirm").hidden = true;
  applyProvider(document.getElementById("provider-select").value);
}

async function applyProvider(provider) {
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
    const select = document.getElementById("provider-select");
    select.value = select.dataset.applied || "";
  }
}

async function fetchReasoningEffort() {
  try {
    const res = await fetch("/api/reasoning-effort");
    if (!res.ok) return;
    const data = await res.json();
    const select = document.getElementById("reasoning-effort");
    select.value = data.effort || "";
    select.dataset.applied = select.value;
  } catch {}
}

// A select cannot be armed like a button, so picking a value stages it and
// a confirm button beside it applies it. Left alone, the stage lapses and
// the select returns to what the fleet is actually using.
let effortStageTimer = null;
function stageReasoningEffort(value) {
  const select = document.getElementById("reasoning-effort");
  const confirmBtn = document.getElementById("effort-confirm");
  clearTimeout(effortStageTimer);
  if (value === (select.dataset.applied || "")) {
    confirmBtn.hidden = true;
    return;
  }
  const label = select.options[select.selectedIndex].textContent;
  confirmBtn.textContent = "Set fleet to " + label + "?";
  confirmBtn.hidden = false;
  effortStageTimer = setTimeout(function() {
    confirmBtn.hidden = true;
    select.value = select.dataset.applied || "";
  }, 6000);
}

function confirmReasoningEffort() {
  clearTimeout(effortStageTimer);
  document.getElementById("effort-confirm").hidden = true;
  setReasoningEffort(document.getElementById("reasoning-effort").value);
}

async function setReasoningEffort(value) {
  const select = document.getElementById("reasoning-effort");
  select.disabled = true;
  try {
    const res = await fetch("/api/reasoning-effort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort: value || null })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to update thinking effort");
    select.dataset.applied = data.effort || "";
    addLogLine({ taskId: "system", stage: "reasoning", line: "Thinking effort set to " + (data.effort || "default") });
  } catch (e) {
    addLogLine({ taskId: "system", stage: "error", line: "Thinking effort update failed: " + e.message });
    await fetchReasoningEffort();
  } finally {
    select.disabled = false;
  }
}

// ---- PR Processor trigger ----
async function triggerPRProcessor() {
  const btn = document.getElementById("pr-proc-btn");
  btn.disabled = true; btn.textContent = "Starting…";
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
      btn.textContent = "PR review";
    }, 3000);
  } catch(e) {
    addLogLine({ taskId: "system", stage: "error", line: "PR Processor failed: " + e.message });
    btn.disabled = false; btn.textContent = "PR review";
  }
}

// ---- Restart stuck issues ----
async function restartStuckIssues() {
  const btn = document.getElementById("restart-stuck-btn");
  // Two-step, in the page: the first click says what the second will do.
  if (!btn.classList.contains("is-armed")) {
    btn.classList.add("is-armed", "btn-danger");
    btn.textContent = "Move every one to Todo?";
    setTimeout(function() {
      if (btn.classList.contains("is-armed") && !btn.disabled) {
        btn.classList.remove("is-armed", "btn-danger"); btn.textContent = "Move all to Todo";
      }
    }, 6000);
    return;
  }
  btn.classList.remove("is-armed", "btn-danger");
  btn.disabled = true;
  btn.textContent = "Moving…";

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
  btn.textContent = "Move all to Todo";
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
  if (!projects.length) { el.innerHTML = "<div class=\"empty\">no repositories</div>"; return; }
  const on = projects.filter(p => p.enabled).length;
  if (sumEl) sumEl.textContent = "config · " + on + " of " + projects.length + " enabled";

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
      prsHtml = "<div class=\"proj-issues\">" +
        "<div class=\"issue-sec-label\">open PRs (" + p.prs.length + ")</div>" +
        p.prs.map(function(pr) {
          return "<div class=\"pr-row\">" +
            "<span class=\"pr-num\">#" + pr.number + "</span>" +
            "<span class=\"pr-branch\" title=\"" + escapeAttr(pr.branch) + "\">" + escapeHtml(pr.branch) + "</span>" +
            "<span class=\"pr-title\" title=\"" + escapeAttr(pr.title) + "\">" + escapeHtml(pr.title) + "</span>" +
            "<span class=\"pr-age\">" + fmtAge(pr.updatedAt) + "</span>" +
          "</div>";
        }).join("") +
      "</div>";
    }
    let issuesHtml = "";
    if (expanded) {
      const secs = [];
      if (p.running.length) secs.push(
        "<div class=\"issue-sec-label\">running</div>" +
        p.running.map(t => issueRow(t, "idot-run")).join("")
      );
      if (p.queued.length) secs.push(
        "<div class=\"issue-sec-label\">queued</div>" +
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
            "<div class=\"issue-sec-label\">" + sn.toLowerCase() + " (" + byState[sn].length + ")</div>" +
            byState[sn].map(t => issueRow(t, "idot-pnd")).join("")
          );
        }
        var otherKeys = Object.keys(byState);
        for (var oi = 0; oi < otherKeys.length; oi++) {
          if (stateOrder.indexOf(otherKeys[oi]) === -1) {
            secs.push(
              "<div class=\"issue-sec-label\">" + otherKeys[oi].toLowerCase() + " (" + byState[otherKeys[oi]].length + ")</div>" +
              byState[otherKeys[oi]].map(t => issueRow(t, "idot-pnd")).join("")
            );
          }
        }
      }
      if (!secs.length) secs.push("<div class=\"empty\" style=\"padding:4px\">no issues</div>");
      // Knowledge graph health info (if cached)
      var kgData = knowledgeCache[p.name] || knowledgeCache[p.path];
      if (kgData && kgData.summary) {
        var s = kgData.summary;
        secs.push(
          "<div class=\"issue-sec-label\">code health</div>" +
          "<div style=\"padding:2px 8px;font-size:12px;color:var(--fg-muted)\">" +
            "modules:" + s.totalModules + " tests:" + s.totalTestFiles +
            " untested:" + s.untestedModules.length +
            " churn:" + (s.avgChurnScore || 0).toFixed(2) +
            (s.hotModules.length ? " hot:" + s.hotModules.slice(0,3).map(function(m){return escapeHtml(m.split("/").pop())}).join(",") : "") +
          "</div>"
        );
      }
      issuesHtml = "<div class=\"proj-issues\">" + secs.join("") + "</div>";
    }

    return (
      "<div class=\"proj-card" + dCls + eCls + "\" data-key=\"" + escapeAttr(key) + "\">" +
      "<div class=\"proj-hdr\" data-key=\"" + escapeAttr(key) + "\" onclick=\"handleToggleExpand(this)\">" +
        "<span class=\"proj-arrow\"></span>" +
        "<div class=\"proj-info\">" +
          "<div class=\"proj-name\">" + escapeHtml(p.name) + "</div>" +
          "<div class=\"proj-path\">" + escapeHtml(p.path) + "</div>" +
          (p.git ? "<div class=\"git-info\">" +
            "\u2387 <span class=\"git-branch-name\">" + escapeHtml(p.git.branch) + "</span>" +
            (p.git.hasChanges ? " <span class=\"git-dirty\">\u25CF " + p.git.uncommittedFiles + "</span>" : "") +
            ((p.git.ahead || p.git.behind) ? " <span class=\"git-sync\">" +
              (p.git.ahead ? "\u2191" + p.git.ahead : "") +
              (p.git.behind ? " \u2193" + p.git.behind : "") +
            "</span>" : "") +
          "</div>" : "") +
        "</div>" +
        "<div class=\"proj-counts\">" +
          (p.running.length ? "<span class=\"cnt cnt-run\">" + p.running.length + "r</span>" : "") +
          (p.queued.length  ? "<span class=\"cnt cnt-que\">" + p.queued.length  + "q</span>" : "") +
          (p.pending.length ? "<span class=\"cnt cnt-pnd\">" + p.pending.length + "p</span>" : "") +
        "</div>" +
        "<div class=\"proj-toggle\" onclick=\"event.stopPropagation()\" style=\"display:flex;align-items:center;gap:4px\">" +
          "<button class=\"btn\" style=\"font-size:11px;padding:1px 4px;opacity:.5\" data-path=\"" + escapeAttr(p.path) + "\" onclick=\"handleUnpin(this)\">✕</button>" +
          "<label class=\"toggle\">" +
            "<input type=\"checkbox\" " + checked + " data-path=\"" + escapeAttr(p.path) + "\" onchange=\"handleToggleProject(this)\">" +
            "<span class=\"slider\"></span>" +
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
    ? "<button class=\"move-to-todo-btn\" data-issue-id=\"" + escapeAttr(t.linearId) + "\" onclick=\"handleMoveToTodo(this)\">→ Todo</button>"
    : "";
  return (
    "<div class=\"issue-row" + extraCls + "\">" +
    "<span class=\"idot " + dotClass + "\"></span>" +
    "<span class=\"prio prio-" + Math.min(4, prio) + "\"></span>" +
    (t.issueIdentifier ? "<span class=\"issue-id\">" + escapeHtml(t.issueIdentifier) + "</span>" : "") +
    "<span class=\"issue-title\" title=\"" + escapeAttr(t.title) + "\">" + escapeHtml(t.title) + "</span>" +
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
const TOKEN_MILLION = 1000000;
const TOKEN_THOUSAND = 1000;
function fmtTokens(n) {
  if (n == null) return "";
  if (n >= TOKEN_MILLION) return (n / 1000000).toFixed(1) + "M";
  if (n >= TOKEN_THOUSAND) return (n / 1000).toFixed(1) + "k";
  return String(n);
}
function buildStageDetails(r) {
  // Builds the expanded "what did the worker actually do" panel for
  // a pipeline:stage payload. Returns "" when there's nothing to show.
  const lines = [];
  function addLine(key, valHtml) {
    lines.push(
      "<div class=\"sd-line\"><div class=\"sd-key\">" + escapeHtml(key) + "</div>" +
      "<div class=\"sd-val\">" + valHtml + "</div></div>"
    );
  }
  function addList(key, items) {
    const ul = items.map(function(s) { return "<li>" + escapeHtml(String(s)) + "</li>"; }).join("");
    lines.push(
      "<div class=\"sd-line\"><div class=\"sd-key\">" + escapeHtml(key) + "</div>" +
      "<div class=\"sd-val\"><ul>" + ul + "</ul></div></div>"
    );
  }

  if (r.summary) addLine("Summary", escapeHtml(r.summary));
  if (r.decision) {
    const cls = "sd-decision-" + safeCssClass(r.decision);
    addLine("Decision", "<span class=\"" + cls + "\">" + escapeHtml(r.decision.toUpperCase()) + "</span>");
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
    addLine("Error", "<span style=\"color:var(--danger)\">" + escapeHtml(r.error) + "</span>");
  }
  return lines.join("");
}

function toggleStageDetails(idx) {
  const block = document.querySelector("[data-stage-idx=\"" + idx + "\"]");
  if (block) block.classList.toggle("expanded");
}

function renderStages() {
  const el = document.getElementById("stage-list");
  const cnt = document.getElementById("stage-count");
  if (!stageRows.length) { el.innerHTML = "<div class=\"empty\">no pipeline events</div>"; return; }
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
      const cls = "sd-decision-" + safeCssClass(r.decision);
      inlineSummary = "<span class=\"" + cls + "\">" + escapeHtml(r.decision.toUpperCase()) + "</span>" +
        (r.feedback ? " · " + escapeHtml(r.feedback.slice(0, 80)) : "");
    } else if (r.summary) {
      inlineSummary = escapeHtml(r.summary);
      if (r.filesChangedCount > 0) inlineSummary += " · " + r.filesChangedCount + " files";
    } else if (r.passed != null || r.failed != null) {
      inlineSummary = "✓ " + (r.passed || 0) + "  ✗ " + (r.failed || 0);
    } else if (r.error) {
      inlineSummary = "<span style=\"color:var(--danger)\">" + escapeHtml(r.error.slice(0, 120)) + "</span>";
    }

    const detailsHtml = buildStageDetails(r);
    const hasDetails = detailsHtml.length > 0;
    const rowClass = "stage-row" + (hasDetails ? " has-details" : "");
    const onclick = hasDetails ? " onclick=\"toggleStageDetails(" + i + ")\"" : "";

    return (
      "<div class=\"stage-block\" data-stage-idx=\"" + i + "\">" +
        "<div class=\"" + rowClass + "\"" + onclick + ">" +
          "<div class=\"sdot " + escapeAttr(r.status || "") + "\"></div>" +
          "<div class=\"srepo\">" + escapeHtml(repoName) + "</div>" +
          "<div class=\"sname\">" + escapeHtml(r.stage) + "</div>" +
          "<div class=\"stask\" title=\"" + escapeAttr(r.taskId || "") + "\">" + escapeHtml(taskLabel) + "</div>" +
          "<div class=\"ssummary\">" + inlineSummary + "</div>" +
          "<div class=\"smodel\">" + escapeHtml(modelStr) + "</div>" +
          "<div class=\"stokens\">" + escapeHtml(tokenStr) + "</div>" +
          "<div class=\"selapsed\">" + elapsed + "</div>" +
          "<div class=\"sstatus\">" + escapeHtml(r.status || "") + "</div>" +
        "</div>" +
        (hasDetails ? "<div class=\"stage-details\">" + detailsHtml + "</div>" : "") +
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
    + '" data-task="all" onclick="selectLogTab(null)">All</button>';

  for (const tid of taskIds) {
    const info = taskTitleMap.get(tid);
    const label = info?.issueIdentifier || tid.slice(0, 8);
    const isActive = selectedLogTaskId === tid;
    html += '<button class="log-tab' + (isActive ? ' active' : '')
      + '" data-task="' + tid + '" onclick="selectLogTab(\'' + tid + '\')">'
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
  if (/Cost:|\$[\.0-9]/.test(line)) return { cls: "", icon: "💲" };
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
        raw = "\u2713 No decomposition needed (" + (obj.totalEstimatedMinutes || "?") + "min) " + r;
      } else if (obj.needsDecomposition === true && obj.subTasks) {
        raw = "\uD83D\uDD00 Decomposed into " + obj.subTasks.length + " sub-tasks (total " + (obj.totalEstimatedMinutes || "?") + "min)";
      } else if (obj.success !== undefined) {
        raw = (obj.success ? "\u2713 " : "\u2717 ") + (obj.summary || obj.error || JSON.stringify(obj).slice(0, 120));
      }
    } catch { /* not valid JSON */ }
  }
  let t = escapeHtml(raw);
  // inline bold: **text** → highlighted
  t = t.replace(/\*\*([^*]+)\*\*/g, '<span class="lhighlight">$1</span>');
  // highlight cost figures
  t = t.replace(/(\$[\d.]+)/g, '<span class="lcost">$1</span>');
  // highlight file counts
  t = t.replace(/(\d+ files? changed)/g, '<span class="lfiles">$1</span>');
  // highlight durations
  t = t.replace(/(\d+\.\d+s|\d+ms)/g, '<span class="lcost">$1</span>');
  // highlight task titles in quotes
  t = t.replace(/(&quot;[^&]+&quot;)/g, '<span class="lhighlight">$1</span>');
  // highlight issue identifiers
  t = t.replace(/(INT-\d+)/g, '<span class="lhighlight">$1</span>');
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
    el.innerHTML = "<div class=\"empty\">" + (selectedLogTaskId ? "no logs for this task" : "no log output") + "</div>";
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
    if (cls === "log-spacer") return "<div class=\"log-line log-spacer\"></div>";
    if (cls === "log-separator") return "<div class=\"log-line log-separator\"><span class=\"ltext\">───────────────────</span></div>";
    const time = fmtLogTime(l._ts);
    const stage = l.stage && l.stage !== "heartbeat" ? l.stage : "";
    // heading2: strip ■ prefix (icon handles it)
    const displayLine = cls === "log-heading2" ? (l.line || "").replace(/^■ /, "") : l.line;
    // tool: strip ▸ prefix
    const displayLine2 = cls === "log-tool" ? (displayLine || "").replace(/^▸ /, "") : displayLine;
    return (
      "<div class=\"log-line " + cls + "\">" +
      "<span class=\"ltime\">" + time + "</span>" +
      "<span class=\"licon\">" + icon + "</span>" +
      "<span class=\"ltag\" title=\"" + escapeAttr(l.taskId || "") + "\">" + escapeHtml(tag) + "</span>" +
      (stage ? "<span class=\"lstage\">" + escapeHtml(stage) + "</span>" : "") +
      "<span class=\"ltext\">" + formatLogText(displayLine2) + "</span>" +
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
    ? "<span class=\"chat-prefix\">YOU &gt;</span>"
    : "<span class=\"chat-prefix\">OpenSwarm&gt;</span>";
  const tsStr = ts ? "<span class=\"chat-ts\">" + fmtTime(ts) + "</span>" : "";
  line.innerHTML = prefix + " <span class=\"chat-text\">" + escapeHtml(text) + "</span>" + tsStr;
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
  thinkEl.innerHTML = "<span class=\"chat-prefix\">OpenSwarm&gt;</span> <span class=\"chat-text chat-thinking\">thinking...</span>";
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
function safeCssClass(text) {
  const cleaned = String(text || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  // Never emit an empty class token: "sd-decision-" + "" would produce a
  // dangling selector prefix that can match unintended elements.
  return cleaned.length > 0 ? cleaned : "_";
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
        "<button class=\"scan-path-remove\" title=\"remove\" onclick=\"removeScanPath(" + escapeJsArgAttr(p) + ")\">✕</button>" +
      "</div>"
    );
  }
  for (const p of (data.customPaths || [])) {
    rows.push(
      "<div class=\"scan-path-row\">" +
        "<span class=\"path\">" + escapeHtml(p) + "</span>" +
        "<button class=\"scan-path-remove\" onclick=\"removeScanPath(" + escapeJsArgAttr(p) + ")\">✕</button>" +
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
        "<span style=\"color:var(--accent)\">📁</span>" +
        "<span>" + escapeHtml(e.name) + "</span>" +
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
    '<div style="padding:8px 6px;font-size:11px">' +
    '<div style="color:var(--fg-primary)"><b style="font-size:15px">' + Object.keys(agents).length + '</b> agents placed <span style="color:var(--fg-muted)">(' + roleLine + ')</span></div>' +
    '<div style="margin-top:4px;color:' + (questions > 0 ? 'var(--warning)' : 'var(--fg-muted)') + '">' + questions + ' question(s) waiting on you · ' + pending.length + ' open exchange(s)</div>' +
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
    // First pass: the data the page cannot render without.
    const [statsRes, projectsRes] = await Promise.all([
      fetch("/api/stats"),
      fetch("/api/projects"),
    ]);
    const stats = await statsRes.json();
    updateStats(stats);

    projects = await projectsRes.json();
    renderProjects();

    // Second pass: history, loaded after first paint so it never blocks it.
    loadSupplementalData();
  } catch(e) {
    console.error("Init failed:", e);
  }
}

// History (chat, log, stage events), loaded after first paint.
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

// Stats and projects change slowly; poll them once a minute.
setInterval(async () => {
  try {
    const [sRes, pRes] = await Promise.all([fetch("/api/stats"), fetch("/api/projects")]);
    const stats = await sRes.json();
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

// ---- Activity tabs: log or the raw stage events ----
document.querySelector(".activity-tabs").addEventListener("click", function(e) {
  const tab = e.target.closest(".activity-tab");
  if (!tab) return;
  document.querySelectorAll(".activity-tab").forEach(function(t) {
    const on = t === tab;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  });
});

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

/**
 * Fill the provider select from the live registry so it cannot drift from
 * isKnownAdapter / POST /api/provider validation (INT-3284). The registry
 * name is the label: "Codex-R" was a nickname nobody could look up.
 */
async function renderProviderOptions() {
  const select = document.getElementById("provider-select");
  if (!select) return;
  let providers = [];
  try {
    const res = await fetch("/api/providers");
    if (res.ok) providers = (await res.json()).providers ?? [];
  } catch {}
  select.replaceChildren(...providers.map(function(name) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    return option;
  }));
}

// ---- The board ----
const STAGE_CHAIN = [
  { key: "worker", label: "worker" },
  { key: "reviewer", label: "review" },
  { key: "tester", label: "test" },
  { key: "documenter", label: "docs" },
];

function fmtClock(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function fmtSince(ts) {
  if (!ts) return "";
  const min = Math.max(0, Math.floor((Date.now() - ts) / 60000));
  if (min < 60) return min + "m";
  return Math.floor(min / 60) + "h " + (min % 60) + "m";
}

function latestStageOf(taskId) {
  for (let i = stageRows.length - 1; i >= 0; i -= 1) {
    if (stageRows[i].taskId === taskId && STAGE_CHAIN.some(function(s) { return s.key === stageRows[i].stage; })) return stageRows[i];
  }
  return null;
}

function stageChain(current, failed) {
  const at = STAGE_CHAIN.findIndex(function(s) { return s.key === current; });
  if (at === -1) return current ? "<span class=\"stg now\">" + escapeHtml(current) + "</span>" : "";
  return STAGE_CHAIN.map(function(s, i) {
    const cls = i < at ? "stg done" : i === at ? "stg now" + (failed ? " is-failed" : "") : "stg";
    return "<span class=\"" + cls + "\">" + s.label + "</span>";
  }).join("");
}

function recordEndedRun(data) {
  if (!data || !data.taskId) return;
  const info = taskTitleMap.get(data.taskId) || {};
  const last = latestStageOf(data.taskId);
  const at = endedRuns.findIndex(function(r) { return r.taskId === data.taskId; });
  if (at !== -1) endedRuns.splice(at, 1);
  endedRuns.unshift({
    taskId: data.taskId,
    identifier: info.issueIdentifier,
    title: info.title,
    projectPath: taskProjectMap.get(data.taskId),
    startedAt: taskStartMap.get(data.taskId) || (data.duration ? Date.now() - data.duration : null),
    endedAt: Date.now(),
    success: data.success !== false,
    stage: last ? last.stage : null,
    model: last ? last.model : null,
  });
  endedRuns.length = Math.min(endedRuns.length, MAX_ENDED);
  renderBoard();
}

let tasksRefreshTimer = null;
function scheduleTasksRefresh() {
  clearTimeout(tasksRefreshTimer);
  tasksRefreshTimer = setTimeout(fetchTasks, 400);
}

async function fetchTasks() {
  try {
    const res = await fetch("/api/tasks");
    if (!res.ok) return;
    const data = await res.json();
    boardTasks = { running: data.running || [], queued: data.queued || [] };
    for (const r of boardTasks.running) {
      if (r.task && r.task.id && r.startedAt) taskStartMap.set(r.task.id, r.startedAt);
    }
    renderBoard();
  } catch {}
}

function renderBoardSource() {
  setText("board-src", "scheduler · " + (streamLive ? "live" : "updates paused, reconnecting"));
}

function boardRow(row) {
  const repo = row.projectPath ? row.projectPath.split("/").pop() : "";
  const agent = row.model ? escapeHtml(row.agent || "") + "<span class=\"sub\">" + (row.agent ? " · " : "") + escapeHtml(shortModel(row.model)) + "</span>" : escapeHtml(row.agent || "");
  return "<tr class=\"" + row.cls + "\">" +
    "<td class=\"c-time\">" + escapeHtml(fmtClock(row.startedAt)) + "</td>" +
    "<td class=\"c-run mono\">" + escapeHtml(row.identifier || (row.taskId || "").slice(0, 8)) + "</td>" +
    "<td class=\"c-title\" title=\"" + escapeAttr(row.title || "") + "\">" + escapeHtml(row.title || "") + "</td>" +
    "<td class=\"c-repo\">" + escapeHtml(repo) + "</td>" +
    "<td class=\"c-agent\">" + agent + "</td>" +
    "<td class=\"c-stage\">" + row.stage + "</td>" +
    "<td class=\"c-status\">" + row.status + "</td>" +
  "</tr>";
}

function renderBoard() {
  const body = document.getElementById("board-rows");
  if (!body) return;
  const rows = [];
  for (const r of boardTasks.running) {
    const t = r.task || {};
    const last = latestStageOf(t.id);
    const stage = r.stage || (last && last.stage) || "";
    rows.push({
      cls: "is-running", taskId: t.id, identifier: t.issueIdentifier, title: t.title,
      projectPath: r.projectPath, startedAt: r.startedAt, agent: stage, model: last && last.model,
      stage: stageChain(stage, false),
      status: "<span class=\"st\">Running · " + fmtSince(r.startedAt) + "</span>",
    });
  }
  for (const q of boardTasks.queued) {
    const t = q.task || {};
    rows.push({
      cls: "is-queued", taskId: t.id, identifier: t.issueIdentifier, title: t.title,
      projectPath: q.projectPath, startedAt: null, agent: "", model: null, stage: "",
      status: "<span class=\"st st-quiet\">Queued · " + fmtSince(q.queuedAt) + "</span>",
    });
  }
  for (const e of endedRuns) {
    rows.push({
      cls: e.success ? "is-done" : "is-failed", taskId: e.taskId, identifier: e.identifier, title: e.title,
      projectPath: e.projectPath, startedAt: e.startedAt, agent: e.stage, model: e.model,
      stage: stageChain(e.stage, !e.success),
      status: e.success
        ? "<span class=\"st st-quiet\">Done " + escapeHtml(fmtClock(e.endedAt)) + "</span>"
        : "<span class=\"tag-failed\">Failed</span>",
    });
  }
  body.innerHTML = rows.map(boardRow).join("");
  document.getElementById("board-empty").hidden = rows.length > 0;
  const failedCount = endedRuns.filter(function(e) { return !e.success; }).length;
  setText("stat-failed", failedCount);
  document.querySelector(".k-failed").classList.toggle("has-value", failedCount > 0);
}

// ---- The notice band: what waits on the operator ----
let stuckData = { stuckIssues: [], failedIssues: [] };

async function fetchShellStatus() {
  try {
    const res = await fetch("/api/shell-status");
    if (!res.ok) return;
    shellStatus = await res.json();
    renderNotice();
  } catch {}
}

function openQuestions() {
  const latest = {};
  coordinationById.forEach(function(ev) {
    const prev = latest[ev.correlationId];
    if (!prev || Number(ev.seq || 0) > Number(prev.seq || 0)) latest[ev.correlationId] = ev;
  });
  return Object.values(latest).filter(function(ev) {
    return ev.kind === "human-question" && ["open", "waiting", "running"].includes(ev.status);
  });
}

function renderNotice() {
  const band = document.getElementById("notice");
  if (!band) return;
  const questions = openQuestions();
  // Prefer the shell's counts so the band and the status line agree; fall
  // back to the board's own questions until the first poll answers.
  const needs = shellStatus && shellStatus.needsYou
    ? shellStatus.needsYou
    : { questions: questions.length, parked: 0, total: questions.length };
  const trackerCount = (stuckData.stuckIssues || []).length + (stuckData.failedIssues || []).length;
  setText("stat-needs", needs.total);
  document.querySelector(".k-needs").classList.toggle("has-value", needs.total > 0);
  band.hidden = needs.total === 0 && trackerCount === 0;
  setText("notice-title", needs.total === 0 ? "Nothing waits on you" : needs.total + (needs.total === 1 ? " needs you" : " need you"));
  const parts = [];
  if (needs.questions) parts.push(needs.questions + " question" + (needs.questions === 1 ? "" : "s"));
  if (needs.parked) parts.push(needs.parked + " parked run" + (needs.parked === 1 ? "" : "s"));
  setText("notice-breakdown", parts.join(" · "));
  let html = questions.map(function(q) {
    const repo = q.repository ? q.repository.split("/").pop() : "";
    const who = (q.actorName || q.actor || "agent") + (q.actorRole ? " (" + q.actorRole + ")" : "");
    return "<div class=\"nrow\">" +
      "<span class=\"tag tag-q\">Question</span>" +
      "<span class=\"mono\">" + escapeHtml(q.taskLabel || (q.taskId || "").slice(0, 8)) + "</span>" +
      "<span class=\"nrow-repo\">" + escapeHtml(repo) + "</span>" +
      "<span class=\"msg\">" + escapeHtml(who) + ": " + escapeHtml(q.summary || "") + "</span>" +
      "<span class=\"when\">waiting " + fmtSince(q.timestamp) + "</span>" +
      "<span class=\"acts\"><a class=\"nb\" href=\"/chat\">Answer in Chat</a></span>" +
    "</div>";
  }).join("");
  if (needs.parked) {
    html += "<div class=\"nrow\">" +
      "<span class=\"tag tag-q\">Parked</span>" +
      "<span class=\"msg nrow-wide\">" + needs.parked + (needs.parked === 1 ? " run is" : " runs are") + " parked until someone resolves " + (needs.parked === 1 ? "it" : "them") + ".</span>" +
      "<span class=\"acts\"><a class=\"nb\" href=\"/orchestration\">Open orchestration</a></span>" +
    "</div>";
  }
  document.getElementById("notice-rows").innerHTML = html;
  document.getElementById("notice-tracker").hidden = trackerCount === 0;
}

// Load in two passes so nothing blocks the first render.
// The provider options exist before the first stats render selects the default.
renderProviderOptions().then(loadInitial).then(function() { connectSSE(true); });
renderBoardSource();
fetchTasks();
fetchShellStatus();
setInterval(fetchTasks, 5000);
setInterval(fetchShellStatus, 15000);

// Polling that starts right away.
setInterval(fetchSvcStatus, 15000);
setInterval(fetchPRProcessorStatus, 60000);  // changes rarely
setInterval(fetchStuckIssues, 60000);        // every call is a tracker API query
setInterval(fetchKnowledgeData, 60000);
setInterval(fetchMonitors, 60000);
setInterval(fetchProcesses, 30000);
setInterval(fetchCoordination, 30000);

// Secondary panels, three seconds after load.
setTimeout(function() {
  fetchSvcStatus();
  fetchPRProcessorStatus();
  fetchStuckIssues();
  fetchKnowledgeData();
  fetchMonitors();
  fetchProcesses();
  fetchReasoningEffort();
}, 3000);

// Stage rows update from the event stream; there is no stage poll.
// setInterval(() => { if (stageRows.length) renderStages(); }, 10000);
