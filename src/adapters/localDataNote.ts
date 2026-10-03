// Created: 2026-10-03
// Purpose: tell an agentic-loop worker where data that git does not carry lives
// Dependencies: node:fs, security/gitWorktreeIdentity

import { existsSync } from 'node:fs';
import { linkedMainCheckoutOf } from '../security/gitWorktreeIdentity.js';

/**
 * Where a worker should look for data a git checkout does not carry.
 *
 * A container deployment mounts a shared read-only `/warehouse` with an index,
 * because a bare clone there has nothing but tracked files. A native host has no
 * such mount: telling the worker to read `/warehouse/INDEX.md` there costs one
 * failed call per run and points at nothing. On a native host the same local-only
 * material sits in the linked main checkout that the read tools can already
 * reach, so the note names that instead. Neither source present means no note,
 * rather than a pointer to a path that does not exist. (AGT-4661)
 */
export function localDataNote(cwd: string, readOnly: boolean | undefined): string {
  const warehouseRoot = process.env.OPENSWARM_WAREHOUSE_ROOT?.trim() || '/warehouse';
  if (existsSync(warehouseRoot)) {
    return `Local-only data, credentials, and cross-repository artifacts may be available read-only under ${warehouseRoot}. ` +
      `Read ${warehouseRoot}/INDEX.md before asking the operator for missing material, and never print secret values.\n\n`;
  }
  // Same condition as the read tools' `allowMainCheckoutRead`: a read-only run
  // is denied that path, so advertising it would be a second wasted call.
  const mainCheckout = readOnly ? null : linkedMainCheckoutOf(cwd);
  if (mainCheckout) {
    return `Local-only data that git does not carry (ignored files, caches, local exports) lives in this worktree's main checkout at ${mainCheckout}. ` +
      `You may read it there (read-only) before asking the operator for missing material, and never print secret values.\n\n`;
  }
  return '';
}
