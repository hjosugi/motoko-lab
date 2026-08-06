# Changelog

## Unreleased

- The documentation site now rewrites links that leave it. A Markdown link to something that is not a staged page — a `.mo` source, a script, a directory — has nowhere to resolve inside the site, so it is redirected to the same path on GitHub. Without this, documentation could not link to the code it documents: the link would resolve in the repository, fail in the site, and take `mkdocs build --strict` down with it. Links to the root `README.md` are redirected to the staged `index.md` rather than off-site.
- Added `--self-test` to `scripts/build_docs_site.py`, seventeen pinned cases for the rewriter, run in CI before anything is staged. It covers a gap the other two gates cannot: `--strict` asks whether a link resolves, never whether it was supposed to be rewritten, so a rewriter that quietly stops rewriting still builds green and produces a site full of dead links. Disabling the rewriter fails nine of the seventeen.
- Documented the three documentation gates in `docs/06_TESTING_CI_DEPLOYMENT.md`, alongside the Candid ones.
- Dropped `apps/06_distributed_llm/tools/package-lock.json` from `FILE_INDEX.md` and `MANIFEST.sha256`. The app's own `.gitignore` excludes it, so it is in neither the repository nor the distributed kit; it was recorded because the inventory had been regenerated in a working tree where npm had run. Regenerating on a clean checkout is what removed it.

## v2026.08.06

- Added `scripts/check_candid_compat.py` (#17): regenerates every app's `.did` with the pinned compiler and rejects drift, then checks the committed interface is a Candid subtype of the one in the last release tag. The tagged tree is the baseline, so there is no copy to keep in step with what was actually released.
- Treat `didc`'s `FIX ME! ... special opt rule` banner as a break. Adding a variant tag to a result exits 0 and lets an old client decode the unknown tag as `null` instead of trapping — the call succeeds and the client silently sees nothing.
- Added `validation/candid-fixtures/`, nine interface pairs whose verdict is known, so a gate that has stopped rejecting anything fails instead of passing quietly.
- Added `scripts/install_didc.sh`, pinning `didc` 0.4.0 to the same release the pocket-ic harness uses.
- Wired both into CI, with `fetch-depth: 0` so the release tag is available to compare against, and documented the allowed and deprecated interface changes in `docs/06_TESTING_CI_DEPLOYMENT.md`.

## v2026.08.05

- Added `apps/06_distributed_llm`: distributed decoding across canisters, with six strategies (baseline, speculative, diffusion-style masked draft, and three sharded wire formats) measured on identical terms.
- Added a deterministic integer-only n-gram model, so scores are bit-identical across replicas and the same model provides both a target and a cheaper draft head.
- Added `llm_shim`, a local canister serving the same `v1_chat` interface as the mainnet LLM canister, and `LlmClient.mo`, a dependency-free client compatible with `mo:llm`.
- Added `sim/Cluster.mo`, which runs the whole cluster in the Motoko interpreter's actor scheduler, and `tools/pocket-ic-e2e.mjs`, which runs it on a real replica.
- Added `tools/latency-model.mjs` to turn the measured round and byte counters into latency estimates per network profile.
- Added `scripts/vendor_core_offline.sh` so `mops check` / `mops test` / `mops build` work where the Mops registry is unreachable.
- Fixed a latent unsoundness in the new tokenizer's binary search: `<unk>` at index 0 is out of sort order, so the searchable region starts at 1.
- Fixed `scripts/check_api_surface.py`, which skipped every `public shared func` declared without a caller pattern, and could not parse a `.did` containing doc comments or an inline record return type.
- Documented a `moc` 1.11.1 bug found while bringing up the replica: `Prim.envVar` traps when the variable name is a runtime-concatenated `Text`.
- Added byzantine shard detection to `apps/06_distributed_llm` (#44): overlapping shard assignment with an exact cross-check, a rotating orchestrator-side spot check, and a range check on every reply. Measured against a lying worker canister on `pocket-ic`, with the unprotected run as the control.
- Added `#shardedDraft`, the one sharded strategy whose output a malicious worker cannot change: the fan-out drafts and an exact local target pass decides. The lie costs acceptance (33% -> 0%), not correctness.
- Added access control and per-principal quotas to the orchestrator's fan-out endpoints (#45). Anonymous callers are refused, the allowlist is empty after install, and an over-budget request is rejected before it runs rather than truncated.
- Added cycle metering: `Report.cyclesSpent`, `stats().cyclesBalance`, and a self-imposed 3T floor below which every gated endpoint refuses rather than running the canister towards its freezing threshold.
- Added `pruneQuotas`, because the usage ledger is unbounded under `setOpenAccess(true)` and an unbounded rate limiter is itself a denial-of-service vector.

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
