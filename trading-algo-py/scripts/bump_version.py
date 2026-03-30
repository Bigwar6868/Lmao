"""Bump the patch version in pyproject.toml.

Usage:
    python scripts/bump_version.py          # bump patch (2.0.1 → 2.0.2)
    python scripts/bump_version.py minor    # bump minor (2.0.1 → 2.1.0)
    python scripts/bump_version.py major    # bump major (2.0.1 → 3.0.0)
    python scripts/bump_version.py set 2.5.0  # set exact version
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def get_version() -> str:
    text = PYPROJECT.read_text()
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    return match.group(1) if match else "0.0.0"


def set_version(new_version: str) -> None:
    text = PYPROJECT.read_text()
    updated = re.sub(
        r'^(version\s*=\s*)"[^"]+"',
        f'\\1"{new_version}"',
        text,
        count=1,
        flags=re.MULTILINE,
    )
    PYPROJECT.write_text(updated)


def bump(part: str = "patch") -> str:
    current = get_version()
    parts = [int(x) for x in current.split(".")[:3]]
    while len(parts) < 3:
        parts.append(0)

    if part == "major":
        parts = [parts[0] + 1, 0, 0]
    elif part == "minor":
        parts = [parts[0], parts[1] + 1, 0]
    else:  # patch
        parts = [parts[0], parts[1], parts[2] + 1]

    new_version = ".".join(str(p) for p in parts)
    set_version(new_version)
    return new_version


def main() -> None:
    old = get_version()

    if len(sys.argv) > 1:
        cmd = sys.argv[1]
        if cmd == "set" and len(sys.argv) > 2:
            set_version(sys.argv[2])
            print(f"{old} → {sys.argv[2]}")
            return
        elif cmd in ("major", "minor", "patch"):
            new = bump(cmd)
        else:
            print(f"Usage: {sys.argv[0]} [major|minor|patch|set <version>]")
            sys.exit(1)
    else:
        new = bump("patch")

    print(f"{old} → {new}")


if __name__ == "__main__":
    main()
