// ============================================
// OpenSwarm - Monitor row mappers (EPIC INT-1813 S6 / INT-1939)
// Pure daemon-JSON → table mappers for the Projects/Tasks/Stuck/Issues tabs.
// No React/ink/network — unit-tested. DataTable renders the {columns, rows}.
// ============================================

export interface Table {
  columns: string[];
  rows: string[][];
  /** One line above the table, e.g. the daemon's work scope on the Projects tab. */
  caption?: string;
}

/** The Projects tab caption: what the daemon may pick from (AGT-3188). Unknown when the daemon did not say. */
export function workScopeCaption(scope: { milestone?: string | null; matched?: boolean } | null | undefined): string {
  if (scope === undefined || scope === null) return 'Work scope: unknown';
  if (!scope.milestone) return 'Work scope: all issues in the allowed projects';
  // matched === false: the last fetch found no open issues for this milestone (wrong/renamed/archived name).
  return `Work scope: milestone "${scope.milestone}" only${scope.matched === false ? ' (matches no open issues)' : ''}`;
}

export interface ApiProject {
  name: string;
  linearProject?: string;
  path: string;
  enabled: boolean;
  running?: ApiTaskSummary[];
  queued?: ApiTaskSummary[];
  pending?: ApiTaskSummary[];
  git?: {
    branch?: string;
    hasChanges?: boolean;
    uncommittedFiles?: number;
    ahead?: number;
    behind?: number;
  } | null;
  prs?: Array<{ number: number; branch: string; title: string; updatedAt?: string }>;
}

interface ApiTaskSummary {
  id: string;
  title: string;
  priority?: number | string;
  issueIdentifier?: string;
  linearState?: string;
}

export function projectsToTable(projects: ApiProject[]): Table {
  return {
    columns: ['', 'PROJECT', 'PATH', 'GIT/WT', 'LINEAR', 'RUN', 'QUEUE', 'PEND', 'LAST'],
    rows: projects.map((p) => [
      p.enabled ? '●' : '○',
      p.name,
      compactPath(p.path),
      gitSummary(p),
      p.linearProject ?? '',
      String(p.running?.length ?? 0),
      String(p.queued?.length ?? 0),
      String(p.pending?.length ?? 0),
      latestProjectActivity(p),
    ]),
  };
}

function compactPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

function gitSummary(p: ApiProject): string {
  const git = p.git;
  const branch = git?.branch ?? (p.prs?.[0]?.branch);
  if (!branch) return '';
  const dirty = git?.hasChanges ? ` +${git.uncommittedFiles ?? 0}` : '';
  const sync = `${git?.ahead ? ` ↑${git.ahead}` : ''}${git?.behind ? ` ↓${git.behind}` : ''}`;
  return `${branch}${dirty}${sync}`;
}

function latestProjectActivity(p: ApiProject): string {
  const running = p.running?.[0];
  if (running) return `run ${truncate(running.title || running.id, 18)}`;
  const queued = p.queued?.[0];
  if (queued) return `queue ${truncate(queued.title || queued.id, 16)}`;
  const pending = p.pending?.[0];
  if (pending) return `${pending.linearState ?? 'Todo'} ${pending.issueIdentifier ?? pending.id}`;
  const pr = p.prs?.[0];
  if (pr) return `PR #${pr.number}`;
  return '';
}

function shortModel(model: string | undefined): string {
  return model ? model.split('-').slice(-2).join('-') : '';
}

