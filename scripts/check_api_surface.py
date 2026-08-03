#!/usr/bin/env python3
"""Compare public Motoko actor methods with hand-written Candid services.

This is an offline guardrail, not a substitute for compiler-generated Candid.
It checks method names, query/update mode, and top-level argument counts.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class Method:
    name: str
    mode: str
    argument_count: int


@dataclass
class AppResult:
    app: str
    motoko_methods: list[Method]
    candid_methods: list[Method]
    missing_in_candid: list[str]
    missing_in_motoko: list[str]
    mode_mismatches: list[dict[str, str]]
    argument_count_mismatches: list[dict[str, int]]

    @property
    def status(self) -> str:
        return "pass" if not (
            self.missing_in_candid
            or self.missing_in_motoko
            or self.mode_mismatches
            or self.argument_count_mismatches
        ) else "fail"


def _find_matching(text: str, opening_index: int, opening: str, closing: str) -> int:
    depth = 0
    in_string = False
    escaped = False
    index = opening_index
    while index < len(text):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue

        if char == '"':
            in_string = True
        elif text.startswith("//", index):
            newline = text.find("\n", index + 2)
            index = len(text) if newline == -1 else newline + 1
            continue
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            if end == -1:
                raise ValueError("unterminated block comment")
            index = end + 2
            continue
        elif char == opening:
            depth += 1
        elif char == closing:
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise ValueError(f"unclosed {opening!r}")


def _top_level_count(text: str) -> int:
    value = text.strip()
    if not value:
        return 0
    depth = {"(": 0, "[": 0, "{": 0, "<": 0}
    pairs = {")": "(", "]": "[", "}": "{", ">": "<"}
    count = 1
    in_string = False
    escaped = False
    for char in value:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char in depth:
            depth[char] += 1
        elif char in pairs:
            opener = pairs[char]
            depth[opener] = max(0, depth[opener] - 1)
        elif char == "," and all(level == 0 for level in depth.values()):
            count += 1
    return count


def extract_motoko_methods(text: str) -> list[Method]:
    pattern = re.compile(
        r"\bpublic\s+"
        # `shared` may appear bare (`public shared func f()`), with a caller
        # pattern (`public shared ({ caller }) func f()`), or not at all. The
        # previous pattern required the caller pattern and silently skipped
        # every method declared without one.
        r"(?P<prefix>(?:(?:shared(?:\s*\([^)]*\))?|composite|query)\s+)*)"
        r"func\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(",
        flags=re.MULTILINE,
    )
    methods: list[Method] = []
    for match in pattern.finditer(text):
        opening = match.end() - 1
        closing = _find_matching(text, opening, "(", ")")
        params = text[opening + 1:closing]
        prefix = match.group("prefix")
        mode = "query" if re.search(r"\bquery\b", prefix) else "update"
        methods.append(Method(match.group("name"), mode, _top_level_count(params)))
    return sorted(methods, key=lambda method: method.name)


def _split_top_level(text: str, separator: str) -> list[str]:
    """Splits on `separator`, ignoring separators nested inside brackets.

    A Candid service entry may return an inline `record { a: nat; b: nat }`, so
    splitting the service body on every `;` would cut a single method into
    fragments.
    """
    parts: list[str] = []
    depth = 0
    current: list[str] = []
    in_string = False
    escaped = False
    for char in text:
        if in_string:
            current.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            current.append(char)
            continue
        # Only real bracket pairs count. `<`/`>` are not brackets in Candid and
        # `>` appears in every `->`, so tracking them would push the depth
        # negative and hide every subsequent separator.
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        if char == separator and depth == 0:
            parts.append("".join(current))
            current = []
            continue
        current.append(char)
    parts.append("".join(current))
    return parts


def _strip_candid_comments(text: str) -> str:
    """Removes `//` and `///` line comments.

    `moc --idl` copies Motoko doc comments into the generated `.did`, so a
    documented public method would otherwise be parsed as part of the service
    entry that follows it.
    """
    return "\n".join(re.sub(r"//.*$", "", line) for line in text.splitlines())


def extract_candid_methods(text: str) -> list[Method]:
    text = _strip_candid_comments(text)
    service = re.search(r"\bservice\s*:\s*\{", text)
    if not service:
        raise ValueError("Candid service declaration not found")
    opening = text.find("{", service.start())
    closing = _find_matching(text, opening, "{", "}")
    body = text[opening + 1:closing]
    methods: list[Method] = []
    for raw_entry in _split_top_level(body, ";"):
        entry = raw_entry.strip()
        if not entry:
            continue
        match = re.fullmatch(
            r"(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*"
            r"\((?P<args>.*)\)\s*->\s*\((?P<returns>.*)\)\s*"
            r"(?P<query>query)?",
            entry,
            flags=re.DOTALL,
        )
        if not match:
            raise ValueError(f"unsupported Candid service entry: {entry!r}")
        mode = "query" if match.group("query") else "update"
        methods.append(Method(match.group("name"), mode, _top_level_count(match.group("args"))))
    return sorted(methods, key=lambda method: method.name)


def compare_app(app_dir: Path) -> AppResult:
    motoko_path = app_dir / "backend" / "src" / "main.mo"
    candid_path = app_dir / "backend" / "candid" / "backend.did"
    motoko = extract_motoko_methods(motoko_path.read_text(encoding="utf-8"))
    candid = extract_candid_methods(candid_path.read_text(encoding="utf-8"))
    motoko_by_name = {method.name: method for method in motoko}
    candid_by_name = {method.name: method for method in candid}

    shared = sorted(motoko_by_name.keys() & candid_by_name.keys())
    mode_mismatches = [
        {
            "method": name,
            "motoko": motoko_by_name[name].mode,
            "candid": candid_by_name[name].mode,
        }
        for name in shared
        if motoko_by_name[name].mode != candid_by_name[name].mode
    ]
    argument_count_mismatches = [
        {
            "method": name,
            "motoko": motoko_by_name[name].argument_count,
            "candid": candid_by_name[name].argument_count,
        }
        for name in shared
        if motoko_by_name[name].argument_count != candid_by_name[name].argument_count
    ]
    return AppResult(
        app=app_dir.name,
        motoko_methods=motoko,
        candid_methods=candid,
        missing_in_candid=sorted(motoko_by_name.keys() - candid_by_name.keys()),
        missing_in_motoko=sorted(candid_by_name.keys() - motoko_by_name.keys()),
        mode_mismatches=mode_mismatches,
        argument_count_mismatches=argument_count_mismatches,
    )


def inspect_kit(root: Path) -> dict[str, object]:
    apps_root = root / "apps"
    results = [compare_app(path) for path in sorted(apps_root.iterdir()) if path.is_dir()]
    return {
        "check": "motoko-candid-api-surface",
        "scope": "method names, query/update modes, and top-level argument counts",
        "limitation": "This does not replace compiler-generated Candid or compatibility checking.",
        "status": "pass" if all(result.status == "pass" for result in results) else "fail",
        "application_count": len(results),
        "method_count": sum(len(result.motoko_methods) for result in results),
        "applications": [
            {
                **asdict(result),
                "status": result.status,
            }
            for result in results
        ],
    }


def render_markdown(payload: dict[str, object]) -> str:
    applications = payload["applications"]
    assert isinstance(applications, list)
    lines = [
        "# Motoko / Candid API Surface Check",
        "",
        f"Status: **{str(payload['status']).upper()}**",
        "",
        "Checked: public method names, query/update modes, and top-level argument counts.",
        "This is an offline guardrail and does not replace compiler-generated Candid or upgrade compatibility checks.",
        "",
        "| App | Methods | Status |",
        "|---|---:|---|",
    ]
    for app in applications:
        assert isinstance(app, dict)
        methods = app.get("motoko_methods", [])
        lines.append(f"| `{app['app']}` | {len(methods)} | {str(app['status']).upper()} |")
    lines.extend(["", "## Per-application methods", ""])
    for app in applications:
        assert isinstance(app, dict)
        lines.append(f"### {app['app']}")
        lines.append("")
        for method in app.get("motoko_methods", []):
            assert isinstance(method, dict)
            lines.append(
                f"- `{method['name']}`: {method['mode']}, {method['argument_count']} argument(s)"
            )
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--json-report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    args = parser.parse_args()

    payload = inspect_kit(args.root.resolve())
    if args.json_report:
        args.json_report.parent.mkdir(parents=True, exist_ok=True)
        args.json_report.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if args.markdown_report:
        args.markdown_report.parent.mkdir(parents=True, exist_ok=True)
        args.markdown_report.write_text(render_markdown(payload), encoding="utf-8")

    print(f"Motoko/Candid API surface: {str(payload['status']).upper()}")
    print(f"Applications: {payload['application_count']} | Methods: {payload['method_count']}")
    if payload["status"] != "pass":
        for app in payload["applications"]:  # type: ignore[index]
            if app["status"] != "pass":
                print(json.dumps(app, indent=2, ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
