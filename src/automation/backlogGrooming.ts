// OpenSwarm - whole-backlog grooming planner (INT-1609)
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getAdapter, spawnCli } from '../adapters/index.js';
import type { AdapterName } from '../adapters/types.js';
import { expandPath } from '../core/config.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ITaskSource, TaskState } from './taskSource.js';

export type BacklogGroomingMode = 'comment' | 'apply';
export type GroomingStatus = 'active' | 'stale' | 'needs_update';

export interface BacklogGroomingConfig {
  enabled: boolean;
  cadenceHours?: number;
  mode?: BacklogGroomingMode;
  plannerModel?: string;
  plannerTimeoutMs?: number;
  maxIssues?: number;
}

export interface GroomingDecision {
  issueId: string;
  identifier?: string;
  status: GroomingStatus;
  reason: string;
  evidence?: string[];
  updatedDescription?: string;
  closeState?: TaskState;
}

export interface BacklogGroomingResult {
  success: boolean;
  decisions: GroomingDecision[];
  error?: string;
}

export interface RunBacklogGroomingOptions {
  tasks: TaskItem[];
  /** If set, only these task IDs may be mutated. Empty set = no mutations allowed. */
  scope?: Set<string>;
  projectPath: string;
  projectName?: string;
  model?: string;
  adapterName?: AdapterName;
  timeoutMs?: number;
  maxIssues?: number;
  onLog?: (line: string) => void;
}

