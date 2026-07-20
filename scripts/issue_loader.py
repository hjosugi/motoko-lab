#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile

FRONT = re.compile(r"\A---\n(.*?)\n---\n", re.S)


def parse_issue(path: Path):
    text = path.read_text(encoding="utf-8")
    match = FRONT.match(text)
    if not match:
        raise ValueError(f"missing front matter: {path}")
    metadata = {}
    for line in match.group(1).splitlines():
        key, sep, raw = line.partition(":")
        if not sep:
            continue
        metadata[key.strip()] = json.loads(raw.strip())
    for required in ("title", "labels", "milestone"):
        if required not in metadata:
            raise ValueError(f"missing {required}: {path}")
    return metadata, text[match.end():]


def main() -> int:
    parser = argparse.ArgumentParser(description="Dry-run or create GitHub issues from Markdown drafts.")
    parser.add_argument("--repo", help="owner/repo; required with --apply")
    parser.add_argument("--dir", default="github/issues")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--use-milestones", action="store_true")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    issue_dir = Path(args.dir)
    paths = sorted(issue_dir.glob("*.md"))
    if args.limit is not None:
        paths = paths[: args.limit]
    if args.apply and not args.repo:
        parser.error("--repo is required with --apply")

    for path in paths:
        metadata, body = parse_issue(path)
        command = ["gh", "issue", "create", "--repo", args.repo or "OWNER/REPO", "--title", metadata["title"]]
        for label in metadata["labels"]:
            command.extend(["--label", label])
        if args.use_milestones:
            command.extend(["--milestone", metadata["milestone"]])
        if not args.apply:
            print(json.dumps({"file": str(path), "title": metadata["title"], "labels": metadata["labels"], "milestone": metadata["milestone"]}, ensure_ascii=False))
            continue
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".md", delete=False) as handle:
            handle.write(f"Milestone: {metadata['milestone']}\n\n{body}")
            body_path = handle.name
        command.extend(["--body-file", body_path])
        subprocess.run(command, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
