#!/usr/bin/env python3
"""Validate, inventory, hash, and create a deterministic ZIP of the kit."""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

FIXED_ZIP_TIME = (2026, 7, 20, 0, 0, 0)
EXCLUDED_DIRS = {".git", "node_modules", ".mops", "__pycache__"}


def files_in(root: Path) -> list[Path]:
    return [
        path
        for path in sorted(root.rglob("*"))
        if path.is_file() and not any(part in EXCLUDED_DIRS for part in path.parts)
    ]


def run(command: list[str], cwd: Path | None = None) -> None:
    print("+", " ".join(command), flush=True)
    environment = os.environ.copy()
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    subprocess.run(command, cwd=cwd, check=True, env=environment)


def remove_caches(root: Path) -> None:
    for name in ("__pycache__", ".mops"):
        for directory in sorted(root.rglob(name), reverse=True):
            if directory.is_dir():
                shutil.rmtree(directory)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_manifest(root: Path) -> None:
    manifest = root / "MANIFEST.sha256"
    lines = []
    for path in files_in(root):
        if path == manifest:
            continue
        relative = path.relative_to(root).as_posix()
        lines.append(f"{sha256_file(path)}  {relative}")
    manifest.write_text("\n".join(lines) + "\n", encoding="utf-8")


def verify_manifest(root: Path) -> None:
    manifest = root / "MANIFEST.sha256"
    for line_number, line in enumerate(manifest.read_text(encoding="utf-8").splitlines(), start=1):
        expected, separator, relative = line.partition("  ")
        if not separator:
            raise RuntimeError(f"invalid manifest line {line_number}")
        path = root / relative
        if not path.is_file():
            raise RuntimeError(f"manifest path missing: {relative}")
        actual = sha256_file(path)
        if actual != expected:
            raise RuntimeError(f"manifest mismatch: {relative}")


def write_zip(root: Path, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.unlink(missing_ok=True)
    prefix = root.name
    with zipfile.ZipFile(
        temporary,
        mode="w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
        allowZip64=True,
    ) as archive:
        for path in files_in(root):
            relative = path.relative_to(root).as_posix()
            info = zipfile.ZipInfo(f"{prefix}/{relative}", FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            mode = path.stat().st_mode & 0o777
            info.external_attr = (mode & 0xFFFF) << 16
            info.flag_bits |= 0x800
            archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    temporary.replace(output)

    with zipfile.ZipFile(output) as archive:
        bad = archive.testzip()
        if bad:
            raise RuntimeError(f"corrupt ZIP entry: {bad}")
        expected = {f"{prefix}/{path.relative_to(root).as_posix()}" for path in files_in(root)}
        actual = set(archive.namelist())
        if actual != expected:
            missing = sorted(expected - actual)
            extra = sorted(actual - expected)
            raise RuntimeError(f"ZIP entry mismatch; missing={missing}, extra={extra}")


def main() -> int:
    parser = argparse.ArgumentParser()
    default_root = Path(__file__).resolve().parents[1]
    parser.add_argument("--root", type=Path, default=default_root)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--skip-checks", action="store_true")
    args = parser.parse_args()

    root = args.root.resolve()
    output = (args.output or root.with_suffix(".zip")).resolve()
    remove_caches(root)
    manifest = root / "MANIFEST.sha256"
    # Recover safely from an interrupted package run that left an empty placeholder.
    if manifest.exists() and manifest.stat().st_size == 0:
        manifest.unlink()
    if not args.skip_checks:
        run([str(root / "scripts" / "run_offline_checks.sh")])

    # Create these before the final report so validation counts the final artifact set.
    (root / "MANIFEST.sha256").touch()
    run([sys.executable, str(root / "scripts" / "generate_file_index.py")])
    # The structural validator rejects empty files. Write a preliminary manifest,
    # then regenerate it after validation updates the machine-readable report.
    write_manifest(root)
    run([
        sys.executable,
        str(root / "scripts" / "check_api_surface.py"),
        str(root),
        "--json-report",
        str(root / "validation" / "api-surface.json"),
        "--markdown-report",
        str(root / "validation" / "API_SURFACE.md"),
    ])
    run([
        sys.executable,
        str(root / "scripts" / "validate_kit.py"),
        str(root),
        "--json-report",
        str(root / "validation" / "structural-validation.json"),
    ])

    remove_caches(root)
    write_manifest(root)
    verify_manifest(root)
    write_zip(root, output)
    checksum = sha256_file(output)
    checksum_path = Path(str(output) + ".sha256")
    checksum_path.write_text(f"{checksum}  {output.name}\n", encoding="utf-8")

    print(f"ZIP: {output}")
    print(f"SHA-256: {checksum}")
    print(f"Checksum file: {checksum_path}")
    print(f"Entries: {len(files_in(root))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
