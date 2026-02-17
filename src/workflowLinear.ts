// ============================================
// Claude Swarm - Linear Workflow Integration
// Sync workflow steps with Linear issues
// ============================================

import {
  WorkflowConfig,
  WorkflowStep,
  WorkflowExecution,
  StepResult,
  topologicalSort,
} from './workflow.js';

// ============================================
// Types
// ============================================

export interface LinearWorkflowOptions {
  /** Parent issue ID (tracks entire workflow) */
  parentIssueId?: string;
  /** Team ID */
  teamId: string;
  /** Project ID (optional) */
  projectId?: string;
  /** Whether to create issues per step */
  createStepIssues?: boolean;
  /** Label ID list */
  labelIds?: string[];
}

export interface LinearStepIssue {
  stepId: string;
  issueId: string;
  issueIdentifier: string;  // e.g., "INT-123"
}

export interface WorkflowLinearSync {
  workflowId: string;
  executionId: string;
  parentIssueId?: string;
  stepIssues: LinearStepIssue[];
  createdAt: number;
}

// ============================================
// Linear MCP Integration
// ============================================

/**
 * Note: This module is used when a Linear MCP server is connected.
 * MCP functions are automatically available in the Claude Code runtime.
 *
 * Actual integration is performed via Discord commands or Claude prompts.
 * This module manages the mapping between workflows and Linear issues.
 */

/**
 * Convert workflow to Linear issue structure
 */
export function workflowToLinearStructure(
  workflow: WorkflowConfig,
  options: LinearWorkflowOptions
): {
  parentIssue: {
    title: string;
    description: string;
    teamId: string;
    projectId?: string;
    labelIds?: string[];
  };
  stepIssues: Array<{
    stepId: string;
    title: string;
    description: string;
    blockedBy: string[];  // step IDs (converted to issue IDs later)
  }>;
} {
  const sortedSteps = topologicalSort(workflow.steps);

  // Parent issue (entire workflow)
  const parentIssue = {
    title: `[Workflow] ${workflow.name}`,
    description: buildWorkflowDescription(workflow),
    teamId: options.teamId,
    projectId: options.projectId,
    labelIds: options.labelIds,
  };

  // Per-step issues
  const stepIssues = sortedSteps.map(step => ({
    stepId: step.id,
    title: `[${workflow.id}] ${step.name}`,
    description: buildStepDescription(step, workflow),
    blockedBy: step.dependsOn || [],
  }));

  return { parentIssue, stepIssues };
}

/**
 * Generate workflow description
 */
function buildWorkflowDescription(workflow: WorkflowConfig): string {
  const parts: string[] = [];

  parts.push(`## ${workflow.name}`);
  if (workflow.description) {
    parts.push(workflow.description);
  }
  parts.push('');

  parts.push('### Steps');
  for (const step of workflow.steps) {
    const deps = step.dependsOn ? ` (← ${step.dependsOn.join(', ')})` : '';
    parts.push(`- [ ] **${step.name}** (\`${step.id}\`)${deps}`);
  }
  parts.push('');

  parts.push('### Execution Flow');
  parts.push('```');
  const sortedSteps = topologicalSort(workflow.steps);
  parts.push(sortedSteps.map(s => s.id).join(' → '));
  parts.push('```');
  parts.push('');

  parts.push('---');
  parts.push('_Managed by Claude Swarm Workflow Engine_');

  return parts.join('\n');
}

/**
 * Generate step description
 */
function buildStepDescription(step: WorkflowStep, workflow: WorkflowConfig): string {
  const parts: string[] = [];

  parts.push(`## Step: ${step.name}`);
  parts.push('');

  parts.push('### Prompt');
  parts.push('```');
  parts.push(step.prompt);
  parts.push('```');
  parts.push('');

  if (step.dependsOn && step.dependsOn.length > 0) {
    parts.push('### Dependencies');
    parts.push(step.dependsOn.map(d => `- \`${d}\``).join('\n'));
    parts.push('');
  }

  parts.push('### Configuration');
  parts.push(`- **On Failure:** ${step.onFailure || workflow.onFailure || 'abort'}`);
  if (step.timeout) {
    parts.push(`- **Timeout:** ${step.timeout}s`);
  }
  if (step.retryCount) {
    parts.push(`- **Retries:** ${step.retryCount}`);
  }
  parts.push('');

  parts.push('---');
  parts.push(`_Part of workflow: ${workflow.name}_`);

  return parts.join('\n');
}

/**
 * Convert step result to Linear comment
 */
