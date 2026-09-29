#!/usr/bin/env python3
"""Check the observability inventory against the design document and the runbook.

`observability/alerts.json` is the reviewed alert inventory for #24: the signals,
their thresholds, the routing and the runbook each alert links to. A monitoring
design is only as good as the agreement between the document, the rules and the
runbook, so this fails the build when they drift apart:

* an alert that names a signal or a route that does not exist, or lacks a
  threshold, a timing or a runbook where one is required;
* a critical alert whose runbook anchor does not resolve in the operations
  runbook — an alert that pages someone with nowhere to go;
* a signal in the schema that no alert uses and that is not recorded-only with a
  stated reason;
* a threshold in `alerts.json` that disagrees with the table in
  docs/29_OBSERVABILITY.md.

`--self-test` mutates the inventory five ways and fails unless each is caught.

Usage:
    scripts/check_observability.py .
    scripts/check_observability.py . --self-test
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path

INVENTORY = Path("observability/alerts.json")
DESIGN = Path("docs/29_OBSERVABILITY.md")
RUNBOOK = Path("docs/07_OPERATIONS_RUNBOOK.md")

COMPARATORS = {"below", "above", "is_true"}
HEADING = re.compile(r"^(#{1,6})\s+(?P<title>.+?)\s*#*\s*$", re.MULTILINE)
# A design-table row whose first two cells are backticked: `alert-id` | `signal`.
TABLE_ROW = re.compile(
    r"^\|\s*`(?P<id>[^`]+)`\s*\|\s*`(?P<signal>[^`]+)`\s*\|(?P<rest>.*)\|\s*$",
    re.MULTILINE,
)
NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


def is_number(value: object) -> bool:
    """A real threshold, not a boolean: `True` is an `int` in Python."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def slug(title: str) -> str:
    """The anchor a Markdown heading gets: lowercase, punctuation dropped."""
    text = re.sub(r"`([^`]*)`", r"\1", title)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = text.strip().lower()
    text = re.sub(r"[^\w\s-]", "", text)
    return re.sub(r"\s+", "-", text)


def anchors(root: Path) -> set[str]:
    text = (root / RUNBOOK).read_text(encoding="utf-8")
    return {slug(match.group("title")) for match in HEADING.finditer(text)}


def design_thresholds(root: Path) -> dict[str, tuple[str, str]]:
    """`alert id` -> (warning cell, critical cell) from the design document."""
    text = (root / DESIGN).read_text(encoding="utf-8")
    found: dict[str, tuple[str, str]] = {}
    for match in TABLE_ROW.finditer(text):
        cells = [cell.strip() for cell in match.group("rest").split("|")]
        if len(cells) < 2:
            continue
        found[match.group("id")] = (cells[0], cells[1])
    return found


def first_number(cell: str) -> float | None:
    match = NUMBER.search(cell)
    return float(match.group()) if match else None


