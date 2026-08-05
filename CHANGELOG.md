# Changelog

## Unreleased

- Added `apps/06_distributed_llm`: distributed decoding across canisters, with six strategies (baseline, speculative, diffusion-style masked draft, and three sharded wire formats) measured on identical terms.
- Added a deterministic integer-only n-gram model, so scores are bit-identical across replicas and the same model provides both a target and a cheaper draft head.
- Added `llm_shim`, a local canister serving the same `v1_chat` interface as the mainnet LLM canister, and `LlmClient.mo`, a dependency-free client compatible with `mo:llm`.
- Added `sim/Cluster.mo`, which runs the whole cluster in the Motoko interpreter's actor scheduler, and `tools/pocket-ic-e2e.mjs`, which runs it on a real replica.
- Added `tools/latency-model.mjs` to turn the measured round and byte counters into latency estimates per network profile.
- Added `scripts/vendor_core_offline.sh` so `mops check` / `mops test` / `mops build` work where the Mops registry is unreachable.
- Fixed a latent unsoundness in the new tokenizer's binary search: `<unk>` at index 0 is out of sort order, so the searchable region starts at 1.
- Fixed `scripts/check_api_surface.py`, which skipped every `public shared func` declared without a caller pattern, and could not parse a `.did` containing doc comments or an inline record return type.
- Documented a `moc` 1.11.1 bug found while bringing up the replica: `Prim.envVar` traps when the variable name is a runtime-concatenated `Text`.

## v2026.07.20

- Initial snapshot.
- Pinned `moc` 1.11.1 and `core` 2.6.0 from current repositories.
- Added five Motoko reference applications.
- Added Creator Provenance Protocol v0.1, JSON Schema, examples, and verifier CLI.
- Added 40 GitHub Issue drafts and dry-run publishing tools.
- Added compiler-maintainer curriculum and production service evidence matrix.
- Fixed `Time.Time`/`Nat` timestamp mismatches across all five applications.
- Regenerated the usage-metered SaaS Candid interface from the compiler output.
- Added reproducible `mops.lock` files for all applications.
- Added Nix/read-only npm-prefix support to the toolchain bootstrap and execution scripts.
- Verified `mops check`, Motoko tests, Wasm build, and Candid compatibility for all five applications.
- Updated GitHub Actions to the current Node 24-based v7 releases.
