#!/usr/bin/env python3
"""Stage the kit's Markdown into a tree MkDocs can build.

The kit's documentation is not in one directory. It is next to the thing it
describes: `apps/06_distributed_llm/docs/DESIGN.md` sits with that app,
`compiler/repros/envvar-rope/README.md` sits with the reproduction it explains.
That is the right layout for a repository and the wrong one for `mkdocs`, which
wants a single `docs_dir`.

Copying into `site-src/` **at the same relative paths** resolves the conflict
without touching the sources. Every relative link between two staged pages keeps
resolving, because their relationship is unchanged, and there is no second copy
of anything to drift.

The one exception is the root `README.md`, which becomes `index.md` so it is the
site's landing page. It sits at the same depth, so its own outbound links are
unaffected.

A link to something that is *not* a staged page — a `.mo` source file, a script,
a directory — has nowhere to resolve inside the site, so it is rewritten to the
same path on GitHub. That is what keeps `mkdocs build --strict` usable: a link
either resolves within the site or leaves it deliberately, and a typo is
neither. Without this, documentation could not link to the code it documents
without breaking the build.

Run `scripts/build_docs_site.py --check` in CI to fail when a page is staged but
missing from the nav in `mkdocs.yml`, which is how a new document silently
becomes unreachable, and `--self-test` to check the rewriter itself.
"""

from __future__ import annotations

import argparse
import os
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

# Where a link that leaves the site points instead.
REPO_URL = "https://github.com/hjosugi/motoko-lab"
REPO_REF = "main"

SKIP_LINK_PREFIXES = (
    "http://", "https://", "mailto:", "tel:", "data:", "javascript:",
    "#", "/", "icp:", "ipfs:", "ar:",
)

# One pass over a line, matching a code span or a link, whichever starts first.
# Both alternatives have to be in the same pattern: scanning for code spans
# first would tear `[`Foo.mo`](path)` apart at the backticks and miss the link,
# and scanning for links first would rewrite one written inside a code span.
#
# The destination deliberately refuses whitespace, so a parenthesis in prose
# cannot be mistaken for a link.
TOKEN = re.compile(
    r"(?P<fence>`+)(?P<code>.*?)(?P=fence)"
    r"|(?P<open>!?\[[^\]]*\]\()(?P<target>[^)\s]+)(?P<close>(?:\s+\"[^\"]*\")?\))"
)
FENCE = re.compile(r"^\s*(```|~~~)")


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


def rewrite_target(target: str, page: Path, pages: set[Path], root: Path) -> str:
    """Point a link at GitHub when it cannot resolve inside the site."""
    if not target or target.startswith(SKIP_LINK_PREFIXES):
        return target
    # Template placeholders and shell interpolation are not links.
    if any(token in target for token in ("${", "<", ">", "{{", "}}")):
        return target

    destination, separator, anchor = target.partition("#")
    if not destination:
        return target

    resolved = (root / page.parent / destination).resolve()
    try:
        relative = resolved.relative_to(root.resolve())
    except ValueError:
        # Escapes the repository entirely; leave it for MkDocs to report.
        return target

    # The landing page is the one file whose staged path differs from its
    # repository path, so a link to it needs redirecting rather than rewriting.
    if relative == Path(LANDING_PAGE):
        return os.path.relpath(STAGED_LANDING_PAGE, page.parent.as_posix()) + separator + anchor
    if relative in pages:
        return target
    if not resolved.exists():
        return target

    kind = "tree" if resolved.is_dir() else "blob"
    return f"{REPO_URL}/{kind}/{REPO_REF}/{relative.as_posix()}{separator}{anchor}"


def rewrite_links(text: str, page: Path, pages: set[Path], root: Path) -> str:
    """Rewrite off-site links, leaving fenced blocks and inline code untouched."""

    def substitute(match: re.Match[str]) -> str:
        if match.group("target") is None:  # a code span
            return match.group(0)
        return (
            match.group("open")
            + rewrite_target(match.group("target"), page, pages, root)
            + match.group("close")
        )

    output = []
    in_fence = False
    for line in text.split("\n"):
        if FENCE.match(line):
            in_fence = not in_fence
            output.append(line)
            continue
        output.append(line if in_fence else TOKEN.sub(substitute, line))
    return "\n".join(output)


