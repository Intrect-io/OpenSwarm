// The remote a PR processor should talk to (AGT-3374)
//
// `openswarm pr review --fresh` failed outright on vega-agent, whose remote is
// named `unohee`: every git call in the PR processor said `origin`. The
// worktree manager already resolves the remote (origin if present, else the
// first one); the PR processor uses the same answer so both agree on which
// remote a repository publishes through.

import { resolveBaseRef } from '../support/worktreeManager.js';

/** The remote name to fetch from / push to for `projectPath`: `origin` when it exists, else the first remote. */
export async function prRemote(projectPath: string): Promise<string> {
  return (await resolveBaseRef(projectPath)).remote;
}
