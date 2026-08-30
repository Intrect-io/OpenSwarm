// ============================================
// OpenSwarm - Task branch naming convention
// The one place that knows what a `swarm/<issue>-<slug>` branch looks like
// ============================================

/** The namespace every task branch this daemon creates lives under. */
const BRANCH_NAMESPACE = 'swarm';

/** Generate branch name: swarm/INT-512-llm-tool-interface */
export function buildBranchName(issueIdentifier: string, title: string): string {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${BRANCH_NAMESPACE}/${issueIdentifier}-${slug}`;
}

/**
 * Does `branch` belong to `issueIdentifier`, whatever slug it was cut with?
 *
 * Deliberately not `branch === buildBranchName(id, title)`: the slug is derived
 * from the issue title, and a title edited after the branch was cut makes the
 * two disagree. Measured against live branches — AX-858 and AX-863 reproduce
 * exactly, but AX-864's branch is `swarm/AX-864-a2-slack` while today's title
 * yields `swarm/AX-864-a2-6-slack`. An equality test would silently miss a
 * third of real cases. (AGT-4095)
 *
 * The trailing delimiter is what keeps the prefix unambiguous: `swarm/AX-86-`
 * cannot match `swarm/AX-863-...`.
 */
export function isBranchForIssue(branch: string, issueIdentifier: string): boolean {
  if (!issueIdentifier) return false;
  const prefix = `${BRANCH_NAMESPACE}/${issueIdentifier}`;
  return branch === prefix || branch.startsWith(`${prefix}-`);
}