function elapsed(ms: number | undefined): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function titleOf(data: ApiPipelineEvent['data']): string {
  return data.issueIdentifier || data.title || data.taskId || '';
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface ApiPipelineEvent {
  type: string;
  data: {
    taskId?: string;
    stage?: string;
    status?: string;
    model?: string;
    title?: string;
    issueIdentifier?: string;
    repository?: string;
    projectPath?: string;
    durationMs?: number;
    decision?: string;
    summary?: string;
    feedback?: string;
    error?: string;
    filesChangedCount?: number;
    issuesCount?: number;
  };
}

const STAGE_ICON: Record<string, string> = { start: '◐', complete: '●', fail: '✗' };

/** Most-recent pipeline stage events as task rows (newest first). */
export function pipelineToTable(stages: ApiPipelineEvent[], limit = 15): Table {
  const info = new Map<string, string>(); // taskId → identifier/title
  const events: Array<ApiPipelineEvent['data'] & { taskId: string; stage: string; status: string }> = [];
  for (const ev of stages) {
    if (ev.type === 'task:started' && ev.data.taskId) {
      info.set(ev.data.taskId, ev.data.issueIdentifier || ev.data.title || ev.data.taskId);
    } else if (ev.type === 'pipeline:stage' && ev.data.taskId && ev.data.stage) {
      events.push({ ...ev.data, taskId: ev.data.taskId, stage: ev.data.stage, status: ev.data.status ?? '' });
    }
  }
  const recent = events.slice(-limit).reverse();
  return {
    columns: ['TASK', 'PROJECT', 'STAGE', 'MODEL', 'STATE', 'AGE', 'DETAIL'],
    rows: recent.map((e) => [
      truncate(info.get(e.taskId) ?? titleOf(e), 16),
      e.repository ?? compactPath(e.projectPath ?? ''),
      e.stage,
      shortModel(e.model),
      `${STAGE_ICON[e.status] ?? '○'} ${e.status}${e.decision ? `/${e.decision}` : ''}`,
      elapsed(e.durationMs),
      stageDetail(e),
    ]),
  };
}

function stageDetail(e: ApiPipelineEvent['data']): string {
  if (e.error) return truncate(e.error, 24);
  if (e.summary) return truncate(e.summary, 24);
  if (e.feedback) return truncate(e.feedback, 24);
  if (e.filesChangedCount != null) return `${e.filesChangedCount} files`;
  if (e.issuesCount != null) return `${e.issuesCount} issues`;
  return '';
}

export interface ApiStuckIssue {
  identifier: string;
  title: string;
  reason: string;
  priority: number | string;
  project?: { name: string };
  state?: string;
  labels?: string[];
  comments?: Array<{ body: string; createdAt: string }>;
  stuckDays?: number;
}

const PRIO = (p: number | string) => {
  if (typeof p === 'string') {
    const normalized = p.toLowerCase();
    return normalized === 'medium' ? 'med' : normalized;
  }
  return p === 1 ? 'urgent' : p === 2 ? 'high' : p === 3 ? 'med' : 'low';
};

export function stuckToTable(stuck: ApiStuckIssue[], failed: ApiStuckIssue[]): Table {
  const row = (kind: string) => (i: ApiStuckIssue): string[] => [
    kind,
    i.identifier,
    i.title.length > 40 ? `${i.title.slice(0, 39)}…` : i.title,
    PRIO(i.priority),
    i.project?.name ?? '',
    i.reason.length > 30 ? `${i.reason.slice(0, 29)}…` : i.reason,
    issueContext(i),
  ];
  return {
    columns: ['KIND', 'ID', 'TITLE', 'PRIO', 'PROJECT', 'REASON', 'CONTEXT'],
    rows: [...stuck.map(row('stuck')), ...failed.map(row('failed'))],
  };
}

function issueContext(i: ApiStuckIssue): string {
  const latestComment = [...(i.comments ?? [])]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latestComment?.body) return truncate(latestComment.body.replace(/\s+/g, ' ').trim(), 24);
  if (typeof i.stuckDays === 'number') return `${i.stuckDays}d stale`;
  const labels = (i.labels ?? []).filter(l => ['retry', 'failed', 'blocked', 'needs-help', 'swarm:stuck'].includes(l));
  if (labels.length > 0) return truncate(labels.join(','), 24);
  return i.state ?? '';
}

export interface ApiIssue {
  id: string;
  title: string;
  status: string;
  priority: number | string;
}

export function issuesToTable(issues: ApiIssue[]): Table {
  return {
    columns: ['TITLE', 'STATUS', 'PRIO'],
    rows: issues.map((i) => [
      i.title.length > 50 ? `${i.title.slice(0, 49)}…` : i.title,
      i.status,
      PRIO(i.priority),
    ]),
  };
}