export function stepResultToComment(result: StepResult): string {
  const parts: string[] = [];

  const statusEmoji = {
    pending: '⏳',
    running: '🔄',
    completed: '✅',
    failed: '❌',
    skipped: '⏭️',
  }[result.status];

  parts.push(`## ${statusEmoji} Step Result`);
  parts.push('');

  parts.push(`**Status:** ${result.status}`);
  parts.push(`**Started:** ${new Date(result.startedAt).toISOString()}`);
  if (result.completedAt) {
    const duration = (result.completedAt - result.startedAt) / 1000;
    parts.push(`**Completed:** ${new Date(result.completedAt).toISOString()}`);
    parts.push(`**Duration:** ${duration.toFixed(1)}s`);
  }
  parts.push('');

  if (result.output) {
    parts.push('### Output');
    parts.push('```');
    parts.push(result.output.slice(0, 3000));  // Linear comment length limit
    if (result.output.length > 3000) {
      parts.push('... (truncated)');
    }
    parts.push('```');
  }

  if (result.error) {
    parts.push('### Error');
    parts.push('```');
    parts.push(result.error);
    parts.push('```');
  }

  if (result.changedFiles && result.changedFiles.length > 0) {
    parts.push('### Changed Files');
    parts.push(result.changedFiles.map(f => `- \`${f}\``).join('\n'));
  }

  return parts.join('\n');
}

/**
 * Map step status to Linear state
 */
export function stepStatusToLinearState(status: StepResult['status']): string {
  const mapping: Record<typeof status, string> = {
    pending: 'Todo',
    running: 'In Progress',
    completed: 'Done',
    failed: 'Canceled',
    skipped: 'Canceled',
  };
  return mapping[status] || 'Todo';
}

/**
 * Create workflow execution summary (for project updates)
 */
export function createExecutionSummary(execution: WorkflowExecution): {
  body: string;
  health: 'onTrack' | 'atRisk' | 'offTrack';
} {
  const results = Object.values(execution.stepResults);
  const completed = results.filter(r => r.status === 'completed').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const total = results.length;

  // Determine health
  let health: 'onTrack' | 'atRisk' | 'offTrack';
  if (failed > 0) {
    health = 'offTrack';
  } else if (completed < total) {
    health = 'atRisk';
  } else {
    health = 'onTrack';
  }

  // Generate summary
  const parts: string[] = [];

  parts.push(`## Workflow Execution: ${execution.workflowId}`);
  parts.push('');
  parts.push(`**Execution ID:** \`${execution.executionId}\``);
  parts.push(`**Status:** ${execution.status}`);
  parts.push(`**Progress:** ${completed}/${total} steps completed`);
  parts.push('');

  parts.push('### Step Summary');
  parts.push('| Step | Status | Duration |');
  parts.push('|------|--------|----------|');

  for (const [stepId, result] of Object.entries(execution.stepResults)) {
    const duration = result.completedAt
      ? `${((result.completedAt - result.startedAt) / 1000).toFixed(1)}s`
      : '-';
    const statusIcon = {
      pending: '⏳',
      running: '🔄',
      completed: '✅',
      failed: '❌',
      skipped: '⏭️',
    }[result.status];
    parts.push(`| ${stepId} | ${statusIcon} ${result.status} | ${duration} |`);
  }
  parts.push('');

  if (failed > 0) {
    parts.push('### Failures');
    for (const [stepId, result] of Object.entries(execution.stepResults)) {
      if (result.status === 'failed' && result.error) {
        parts.push(`- **${stepId}:** ${result.error}`);
      }
    }
  }

  return { body: parts.join('\n'), health };
}

// ============================================
// Linear MCP Command Templates
// ============================================

/**
 * Linear issue creation command template (for MCP)
 */
export function getCreateIssueCommand(
  title: string,
  description: string,
  teamId: string,
  options?: {
    projectId?: string;
    parentId?: string;
    labelIds?: string[];
    blockedBy?: string[];
  }
): {
  tool: string;
  params: Record<string, unknown>;
} {
  return {
    tool: 'mcp__linear-server__create_issue',
    params: {
      title,
      description,
      team: teamId,
      project: options?.projectId,
      parentId: options?.parentId,
      labels: options?.labelIds,
      blockedBy: options?.blockedBy,
    },
  };
}

/**
 * Linear issue status update command template
 */
export function getUpdateIssueCommand(
  issueId: string,
  state: string
): {
  tool: string;
  params: Record<string, unknown>;
} {
  return {
    tool: 'mcp__linear-server__update_issue',
    params: {
      id: issueId,
      state,
    },
  };
}

/**
 * Linear comment creation command template
 */
export function getCreateCommentCommand(
  issueId: string,
  body: string
): {
  tool: string;
  params: Record<string, unknown>;
} {
  return {
    tool: 'mcp__linear-server__create_comment',
    params: {
      issueId,
      body,
    },
  };
}

/**
 * Linear project update command template
 */
export function getCreateProjectUpdateCommand(
  projectId: string,
  body: string,
  health: 'onTrack' | 'atRisk' | 'offTrack'
): {
  tool: string;
  params: Record<string, unknown>;
} {
  return {
    tool: 'mcp__linear-server__create_project_update',
    params: {
      project: projectId,
      body,
      health,
    },
  };
}
