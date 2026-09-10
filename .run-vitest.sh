#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo "=== diagnose ==="
command -v node npm || true
node -v || true
npm -v || true
ls -la node_modules 2>&1 | head -10
find /work/OpenSwarm -maxdepth 3 -name 'vitest.mjs' 2>/dev/null | head
find /home -maxdepth 4 -name 'vitest.mjs' 2>/dev/null | head
echo "=== ensure deps ==="
if [[ ! -f node_modules/vitest/vitest.mjs && ! -f /work/OpenSwarm/node_modules/vitest/vitest.mjs ]]; then
  npm ci || npm install
fi
echo "=== vitest ==="
node --experimental-vm-modules node_modules/vitest/vitest.mjs run \
  --reporter=verbose \
  src/core/eventHub.test.ts \
  src/tui/components/LogLine.test.ts \
  src/adapters/chatStream.test.ts \
  src/runners/cliRunner.test.ts \
  src/adapters/__tests__/streamBuffer.test.ts
echo "=== tsc filter ==="
npx tsc --noEmit -p tsconfig.check.json 2>&1 | rg 'eventHub|LogLine|chatBackend|discordPair|codexResponses|chatStream' | head -40 || true
