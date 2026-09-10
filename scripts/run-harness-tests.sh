#!/usr/bin/env bash
# Parent/agent helper: run quality-harness tests when Shell(npx/npm) is allowlisted.
set -euo pipefail
cd /work/OpenSwarm/worktree/2d671986-25db-40ef-b19c-1cc4196bebd4

echo '=== node_modules check ==='
ls -la node_modules 2>&1 | head -3
if [[ ! -e node_modules/vitest ]]; then
  echo 'vitest missing — running npm ci'
  npm ci
fi

echo '=== vitest ==='
npx vitest run \
  src/verify/qualityHarness.test.ts \
  src/cli/reviewAudit.test.ts \
  src/cli/reviewMaxHarness.smoke.test.ts \
  --reporter=verbose 2>&1 | tee /tmp/vitest-harness-out.txt
echo "vitest_exit=${PIPESTATUS[0]}"

echo '=== tsc filtered ==='
npx tsc --noEmit -p tsconfig.check.json 2>&1 \
  | rg -n "qualityHarness|reviewAudit|reviewMax|cli\.ts" \
  | head -40 \
  | tee /tmp/tsc-harness-out.txt || true
