#!/usr/bin/env python3
"""Generate a stable, path-only index for all files in the kit."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    output = root / "FILE_INDEX.md"
    paths = [
        path.relative_to(root).as_posix()
        for path in sorted(root.rglob("*"))
        if path.is_file()
        and not any(
            part in {".git", "node_modules", ".mops", ".mops-cache", ".pocket-ic", "__pycache__"}
            for part in path.parts
        )
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
