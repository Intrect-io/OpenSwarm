#!/bin/bash
# Triggered on afterFileEdit — symlink vitest + run GraphQL cost tests.
set -uo pipefail
ROOT=/work/OpenSwarm/worktree/e173c117-465f-43b5-849b-ed6204745dcf
OUT="$ROOT/HOOK_TEST_OUT.txt"
exec >"$OUT" 2>&1
echo "=== HOOK START $(date -Iseconds) ==="
cd "$ROOT" || exit 1
SIB=/work/OpenSwarm/worktree/007807cd-6302-4922-b324-fcc8a771b48c/node_modules
SHARED=/work/OpenSwarm/node_modules

echo "=== NODE ==="
command -v node; node -v; command -v npm; npm -v; command -v npx

echo "=== VITEST LINK ==="
if [ ! -e "$SHARED/vitest" ] && [ -d "$SIB/vitest" ]; then
  ln -sfn "$SIB/vitest" "$SHARED/vitest" && echo "linked vitest"
  ln -sfn "$SIB/@vitest" "$SHARED/@vitest" 2>/dev/null || true
  mkdir -p "$SHARED/.bin"
  ln -sfn "$SIB/.bin/vitest" "$SHARED/.bin/vitest" 2>/dev/null || true
  for pkg in chai tinyrainbow pathe std-env tinyexec tinyglobby tinypool tinyspy vite debug siginfo why-is-node-running estree-walker magic-string es-module-lexer rollup esbuild postcss picocolors source-map-js fdir picomatch expect-type cac vite-node tinypool obug; do
    if [ -d "$SIB/$pkg" ] && [ ! -e "$SHARED/$pkg" ]; then
      ln -sfn "$SIB/$pkg" "$SHARED/$pkg" || true
    fi
  done
  # link @vitest/* packages
  if [ -d "$SIB/@vitest" ]; then
    mkdir -p "$SHARED/@vitest"
    for d in "$SIB/@vitest"/*; do
      [ -e "$d" ] || continue
      base=$(basename "$d")
      [ -e "$SHARED/@vitest/$base" ] || ln -sfn "$d" "$SHARED/@vitest/$base" || true
    done
  fi
fi
ls -la "$SHARED/vitest" 2>&1 | head -5

echo "=== VITEST ==="
npx vitest run src/issues/graphql/server.test.ts --reporter=verbose 2>&1 \
  || /usr/local/bin/node --experimental-vm-modules "$SHARED/vitest/vitest.mjs" run src/issues/graphql/server.test.ts --reporter=verbose 2>&1

echo "=== SMOKE ==="
/usr/local/bin/node --import tsx scripts/run-cost-analysis-smoke.mjs 2>&1 \
  || /usr/local/bin/node scripts/run-cost-analysis-smoke.mjs 2>&1

echo "=== GIT ==="
/usr/bin/git -C "$ROOT" status -sb
/usr/bin/git -C "$ROOT" diff --stat -- src/issues/graphql/
echo "=== HOOK DONE ==="
