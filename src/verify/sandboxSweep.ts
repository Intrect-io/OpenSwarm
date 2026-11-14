// ============================================
// OpenSwarm - Startup sweep of leftover verify sandboxes (AGT-4785)
// ============================================
//
// Each verify command clones the project into `$TMPDIR/.openswarm-verify-head-*`
// (and `.openswarm-verify-base-*` for the base comparison). The runner removes
// them on every exit path it controls, but a daemon killed mid-verify — a
// crash, a reboot, an OOM — leaves the whole clone behind, about 1 GB each on
// cgf-portal. On 2026-10-20 the host ran out of disk while copying git packs
// into exactly these directories, and nothing ever removed the leftovers.
//
// The sweep runs once at daemon start. It only removes sandboxes older than a
// generous age, because another process (a CLI run, a second daemon) may own a
// fresh one right now.

import { lstat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Directory names the verify runner creates with mkdtemp. */
export const VERIFY_SANDBOX_PATTERN = /^\.openswarm-verify-(?:head|base)-[A-Za-z0-9]+$/;

/** A verify run is bounded far below this; anything older has no live owner. */
export const DEFAULT_STALE_SANDBOX_AGE_MS = 6 * 60 * 60_000;

export interface VerifySandboxSweepResult {
  removed: string[];
  /** Matching sandboxes left alone because they are younger than the age floor. */
  keptFresh: number;
  failed: Array<{ path: string; error: string }>;
}

export async function sweepStaleVerifySandboxes(options: {
  root?: string;
  olderThanMs?: number;
  now?: number;
} = {}): Promise<VerifySandboxSweepResult> {
  const root = options.root ?? tmpdir();
  const olderThanMs = options.olderThanMs ?? DEFAULT_STALE_SANDBOX_AGE_MS;
  const now = options.now ?? Date.now();
  const result: VerifySandboxSweepResult = { removed: [], keptFresh: 0, failed: [] };

  let names: string[];
  try {
    names = await readdir(root);
  } catch { // cxt-ignore: error_swallow — an unreadable tmpdir has nothing to sweep
    return result;
  }

  for (const name of names) {
    if (!VERIFY_SANDBOX_PATTERN.test(name)) continue;
    const path = join(root, name);
    try {
      const info = await lstat(path);
      // Never follow a link out of the scratch directory.
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if (now - info.mtimeMs < olderThanMs) {
        result.keptFresh += 1;
        continue;
      }
      await rm(path, { recursive: true, force: true });
      result.removed.push(path);
    } catch (error) {
      result.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