def stage(root: Path, out: Path) -> list[Path]:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    pages = staged_pages(root)
    page_set = set(pages)

    def write(source: Path, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        text = (root / source).read_text(encoding="utf-8")
        destination.write_text(rewrite_links(text, source, page_set, root), encoding="utf-8")

    for page in pages:
        write(page, out / page)
    write(Path(LANDING_PAGE), out / STAGED_LANDING_PAGE)
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


# A link rewriter that quietly stops rewriting produces a site that builds
# cleanly and is full of dead links; `--strict` cannot see that, because it only
# asks whether a link resolves, not whether it was supposed to be changed. So
# the behaviour is pinned here. Every path below is one `scripts/validate_kit.py`
# already requires to exist.
BLOB = f"{REPO_URL}/blob/{REPO_REF}"
TREE = f"{REPO_URL}/tree/{REPO_REF}"
SELF_TEST_CASES: tuple[tuple[str, str, str], ...] = (
    # A staged page keeps its relative link: same tree shape, still resolves.
    ("CONTENTS.md", "[a](docs/00_START_HERE.md)", "[a](docs/00_START_HERE.md)"),
    ("CONTENTS.md", "[a](docs/00_START_HERE.md#x)", "[a](docs/00_START_HERE.md#x)"),
    # Anything that is not a page leaves the site, by file or by directory.
    ("CONTENTS.md", "[a](Makefile)", f"[a]({BLOB}/Makefile)"),
    ("CONTENTS.md", "[a](apps/)", f"[a]({TREE}/apps)"),
    ("CONTENTS.md", "[a](mkdocs.yml)", f"[a]({BLOB}/mkdocs.yml)"),
    # Resolved relative to the linking page, not to the repository root.
    ("docs/06_TESTING_CI_DEPLOYMENT.md", "[a](../Makefile)", f"[a]({BLOB}/Makefile)"),
    ("docs/06_TESTING_CI_DEPLOYMENT.md", "[a](00_START_HERE.md)", "[a](00_START_HERE.md)"),
    # The landing page is staged as index.md, so links to it are redirected.
    ("CONTENTS.md", "[a](README.md)", "[a](index.md)"),
    ("docs/06_TESTING_CI_DEPLOYMENT.md", "[a](../README.md)", "[a](../index.md)"),
    # Link text containing a code span is the common case in this kit.
    ("CONTENTS.md", "[`Makefile`](Makefile)", f"[`Makefile`]({BLOB}/Makefile)"),
    # A title after the destination survives; images are links too.
    ("CONTENTS.md", '[a](Makefile "t")', f'[a]({BLOB}/Makefile "t")'),
    ("CONTENTS.md", "![a](Makefile)", f"![a]({BLOB}/Makefile)"),
    # Code spans and fenced blocks are content, not links.
    ("CONTENTS.md", "`[a](Makefile)`", "`[a](Makefile)`"),
    ("CONTENTS.md", "```\n[a](Makefile)\n```", "```\n[a](Makefile)\n```"),
    # External, absolute, and unresolvable targets are left for MkDocs to judge.
    ("CONTENTS.md", "[a](https://example.test/x)", "[a](https://example.test/x)"),
    ("CONTENTS.md", "[a](/Makefile)", "[a](/Makefile)"),
    ("CONTENTS.md", "[a](no/such/file.md)", "[a](no/such/file.md)"),
)


def self_test(root: Path) -> int:
    pages = set(staged_pages(root))
    failures = 0
    for page, source, expected in SELF_TEST_CASES:
        actual = rewrite_links(source, Path(page), pages, root)
        if actual == expected:
            continue
        failures += 1
        print(f"FAIL {page}: {source!r}\n  expected {expected!r}\n  actual   {actual!r}", file=sys.stderr)
    total = len(SELF_TEST_CASES)
    print(f"link rewriter self-test: {total - failures}/{total} cases")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=None, help="staging directory (default: site-src)")
    parser.add_argument("--check", action="store_true", help="also verify nav coverage")
    parser.add_argument("--self-test", action="store_true", help="check the link rewriter, then exit")
    args = parser.parse_args()

    root = repo_root()
    if args.self_test:
        return self_test(root)

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
