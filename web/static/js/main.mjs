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
  .on('$open', () => pollHealth())
  .on('$down', () => setDaemonStatus('down', 'reconnecting…'));
events.connect();

(async () => {
  await pollHealth();
  setInterval(pollHealth, 10_000);
  try {
    await picker.load(() => api.localProjects());
  } catch (err) {
    console.error('Failed to load projects', err);
  }
  // Recover in-flight work after a reload from the stage replay buffer.
  try {
    const stages = await api.stages();
    workCards.seed(Array.isArray(stages) ? stages : stages?.stages);
  } catch {
    // stage snapshot is best-effort
  }
})();
