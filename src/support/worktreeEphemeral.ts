/** Ephemeral paths under agent worktrees — never task source / never verify input. */

/** Test/runtime outputs are never task source, including on a resumed WIP branch. */
/**
 * A Python virtualenv directory by name, at any depth: `.venv`, `venv`,
 * `.venv-verify`, `.venv.bak`, `.venv_test`, `.test_venv`, … The old list named the
 * worktree-level `.venv` link and two known siblings by exact string, so a
 * worker's `uv venv .venv_test` (cgf-portal AX-868, 2026-09-02) committed
 * 11,026 interpreter files that the purge then could not see, and the branch
 * failed the publication fence on every attempt after that.
 */
const VENV_DIR = /(?:^|\/)(?:\.?venv[\w.-]*|\.?test_venv)\//;
/** The worktree-level link/dir entry itself (`.venv`, `venv`, `.test_venv`, `.venv-verify`) — never `venv_tools.py`. */
const VENV_ENTRY = /^(?:\.?venv(?:[\w-]*|\.bak)|\.?test_venv)$/;

export function isEphemeralWorktreeArtifact(file: string): boolean {
  return VENV_DIR.test(file)
    || VENV_ENTRY.test(file)
    // Some verification harnesses write their basetemp under the repository
    // root as `pytest-local/<case>`. Keep the whole tree out of preserved WIP
    // and publication-scope checks; only the directory itself was ignored
    // before, so its committed children could trigger a false scope park.
    || /^pytest-local(?:\/|$)/.test(file)
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
    || /(?:^|\/)(?:\.pytest_cache|\.hypothesis|\.mypy_cache|\.ruff_cache|__pycache__|htmlcov)(?:\/|$)/.test(file)
    // The agent's own scratch, written INTO the worktree it was given. Seven
    // shapes reached main or an open PR on 2026-09-10 before this existed:
    //
    //   node_modules              symlink to /work/<repo>/node_modules, created
    //                             by worktreeManager to share one install. A
    //                             checkout that receives it cannot `npm ci`.
    //   cli.json, cursor/cli.json cursor-agent permission allow-lists granting
    //                             `Shell(**)` and `Shell(rm*)` — a repository
    //                             that ships one hands that to every checkout.
    //                             One anchored `cli.json` rule covers both; a
    //                             blanket `cursor/` rule would also swallow a
    //                             project that legitimately tracks that name.
    //   .run-tests.sh             generated runners that hardcode a container
    //   .tmp-run-dod-tests.sh     worktree UUID and `rm -rf node_modules`.
    //   .run-targeted-tests.mjs
    //   .test-runner-tmp.sh
    //   .cursor-review-git-dump.py
    //
    // `.gitignore` is the other half of this and was widened too (#601/#605/
    // #606), but it only protects repositories that carry the pattern. This
    // predicate is the daemon's own staging step, so it holds for every project
    // the daemon touches, including ones it has never committed to before.
    || file === 'node_modules'
    || /(?:^|\/)cli\.json$/.test(file)
    || /(?:^|\/)\.run-[^/]*\.(?:sh|mjs|js|py)$/.test(file)
    || /(?:^|\/)\.tmp-run-[^/]*\.(?:sh|mjs|js|py)$/.test(file)
    // Dotless too. Every rule above assumed a leading dot, and #604 put
    // `tmp-run-memory-tests.sh` on main because of it — the same script, the
    // same purpose, one character different. Anchored so a project's own
    // `scripts/tmp-run.sh` is untouched only if it is not at a path root.
    || /(?:^|\/)tmp-run-[^/]*\.(?:sh|mjs|js|py)$/.test(file)
    || /(?:^|\/)\.test-runner-tmp\.[^/]+$/.test(file)
    || /(?:^|\/)\.cursor-review-[^/]+$/.test(file);
}


const GUARD_PATH_RE = /\[(?:WARNING|CRITICAL|MINOR)\]\s+([^:\s]+):/g;
const SCOPE_LIST_RE = /outside reserved write scope:\s*(.+)$/m;

/**
 * True when a pipeline-guard / publication-scope failure only cites
 * ephemeral paths (`.test_venv/...`, `pytest-local/...`). Those parks are
 * false positives — the next heartbeat should resume the run.
 */
export function citedPathsAreEphemeral(detail: string): boolean {
  if (!detail) return false;
  const cited = [...detail.matchAll(GUARD_PATH_RE)].map((match) => match[1]);
  const scope = detail.match(SCOPE_LIST_RE)?.[1] ?? '';
  const published = scope
    ? scope.split(/,\s*/).map((part) => part.trim()).filter(Boolean)
    : [];
  const paths = [...cited, ...published];
  return paths.length > 0 && paths.every((path) => isEphemeralWorktreeArtifact(path));
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
      const m = file.match(/^(.*(?:^|\/)pytest-of-[^/]+)/) ?? file.match(/^(.*?(?:^|\/)(?:\.?venv[\w.-]*|\.?test_venv))\//);
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
