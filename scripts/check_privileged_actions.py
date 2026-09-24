#!/usr/bin/env python3
"""Check that every privileged canister method is in the governance inventory.

docs/26_GOVERNANCE_DECISION_RECORD.md lists every public method that only a
privileged principal may call, because a governance decision about who holds
those powers is only as good as the list of powers it covers. A method added
behind a controller check and missing from the list is a power nobody decided
about, so this fails the build instead of letting the list drift.

A method is privileged when its body consults one of the gates the kit uses:

    Principal.isController / isController(...)   -- the replica's controller list
    requireOwner(...) / isOwner(...)              -- app 06's first-caller owner
    switch (controller) { ... }                   -- app 06's worker, same pattern

The inventory is the Markdown table whose rows start with "| `app` | `method` |".

Usage:
    scripts/check_privileged_actions.py .
    scripts/check_privileged_actions.py . --self-test
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

DOC = Path("docs/26_GOVERNANCE_DECISION_RECORD.md")
GATES = re.compile(r"\bisController\s*\(|\brequireOwner\s*\(|\bisOwner\s*\(|switch\s*\(\s*controller\s*\)")
METHOD = re.compile(
    r"\bpublic\s+(?:(?:shared|query)(?:\s*\([^)]*\))?\s+|composite\s+)*func\s+(?P<name>[A-Za-z_]\w*)\s*\("
)
ROW = re.compile(r"^\|\s*`(?P<app>[^`]+)`\s*\|\s*`(?P<method>[^`]+)`\s*\|", re.MULTILINE)


def _body(text: str, start: int) -> str:
    """The brace-balanced body of the function whose signature starts at `start`."""
    opening = text.index("{", start)
    depth = 0
    for index in range(opening, len(text)):
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[opening:index + 1]
    raise ValueError("unbalanced braces")


HELPER = re.compile(r"(?<!public )\bfunc\s+(?P<name>[A-Za-z_]\w*)\s*[(<]")


def _gates(text: str) -> re.Pattern[str]:
    """The gates plus every private helper that consults one, to a fixpoint.

    `isReporter` calls `isController`, and `mayRead` does too; a method gated
    through a helper is exactly as privileged as one gated directly, and a
    detector that only saw direct calls would miss it.
    """
    names: set[str] = set()
    while True:
        pattern = GATES.pattern + "".join(rf"|\b{re.escape(name)}\s*\(" for name in sorted(names))
        gates = re.compile(pattern)
        grown = set(names)
        for match in HELPER.finditer(text):
            if match.group("name") in grown:
                continue
            try:
                body = _body(text, match.end())
            except ValueError:
                continue
            if gates.search(body):
                grown.add(match.group("name"))
        if grown == names:
            return gates
        names = grown


def privileged_methods(text: str) -> set[str]:
    gates = _gates(text)
    found = set()
    for match in METHOD.finditer(text):
        if gates.search(_body(text, match.end())):
            found.add(match.group("name"))
    return found


def scan(root: Path) -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for source in sorted((root / "apps").glob("*/**/src/main.mo")):
        if ".mops" in source.parts:
            continue
        app = source.relative_to(root / "apps").parts[0]
        for name in privileged_methods(source.read_text(encoding="utf-8")):
            found.add((app, name))
    return found


def inventory(root: Path) -> set[tuple[str, str]]:
    text = (root / DOC).read_text(encoding="utf-8")
    return {(match.group("app"), match.group("method")) for match in ROW.finditer(text)}


def self_test() -> int:
    """The gate has to bite: each of these would slip past a broken detector."""
    cases = [
        ("controller gate", "public shared ({ caller }) func a() : async () { if (not Principal.isController(caller)) return; };", {"a"}),
        ("helper gate", "public shared ({ caller }) func b() : async () { if (not isController(caller)) return; };", {"b"}),
        ("owner gate", "public shared ({ caller }) func c() : async () { switch (requireOwner(caller)) { case _ {} } };", {"c"}),
        ("first-caller gate", "public shared ({ caller }) func d() : async () { switch (controller) { case null {} } };", {"d"}),
        ("query with caller", "public query ({ caller }) func e() : async Nat { if (isController(caller)) 1 else 0 };", {"e"}),
        ("ungated", "public shared ({ caller }) func f() : async () { ignore caller; };", set()),
        ("gate in a later method only", "public func g() : async () { }; public func h() : async () { if (isOwner(x)) {} };", {"h"}),
        ("gate through a helper", "func may(p : Principal) : Bool { isController(p) }; public query ({ caller }) func i() : async Nat { if (may(caller)) 1 else 0 };", {"i"}),
        ("gate through two helpers", "func a1(p : Principal) : Bool { Principal.isController(p) }; func a2(p : Principal) : Bool { a1(p) }; public func j() : async () { if (a2(x)) {} };", {"j"}),
    ]
    failed = 0
    for label, source, expected in cases:
        actual = privileged_methods(source)
        status = "ok" if actual == expected else "FAIL"
        failed += status == "FAIL"
        print(f"  {status:4} [self-test] {label}: {sorted(actual)}")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, nargs="?", default=Path("."))
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()

    if args.self_test and self_test():
        print("Status: FAIL (self-test)")
        return 1

    code = scan(root)
    listed = inventory(root)
    missing = sorted(code - listed)
    stale = sorted(listed - code)
    for app, method in missing:
        print(f"  FAIL {app}/{method}: privileged in code, missing from {DOC}")
    for app, method in stale:
        print(f"  FAIL {app}/{method}: listed in {DOC}, not privileged in code")
    print(f"privileged methods: {len(code)} in code, {len(listed)} in the inventory")
    if missing or stale:
        print("Status: FAIL")
        return 1
    print("Status: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
