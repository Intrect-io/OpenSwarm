/** Ephemeral paths under agent worktrees — never task source / never verify input. */

/** Test/runtime outputs are never task source, including on a resumed WIP branch. */
/**
 * A Python virtualenv directory by name, at any depth: `.venv`, `venv`,
 * `.venv-verify`, `.venv.bak`, `.venv_test`, … The old list named the
 * worktree-level `.venv` link and two known siblings by exact string, so a
 * worker's `uv venv .venv_test` (cgf-portal AX-868, 2026-09-02) committed
 * 11,026 interpreter files that the purge then could not see, and the branch
 * failed the publication fence on every attempt after that.
 */
const VENV_DIR = /(?:^|\/)\.?venv[\w.-]*\//;
/** The worktree-level link/dir entry itself (`.venv`, `venv`, `.venv-verify`, `.venv.bak`) — never `venv_tools.py`. */
const VENV_ENTRY = /^\.?venv(?:[\w-]*|\.bak)$/;

export function isEphemeralWorktreeArtifact(file: string): boolean {
  return VENV_DIR.test(file)
    || VENV_ENTRY.test(file)
    || file === 'pytest-local'
    // pytest's basetemp (`pytest-of-<user>/…`) anywhere in the tree, and the
    // whole worktree-local `.trash/` quarantine (cgf-portal ships secrets under
    // `.trash/<issue>/pytest-a3/…` which is not named pytest-of-*).
    || /(?:^|\/)pytest-of-[^/]+\//.test(file)
    || /^pytest-of-[^/]+$/.test(file)
    || /^\.trash(?:\/|$)/.test(file)
    || /^\.openswarm-trash\/[^/]*-(?:pytest|verify)(?:-|\/|$)/.test(file)
    // The VEGA heartbeat takes this worktree-local process lock while syncing.
    // It is never task source and must not be carried into a WIP/PR branch.
    || file === '.vega/google_heartbeat_sync.lock'
    || /^\.openswarm\/(?:repo-snapshot\.json|repo\.graphql)$/.test(file)
    || /^\.test-tmp(?:-[^/]+)?(?:\/|$)/.test(file)
    || /^\.pytest-lathe(?:\/|$)/.test(file)
    || /^int\d+_[a-z0-9_]{8,}(?:\/|$)/i.test(file)
    // Python's tempfile.mkdtemp() draws its 8-character suffix from
    // [a-z0-9_], so `tmppcd_d3bf/` must match too (vega-plugins#36).
    || /^tmp[a-z0-9_]{8,}(?:\/|$)/i.test(file)
    // Python test-run output at any depth. A repository that ignores only
    // `coverage/` still leaves `.coverage` (and pytest-xdist's
    // `.coverage.<host>.<pid>.<n>`) trackable, so a worker's `pytest --cov`
    // reached the PR: cgf-portal#207 shipped `apps/pipelines/.coverage`.
    || /(?:^|\/)\.coverage(?:\.[^/]+)?$/.test(file)
    || /(?:^|\/)\.full-pytest\.status$/.test(file)
    || /(?:^|\/)(?:\.pytest_cache|\.hypothesis|\.mypy_cache|\.ruff_cache|__pycache__|htmlcov)(?:\/|$)/.test(file);
}

/** Collapse file paths to the shallowest directory (or file) git can rm -r. */
export function ephemeralPathspecRoots(files: string[]): string[] {
  const roots: string[] = [];
  const sorted = [...new Set(files)].sort();
  for (const file of sorted) {
    const slash = file.indexOf('/');
    const root = slash === -1 ? file : file.slice(0, slash);
    // Prefer a stable directory root when the match is under a known quarantine
    // or pytest basetemp prefix; otherwise keep the full relative path.
    let pathspec = file;
    if (/^\.trash(?:\/|$)/.test(file) || /^\.test-tmp(?:-[^/]+)?(?:\/|$)/.test(file) || /^\.pytest-lathe(?:\/|$)/.test(file)) {
      pathspec = root;
    } else {
      // One `git rm -r` per virtualenv or pytest basetemp, not one per file.
      const m = file.match(/^(.*(?:^|\/)pytest-of-[^/]+)/) ?? file.match(/^(.*?(?:^|\/)\.?venv[\w.-]*)\//);
      if (m) pathspec = m[1];
    }
    if (roots.some((r) => pathspec === r || pathspec.startsWith(`${r}/`))) continue;
    // Drop any prior root that this one supersedes.
    for (let i = roots.length - 1; i >= 0; i -= 1) {
      if (roots[i].startsWith(`${pathspec}/`)) roots.splice(i, 1);
    }
    roots.push(pathspec);
  }
  return roots;
}

