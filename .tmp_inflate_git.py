#!/usr/bin/env python3
"""Inflate a git loose object and print text (for search-only use)."""
import sys, zlib, pathlib

def main() -> None:
    path = pathlib.Path(sys.argv[1])
    data = zlib.decompress(path.read_bytes())
    # Split header / body
    nul = data.find(b"\x00")
    header = data[:nul].decode("ascii", "replace")
    body = data[nul + 1 :]
    sys.stdout.write(header + "\n")
    sys.stdout.buffer.write(body)
    if not body.endswith(b"\n"):
        sys.stdout.write("\n")

if __name__ == "__main__":
    main()
