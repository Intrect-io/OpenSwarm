import type { TaskItem } from '../orchestration/decisionEngine.js';

export function buildTaskPrefix(task: TaskItem, projectPath: string): string {
  const parts: string[] = [];
  const projectName = task.linearProject?.name || projectPath.split('/').pop() || 'unknown';
  parts.push(projectName);
  if (task.issueIdentifier) {
    parts.push(task.issueIdentifier);
  } else if (task.issueId) {
    parts.push(task.issueId.slice(0, 8));
  }
  const worktreeMatch = projectPath.match(/worktree\/([a-f0-9-]+)/);
  if (worktreeMatch) parts.push(`worktree/${worktreeMatch[1].slice(0, 8)}`);
  // This value is interpolated into daemon and terminal log entries throughout
  // the pipeline. Linear project names and task identifiers are external input,
  // so remove line breaks once at the boundary rather than allowing forged logs.
  return parts.join(' | ').replace(/[\r\n]/g, '');
}
