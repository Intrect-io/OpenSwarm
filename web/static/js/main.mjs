// Cockpit bootstrap: wire modules together. Wiring only — behavior lives in
// the modules so it stays testable. (INT-3388, cockpit shell INT-3402)

import { api } from './api.mjs';
import { EventStream } from './events.mjs';
import { RepoPicker } from './repoPicker.mjs';
import { IssueBoard } from './issueBoard.mjs';
import { WorkCards } from './workCards.mjs';
import { QuotaGauge } from './quotaGauge.mjs';
import { SessionStore } from './sessionStore.mjs';
import { TranscriptModel } from './transcriptModel.mjs';
import { TranscriptView } from './transcriptView.mjs';
import { SessionTree } from './sessionTree.mjs';
import { SessionPanel } from './sessionPanel.mjs';
import { DiffPanel } from './diffPanel.mjs';
import { Nav } from './nav.mjs';
import { resolveSelection } from './sessionSelection.mjs';

const statusDot = document.querySelector('#daemon-status .dot');
const statusLabel = document.querySelector('#daemon-status .label');

function setDaemonStatus(state, label) {
  statusDot.dataset.state = state;
  statusLabel.textContent = label;
}

async function pollHealth() {
  try {
    const health = await api.health();
    setDaemonStatus('ok', `daemon v${health.backend_version}`);
  } catch {
    setDaemonStatus('down', 'daemon unreachable');
  }
}

// ── Models ─────────────────────────────────────────────────────────────

const sessions = new SessionStore();
const transcripts = new TranscriptModel();

// ── Views ──────────────────────────────────────────────────────────────

const workCards = new WorkCards(document.getElementById('work-cards'));

const nav = new Nav({
  buttons: [...document.querySelectorAll('.nav-item')],
});

const transcriptEl = document.createElement('div');
transcriptEl.className = 'transcript';
const transcriptView = new TranscriptView(transcriptEl, { model: transcripts });

const diffEl = document.createElement('div');
diffEl.className = 'diff-pane';
diffEl.hidden = true;
const diffPanel = new DiffPanel(diffEl, { fetchDiff: (taskId) => api.workDiff(taskId) });

const sessionPanel = new SessionPanel(document.getElementById('session-body'), {
  store: sessions,
  transcripts,
  transcriptView,
  diffPanel,
  fetchLog: (taskId) => api.sessionLog(taskId),
});

const sessionTree = new SessionTree(document.getElementById('session-tree'), {
  store: sessions,
  // The hash is the single source of selection — clicking navigates, and the
  // nav 'change' handler below does the actual showing.
  onSelect: (taskId) => nav.show('sessions', taskId),
});

const sessionCount = document.getElementById('session-count');
sessions.addEventListener('change', () => {
  const running = sessions.list().filter((s) => s.phase === 'running').length;
  const total = sessions.list().length;
  sessionCount.textContent = total ? `${running} running · ${total} total` : '';
});

// True once GET /api/work/sessions has answered — until then an unknown deep
// link is "not loaded yet", not "does not exist".
let sessionSnapshotLoaded = false;

function showSelectedSession(taskId) {
  sessionTree.select(taskId);
  const choice = resolveSelection({
    hashTaskId: taskId,
    sessions: sessions.list(),
    snapshotLoaded: sessionSnapshotLoaded,
  });
  if (choice.taskId) void sessionPanel.show(choice.taskId);
  else sessionPanel.showEmpty(choice.message);
}

/** Re-ask the selection question with whatever is known now. */
function reconcileSelection() {
  const { view, taskId } = nav.current;
  if (view === 'sessions') showSelectedSession(taskId);
}

nav.addEventListener('change', (event) => {
  if (event.detail.view === 'sessions') showSelectedSession(event.detail.taskId);
});

// Deploy → follow the work: switch to Sessions and open the first session
// this dispatch produces. Bounded so a session started much later by someone
// else never hijacks the view.
const DEPLOY_FOLLOW_WINDOW_MS = 120_000;
let pendingDeploy = null;

function followDeployedSession(session) {
  if (!pendingDeploy) return false;
  if (session.projectPath && session.projectPath !== pendingDeploy.projectPath) return false;
  if (Date.now() - pendingDeploy.at > DEPLOY_FOLLOW_WINDOW_MS) {
    pendingDeploy = null;
    return false;
  }
  pendingDeploy = null;
  nav.show('sessions', session.taskId);
  return true;
}

