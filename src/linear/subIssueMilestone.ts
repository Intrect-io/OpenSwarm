// Created: 2026-11-21
// Purpose: keep decomposed/follow-up sub-issues inside the parent's project milestone (AGT-3188),
//          so a milestone-scoped daemon can still pick up the children of an in-scope parent
// Dependencies: none (structural types over the @linear/sdk Issue/ProjectMilestone models)
// Test Status: linear.test.ts (createSubIssue milestone inheritance)

type Awaitable<T> = T | PromiseLike<T>;

interface MilestoneLike {
  id: string;
  project?: Awaitable<{ id: string } | undefined> | undefined;
}

export interface ParentWithMilestone {
  projectMilestone?: Awaitable<MilestoneLike | undefined> | undefined;
}

/**
 * The project/milestone fields for a sub-issue create input. The parent's milestone is copied
 * when it has one. A milestone belongs to one project, so when the caller asks for a different
 * project the milestone is left off rather than sending a pair Linear would reject.
 */
export async function subIssueProjectFields(
  parent: ParentWithMilestone,
  projectId: string | undefined,
): Promise<{ projectId?: string; projectMilestoneId?: string }> {
  const milestone = await parent.projectMilestone;
  if (!milestone?.id) return { projectId };
  const milestoneProjectId = (await milestone.project)?.id;
  if (projectId && milestoneProjectId && projectId !== milestoneProjectId) return { projectId };
  return { projectId: projectId ?? milestoneProjectId, projectMilestoneId: milestone.id };
}
