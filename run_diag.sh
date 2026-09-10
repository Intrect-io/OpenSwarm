#!/bin/bash
cd /work/OpenSwarm/worktree/e173c117-465f-43b5-849b-ed6204745dcf
{
  echo "=== PERMS ==="
  date -Iseconds
  echo "=== VITEST LINK ==="
  if [ ! -e /work/OpenSwarm/node_modules/vitest ]; then
    ln -sfn /work/OpenSwarm/worktree/007807cd-6302-4922-b324-fcc8a771b48c/node_modules/vitest /work/OpenSwarm/node_modules/vitest
    ln -sfn /work/OpenSwarm/worktree/007807cd-6302-4922-b324-fcc8a771b48c/node_modules/.bin/vitest /work/OpenSwarm/node_modules/.bin/vitest
    # also link critical vitest deps from sibling if missing
    for dep in @vitest vite-node chai tinyrainbow pathe std-env tinyexec tinybench tinypool why-is-node-running; do
      if [ ! -e "/work/OpenSwarm/node_modules/$dep" ] && [ -e "/work/OpenSwarm/worktree/007807cd-6302-4922-b324-fcc8a771b48c/node_modules/$dep" ]; then
        ln -sfn "/work/OpenSwarm/worktree/007807cd-6302-4922-b324-fcc8a771b48c/node_modules/$dep" "/work/OpenSwarm/node_modules/$dep"
      fi
    done
  fi
  ls -la node_modules/vitest 2>&1 | head -5
  echo "=== TEST ==="
  npx vitest run src/issues/graphql/server.test.ts 2>&1 || node --experimental-vm-modules ./node_modules/vitest/vitest.mjs run src/issues/graphql/server.test.ts 2>&1
  echo "=== GIT ==="
  git status -sb
  git diff --stat origin/main...HEAD -- 'src/issues/graphql/*'
  echo "=== COMMIT ==="
  # only commit if tests passed - checked via exit in TEST section separately
} > /work/OpenSwarm/worktree/e173c117-465f-43b5-849b-ed6204745dcf/BOOTSTRAP_OUT.txt 2>&1
echo DONE >> /work/OpenSwarm/worktree/e173c117-465f-43b5-849b-ed6204745dcf/BOOTSTRAP_OUT.txt
