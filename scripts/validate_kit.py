#!/usr/bin/env python3
"""Offline structural validator for the Motoko Mastery Kit.

This script deliberately separates checks that are possible without a Motoko
compiler from checks that require the pinned external toolchain. It exits nonzero
only for structural errors in the artifact itself.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import tomllib

# Avoid polluting the distributable kit when importing sibling validation modules.
sys.dont_write_bytecode = True
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover
    yaml = None

try:
    import jsonschema  # type: ignore
except ImportError:  # pragma: no cover
    jsonschema = None

try:
    from check_api_surface import inspect_kit as inspect_api_surface
except ImportError:  # pragma: no cover
    inspect_api_surface = None


TEXT_SUFFIXES = {
    ".md", ".mo", ".did", ".yaml", ".yml", ".toml", ".json", ".mjs",
    ".js", ".py", ".sh", ".txt", ".example", ".gitignore",
}
SKIP_LINK_PREFIXES = (
    "http://", "https://", "mailto:", "tel:", "data:", "javascript:",
    "#", "icp:", "ipfs:", "ar:",
)
REQUIRED_APP_FILES = (
    "README.md",
    "Makefile",
    "icp.yaml",
    "mops.toml",
    "backend/canister.yaml",
    "backend/candid/backend.did",
    "backend/src/main.mo",
    "backend/src/Validation.mo",
    "test/Validation.test.mo",
    "docs/THREAT_MODEL.md",
    "docs/UPGRADE_PLAN.md",
)
EXPECTED_APP_DIRS = {
    "01_creator_proof_registry",
    "02_merkle_anchor",
    "03_license_marketplace",
    "04_bounty_board",
    "05_usage_metered_saas",
}
EXPECTED_DOCS = {f"{i:02d}_" for i in range(26)}
EXPECTED_ISSUE_COUNT = 40
EXPECTED_MOC = "1.11.1"
EXPECTED_CORE = "2.6.0"
EXPECTED_RECIPE = "@dfinity/motoko@v5.0.0"


@dataclass
class Report:
    root: Path
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    passed: Counter[str] = field(default_factory=Counter)
    stats: dict[str, Any] = field(default_factory=dict)

    def ok(self, category: str, count: int = 1) -> None:
        self.passed[category] += count

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)


def rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def iter_files(root: Path) -> Iterable[Path]:
    for path in sorted(root.rglob("*")):
        if path.is_file() and not any(part in {".git", "node_modules", ".mops", "__pycache__"} for part in path.parts):
            yield path


def is_text_file(path: Path) -> bool:
    return path.name in {"LICENSE", "Makefile"} or path.suffix.lower() in TEXT_SUFFIXES


def read_utf8(report: Report, path: Path) -> str | None:
    data = path.read_bytes()
    if b"\x00" in data:
        report.error(f"{rel(report.root, path)} contains a NUL byte")
        return None
    if b"\r\n" in data or b"\r" in data:
        report.error(f"{rel(report.root, path)} is not LF-only")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        report.error(f"{rel(report.root, path)} is not valid UTF-8: {exc}")
        return None
    if data and not data.endswith(b"\n") and path.suffix not in {".json"}:
        report.warn(f"{rel(report.root, path)} does not end with LF")
    report.ok("utf8_lf")
    return text


def strip_fenced_code(text: str) -> str:
    return re.sub(r"```.*?```", "", text, flags=re.DOTALL)


def normalize_link_target(raw: str) -> str:
    target = raw.strip().strip("<>")
    # Markdown destinations may have an optional title after whitespace.
    if target.startswith(("'", '"')):
        return target
    if " " in target and not target.startswith("./"):
        target = target.split(" ", 1)[0]
    return target


def check_markdown_links(report: Report, path: Path, text: str) -> None:
    clean = strip_fenced_code(text)
    for raw in re.findall(r"(?<!!)\[[^\]]*\]\(([^)]+)\)", clean):
        target = normalize_link_target(raw)
        if not target or target.startswith(SKIP_LINK_PREFIXES):
            continue
        target_no_anchor = target.split("#", 1)[0]
        if not target_no_anchor:
            continue
        # Ignore template placeholders and shell interpolation.
        if any(token in target_no_anchor for token in ("${", "<", ">", "{{", "}}")):
            continue
        candidate = (path.parent / target_no_anchor).resolve()
        try:
            candidate.relative_to(report.root.resolve())
        except ValueError:
            report.error(f"{rel(report.root, path)} links outside the kit: {target}")
            continue
        if not candidate.exists():
            report.error(f"{rel(report.root, path)} has broken relative link: {target}")
        else:
            report.ok("relative_links")


def balanced_delimiters(text: str, pairs: dict[str, str]) -> tuple[bool, str]:
    # Remove strings and comments for a conservative delimiter scan.
    cleaned = re.sub(r'"(?:\\.|[^"\\])*"', '""', text)
    cleaned = re.sub(r"//.*", "", cleaned)
    cleaned = re.sub(r"/\*.*?\*/", "", cleaned, flags=re.DOTALL)
    closing = {v: k for k, v in pairs.items()}
    stack: list[tuple[str, int]] = []
    for index, char in enumerate(cleaned):
        if char in pairs:
            stack.append((char, index))
        elif char in closing:
            if not stack or stack[-1][0] != closing[char]:
                return False, f"unexpected {char!r} at offset {index}"
            stack.pop()
    if stack:
        char, index = stack[-1]
        return False, f"unclosed {char!r} at offset {index}"
    return True, ""


def check_motoko(report: Report, path: Path, text: str) -> None:
    ok, reason = balanced_delimiters(text, {"(": ")", "[": "]", "{": "}"})
    if not ok:
        report.error(f"{rel(report.root, path)} delimiter error: {reason}")
    else:
        report.ok("motoko_delimiters")

    for module_path in re.findall(r'^\s*import\s+(?:\w+\s+)?"([^"]+)"\s*;', text, flags=re.MULTILINE):
        if module_path.startswith("mo:"):
            continue
        candidate = (path.parent / module_path).with_suffix(".mo")
        if not candidate.exists():
            report.error(f"{rel(report.root, path)} has unresolved local import: {module_path}")
        else:
            report.ok("motoko_imports")

    if path.name == "main.mo":
        if "persistent actor" not in text:
            report.error(f"{rel(report.root, path)} does not use a persistent actor")
        if "public type Error" not in text or "public type Result" not in text:
            report.error(f"{rel(report.root, path)} lacks explicit Error/Result API types")
        if "Map.empty" not in text:
            report.warn(f"{rel(report.root, path)} has no Map-backed state; verify persistence design")


def check_candid(report: Report, path: Path, text: str) -> None:
    ok, reason = balanced_delimiters(text, {"(": ")", "[": "]", "{": "}"})
    if not ok:
        report.error(f"{rel(report.root, path)} Candid delimiter error: {reason}")
    elif "service" not in text:
        report.error(f"{rel(report.root, path)} does not declare a Candid service")
    else:
        report.ok("candid_structure")


def parse_yaml(report: Report, path: Path, text: str) -> Any:
    if yaml is None:
        report.warn("PyYAML is unavailable; YAML parsing skipped")
        return None
    try:
        value = yaml.safe_load(text)
    except Exception as exc:
        report.error(f"{rel(report.root, path)} invalid YAML: {exc}")
        return None
    report.ok("yaml_parse")
    return value


def parse_json(report: Report, path: Path, text: str) -> Any:
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        report.error(f"{rel(report.root, path)} invalid JSON: {exc}")
        return None
    report.ok("json_parse")
    return value


def parse_toml(report: Report, path: Path, text: str) -> Any:
    try:
        value = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        report.error(f"{rel(report.root, path)} invalid TOML: {exc}")
        return None
    report.ok("toml_parse")
    return value


def parse_issue_front_matter(report: Report, path: Path, text: str) -> dict[str, Any] | None:
    match = re.match(r"\A---\n(.*?)\n---\n", text, flags=re.DOTALL)
    if not match:
        report.error(f"{rel(report.root, path)} has no valid YAML front matter")
        return None
    if yaml is None:
        return None
    try:
        data = yaml.safe_load(match.group(1))
    except Exception as exc:
        report.error(f"{rel(report.root, path)} invalid issue front matter: {exc}")
        return None
    if not isinstance(data, dict):
        report.error(f"{rel(report.root, path)} issue front matter must be a mapping")
        return None
    for key in ("title", "labels", "milestone"):
        if key not in data:
            report.error(f"{rel(report.root, path)} issue front matter missing {key!r}")
    if not isinstance(data.get("title"), str) or not data.get("title", "").strip():
        report.error(f"{rel(report.root, path)} issue title is empty")
    if not isinstance(data.get("labels"), list) or not all(isinstance(x, str) for x in data.get("labels", [])):
        report.error(f"{rel(report.root, path)} labels must be a string list")
    for heading in ("# Context", "## Scope", "## Acceptance criteria", "## Test plan", "## Dependencies"):
        if heading not in text:
            report.error(f"{rel(report.root, path)} missing section {heading!r}")
    report.ok("issue_front_matter")
    return data


def extract_declared_labels(labels_md: str) -> set[str]:
    return set(re.findall(r"`([^`]+)`", labels_md))


def extract_milestones(milestones_md: str) -> set[str]:
    # Accept both headings and bullet labels.
    result = set(re.findall(r"^##\s+(.+?)\s*$", milestones_md, flags=re.MULTILINE))
    result.update(re.findall(r"^-\s+`([^`]+)`", milestones_md, flags=re.MULTILINE))
    return result


def check_issue_backlog(report: Report) -> None:
    issue_dir = report.root / "github" / "issues"
    issues = sorted(issue_dir.glob("*.md"))
    report.stats["issue_count"] = len(issues)
    if len(issues) != EXPECTED_ISSUE_COUNT:
        report.error(f"expected {EXPECTED_ISSUE_COUNT} issue drafts, found {len(issues)}")

    numbers: list[int] = []
    titles: list[str] = []
    used_labels: set[str] = set()
    used_milestones: set[str] = set()
    for issue in issues:
        match = re.match(r"(\d{3})-", issue.name)
        if not match:
            report.error(f"{rel(report.root, issue)} does not start with a three-digit sequence")
            continue
        numbers.append(int(match.group(1)))
        text = issue.read_text(encoding="utf-8")
        data = parse_issue_front_matter(report, issue, text)
        if data:
            titles.append(data.get("title", ""))
            used_labels.update(data.get("labels", []))
            milestone = data.get("milestone")
            if isinstance(milestone, str):
                used_milestones.add(milestone)

    if numbers != list(range(1, EXPECTED_ISSUE_COUNT + 1)):
        report.error(f"issue sequence is not exactly 001..{EXPECTED_ISSUE_COUNT:03d}")
    if len(titles) != len(set(titles)):
        report.error("issue titles are not unique")

    labels_path = report.root / "github" / "labels.md"
    milestones_path = report.root / "github" / "milestones.md"
    declared_labels = extract_declared_labels(labels_path.read_text(encoding="utf-8"))
    declared_milestones = extract_milestones(milestones_path.read_text(encoding="utf-8"))
    missing_labels = sorted(used_labels - declared_labels)
    if missing_labels:
        report.error(f"issue labels missing from labels.md: {', '.join(missing_labels)}")
    missing_milestones = sorted(used_milestones - declared_milestones)
    if missing_milestones:
        report.error(f"issue milestones missing from milestones.md: {', '.join(missing_milestones)}")
    report.stats["issue_label_count"] = len(used_labels)
    report.stats["milestone_count"] = len(used_milestones)


def check_apps(report: Report) -> None:
    apps_root = report.root / "apps"
    app_dirs = {path.name for path in apps_root.iterdir() if path.is_dir()}
    if app_dirs != EXPECTED_APP_DIRS:
        report.error(f"application set mismatch: {sorted(app_dirs)}")
    report.stats["application_count"] = len(app_dirs)

    for app_name in sorted(EXPECTED_APP_DIRS):
        app = apps_root / app_name
        for required in REQUIRED_APP_FILES:
            if not (app / required).is_file():
                report.error(f"{app_name} is missing {required}")
            else:
                report.ok("app_required_files")

        mops_path = app / "mops.toml"
        if mops_path.exists():
            data = tomllib.loads(mops_path.read_text(encoding="utf-8"))
            deps = data.get("dependencies", {})
            toolchain = data.get("toolchain", {})
            if deps.get("core") != EXPECTED_CORE:
                report.error(f"{app_name} core pin is {deps.get('core')!r}, expected {EXPECTED_CORE}")
            if toolchain.get("moc") != EXPECTED_MOC:
                report.error(f"{app_name} moc pin is {toolchain.get('moc')!r}, expected {EXPECTED_MOC}")

        recipe_path = app / "backend" / "canister.yaml"
        if recipe_path.exists():
            recipe_text = recipe_path.read_text(encoding="utf-8")
            if EXPECTED_RECIPE not in recipe_text:
                report.error(f"{app_name} recipe is not pinned to {EXPECTED_RECIPE}")

        icp_path = app / "icp.yaml"
        if icp_path.exists():
            icp_text = icp_path.read_text(encoding="utf-8")
            if "$schema=" not in icp_text:
                report.warn(f"{app_name}/icp.yaml has no schema comment")
            if "backend" not in icp_text:
                report.error(f"{app_name}/icp.yaml does not declare backend canister")


def check_docs(report: Report) -> None:
    docs = sorted((report.root / "docs").glob("*.md"))
    prefixes = {path.name[:3] for path in docs if re.match(r"\d{2}_", path.name)}
    missing = sorted(EXPECTED_DOCS - prefixes)
    if missing:
        report.error(f"missing numbered docs: {missing}")
    report.stats["numbered_doc_count"] = len(prefixes)


def check_protocol(report: Report) -> None:
    protocol = report.root / "protocol"
    required = [
        "README.md", "INTEROPERABILITY.md", "package.json",
        "schemas/provenance-manifest.schema.json",
        "schemas/verification-report.schema.json",
        "examples/human-only.json", "examples/ai-assisted.json",
        "test-vectors/test-vectors.json",
        "tools/provenance-cli.mjs", "tools/provenance-cli.test.mjs",
    ]
    for item in required:
        if not (protocol / item).is_file():
            report.error(f"protocol package is missing {item}")
        else:
            report.ok("protocol_required_files")

    if jsonschema is None:
        report.warn("jsonschema is unavailable; protocol example validation skipped")
        return
    try:
        schema = json.loads((protocol / "schemas/provenance-manifest.schema.json").read_text(encoding="utf-8"))
        validator = jsonschema.Draft202012Validator(schema)
        for name in ("human-only.json", "ai-assisted.json"):
            instance = json.loads((protocol / "examples" / name).read_text(encoding="utf-8"))
            errors = sorted(validator.iter_errors(instance), key=lambda e: list(e.path))
            if errors:
                for error in errors:
                    loc = "/".join(map(str, error.path)) or "<root>"
                    report.error(f"protocol/examples/{name} schema error at {loc}: {error.message}")
            else:
                report.ok("protocol_schema_examples")
    except Exception as exc:
        report.error(f"could not validate protocol examples: {exc}")


def check_api_surface(report: Report) -> None:
    if inspect_api_surface is None:
        report.warn("check_api_surface.py could not be imported; Motoko/Candid surface check skipped")
        return
    try:
        payload = inspect_api_surface(report.root)
    except Exception as exc:
        report.error(f"Motoko/Candid API surface check failed to run: {exc}")
        return

    report.stats["public_api_method_count"] = payload.get("method_count", 0)
    if payload.get("status") == "pass":
        report.ok("motoko_candid_api_surface", int(payload.get("method_count", 0)))
        return

    for app in payload.get("applications", []):
        if not isinstance(app, dict) or app.get("status") == "pass":
            continue
        details = {
            key: app.get(key)
            for key in (
                "missing_in_candid",
                "missing_in_motoko",
                "mode_mismatches",
                "argument_count_mismatches",
            )
            if app.get(key)
        }
        report.error(f"{app.get('app')} Motoko/Candid API mismatch: {details}")


def check_scripts(report: Report) -> None:
    scripts = sorted((report.root / "scripts").iterdir())
    for path in scripts:
        if not path.is_file() or path.suffix not in {".sh", ".py"}:
            continue
        mode = path.stat().st_mode
        if not mode & stat.S_IXUSR:
            report.warn(f"{rel(report.root, path)} is not executable")
        first_line = path.read_text(encoding="utf-8").splitlines()[0]
        if not first_line.startswith("#!"):
            report.error(f"{rel(report.root, path)} has no shebang")
        else:
            report.ok("script_shebang")


def check_metadata(report: Report) -> None:
    path = report.root / "kit-metadata.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    expected = {
        "motokoCompiler": EXPECTED_MOC,
        "corePackage": EXPECTED_CORE,
        "motokoRecipe": EXPECTED_RECIPE,
        "snapshotDate": "2026-07-20",
    }
    for key, value in expected.items():
        if data.get(key) != value:
            report.error(f"kit-metadata.json {key} is {data.get(key)!r}, expected {value!r}")
    report.ok("metadata_consistency")


def run_validation(root: Path) -> Report:
    report = Report(root=root.resolve())
    if not report.root.is_dir():
        report.error(f"not a directory: {report.root}")
        return report

    files = list(iter_files(report.root))
    report.stats["file_count"] = len(files)
    report.stats["directory_count"] = sum(1 for path in report.root.rglob("*") if path.is_dir()) + 1
    report.stats["total_bytes"] = sum(path.stat().st_size for path in files)
    report.stats["total_lines"] = 0

    for path in files:
        if path.stat().st_size == 0:
            report.error(f"{rel(report.root, path)} is empty")
        if not is_text_file(path):
            continue
        text = read_utf8(report, path)
        if text is None:
            continue
        report.stats["total_lines"] += text.count("\n") + (1 if text and not text.endswith("\n") else 0)

        if path.suffix == ".md":
            check_markdown_links(report, path, text)
        elif path.suffix == ".mo":
            check_motoko(report, path, text)
        elif path.suffix == ".did":
            check_candid(report, path, text)
        elif path.suffix == ".json":
            parse_json(report, path, text)
        elif path.suffix == ".toml":
            parse_toml(report, path, text)
        elif path.suffix in {".yaml", ".yml"}:
            parse_yaml(report, path, text)

    check_metadata(report)
    check_apps(report)
    check_docs(report)
    check_protocol(report)
    check_issue_backlog(report)
    check_api_surface(report)
    check_scripts(report)

    return report


def human_size(size: int) -> str:
    units = ["B", "KiB", "MiB", "GiB"]
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{size} B"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json-report", type=Path, help="write a machine-readable report")
    args = parser.parse_args()

    report = run_validation(Path(args.root))
    payload = {
        "root": str(report.root),
        "status": "pass" if not report.errors else "fail",
        "stats": report.stats,
        "passed": dict(sorted(report.passed.items())),
        "warnings": report.warnings,
        "errors": report.errors,
    }

    print("Motoko Mastery Kit structural validation")
    print(f"Status: {payload['status'].upper()}")
    print(
        f"Files: {report.stats.get('file_count', 0)} | "
        f"Lines: {report.stats.get('total_lines', 0)} | "
        f"Size: {human_size(report.stats.get('total_bytes', 0))}"
    )
    print(
        f"Apps: {report.stats.get('application_count', 0)} | "
        f"Issues: {report.stats.get('issue_count', 0)} | "
        f"Numbered docs: {report.stats.get('numbered_doc_count', 0)}"
    )
    if report.warnings:
        print("\nWarnings:")
        for item in report.warnings:
            print(f"- {item}")
    if report.errors:
        print("\nErrors:")
        for item in report.errors:
            print(f"- {item}")
    else:
        print("\nAll offline structural checks passed.")
        print("Motoko compilation and PocketIC integration remain separate toolchain-dependent gates.")

    if args.json_report:
        args.json_report.parent.mkdir(parents=True, exist_ok=True)
        args.json_report.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"JSON report: {args.json_report}")

    return 1 if report.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
