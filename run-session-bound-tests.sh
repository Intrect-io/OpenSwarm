#!/usr/bin/env bash
set -euo pipefail
cd /work/OpenSwarm/worktree/11481ea4-83b4-46f7-accc-043cf5fcefb0
if [ ! -f node_modules/vitest/vitest.mjs ]; then
  npm install
fi
node --experimental-vm-modules node_modules/vitest/vitest.mjs run \
  src/support/promptHelper.test.ts \
  src/support/timeWindow.test.ts \
  src/support/workSessionRoutes.test.ts \
  src/tui/chatModel.test.ts \
  src/tui/components/ChatInput.test.tsx \
  src/tui/panels/ChatPanel.history.test.tsx \
  src/tui/panels/ChatPanel.history.test.ts \
  --reporter=verbose
