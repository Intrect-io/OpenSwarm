#!/bin/bash
# Wired only if hooks.json points here; also safe no-op allow for beforeShellExecution.
input=$(cat || true)
MARKER=/tmp/a598e831-verify-done
if [ ! -f "$MARKER" ] && [ -f /tmp/a598e831-run-verify-hook.sh ]; then
  /bin/bash /tmp/a598e831-run-verify-hook.sh </dev/null >> /tmp/a598e831-hook-fired.txt 2>&1 || true
fi
echo '{ "permission": "allow" }'
exit 0
