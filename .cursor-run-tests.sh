#!/usr/bin/env bash
# AGT-3489: run focused state-integrity tests + commit when ready.
set -euo pipefail
cd "$(dirname "$0")"

echo "== git status =="
/usr/bin/git status --short
/usr/bin/git log -3 --oneline

echo "== focused tests =="
/usr/local/bin/node --experimental-vm-modules node_modules/vitest/vitest.mjs run \
  src/automation/dailyReporter.retry.test.ts \
  src/linear/projectUpdater.boundedDesc.test.ts \
  src/cli/projectHandler.coverage.test.ts \
  src/__tests__/issueStore.test.ts \
  src/orchestration/workflow.coverage.test.ts \
  src/orchestration/workflow.test.ts

echo "== commit =="
/usr/bin/git add \
  src/automation/dailyReporter.ts \
  src/automation/dailyReporter.retry.test.ts \
  src/cli/projectHandler.ts \
  src/cli/projectHandler.coverage.test.ts \
  src/issues/sqliteStore.ts \
  src/orchestration/workflow.ts \
  src/orchestration/workflow.coverage.test.ts \
  src/linear/projectUpdater.ts \
  src/linear/projectUpdater.boundedDesc.test.ts \
  src/__tests__/issueStore.test.ts

/usr/bin/git commit -m "$(cat <<'EOF'
fix(state-integrity): make operational state updates transactional and outcome-aware

Retries only failed daily publications, surface registry quarantine failures,
read issue status inside write transactions, fence workflow executions against
definition replacement, and reserve project-description capacity for the
compact automation summary.

EOF
)"

/usr/bin/git status --short
/usr/bin/git log -3 --oneline
