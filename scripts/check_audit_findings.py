#!/usr/bin/env python3
"""Check the security-audit findings register (docs/33_SECURITY_AUDIT.md).

The register is the artifact an independent audit leaves behind, and the gate
the launch checklist reads. This script enforces the rules the issue names:

    * every finding has an id, a title, a known severity and status, a
      component and evidence;
    * no critical or high finding may be `open` — "no unresolved critical/high
      finding at production launch" is a CI failure, not a promise;
    * an `accepted` risk has an owner, a rationale and an expiry that has not
      passed;
    * a `remediated` finding names its remediation and its re-test;
    * a `false-positive` finding says why.

Usage:
    scripts/check_audit_findings.py .
    scripts/check_audit_findings.py . --self-test
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import sys
from pathlib import Path

SEVERITIES = {"critical", "high", "medium", "low", "info"}
STATUSES = {"open", "remediated", "accepted", "false-positive"}
REGISTER = Path("security/audit/findings.json")
BLOCKING = {"critical", "high"}


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def check(root: Path) -> list[str]:
    errors: list[str] = []
    register = load(root / REGISTER)
    if register.get("format") != "motoko-lab:audit-findings:v1":
        errors.append(f"{REGISTER}: unknown format {register.get('format')!r}")
    audit = register.get("audit") or {}
    for field in ("commit", "auditor", "reportUri"):
        if field not in audit:
            errors.append(f"{REGISTER}: audit.{field} is missing (empty is allowed until the engagement starts)")
    if sorted(register.get("severities", [])) != sorted(SEVERITIES):
        errors.append(f"{REGISTER}: severities must be exactly {sorted(SEVERITIES)}")

    today = dt.date.today()
    seen: set[str] = set()
    for index, finding in enumerate(register.get("findings", [])):
        label = finding.get("id") or f"findings[{index}]"
        if not finding.get("id"):
            errors.append(f"{label}: every finding needs an id")
        elif finding["id"] in seen:
            errors.append(f"{label}: duplicate id")
        seen.add(finding.get("id", label))
        for field in ("title", "component", "evidence"):
            if not finding.get(field):
                errors.append(f"{label}: {field} is required")
        severity = finding.get("severity")
        status = finding.get("status")
        if severity not in SEVERITIES:
            errors.append(f"{label}: unknown severity {severity!r}")
        if status not in STATUSES:
            errors.append(f"{label}: unknown status {status!r}")
            continue
        if severity in BLOCKING and status == "open":
            errors.append(f"{label}: {severity} finding is open; production launch is blocked until it is remediated or accepted")
        if status == "accepted":
            if not finding.get("owner"):
                errors.append(f"{label}: an accepted risk needs an owner")
            if not finding.get("rationale"):
                errors.append(f"{label}: an accepted risk needs a rationale")
            expiry = finding.get("expiry")
            if not expiry:
                errors.append(f"{label}: an accepted risk needs an expiry")
            else:
                try:
                    if dt.date.fromisoformat(expiry) < today:
                        errors.append(f"{label}: the acceptance expired on {expiry}; re-review it")
                except ValueError:
                    errors.append(f"{label}: expiry must be an ISO date, got {expiry!r}")
        if status == "remediated" and (not finding.get("remediation") or not finding.get("retest")):
            errors.append(f"{label}: a remediated finding names its remediation and its re-test")
        if status == "false-positive" and not finding.get("rationale"):
            errors.append(f"{label}: a false positive needs a rationale")
    return errors


def self_test(root: Path) -> int:
    path = root / REGISTER
    original_text = path.read_text(encoding="utf-8")
    original = json.loads(original_text)
    if check(root):
        print("self-test cannot run: the real register already fails", file=sys.stderr)
        return 1

    def mutated(change) -> list[str]:
        candidate = copy.deepcopy(original)
        change(candidate)
        path.write_text(json.dumps(candidate, indent=2) + "\n", encoding="utf-8")
        try:
            return check(root)
        finally:
            # Restore the exact bytes, not a re-serialization: running the
            # self-test must not dirty the working tree.
            path.write_text(original_text, encoding="utf-8")

    def with_finding(**fields):
        def change(candidate):
            candidate["findings"].append({
                "id": "T-001", "title": "test", "component": "apps/01", "evidence": "docs/05",
                **fields,
            })
        return change

    cases = [
        ("an open high finding blocks the launch",
         with_finding(severity="high", status="open")),
        ("an accepted risk without an owner is refused",
         with_finding(severity="medium", status="accepted", rationale="x", expiry="2099-01-01")),
        ("an expired acceptance is refused",
         with_finding(severity="medium", status="accepted", owner="ops", rationale="x", expiry="2000-01-01")),
        ("a remediated finding without a re-test is refused",
         with_finding(severity="medium", status="remediated", remediation="done")),
        ("an unknown severity is refused",
         with_finding(severity="urgent", status="open")),
    ]
    failures = 0
    for description, change in cases:
        errors = mutated(change)
        if errors:
            print(f"  ok  [self-test] {description}")
        else:
            failures += 1
            print(f"  FAIL [self-test] {description}: the mutation was not caught")
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, nargs="?", default=Path(__file__).resolve().parents[1])
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()

    print("Security audit findings register")
    errors = check(root)
    if errors:
        for error in errors:
            print(f"  FAIL {error}")
        print(f"Status: FAIL ({len(errors)} problem(s))")
        return 1
    register = load(root / REGISTER)
    counts: dict[str, int] = {}
    for finding in register["findings"]:
        counts[finding["severity"]] = counts.get(finding["severity"], 0) + 1
    print(f"Findings: {len(register['findings'])}" + (f" ({counts})" if counts else ""))
    print(f"Auditor: {register['audit']['auditor'] or 'not commissioned yet'}")
    print("Status: PASS")
    if args.self_test:
        return self_test(root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
