#!/usr/bin/env python3
"""Check every dependency against the reviewed inventory, and emit an SBOM.

The compiler, the Mops packages, the npm tools, the replica and the CI actions
are all part of what a released canister is built from. `supply-chain/
dependencies.json` is the reviewed list: name, exact version, license, source
and maintainer for each. This script fails when the tree and the list disagree,
so a dependency cannot change — be added, bumped, or swapped by a lockfile edit
— without the change showing up as an edit to the list in the same review.

Checked:

* every Mops package in every `mops.lock` (direct and transitive, as recorded in
  the lock's `hashes`) is listed with that exact version, and every listed
  package is still used;
* every lock records a SHA-256 for every file of every package, which is what
  `mops install` verifies against ("Checking integrity");
* every license is on the allowlist, which is chosen to be compatible with the
  kit's Apache-2.0;
* the toolchain pins — `moc` and `pocket-ic` in each `mops.toml`, the npm tools
  in `scripts/bootstrap_toolchain.sh`, the harness packages in
  `tools/pocket-ic/package.json`, `didc`, the docs toolchain — are exact and
  match the list;
* every GitHub Action a workflow uses is listed at the ref it is used at.

`--sbom PATH` writes a CycloneDX 1.5 JSON SBOM of the same inventory, with a
SHA-256 per Mops package computed from the lock's per-file hashes.

Usage:
    scripts/check_supply_chain.py .
    scripts/check_supply_chain.py . --self-test --sbom validation/sbom.cdx.json
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import sys
import tomllib
from pathlib import Path

INVENTORY = Path("supply-chain/dependencies.json")


def locked_packages(root: Path) -> dict[str, dict]:
    """`name@version` -> {files: {path: sha256}, users: [project]}."""
    found: dict[str, dict] = {}
    for lock in sorted(list(root.glob("apps/*/mops.lock")) + list(root.glob("labs/*/mops.lock"))):
        data = json.loads(lock.read_text(encoding="utf-8"))
        project = lock.parent.relative_to(root).as_posix()
        for key, files in data.get("hashes", {}).items():
            entry = found.setdefault(key, {"files": {}, "users": []})
            entry["files"].update(files)
            entry["users"].append(project)
    return found


def package_digest(files: dict[str, str]) -> str:
    """One SHA-256 per package: over the sorted `path  sha256` lines of the lock."""
    lines = "".join(f"{path}  {digest}\n" for path, digest in sorted(files.items()))
    return hashlib.sha256(lines.encode("utf-8")).hexdigest()


def pins(root: Path) -> dict[str, set[str]]:
    """Every toolchain version actually pinned in the tree, by tool."""
    out: dict[str, set[str]] = {}

    def add(name: str, version: str) -> None:
        out.setdefault(name, set()).add(version)

    for toml in sorted(list(root.glob("apps/*/mops.toml")) + list(root.glob("labs/*/mops.toml"))):
        toolchain = tomllib.loads(toml.read_text(encoding="utf-8")).get("toolchain", {})
        for tool in ("moc", "pocket-ic"):
            if tool in toolchain:
                add(tool, toolchain[tool])
    setup = (root / "tools/pocket-ic/setup.mjs").read_text(encoding="utf-8")
    for constant, tool in (("PIC_SERVER_VERSION", "pocket-ic"), ("DIDC_RELEASE", "didc")):
        match = re.search(rf"{constant}\s*=\s*'([^']+)'", setup)
        if match:
            add(tool, match.group(1))
    didc = re.search(r'DIDC_RELEASE:-([^}"]+)', (root / "scripts/install_didc.sh").read_text(encoding="utf-8"))
    if didc:
        add("didc", didc.group(1))
    bootstrap = (root / "scripts/bootstrap_toolchain.sh").read_text(encoding="utf-8")
    for name, version in re.findall(r'"(@?[\w./-]+)@\$\{\w+:-([^}]+)\}"', bootstrap):
        add(name, version)
    package = json.loads((root / "tools/pocket-ic/package.json").read_text(encoding="utf-8"))
    for name, version in package.get("dependencies", {}).items():
        add(name, version)
    for line in (root / "requirements-docs.txt").read_text(encoding="utf-8").splitlines():
        match = re.match(r"^([A-Za-z0-9_.-]+)==(\S+)", line.strip())
        if match:
            add(match.group(1), match.group(2))
    return out


def actions(root: Path) -> set[tuple[str, str]]:
    used = set()
    for workflow in sorted((root / ".github/workflows").glob("*.yml")):
        for name, ref in re.findall(r"uses:\s*([\w./-]+)@([\w./-]+)", workflow.read_text(encoding="utf-8")):
            used.add((name, ref))
    return used


def check(root: Path, inventory: dict) -> list[str]:
    problems: list[str] = []
    allowed = set(inventory["allowedLicenses"])

    listed = {f"{item['name']}@{item['version']}": item for item in inventory["mops"]}
    locked = locked_packages(root)
    for key in sorted(locked.keys() - listed.keys()):
        problems.append(f"mops package {key} is locked by {', '.join(locked[key]['users'])} but not in {INVENTORY}")
    for key in sorted(listed.keys() - locked.keys()):
        problems.append(f"mops package {key} is in {INVENTORY} but no lock uses it")
    for key, entry in sorted(locked.items()):
        if not entry["files"] or not all(re.fullmatch(r"[0-9a-f]{64}", d) for d in entry["files"].values()):
            problems.append(f"mops package {key} has no SHA-256 for every file in its lock")

    reviewed = {item["name"]: item for group in ("toolchain", "npm", "python") for item in inventory[group]}
    for name, versions in sorted(pins(root).items()):
        item = reviewed.get(name)
        if item is None:
            problems.append(f"{name} is pinned ({', '.join(sorted(versions))}) but not in {INVENTORY}")
            continue
        for version in sorted(versions):
            if not re.fullmatch(r"[0-9][\w.-]*", version):
                problems.append(f"{name} is pinned to a range ({version}); pin an exact version")
            elif version != item["version"]:
                problems.append(f"{name} is pinned to {version}, {INVENTORY} reviewed {item['version']}")

    listed_actions = {(item["name"], item["ref"]) for item in inventory["actions"]}
    for name, ref in sorted(actions(root) - listed_actions):
        problems.append(f"workflow action {name}@{ref} is not in {INVENTORY}")
    for name, ref in sorted(listed_actions - actions(root)):
        problems.append(f"workflow action {name}@{ref} is in {INVENTORY} but no workflow uses it")

    for group in ("mops", "toolchain", "npm", "python", "actions"):
        for item in inventory[group]:
            if item["license"] not in allowed:
                problems.append(f"{item['name']} is licensed {item['license']}, which is not on the allowlist")
    return problems


def sbom(root: Path, inventory: dict) -> dict:
    locked = locked_packages(root)
    components = []
    for item in inventory["mops"]:
        key = f"{item['name']}@{item['version']}"
        components.append({
            "type": "library",
            "name": item["name"],
            "version": item["version"],
            "purl": f"pkg:generic/mops/{item['name']}@{item['version']}",
            "licenses": [{"license": {"id": item["license"]}}],
            "hashes": [{"alg": "SHA-256", "content": package_digest(locked[key]["files"])}] if key in locked else [],
            "externalReferences": [{"type": "vcs", "url": item["source"]}],
            "properties": [{"name": "motoko-lab:use", "value": item["use"]}],
        })
    for group, kind, purl in (("toolchain", "application", "generic"), ("npm", "library", "npm"), ("python", "library", "pypi")):
        for item in inventory[group]:
            components.append({
                "type": kind,
                "name": item["name"],
                "version": item["version"],
                "purl": f"pkg:{purl}/{item['name']}@{item['version']}",
                "licenses": [{"license": {"id": item["license"]}}],
                "externalReferences": [{"type": "vcs", "url": item["source"]}],
            })
    for item in inventory["actions"]:
        components.append({
            "type": "application",
            "name": item["name"],
            "version": item["ref"],
            "purl": f"pkg:github/{item['name']}@{item['ref']}",
            "licenses": [{"license": {"id": item["license"]}}],
        })
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "component": {"type": "application", "name": "motoko-mastery-kit", "licenses": [{"license": {"id": "Apache-2.0"}}]},
            "properties": [{"name": "motoko-lab:reviewed", "value": inventory["reviewed"]}],
        },
        "components": components,
    }


def self_test(root: Path, inventory: dict) -> int:
    """Each mutation below is a supply-chain change that must fail review."""
    cases = []

    def dropped_package(inv):
        inv["mops"] = [item for item in inv["mops"] if item["name"] != "ecdsa"]
    cases.append(("a package added without review", dropped_package, "ecdsa@8.0.1 is locked"))

    def bumped(inv):
        next(item for item in inv["mops"] if item["name"] == "sha2" and item["version"] == "0.2.5")["version"] = "0.2.4"
    cases.append(("a version changed behind the reviewer's back", bumped, "sha2@0.2.5 is locked"))

    def license_change(inv):
        next(item for item in inv["mops"] if item["name"] == "cbor")["license"] = "GPL-3.0-only"
    cases.append(("an incompatible license", license_change, "not on the allowlist"))

    def moc_review(inv):
        next(item for item in inv["toolchain"] if item["name"] == "moc")["version"] = "1.12.0"
    cases.append(("a compiler pin that differs from the reviewed one", moc_review, "moc is pinned to 1.11.1"))

    def action_drift(inv):
        next(item for item in inv["actions"] if item["name"] == "actions/checkout")["ref"] = "v6"
    cases.append(("a CI action ref that was not reviewed", action_drift, "actions/checkout@v7 is not in"))

    failed = 0
    for label, mutate, expected in cases:
        mutated = copy.deepcopy(inventory)
        mutate(mutated)
        problems = check(root, mutated)
        bit = any(expected in problem for problem in problems)
        failed += not bit
        print(f"  {'ok' if bit else 'FAIL':4} [self-test] {label}")
    return failed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, nargs="?", default=Path("."))
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--sbom", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    inventory = json.loads((root / INVENTORY).read_text(encoding="utf-8"))

    if args.self_test and self_test(root, inventory):
        print("Status: FAIL (self-test)")
        return 1
    problems = check(root, inventory)
    for problem in problems:
        print(f"  FAIL {problem}")
    counts = {group: len(inventory[group]) for group in ("mops", "toolchain", "npm", "python", "actions")}
    print("reviewed: " + ", ".join(f"{count} {group}" for group, count in counts.items()))
    if args.sbom:
        args.sbom.write_text(json.dumps(sbom(root, inventory), indent=2) + "\n", encoding="utf-8")
        print(f"SBOM: {args.sbom}")
    print("Status: " + ("FAIL" if problems else "PASS"))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
