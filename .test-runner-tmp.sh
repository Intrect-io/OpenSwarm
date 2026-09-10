#!/bin/bash
set -euo pipefail
cd /work/OpenSwarm/worktree/c3a1fec2-e426-4677-8cdf-a7ecef8d4b62
npx vitest run \
  src/adapters/resultParsing.test.ts \
  src/adapters/tools.test.ts \
  src/cli/projectHandler.test.ts \
  src/cli/memoryCommand.coverage.test.ts \
  src/cli/workCommand.test.ts \
  src/github/ciState.test.ts \
  src/registry/sqliteStore.test.ts \
  2>&1 | tee /tmp/vitest-out.txt
python3 -c "
from src.task_state_model import OpenSwarmTaskState
from datetime import datetime, timezone
s = OpenSwarmTaskState(issueId='x', updatedAt=datetime.now(timezone.utc), topoRank=2.0, execution={'status':'todo','retryCount':'3'})
d = s.model_dump(by_alias=True)
assert d['topoRank'] == 2
assert d['execution']['retryCount'] == 3
print('py-ok')
" 2>&1 | tee -a /tmp/vitest-out.txt
