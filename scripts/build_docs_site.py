#!/usr/bin/env python3
"""Stage the kit's Markdown into a tree MkDocs can build.

The kit's documentation is not in one directory. It is next to the thing it
describes: `apps/06_distributed_llm/docs/DESIGN.md` sits with that app,
`compiler/repros/envvar-rope/README.md` sits with the reproduction it explains.
That is the right layout for a repository and the wrong one for `mkdocs`, which
wants a single `docs_dir`.

Copying into `site-src/` **at the same relative paths** resolves the conflict
without touching the sources. Every relative link between two staged pages keeps
resolving, because their relationship is unchanged — no link rewriting, and no
second copy of anything to drift.

The one exception is the root `README.md`, which becomes `index.md` so it is the
site's landing page. It sits at the same depth, so its own outbound links are
unaffected.

Run `scripts/build_docs_site.py --check` in CI to fail when a page is staged but
missing from the nav in `mkdocs.yml`, which is how a new document silently
becomes unreachable.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

# Everything staged onto the site, as glob patterns relative to the repo root.
#
# Deliberately excluded: `AGENTS.md` and `CLAUDE.md` (instructions to coding
# agents, not documentation), `FILE_INDEX.md` and `MANIFEST.sha256` (generated
# inventories that are noise on a rendered site), and anything under a
# generated directory.
PATTERNS = (
    "CONTENTS.md",
    "CHANGELOG.md",
    "VALIDATION_STATUS.md",
    "VERSION_SNAPSHOT.md",
    "BUILD_REPORT.md",
    "THIRD_PARTY_NOTICES.md",
    "docs/*.md",
    "apps/*/README.md",
    "apps/*/docs/*.md",
    "protocol/**/*.md",
    "labs/*.md",
    "compiler/*.md",
    "compiler/repros/*/README.md",
    "career/*.md",
    "github/ISSUE_BACKLOG.md",
    "github/labels.md",
    "github/milestones.md",
    # The 45 issue drafts are staged but intentionally left out of the nav: the
    # table in ISSUE_BACKLOG.md is a better index than a 45-entry sidebar, and
    # its links only resolve if the drafts are present.
    "github/issues/*.md",
    "validation/API_SURFACE.md",
)

LANDING_PAGE = "README.md"
STAGED_LANDING_PAGE = "index.md"

IGNORED_DIRS = {".git", "node_modules", ".mops", ".mops-cache", ".pocket-ic", "__pycache__", "site", "site-src"}


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def staged_pages(root: Path) -> list[Path]:
    """Repo-relative paths of every page that belongs on the site."""
    seen: set[Path] = set()
    for pattern in PATTERNS:
        for path in sorted(root.glob(pattern)):
            if not path.is_file():
                continue
            if any(part in IGNORED_DIRS for part in path.parts):
                continue
            seen.add(path.relative_to(root))
    return sorted(seen)


def stage(root: Path, out: Path) -> list[Path]:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    pages = staged_pages(root)
    for page in pages:
        destination = out / page
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / page, destination)

    shutil.copy2(root / LANDING_PAGE, out / STAGED_LANDING_PAGE)
    return pages


def nav_targets(root: Path) -> set[str]:
    """Page paths named in the `nav:` block of mkdocs.yml.

    Parsed with a regex rather than a YAML library so the check has no
    dependency of its own: it runs in `scripts/run_offline_checks.sh`, where
    PyYAML is optional and already reported as such.
    """
    config = (root / "mkdocs.yml").read_text(encoding="utf-8")
    # `nav:` runs to the next top-level key, or to the end of the file when it is
    # the last block — which it is here, so the `\Z` alternative is load-bearing.
    match = re.search(r"^nav:\s*$(.*?)(?=^\S|\Z)", config, re.MULTILINE | re.DOTALL)
    if match is None:
        raise SystemExit("mkdocs.yml has no nav: block")
    return set(re.findall(r":\s*([^\s:]+\.md)\s*$", match.group(1), re.MULTILINE))


def check_nav(root: Path, pages: list[Path]) -> int:
    """Reports pages that are staged but unreachable, and nav entries that point nowhere."""
    listed = nav_targets(root)
    staged = {page.as_posix() for page in pages} | {STAGED_LANDING_PAGE}

    # The issue drafts are indexed by ISSUE_BACKLOG.md instead of by the nav.
    unlisted = {p for p in staged - listed if not p.startswith("github/issues/")}
    missing = listed - staged

    problems = 0
    for path in sorted(unlisted):
        print(f"staged but not in the mkdocs.yml nav: {path}", file=sys.stderr)
        problems += 1
    for path in sorted(missing):
        print(f"in the mkdocs.yml nav but not staged: {path}", file=sys.stderr)
        problems += 1
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=None, help="staging directory (default: site-src)")
    parser.add_argument("--check", action="store_true", help="also verify nav coverage")
    args = parser.parse_args()

    root = repo_root()
    out = args.out or root / "site-src"

    pages = stage(root, out)
    print(f"staged {len(pages) + 1} pages into {out.relative_to(root) if out.is_relative_to(root) else out}")

    if args.check:
        problems = check_nav(root, pages)
        if problems:
            print(f"{problems} nav problem(s)", file=sys.stderr)
            return 1
        print("nav covers every staged page")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
