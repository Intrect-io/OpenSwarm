#!/usr/bin/env bash
# afterFileEdit: run DoD verify once
set -euo pipefail
MARKER=/tmp/agt3489-verify-done
OUT=/tmp/agt3489-verify-out.txt
if [[ -f "$MARKER" ]]; then
  echo '{}'
  exit 0
fi
touch "$MARKER"
{
  echo "=== START $(date -Iseconds) ==="
  /bin/bash /tmp/agt3489-run.sh
  echo "=== END exit:$? ==="
} >"$OUT" 2>&1 || true
echo '{}'
