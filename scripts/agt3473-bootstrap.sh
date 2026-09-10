#!/bin/bash
# AGT-3473 bootstrap — intended to be run once Shell(**) is allowed.
set -euo pipefail
WT=/work/OpenSwarm/worktree/e173c117-465f-43b5-849b-ed6204745dcf
cd "$WT"
SHARED=/work/OpenSwarm/node_modules
SIB=/work/OpenSwarm/worktree/007807cd-6302-4922-b324-fcc8a771b48c/node_modules

if [ ! -e "$SHARED/vitest" ] && [ -d "$SIB/vitest" ]; then
  ln -sfn "$SIB/vitest" "$SHARED/vitest"
  ln -sfn "$SIB/@vitest" "$SHARED/@vitest" 2>/dev/null || true
  mkdir -p "$SHARED/.bin"
  ln -sfn "$SIB/.bin/vitest" "$SHARED/.bin/vitest" 2>/dev/null || true
  for pkg in chai tinyrainbow pathe std-env tinyexec tinyglobby tinypool tinyspy vite debug siginfo why-is-node-running estree-walker magic-string es-module-lexer rollup esbuild postcss picocolors source-map-js fdir picomatch expect-type cac; do
    if [ -d "$SIB/$pkg" ] && [ ! -e "$SHARED/$pkg" ]; then
      ln -sfn "$SIB/$pkg" "$SHARED/$pkg" || true
    fi
  done
fi

/usr/local/bin/node --experimental-vm-modules "$SHARED/vitest/vitest.mjs" run src/issues/graphql/server.test.ts --reporter=verbose
/usr/bin/git -C "$WT" add src/issues/graphql/costAnalysis.ts src/issues/graphql/server.ts src/issues/graphql/server.test.ts
/usr/bin/git -C "$WT" status -sb
/usr/bin/git -C "$WT" diff --cached --stat
