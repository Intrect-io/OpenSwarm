#!/bin/bash
set -euo pipefail
cd /work/OpenSwarm/worktree/f4e68fe6-777c-4115-904e-41df3bc6527e

SIBLING_NM=/work/OpenSwarm/worktree/007807cd-6302-4922-b324-fcc8a771b48c/node_modules

if [ ! -e node_modules/vitest ]; then
  if [ -d /work/OpenSwarm/node_modules/vitest ]; then
    ln -sfn /work/OpenSwarm/node_modules node_modules
  elif [ -d "$SIBLING_NM/vitest" ]; then
    # Incomplete local node_modules (runtime deps only) — replace with sibling that has vitest.
    if [ -d node_modules ] && [ ! -L node_modules ]; then
      rm -rf node_modules
    fi
    ln -sfn "$SIBLING_NM" node_modules
  else
    npm ci
  fi
fi

echo "=== VITEST (AGT-3443) ==="
node --experimental-vm-modules node_modules/vitest/vitest.mjs run \
  src/support/fileLock.test.ts \
  src/auth/openBrowser.test.ts \
  src/automation/runnerState.coverage.test.ts \
  src/github/github.test.ts \
  src/issues/graphql/resolvers.autolink.test.ts \
  src/issues/graphql/server.test.ts \
  src/telemetry/installIdStability.test.ts \
  src/telemetry/telemetry.test.ts \
  src/telemetry/telemetry.coverage.test.ts

echo "=== TSC ==="
node_modules/.bin/tsc --noEmit -p tsconfig.json
