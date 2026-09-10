#!/bin/bash
set -euo pipefail
cd /work/OpenSwarm/worktree/ec3f1416-ae3c-423f-9952-a8adee496b79
OUT=src/.agt3429-vitest-out.txt
{
  echo "=== start $(date -Iseconds) ==="
  if [ ! -f ./node_modules/vitest/vitest.mjs ] && [ ! -f /work/OpenSwarm/node_modules/vitest/vitest.mjs ]; then
    echo "=== npm install vitest ==="
    /usr/local/bin/npm install vitest@^4.0.18 @vitest/coverage-v8@^4.0.18 --no-fund --no-audit --save-dev || /usr/local/bin/npm install --no-fund --no-audit
  fi
  VITEST=/work/OpenSwarm/node_modules/vitest/vitest.mjs
  if [ ! -f "$VITEST" ]; then VITEST=./node_modules/vitest/vitest.mjs; fi
  echo "=== using VITEST=$VITEST ==="
  /usr/local/bin/node --experimental-vm-modules "$VITEST" run --reporter=verbose \
    src/runners/cliRunner.test.ts \
    src/core/eventHub.test.ts \
    src/tui/components/LogLine.test.ts \
    src/adapters/chatStream.test.ts \
    src/adapters/codexResponses.test.ts
  echo EXIT:$?
} 2>&1 | tee "$OUT"
# ensure EXIT line exists even if tee nested oddly
if ! grep -q '^EXIT:' "$OUT"; then echo EXIT:1 >> "$OUT"; fi