export interface ApplyBacklogGroomingResult {
  commented: number;
  failedComments: number;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function taskPayload(task: TaskItem): Record<string, unknown> {
  return {
    id: task.issueId ?? task.id,
    identifier: task.issueIdentifier ?? task.identifier,
    title: task.title,
    status: task.linearState ?? task.state,
    priority: task.priority,
    labels: task.labels,
    assignee: task.assignee,
    description: task.description ? task.description.slice(0, 500) : undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function repoSnapshotSummary(projectPath: string): string {
  const gitHead = join(projectPath, '.git', 'HEAD');
  if (!existsSync(gitHead)) return '';
  try {
    const ref = readFileSync(gitHead, 'utf-8').trim();
    if (ref.startsWith('ref: ')) {
      const refPath = join(projectPath, '.git', ref.slice(5));
      if (existsSync(refPath)) {
        return readFileSync(refPath, 'utf-8').trim().slice(0, 12);
      }
    }
    return ref.slice(0, 12);
  } catch {
    return '';
  }
}

export function buildBacklogGroomingPrompt(options: RunBacklogGroomingOptions): string {
  const tasks = options.tasks.slice(0, options.maxIssues ?? 50);
  const taskList = tasks.map(t => JSON.stringify(taskPayload(t), null, 2)).join(',\n');
  const snapshot = repoSnapshotSummary(options.projectPath);
  const snapshotLine = snapshot ? `\nRepo snapshot: \`${snapshot}\`` : '';

  return `You are a backlog grooming planner for the OpenSwarm project.

Review the following tasks and decide for each one whether it should remain active, needs an updated description, or is stale and should be closed.

${snapshotLine}

Tasks:
[
${taskList}
]

Respond with a JSON block:
\`\`\`json
{
  "decisions": [
    {
      "issueId": "<id>",
      "identifier": "<optional identifier>",
      "status": "active" | "needs_update" | "stale",
      "reason": "<brief reason>",
      "evidence": ["<optional evidence>"],
      "updatedDescription": "<optional new description if needs_update>",
      "closeState": "Done"
    }
  ]
}
\`\`\`

Rules:
- Do not invent issue ids.
- Do not close parent/epic issues just because child issues exist.
- Use closeState "Done" only for stale issues that are already implemented; otherwise omit it.
- Keep updatedDescription concise and implementation-ready.`;
}

export function parseBacklogGroomingOutput(output: string): BacklogGroomingResult {
  try {
    const fence = output.match(/```json\s*([\s\S]*?)```/i);
    const jsonText = fence?.[1] ?? output.slice(output.indexOf('{'));
    const parsed = JSON.parse(jsonText) as { decisions?: unknown };
    const raw = Array.isArray(parsed.decisions) ? parsed.decisions : [];
    const decisions = raw.flatMap((item): GroomingDecision[] => {
      if (!item || typeof item !== 'object') return [];
      const d = item as Partial<GroomingDecision>;
      if (!d.issueId || !d.status || !d.reason) return [];
      if (!['active', 'needs_update', 'stale'].includes(d.status)) return [];
      return [{
        issueId: String(d.issueId),
        identifier: d.identifier ? String(d.identifier) : undefined,
        status: d.status,
        reason: String(d.reason),
        evidence: Array.isArray(d.evidence) ? d.evidence.map(String) : undefined,
        updatedDescription: d.updatedDescription ? String(d.updatedDescription) : undefined,
        closeState: d.closeState as TaskState | undefined,
      }];
    });
    return { success: true, decisions };
  } catch (error) {
    return { success: false, decisions: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runBacklogGroomingPlanner(options: RunBacklogGroomingOptions): Promise<BacklogGroomingResult> {
  // Restrict mutations to the supplied scope before any decision is made.
  const scope = options.scope;
  const tasks = scope
    ? options.tasks.filter(t => scope.has(t.issueId ?? t.id ?? ''))
    : options.tasks;
  if (tasks.length === 0) return { success: true, decisions: [] };
  try {
    const adapter = getAdapter(options.adapterName);
    const cwd = expandPath(options.projectPath);
    const raw = await spawnCli(adapter, {
      prompt: buildBacklogGroomingPrompt({ ...options, tasks, projectPath: cwd }),
      cwd,
      timeoutMs: options.timeoutMs ?? 600_000,
      model: options.model,
      maxTurns: 20,
      onLog: options.onLog,
      readOnly: true,
      reasoningEffort: 'high',
      processContext: { taskId: `groom:${options.projectName ?? basename(cwd)}`, stage: 'groom' },
    });
    if (raw.exitCode !== 0 && !raw.stdout.trim()) {
      return { success: false, decisions: [], error: raw.stderr.slice(0, 500) || `Planner adapter exited with code ${raw.exitCode}` };
    }
    return parseBacklogGroomingOutput(raw.stdout);
  } catch (error) {
    return { success: false, decisions: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function formatGroomingComment(decision: GroomingDecision, action: string): string {
  const evidence = decision.evidence?.length
    ? `\n\nEvidence:\n${decision.evidence.map(e => `- ${e}`).join('\n')}`
    : '';
  return `Backlog grooming result: ${decision.status}

Reason: ${decision.reason}${evidence}

Action: ${action}`;
}

export async function applyBacklogGrooming(
  source: ITaskSource,
  result: BacklogGroomingResult,
  mode: BacklogGroomingMode = 'comment',
  validIssueIds?: Set<string>,
): Promise<ApplyBacklogGroomingResult> {
  const applied: ApplyBacklogGroomingResult = {
    commented: 0,
    failedComments: 0,
  };
  for (const decision of result.decisions) {
    if (validIssueIds && !validIssueIds.has(decision.issueId)) continue;
    const action = mode === 'apply' ? 'applied' : 'commented';
    try {
      await source.addComment(decision.issueId, formatGroomingComment(decision, action));
      applied.commented++;
    } catch {
      applied.failedComments++;
    }
  }
  return applied;
}

export function filterGroomableTasks(tasks: TaskItem[], scope?: Set<string>): TaskItem[] {
  return tasks.filter(task => {
    if (scope && !scope.has(task.issueId ?? task.id ?? '')) return false;
    const state = task.linearState?.toLowerCase();
    return state === 'todo' || state === 'backlog' || state === 'in progress' || state === 'in review';
  });
}

export function summarizeGroomingDecision(decision: GroomingDecision): string {
  return `${decision.identifier ?? decision.issueId}: ${decision.status} — ${decision.reason}`;
}