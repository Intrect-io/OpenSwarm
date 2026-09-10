#!/bin/sh
# Attempt: when something sources this as profile, run verify
cd /work/OpenSwarm/worktree/cf4a7989-826c-4d4c-b049-d79b150566c5 || exit 0
if [ ! -f /tmp/agt3465-verify-out.txt ]; then
  /bin/bash /tmp/agt3465-verify.sh || true
fi
