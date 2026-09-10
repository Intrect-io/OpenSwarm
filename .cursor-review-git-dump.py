#!/usr/bin/env python3
"""Temporary helper to dump git evidence when Shell is blocked for the agent."""
import zlib
import subprocess
from pathlib import Path

ROOT = Path("/work/OpenSwarm/worktree/c3a1fec2-e426-4677-8cdf-a7ecef8d4b62")
OUT = ROOT / ".cursor-review-git-evidence.txt"


def read_loose(sha: str) -> bytes | None:
    p = Path(f"/work/OpenSwarm/.git/objects/{sha[:2]}/{sha[2:]}")
    if not p.exists():
        return None
    return zlib.decompress(p.read_bytes())


def main() -> None:
    lines: list[str] = []
    cmds = [
        ["git", "status"],
        ["git", "log", "--oneline", "-10"],
        ["git", "diff", "--stat"],
        ["git", "diff"],
        ["git", "diff", "--cached"],
        ["git", "diff", "origin/main...HEAD", "--stat"],
        ["git", "diff", "origin/main...HEAD", "--name-only"],
        ["git", "log", "origin/main..HEAD", "--oneline"],
        ["git", "diff", "origin/main...HEAD"],
    ]
    for cmd in cmds:
        lines.append("=" * 80)
        lines.append("CMD: " + " ".join(cmd))
        lines.append("=" * 80)
        try:
            r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=120)
            lines.append(r.stdout)
            if r.stderr:
                lines.append("STDERR:\n" + r.stderr)
            lines.append(f"exit={r.returncode}")
        except Exception as e:
            lines.append(f"ERROR: {e}")

    for sha in [
        "0ffdc093bdf9a365c1921d0f9b55bb57efca624c",
        "dff3e7c98c73fe3a8df73ae087921d5f017dfa0b",
        "f1fd3aef77d865dcd135fccab23105e6a3889534",
        "75cddfb7b3151c7157697d6945f1352be28422bb",
    ]:
        lines.append("=" * 80)
        lines.append(f"OBJECT {sha}")
        data = read_loose(sha)
        if data is None:
            lines.append("not a loose object")
            continue
        nul = data.find(b"\x00")
        header = data[:nul].decode()
        body = data[nul + 1 :]
        lines.append(header)
        if header.startswith("commit"):
            lines.append(body.decode("utf-8", errors="replace"))

    # also git show --stat for branch commits
    for sha in [
        "0ffdc093bdf9a365c1921d0f9b55bb57efca624c",
        "dff3e7c98c73fe3a8df73ae087921d5f017dfa0b",
    ]:
        lines.append("=" * 80)
        lines.append(f"CMD: git show --stat {sha}")
        try:
            r = subprocess.run(
                ["git", "show", "--stat", "--format=fuller", sha],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=60,
            )
            lines.append(r.stdout)
            if r.stderr:
                lines.append("STDERR:\n" + r.stderr)
        except Exception as e:
            lines.append(f"ERROR: {e}")

    targets = [
        "src/adapters/resultParsing.ts",
        "src/adapters/tools.ts",
        "src/cli/memoryCommand.ts",
        "src/cli/projectHandler.ts",
        "src/cli/workCommand.ts",
        "src/github/github.ts",
        "src/registry/sqliteStore.ts",
        "src/task_state_model.py",
    ]
    for f in targets:
        lines.append("=" * 80)
        lines.append(f"CMD: git diff origin/main...HEAD -- {f}")
        try:
            r = subprocess.run(
                ["git", "diff", "origin/main...HEAD", "--", f],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=60,
            )
            lines.append(r.stdout or "(empty)")
            if r.stderr:
                lines.append("STDERR:\n" + r.stderr)
        except Exception as e:
            lines.append(f"ERROR: {e}")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
