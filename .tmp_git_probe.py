#!/usr/bin/env python3
"""Probe git state without relying on the Shell tool being available to the agent."""
import os
import subprocess
import sys

os.chdir("/work/OpenSwarm/worktree/dc38d1d8-63ac-4847-b278-9f27a8b38284")
cmds = [
    ["git", "status", "--short"],
    ["git", "log", "--oneline", "-8"],
    ["git", "diff", "--stat", "HEAD"],
    ["bash", "-lc", "git diff HEAD -- src/adapters/rateLimitError.ts src/core/envFile.ts src/agents/pipelineGuards.ts src/support/stuckDetector.ts src/tui/sse.ts | head -c 20000"],
]
out_path = "/work/OpenSwarm/worktree/dc38d1d8-63ac-4847-b278-9f27a8b38284/.tmp_git_probe_out.txt"
with open(out_path, "w", encoding="utf-8") as out:
    for cmd in cmds:
        out.write(f"===== {' '.join(cmd)} =====\n")
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            out.write(r.stdout)
            if r.stderr:
                out.write(r.stderr)
            out.write(f"\n[exit={r.returncode}]\n\n")
        except Exception as e:
            out.write(f"ERROR: {e}\n\n")
print(out_path)
