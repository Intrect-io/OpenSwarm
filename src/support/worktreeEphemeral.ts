/** Ephemeral paths under agent worktrees — never task source / never verify input. */

/** Test/runtime outputs are never task source, including on a resumed WIP branch. */
export function isEphemeralWorktreeArtifact(file: string): boolean {
  return file === '.venv'
    || file === '.venv-verify'
    || file === '.venv.bak'
    || file.startsWith('.venv.bak/')
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
    || /^tmp[a-z0-9]{8,}(?:\/|$)/i.test(file);
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
      const m = file.match(/^(.*(?:^|\/)pytest-of-[^/]+)/);
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

