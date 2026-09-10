#!/usr/bin/env bash
set -euo pipefail
cd /work/OpenSwarm/worktree/05210b3d-66aa-409e-976a-20cf18c43e34
ls node_modules/vitest 2>&1 | head -3 || true
if [ ! -d node_modules/vitest ]; then
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
fi
npm test -- \
  src/orchestration/decisionEngine.coverage.test.ts \
  src/orchestration/decisionEngine.test.ts \
  src/orchestration/decisionEngine.gating.test.ts \
  src/orchestration/decisionEngine.dependency.test.ts \
  src/orchestration/decisionEngine.stuck.test.ts \
  src/automation/runnerState.coverage.test.ts \
  src/automation/runnerStateBudget.test.ts \
  src/support/fileLock.test.ts \
  src/support/atomicFile.test.ts \
  src/taskState/store.test.ts