sessions.addEventListener('session:new', (event) => {
  const session = event.detail.session;
  if (followDeployedSession(session)) return;
  const { view, taskId } = nav.current;
  if (view !== 'sessions') return;
  // The deep-linked session may only now have appeared, or the view may be
  // sitting on the placeholder with nothing selected — either way, re-ask.
  if (session.taskId === taskId || !sessionPanel.taskId) reconcileSelection();
});

const board = new IssueBoard({
  listEl: document.getElementById('issue-list'),
  countEl: document.getElementById('issue-count'),
  summaryEl: document.getElementById('selection-summary'),
  deployBtn: document.getElementById('deploy-btn'),
  fetchIssues: (path) => api.workIssues(path),
  dispatch: async (path, issueIds) => {
    const result = await api.dispatchWork(path, issueIds);
    if (result?.queued) {
      pendingDeploy = { projectPath: path, at: Date.now() };
      // The daemon may have queued and broadcast before this response landed,
      // so the session:new for our own dispatch can already be behind us —
      // arming alone would wait for an event that never comes again.
      const dispatched = new Set(result.items?.filter((i) => i.status === 'queued').map((i) => i.issueId));
      const existing = sessions.byProject(path).find((s) => dispatched.has(s.taskId));
      if (existing) followDeployedSession(existing);
    }
    return result;
  },
});

const picker = new RepoPicker(document.getElementById('repo-picker'), {
  onSelect: (path) => {
    board.loadFor(path);
    nav.show('issues');
  },
});

// ── Live stream ────────────────────────────────────────────────────────

const events = new EventStream();
events
  .on('pipeline:stage', (data) => {
    workCards.onStage(data);
    sessions.applyEvent('pipeline:stage', data);
  })
  .on('log', (data) => {
    workCards.onLog(data);
    transcripts.append(data.taskId, { stage: data.stage, line: data.line, ts: data.ts, seq: data.seq });
  })
  .on('task:queued', (data) => sessions.applyEvent('task:queued', data))
  .on('task:started', (data) => sessions.applyEvent('task:started', data))
  .on('task:completed', (data) => sessions.applyEvent('task:completed', data))
  .on('task:cost', (data) => sessions.applyEvent('task:cost', data))
  .on('pipeline:iteration', (data) => sessions.applyEvent('pipeline:iteration', data))
  .on('pipeline:escalation', (data) => sessions.applyEvent('pipeline:escalation', data))
  .on('$open', () => pollHealth())
  .on('$down', () => setDaemonStatus('down', 'reconnecting…'));
// Connect immediately — delaying SSE behind the snapshot fetch opened a
// live-output blind window. Ordering against the async stage snapshot does
// not matter: log lines that arrive before their card exists are parked in
// WorkCards' bounded pending buffer and flushed when the card materializes,
// and SessionStore's phase-rank guard makes replay idempotent.
events.connect();

// Independent of the bootstrap chain: a hanging /api/health request must not
// keep the gauge from ever starting. Usage windows move in hours, so a slow
// poll is plenty, and the gauge stays hidden until the daemon has actually
// observed a provider header.
new QuotaGauge(document.getElementById('quota-gauge'), { fetchQuota: () => api.quota() }).start();

nav.start();

(async () => {
  await pollHealth();
  setInterval(pollHealth, 10_000);
  try {
    // /api/work/projects mirrors dispatchWork's allow-list — every offered
    // path is dispatchable (unlike /api/local-projects, which scans children).
    await picker.load(() => api.workProjects());
  } catch (err) {
    console.error('Failed to load projects', err);
  }
  // Recover in-flight work from the stage snapshot. Stage events are folded
  // idempotently, so replaying them on top of the SSE replay is harmless.
  //
  // Console history deliberately has NO snapshot pass of its own: the SSE
  // replay is the single source for console recovery — fewer lines than
  // /api/logs would carry, but each line exactly once (no duplication).
  try {
    const stages = await api.stages();
    workCards.seed(Array.isArray(stages) ? stages : stages?.stages);
  } catch {
    // stage snapshot is best-effort — SSE replay still seeds recent cards
  }
  // Authoritative session list (null on a daemon that predates the endpoint,
  // in which case the SSE-derived state above is all we have).
  try {
    sessions.seed(await api.workSessions());
  } catch (err) {
    console.error('Failed to load sessions', err);
  } finally {
    // The hash was read before this answered: a deep link to a session the
    // store did not know yet showed a placeholder, and an empty view never
    // adopted the newly-known sessions. Ask again now.
    sessionSnapshotLoaded = true;
    reconcileSelection();
  }
})();
