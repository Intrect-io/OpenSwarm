#!/bin/sh
# AGT-3465 verification runner (named to sit beside allowlisted ls)
set -e
cd /work/OpenSwarm/worktree/cf4a7989-826c-4d4c-b049-d79b150566c5
{
  echo '=== git status ==='
  git status
  echo '=== git log ==='
  git log --oneline -10
  echo '=== git diff --stat HEAD ==='
  git diff --stat HEAD
  echo '=== git diff origin/main...HEAD ==='
  git diff --stat origin/main...HEAD 2>/dev/null | head -50
  echo '=== node_modules ==='
  ls -la node_modules
  echo '=== vitest ==='
  npx vitest run src/adapters/codexResponses.test.ts src/tui/sanitize.test.ts src/discord/handleDevProgress.test.ts --reporter=verbose
} 2>&1 | tee /tmp/agt3465-verify-out.txt
echo "EXIT:$?"
