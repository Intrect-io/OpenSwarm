import type { PipelineRunMetadata } from '../agents/pairPipeline.js';
import { repositoryCell } from '../coordination/repositoryCell.js';
import type { WorktreeInfo } from '../support/worktreeManager.js';

export interface PipelineMetadataTask {
  id: string;
  title: string;
  issueId?: string;
  issueIdentifier?: string;
  linearProject?: { id?: string; name?: string };
}

export function pipelineMetadata(
  task: PipelineMetadataTask,
  projectPath: string,
  worktreeInfo?: WorktreeInfo | null,
): PipelineRunMetadata {
  const activePath = worktreeInfo?.worktreePath ?? projectPath;
  const cell = repositoryCell(projectPath);
  return {
    repository: task.linearProject?.name ?? repoNameFromPath(projectPath),
    projectPath: activePath,
    coordinationRepository: cell.repositoryPath,
    repoKey: cell.repoKey,
    worktree: worktreeInfo?.issueId ?? worktreeNameFromPath(activePath),
    branch: worktreeInfo?.branchName,
    issueIdentifier: task.issueIdentifier ?? task.issueId,
    title: task.title,
  };
}

function repoNameFromPath(projectPath: string): string {
  return projectPath.replace(/\/+$/, '').replace(/\/worktree\/[^/]+$/, '').split('/').pop() || projectPath;
}

function worktreeNameFromPath(projectPath: string): string | undefined {
  return projectPath.match(/\/worktree\/([^/]+)\/?$/)?.[1];
}
