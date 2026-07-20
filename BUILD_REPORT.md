# Build and Validation Report

Snapshot: **2026-07-20 JST**

## Result

The artifact package passed both offline checks and the pinned native Motoko toolchain gates.

- provenance CLI unit tests: pass
- protocol JSON Schema examples: pass
- Python source compile: pass
- shell syntax: pass
- Node syntax: pass
- GitHub issue/label dry-run: pass
- structural validator: pass
- Motoko/Candid API surface: pass for 5 applications and 46 public methods
- `mops install`, `mops check`, and Motoko unit tests: pass for all 5 applications
- pinned `moc` 1.11.1 Wasm build: pass for all 5 applications
- compiler-generated Candid compatibility: pass for all 5 applications
- Nix/read-only npm-prefix fallback: pass
- SHA-256 manifest verification: pass
- ZIP entry/integrity verification: pass

## Remaining production gates

The following gates remain intentionally open:

- local replica deployment
- PocketIC integration
- upgrade rehearsal
- load testing
- mainnet deployment
- independent security audit

These are represented as explicit GitHub Issues rather than being hidden. The native compile baseline from Issue 001 is complete.

## Reproduction

```bash
./scripts/run_offline_checks.sh
./scripts/bootstrap_toolchain.sh
./scripts/check_all_apps.sh
python3 scripts/package_kit.py
```

The package command regenerates `FILE_INDEX.md`, `validation/*`, `MANIFEST.sha256`, the ZIP, and its external `.sha256` checksum. ZIP entries use a fixed snapshot timestamp and sorted paths.
