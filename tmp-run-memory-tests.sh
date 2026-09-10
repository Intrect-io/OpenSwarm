#!/usr/bin/env bash
# Run focused AGT-3445 inventory pagination tests.
set -euo pipefail
cd "$(dirname "$0")"
npm test -- \
  src/cli/memoryCommand.test.ts \
  src/cli/memoryCommand.coverage.test.ts \
  src/linear/linear.test.ts \
  src/registry/entityScanner.test.ts \
  src/registry/entityScanner.coverage.test.ts \
  src/registry/sqliteStore.test.ts
