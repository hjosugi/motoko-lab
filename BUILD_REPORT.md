# Build and Validation Report

Snapshot: **2026-07-20 JST**

## Result

The artifact package passed all checks that can run without downloading the native Motoko toolchain.

- provenance CLI unit tests: pass
- protocol JSON Schema examples: pass
- Python source compile: pass
- shell syntax: pass
- Node syntax: pass
- GitHub issue/label dry-run: pass
- structural validator: pass
- Motoko/Candid API surface: pass for 5 applications and 46 public methods
- SHA-256 manifest verification: pass
- ZIP entry/integrity verification: pass

## Native toolchain boundary

The following gates remain intentionally open because the execution environment could not install `moc`, Mops, `icp-cli`, or PocketIC:

- Motoko type-check and Wasm build
- compiler-generated Candid comparison
- local replica deployment
- upgrade rehearsal
- integration/load/security testing

These are represented as explicit GitHub Issue drafts rather than being hidden. The first mandatory gate is `github/issues/001-compile-all-reference-apps-with-the-current-pinned-toolchain.md`.

## Reproduction

```bash
./scripts/run_offline_checks.sh
python3 scripts/package_kit.py
```

The package command regenerates `FILE_INDEX.md`, `validation/*`, `MANIFEST.sha256`, the ZIP, and its external `.sha256` checksum. ZIP entries use a fixed snapshot timestamp and sorted paths.
