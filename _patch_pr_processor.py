#!/usr/bin/env python3
"""Copy and patch prProcessor.ts: withStoreLock -> withFileLock lease."""
from __future__ import annotations

from pathlib import Path

SRC = Path("/work/OpenSwarm/src/automation/prProcessor.ts")
DST = Path(
    "/work/OpenSwarm/worktree/743ccc9e-7b29-4268-ad09-c64586dad683"
    "/src/automation/prProcessor.ts"
)

text = SRC.read_text(encoding="utf-8")

# 1. Add withFileLock import after atomicWriteFileSync import
old_import = "import { atomicWriteFileSync } from '../support/atomicFile.js';\n"
new_import = (
    "import { atomicWriteFileSync } from '../support/atomicFile.js';\n"
    "import { withFileLock } from '../support/fileLock.js';\n"
)
if "withFileLock" not in text.split("from '../support/fileLock.js'")[0] if "fileLock" in text else True:
    if "import { withFileLock } from '../support/fileLock.js';" not in text:
        if old_import not in text:
            raise SystemExit("atomicWriteFileSync import not found")
        text = text.replace(old_import, new_import, 1)

# 2. Add PR_STATE_LOCK_PATH after PR_STATE_PATH
old_path = (
    "const PR_STATE_PATH = resolve(homedir(), '.openswarm', 'pr-state.json');\n"
)
new_path = (
    "const PR_STATE_PATH = resolve(homedir(), '.openswarm', 'pr-state.json');\n"
    "const PR_STATE_LOCK_PATH = `${PR_STATE_PATH}.lock`;\n"
)
if "PR_STATE_LOCK_PATH" not in text:
    if old_path not in text:
        raise SystemExit("PR_STATE_PATH not found")
    text = text.replace(old_path, new_path, 1)

# 3. Wrap fixOne processPR call
old_fix = """    await this.processPR(pr, projectPath, state, key);
    const entry = state.prs[key];
    return {
      success: entry?.status === 'completed',
      error: entry?.lastError,
      iterations: entry?.iterations ?? 0,
    };
  }

  /**
   * One-shot review-feedback pass for a single PR (CLI `openswarm pr review`).
"""

new_fix = """    // Cross-process lease shared with the cron path (state + checkout serialization)
    await withFileLock(PR_STATE_LOCK_PATH, async () => {
      await this.processPR(pr, projectPath, state, key);
    }, { timeoutMs: 30 * 60_000 });
    const entry = state.prs[key];
    return {
      success: entry?.status === 'completed',
      error: entry?.lastError,
      iterations: entry?.iterations ?? 0,
    };
  }

  /**
   * One-shot review-feedback pass for a single PR (CLI `openswarm pr review`).
"""

if old_fix not in text:
    raise SystemExit("fixOne processPR block not found")
text = text.replace(old_fix, new_fix, 1)

# 4. Wrap reviewOne load/process/save
old_review = """  async reviewOne(
    pr: PRInfo,
    projectPath: string,
  ): Promise<{ success: boolean; error?: string; iterations: number }> {
    const key = `${pr.repo}#${pr.number}`;
    const state = await this.loadState();
    state.prs[key] = {
      ...state.prs[key],
      repo: pr.repo,
      prNumber: pr.number,
      status: 'processing',
      iterations: 0,
    };
    await this.processReviewFeedback(pr, projectPath, state, key, 0);
    await this.saveState(state);
    const entry = state.prs[key];
    return {
      success: entry?.status === 'completed',
      error: entry?.lastError,
      iterations: entry?.iterations ?? 0,
    };
  }
"""

new_review = """  async reviewOne(
    pr: PRInfo,
    projectPath: string,
  ): Promise<{ success: boolean; error?: string; iterations: number }> {
    const key = `${pr.repo}#${pr.number}`;
    return await withFileLock(PR_STATE_LOCK_PATH, async () => {
      const state = await this.loadState();
      state.prs[key] = {
        ...state.prs[key],
        repo: pr.repo,
        prNumber: pr.number,
        status: 'processing',
        iterations: 0,
      };
      await this.processReviewFeedback(pr, projectPath, state, key, 0);
      await this.saveState(state);
      const entry = state.prs[key];
      return {
        success: entry?.status === 'completed',
        error: entry?.lastError,
        iterations: entry?.iterations ?? 0,
      };
    }, { timeoutMs: 30 * 60_000 });
  }
"""

if old_review not in text:
    raise SystemExit("reviewOne block not found")
text = text.replace(old_review, new_review, 1)

# 5. Wrap processPRs try body in withFileLock
old_try = """    try {
      const state = await this.loadState();

      for (const repo of this.config.repos) {
"""

new_try = """    try {
      await withFileLock(PR_STATE_LOCK_PATH, async () => {
      const state = await this.loadState();

      for (const repo of this.config.repos) {
"""

if old_try not in text:
    raise SystemExit("processPRs try start not found")
text = text.replace(old_try, new_try, 1)

# Close the withFileLock before catch — indent the saveState and close callback
old_end = """      await this.saveState(state);
    } catch (err) {
      console.error('[PRProcessor] Error:', err);
    } finally {
"""

new_end = """      await this.saveState(state);
      }, { timeoutMs: 30 * 60_000 });
    } catch (err) {
      console.error('[PRProcessor] Error:', err);
    } finally {
"""

if old_end not in text:
    raise SystemExit("processPRs try end not found")
text = text.replace(old_end, new_end, 1)

if "withStoreLock" in text:
    raise SystemExit("withStoreLock still present after patch")

DST.write_text(text, encoding="utf-8")
lines = text.count("\n") + (0 if text.endswith("\n") else 1)
print(f"Wrote {DST}")
print(f"lines: {lines}")
print("head:")
print("\n".join(text.splitlines()[:3]))
print("--- verify ---")
for i, line in enumerate(text.splitlines(), 1):
    if any(s in line for s in ("withFileLock", "withStoreLock", "PR_STATE_LOCK")):
        print(f"{i}:{line}")
