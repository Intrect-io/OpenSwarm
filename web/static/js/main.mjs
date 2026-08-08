// Board bootstrap: wire modules together. (INT-3388)

import { api } from './api.mjs';
import { EventStream } from './events.mjs';
import { RepoPicker } from './repoPicker.mjs';
import { IssueBoard } from './issueBoard.mjs';
import { WorkCards } from './workCards.mjs';

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

const workCards = new WorkCards(document.getElementById('work-cards'));

const board = new IssueBoard({
  listEl: document.getElementById('issue-list'),
  countEl: document.getElementById('issue-count'),
  summaryEl: document.getElementById('selection-summary'),
  deployBtn: document.getElementById('deploy-btn'),
  fetchIssues: (path) => api.workIssues(path),
  dispatch: (path, issueIds) => api.dispatchWork(path, issueIds),
});

const picker = new RepoPicker(document.getElementById('repo-picker'), {
  onSelect: (path) => board.loadFor(path),
});

const events = new EventStream();
events
  .on('pipeline:stage', (data) => workCards.onStage(data))
  .on('log', (data) => workCards.onLog(data))
  .on('$open', () => pollHealth())
  .on('$down', () => setDaemonStatus('down', 'reconnecting…'));
// Connect immediately — delaying SSE behind the snapshot fetch opened a
// live-output blind window. Ordering against the async stage snapshot does
// not matter: log lines that arrive before their card exists are parked in
// WorkCards' bounded pending buffer and flushed when the card materializes.
events.connect();

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
})();
