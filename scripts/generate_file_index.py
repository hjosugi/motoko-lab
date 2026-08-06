#!/usr/bin/env python3
"""Generate a stable, path-only index for all files in the kit."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path

# Kept in step with scripts/validate_kit.py and scripts/package_kit.py.
IGNORED_DIRS = {".git", "node_modules", ".mops", ".mops-cache", ".pocket-ic", "__pycache__"}
IGNORED_SEQUENCES = ((".icp", "cache"),)


def is_generated(path: Path, root: Path) -> bool:
    """True when `path` lives in a generated tree and is not kit content."""
    parts = path.relative_to(root).parts if path.is_relative_to(root) else path.parts
    if any(part in IGNORED_DIRS for part in parts):
        return True
    return any(
        parts[index:index + len(sequence)] == sequence
        for sequence in IGNORED_SEQUENCES
        for index in range(len(parts))
    )


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    output = root / "FILE_INDEX.md"
    paths = [
        path.relative_to(root).as_posix()
        for path in sorted(root.rglob("*"))
        if path.is_file()
        and not is_generated(path, root)
    ]
    if "FILE_INDEX.md" not in paths:
        paths.append("FILE_INDEX.md")
    paths = sorted(set(paths))

    groups: dict[str, list[str]] = defaultdict(list)
    for path in paths:
        top = path.split("/", 1)[0] if "/" in path else "root"
        groups[top].append(path)

    lines = [
        "# File Index",
        "",
        "このファイルはpathだけを列挙するため、各ファイルのsize/hashが変わってもindex構造は安定します。",
        "完全性確認には`MANIFEST.sha256`を使用してください。",
        "",
        f"Indexed files: **{len(paths)}**",
        "",
    ]
    order = ["root"] + sorted(key for key in groups if key != "root")
    for group in order:
        if group not in groups:
            continue
        title = "Root" if group == "root" else f"`{group}/`"
        lines.extend([f"## {title}", ""])
        lines.extend(f"- `{path}`" for path in groups[group])
        lines.append("")
    output.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    print(f"wrote {output} with {len(paths)} paths")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