def validate(data: dict, root: Path) -> list[str]:
    """Every way the inventory and the documents can disagree."""
    errors: list[str] = []
    signals: dict = data.get("signals", {})
    routes: dict = data.get("routes", {})
    alerts: list = data.get("alerts", [])
    recorded_only: dict = data.get("recorded_only", {})
    runbook_anchors = anchors(root)
    doc = design_thresholds(root)

    if not isinstance(signals, dict) or not signals:
        errors.append("signals: missing or empty")
    if not isinstance(alerts, list) or not alerts:
        errors.append("alerts: missing or empty")

    seen_ids: set[str] = set()
    for rule in alerts:
        rule_id = rule.get("id", "<no id>")
        if rule_id in seen_ids:
            errors.append(f"{rule_id}: duplicate alert id")
        seen_ids.add(rule_id)
        for field in ("signal", "scope", "comparator", "warning", "critical", "for_seconds", "clear_seconds", "repeat_seconds", "route"):
            if field not in rule:
                errors.append(f"{rule_id}: missing field {field}")
        if rule.get("signal") not in signals:
            errors.append(f"{rule_id}: signal {rule.get('signal')!r} is not in the schema")
        if rule.get("route") not in routes:
            errors.append(f"{rule_id}: route {rule.get('route')!r} is not defined")
        if rule.get("comparator") not in COMPARATORS:
            errors.append(f"{rule_id}: unknown comparator {rule.get('comparator')!r}")
        if rule.get("comparator") in ("below", "above") and not (
            is_number(rule.get("warning")) and is_number(rule.get("critical"))
        ):
            errors.append(f"{rule_id}: a numeric comparator needs numeric warning and critical thresholds")
        if rule.get("comparator") == "below" and is_number(rule.get("warning")) and rule["warning"] <= rule["critical"]:
            errors.append(f"{rule_id}: 'below' rules must have warning > critical")
        if rule.get("comparator") == "above" and is_number(rule.get("warning")) and rule["warning"] >= rule["critical"]:
            errors.append(f"{rule_id}: 'above' rules must have warning < critical")
        for timing in ("for_seconds", "clear_seconds"):
            if not is_number(rule.get(timing)) or rule.get(timing, -1) < 0:
                errors.append(f"{rule_id}: {timing} must be a non-negative number")
        if not is_number(rule.get("repeat_seconds")) or rule.get("repeat_seconds", 0) <= 0:
            errors.append(f"{rule_id}: repeat_seconds must be positive")

        # Every critical alert must link to a runbook section that exists.
        critical_fires = rule.get("critical") is not False and rule.get("critical") is not None
        runbook = rule.get("runbook")
        if critical_fires or runbook:
            if not runbook:
                errors.append(f"{rule_id}: a critical alert has no runbook")
            elif "#" not in runbook:
                errors.append(f"{rule_id}: runbook {runbook!r} has no anchor")
            else:
                path, _, anchor = runbook.partition("#")
                if path != RUNBOOK.as_posix():
                    errors.append(f"{rule_id}: runbook must point into {RUNBOOK.as_posix()}, got {path!r}")
                elif anchor not in runbook_anchors:
                    errors.append(f"{rule_id}: runbook anchor #{anchor} does not resolve in {RUNBOOK.as_posix()}")

        # The design table must carry the same thresholds.
        if rule_id not in doc:
            errors.append(f"{rule_id}: not in the threshold table of {DESIGN.as_posix()}")
        else:
            warning_cell, critical_cell = doc[rule_id]
            if is_number(rule.get("warning")):
                if first_number(warning_cell) != rule["warning"]:
                    errors.append(f"{rule_id}: warning {rule['warning']} disagrees with the document ({warning_cell!r})")
            if is_number(rule.get("critical")):
                if first_number(critical_cell) != rule["critical"]:
                    errors.append(f"{rule_id}: critical {rule['critical']} disagrees with the document ({critical_cell!r})")

    # Table rows that name no alert are stale.
    for rule_id in doc:
        if rule_id not in seen_ids:
            errors.append(f"{rule_id}: in the document threshold table but not in the inventory")

    # Every signal is alerted on or recorded-only with a reason.
    referenced = {rule.get("signal") for rule in alerts}
    for name in signals:
        if name not in referenced and name not in recorded_only:
            errors.append(f"signal {name}: neither alerted on nor recorded-only")
    for name in recorded_only:
        if name not in signals:
            errors.append(f"recorded_only {name}: not a signal in the schema")
        if not str(recorded_only[name]).strip():
            errors.append(f"recorded_only {name}: has no reason")

    return errors


def self_test() -> int:
    """The check has to bite: each mutation would slip past a broken detector."""
    root = Path(__file__).resolve().parent.parent
    data = json.loads((root / INVENTORY).read_text(encoding="utf-8"))
    baseline = validate(data, root)
    if baseline:
        print("  FAIL [self-test] the unmodified inventory does not validate:")
        for error in baseline:
            print(f"       {error}")
        return 1

    def mutate(change) -> dict:
        edited = copy.deepcopy(data)
        change(edited)
        return edited

    cases = [
        ("critical alert without a runbook", lambda d: d["alerts"][0].pop("runbook")),
        ("runbook anchor that does not resolve", lambda d: d["alerts"][1].update(runbook=f"{RUNBOOK.as_posix()}#no-such-section")),
        ("threshold that disagrees with the document", lambda d: d["alerts"][0].update(warning=999)),
        ("signal neither alerted nor recorded-only", lambda d: d["signals"].update(unwatched_signal={"unit": "count"})),
        ("alert routed to an undefined route", lambda d: d["alerts"][2].update(route="nope")),
    ]
    failed = 0
    for label, change in cases:
        errors = validate(mutate(change), root)
        status = "ok" if errors else "FAIL"
        failed += status == "FAIL"
        print(f"  {status:4} [self-test] {label}: {errors[0] if errors else 'not caught'}")
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

    data = json.loads((root / INVENTORY).read_text(encoding="utf-8"))
    errors = validate(data, root)
    for error in errors:
        print(f"  FAIL {error}")
    alerts = data.get("alerts", [])
    critical = [rule for rule in alerts if rule.get("critical") not in (False, None)]
    print(f"alerts: {len(alerts)} total, {len(critical)} critical; runbook anchors: {len(anchors(root))}")
    if errors:
        print("Status: FAIL")
        return 1
    print("Status: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
