#!/usr/bin/env python3
"""Check every app's Candid interface for drift and for breaking changes.

Two questions, answered separately because they fail for different reasons:

1. **Drift.** Does the committed `.did` still match what the pinned compiler
   emits from the Motoko source? A hand-edited or stale interface file is a lie
   that only surfaces when a client generates bindings from it.

2. **Compatibility.** Is the current interface a Candid subtype of the one in the
   last release? A canister upgrade replaces the service behind a principal that
   clients already hold, so an interface that is not a subtype breaks callers
   that were written against the release.

The baseline is the git tag itself. Every `.did` is in the tagged tree, which is
immutable and already published, so there is nothing to copy into the repository
and nothing that can drift out of step with what was actually released.

`didc` decides both questions; this script decides which of its answers are
allowed. That distinction matters in one place. `didc check` exits 0 for a change
that adds a variant tag to a *result*, while printing

    FIX ME! ... via special opt rule.
    This means the sender and receiver type has diverged, and can cause data loss

because Candid's special `opt` rule lets an old client decode the unknown tag as
`null` rather than trap. The call succeeds and the client silently sees nothing.
That is a compatibility break in every sense that matters to an operator, so a
`FIX ME!` is reported as a break here even though the exit code is 0.

Usage:

    scripts/check_candid_compat.py .                      # drift + latest tag
    scripts/check_candid_compat.py . --baseline v2026.07.20
    scripts/check_candid_compat.py . --self-test          # prove the check bites
    scripts/check_candid_compat.py . --json-report validation/candid-compat.json
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

# The `FIX ME!` banner didc prints for a change that type checks but loses data.
DIVERGENCE_MARKER = "FIX ME!"

FIXTURE_DIR = "validation/candid-fixtures"


@dataclass
class Canister:
    app: str
    name: str
    main: Path
    candid: Path

    @property
    def label(self) -> str:
        return f"{self.app}/{self.name}"


@dataclass
class Finding:
    canister: str
    check: str
    status: str
    detail: str = ""

    @property
    def failed(self) -> bool:
        return self.status == "fail"


@dataclass
class Report:
    baseline: str | None
    findings: list[Finding] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)

    def add(self, canister: str, check: str, status: str, detail: str = "") -> Finding:
        finding = Finding(canister=canister, check=check, status=status, detail=detail)
        self.findings.append(finding)
        return finding

    @property
    def failures(self) -> list[Finding]:
        return [f for f in self.findings if f.failed]

    @property
    def status(self) -> str:
        return "fail" if self.failures else "pass"


# ------------------------------------------------------------------ tools --


def find_tool(explicit: str | None, env: str, candidates: list[Path], name: str) -> Path | None:
    if explicit:
        return Path(explicit)
    if os.environ.get(env):
        return Path(os.environ[env])
    on_path = shutil.which(name)
    if on_path:
        return Path(on_path)
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def find_moc(root: Path, explicit: str | None) -> Path | None:
    """The pinned compiler. `mops toolchain bin moc` is the normal answer; the
    cache path is the fallback for an environment that cannot reach the registry
    to run `mops` at all."""
    if explicit:
        return Path(explicit)
    if os.environ.get("MOC"):
        return Path(os.environ["MOC"])
    try:
        out = subprocess.run(
            ["mops", "toolchain", "bin", "moc"],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        if out:
            return Path(out)
    except (OSError, subprocess.CalledProcessError):
        pass
    cache = Path.home() / ".cache" / "mops" / "moc"
    if cache.is_dir():
        for version in sorted(cache.iterdir(), reverse=True):
            candidate = version / "moc"
            if candidate.is_file():
                return candidate
    return None


def toolchain_prefix() -> Path:
    """Mirrors `motoko_toolchain_prefix` in `scripts/toolchain_env.sh`, which is
    where `install_didc.sh` puts the binary when the global npm prefix is not
    writable — the normal case in a sandbox or on a CI runner."""
    override = os.environ.get("MOTOKO_TOOLCHAIN_PREFIX")
    if override:
        return Path(override)
    data_home = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(data_home) / "motoko-lab" / "npm"


def find_didc(root: Path, explicit: str | None) -> Path | None:
    return find_tool(
        explicit,
        "DIDC",
        [
            toolchain_prefix() / "bin" / "didc",
            root / "apps" / "06_distributed_llm" / "tools" / ".pocket-ic" / "didc",
        ],
        "didc",
    )


def run_didc(didc: Path, args: list[str]) -> tuple[int, str]:
    result = subprocess.run([str(didc), *args], capture_output=True, text=True)
    return result.returncode, (result.stdout + result.stderr).strip()


# ----------------------------------------------------------- discovery --


def canisters_of(app: Path) -> list[Canister]:
    """Canisters declared in an app's `mops.toml`.

    Several may share one source file — app 06 deploys the same worker four
    times — so the list is deduplicated on (main, candid) to avoid checking the
    identical pair repeatedly.
    """
    manifest = app / "mops.toml"
    if not manifest.is_file():
        return []
    data = tomllib.loads(manifest.read_text(encoding="utf-8"))
    seen: set[tuple[str, str]] = set()
    out: list[Canister] = []
    for name, entry in sorted(data.get("canisters", {}).items()):
        main = entry.get("main")
        candid = entry.get("candid")
        if not main or not candid:
            continue
        key = (main, candid)
        if key in seen:
            continue
        seen.add(key)
        out.append(Canister(app=app.name, name=name, main=app / main, candid=app / candid))
    return out


def vendored_packages(app: Path, root: Path) -> dict[str, Path]:
    """Every vendored Mops package, which `moc --idl` needs on the package path.

    The app's own `.mops/` is what `mops install` and `vendor_core_offline.sh`
    populate. The kit-wide `.mops-cache/` holds the same packages, downloaded
    once by the vendor script, and it lets this check run against an app whose
    `.mops/` was cleared — which `package_kit.py` does on every release build.

    Every package is passed, not only `mo:core`: an app that imports anything
    else — `apps/01_creator_proof_registry` imports `mo:sha2` for on-chain
    commitment verification — fails to compile with a partial package path, and
    a compile failure here reads as "no interface to compare", which would let
    real drift through unnoticed.

    `.mops/` wins over `.mops-cache/` for the same package name, because that is
    the tree the app actually builds against.
    """
    found: dict[str, Path] = {}
    for base in (app / ".mops", root / ".mops-cache"):
        if not base.is_dir():
            continue
        for candidate in sorted(base.glob("*@*/src")):
            name = candidate.parent.name.split("@", 1)[0]
            found.setdefault(name, candidate)
    return found


# -------------------------------------------------------------- checks --


def generate_did(moc: Path, canister: Canister, app: Path, root: Path, out_dir: Path) -> tuple[Path | None, str]:
    packages = vendored_packages(app, root)
    if "core" not in packages:
        return None, f"no vendored mo:core for {app.name}; run scripts/vendor_core_offline.sh"
    target = out_dir / f"{canister.app}.{canister.name}.did"
    command = [str(moc), "--idl"]
    for name, src in sorted(packages.items()):
        command += ["--package", name, str(src)]
    command += ["-o", str(target), str(canister.main)]
    result = subprocess.run(command, cwd=app, capture_output=True, text=True)
    if result.returncode != 0:
        return None, (result.stdout + result.stderr).strip()
    return target, ""


def check_drift(didc: Path, generated: Path, committed: Path) -> tuple[str, str]:
    """Structural equality, not a textual diff.

    `didc check -s` compares the types rather than the bytes, so reordering a
    declaration or rewrapping a comment is not reported as drift while an actual
    change of shape is.
    """
    code, output = run_didc(didc, ["check", "-s", str(generated), str(committed)])
    if code != 0:
        return "fail", output
    return "pass", ""


def check_compat(didc: Path, current: Path, baseline: Path) -> tuple[str, str]:
    code, output = run_didc(didc, ["check", str(current), str(baseline)])
    if code != 0:
        return "fail", output
    if DIVERGENCE_MARKER in output:
        return "fail", output
    return "pass", output


def baseline_from_tag(root: Path, tag: str, relative: Path, out_dir: Path) -> Path | None:
    """The `.did` as it stood at a tag. `None` when the tag did not carry that
    file, which is the normal answer for a canister added since the release."""
    result = subprocess.run(
        ["git", "show", f"{tag}:{relative.as_posix()}"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    target = out_dir / f"baseline.{relative.as_posix().replace('/', '.')}"
    target.write_text(result.stdout, encoding="utf-8")
    return target


def latest_tag(root: Path) -> str | None:
    result = subprocess.run(
        ["git", "tag", "--sort=-v:refname"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    tags = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    return tags[0] if tags else None


# ----------------------------------------------------------- self test --


def self_test(root: Path, didc: Path, report: Report) -> None:
    """Runs the checker against fixtures whose verdict is known.

    A compatibility gate that has never rejected anything is indistinguishable
    from one that cannot. Each fixture names the verdict it expects, and a
    fixture that does not produce it fails the run.
    """
    directory = root / FIXTURE_DIR
    expectations = json.loads((directory / "expected.json").read_text(encoding="utf-8"))
    baseline = directory / expectations["baseline"]

    for case in expectations["cases"]:
        current = directory / case["file"]
        status, output = check_compat(didc, current, baseline)
        expected = case["expected"]
        if status == expected:
            report.add(f"fixture/{case['file']}", "self-test", "pass", case["why"])
        else:
            report.add(
                f"fixture/{case['file']}",
                "self-test",
                "fail",
                f"expected {expected}, got {status}: {output}",
            )


# ---------------------------------------------------------------- main --


def inspect(
    root: Path,
    moc: Path,
    didc: Path,
    baseline_tag: str | None,
    require_baseline: bool,
) -> Report:
    report = Report(baseline=baseline_tag)
    apps = sorted(path for path in (root / "apps").iterdir() if (path / "mops.toml").is_file())

    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp)
        for app in apps:
            for canister in canisters_of(app):
                generated, error = generate_did(moc, canister, app, root, out_dir)
                if generated is None:
                    report.add(canister.label, "drift", "fail", error)
                    continue

                status, detail = check_drift(didc, generated, canister.candid)
                report.add(canister.label, "drift", status, detail)

                if baseline_tag is None:
                    report.skipped.append(canister.label)
                    continue

                relative = canister.candid.relative_to(root)
                previous = baseline_from_tag(root, baseline_tag, relative, out_dir)
                if previous is None:
                    # A canister that did not exist at the baseline has nothing
                    # to be incompatible with. Recorded rather than silent: a
                    # missing baseline and a passing check look the same in a
                    # summary line, and only one of them is coverage.
                    report.add(
                        canister.label,
                        "compat",
                        "fail" if require_baseline else "new",
                        f"not present at {baseline_tag}",
                    )
                    continue

                status, detail = check_compat(didc, canister.candid, previous)
                report.add(canister.label, "compat", status, detail)

    return report


def render_markdown(report: Report) -> str:
    lines = [
        "# Candid Compatibility",
        "",
        f"Baseline: `{report.baseline or 'none'}`",
        f"Status: **{report.status}**",
        "",
        "| canister | check | status | detail |",
        "|---|---|---|---|",
    ]
    for finding in report.findings:
        detail = finding.detail.splitlines()[0] if finding.detail else ""
        detail = detail.replace("|", "\\|")
        lines.append(f"| `{finding.canister}` | {finding.check} | {finding.status} | {detail} |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path, nargs="?", default=Path(__file__).resolve().parents[1])
    parser.add_argument("--baseline", help="git tag to compare against (default: newest tag)")
    parser.add_argument("--moc", help="path to the pinned Motoko compiler")
    parser.add_argument("--didc", help="path to didc")
    parser.add_argument("--json-report", type=Path)
    parser.add_argument("--markdown-report", type=Path)
    parser.add_argument("--self-test", action="store_true", help="also run the fixture suite")
    parser.add_argument(
        "--require-baseline",
        action="store_true",
        help="fail instead of skipping when a baseline interface is unavailable",
    )
    args = parser.parse_args()

    root = args.root.resolve()
    moc = find_moc(root, args.moc)
    didc = find_didc(root, args.didc)

    if didc is None:
        print("didc not found; run scripts/install_didc.sh or set DIDC", file=sys.stderr)
        return 2
    if moc is None:
        print("moc not found; run scripts/bootstrap_toolchain.sh or set MOC", file=sys.stderr)
        return 2

    baseline = args.baseline or latest_tag(root)
    if baseline is None and args.require_baseline:
        print("no git tag to use as a baseline", file=sys.stderr)
        return 2

    report = inspect(root, moc, didc, baseline, args.require_baseline)
    if args.self_test:
        self_test(root, didc, report)

    print("Candid drift and compatibility")
    print(f"Baseline: {baseline or 'none (no tag available)'}")
    for finding in report.findings:
        mark = {"pass": "ok  ", "fail": "FAIL", "new": "new "}.get(finding.status, finding.status)
        detail = f" — {finding.detail.splitlines()[0]}" if finding.detail else ""
        print(f"  {mark} {finding.canister} [{finding.check}]{detail}")
    if report.skipped:
        print(f"  compatibility skipped for {len(report.skipped)} canisters (no baseline)")

    if args.json_report:
        args.json_report.parent.mkdir(parents=True, exist_ok=True)
        args.json_report.write_text(
            json.dumps(
                {
                    "check": "candid-drift-and-compatibility",
                    "baseline": baseline,
                    "status": report.status,
                    "findings": [vars(f) for f in report.findings],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
    if args.markdown_report:
        args.markdown_report.parent.mkdir(parents=True, exist_ok=True)
        args.markdown_report.write_text(render_markdown(report), encoding="utf-8")

    print(f"Status: {report.status.upper()}")
    return 1 if report.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
