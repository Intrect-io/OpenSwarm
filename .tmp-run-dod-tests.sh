#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x node_modules/vitest/vitest.mjs && ! -f node_modules/vitest/vitest.mjs ]]; then
  SIBLING=/work/OpenSwarm/worktree/007807cd-6302-4922-b324-fcc8a771b48c/node_modules
  if [[ -f "$SIBLING/vitest/vitest.mjs" ]]; then
    rm -rf node_modules
    ln -sfn "$SIBLING" node_modules
  else
    npm install --no-audit --no-fund
  fi
fi
exec node --experimental-vm-modules node_modules/vitest/vitest.mjs run \
  src/memory/memoryCore.test.ts \
  src/memory/memoryOps.test.ts \
  src/issues/sqliteStore.test.ts \
  src/orchestration/workflow.test.ts
