// ============================================
// OpenSwarm — the worker prompt's section names and their eviction order (AGT-4151)
// ============================================

/**
 * Which context sections the aggregate budget drops first, most disposable
 * first. Everything here is rediscoverable by the worker with its own tools;
 * what is NOT here — the task, operator decisions, previous feedback, prior
 * deliveries, the edit boundary and the DoD — is binding and only ever cut
 * short after all of these are gone (see `fitPromptSections`).
 *
 * - registry briefs: a convenience map of files the worker can read itself
 * - repo memories: learned hints, useful but never load-bearing
 * - sibling work: what other worktrees touch; integration merges either way
 * - impact analysis: derivable from the code
 * - draft analysis: the drafter's reading of the task; the task itself stays
 * - repository contract: manifests and verification commands, in the repo
 */
export const WORKER_PROMPT_EVICTION_ORDER: readonly string[] = [
  'registry-briefs',
  'repo-memories',
  'sibling-work',
  'impact-analysis',
  'draft-analysis',
  'repository-contract',
];
