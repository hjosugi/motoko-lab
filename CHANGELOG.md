# Changelog

## Unreleased

- The documentation site now rewrites links that leave it. A Markdown link to something that is not a staged page — a `.mo` source, a script, a directory — has nowhere to resolve inside the site, so it is redirected to the same path on GitHub. Without this, documentation could not link to the code it documents: the link would resolve in the repository, fail in the site, and take `mkdocs build --strict` down with it. Links to the root `README.md` are redirected to the staged `index.md` rather than off-site.
- Added `--self-test` to `scripts/build_docs_site.py`, seventeen pinned cases for the rewriter, run in CI before anything is staged. It covers a gap the other two gates cannot: `--strict` asks whether a link resolves, never whether it was supposed to be rewritten, so a rewriter that quietly stops rewriting still builds green and produces a site full of dead links. Disabling the rewriter fails nine of the seventeen.
- Documented the three documentation gates in `docs/06_TESTING_CI_DEPLOYMENT.md`, alongside the Candid ones.
- Brought `VALIDATION_STATUS.md` back in step with what has actually been run. It still listed `icp network start -d`, `icp deploy`, and the upgrade rehearsal as outstanding after they had been performed and recorded in `apps/06_distributed_llm/docs/MEASUREMENTS.md`, and said nothing about the documentation site. Understating what was verified is the safe direction to be wrong in, but it is still wrong.
- Dropped `apps/06_distributed_llm/tools/package-lock.json` from `FILE_INDEX.md` and `MANIFEST.sha256`. The app's own `.gitignore` excludes it, so it is in neither the repository nor the distributed kit; it was recorded because the inventory had been regenerated in a working tree where npm had run. Regenerating on a clean checkout is what removed it.
- Froze the v1 commitment layout and published its conformance vectors (#5). `protocol/COMMITMENT_V1.md` gives the byte-level ABNF, the principal rules, the error behaviour and the version negotiation rules; `protocol/test-vectors/commitment/vectors.json` gives 17 accept and 22 reject vectors, each accept vector pinning the full preimage in hexadecimal, its length and the commitment.
- The layout itself did not change. Principal validation did, and it needed to: it was a length check accepting any string of 5 to 100 characters, so `hello` and `not-a-principal` produced perfectly good commitments that no canister could ever match — the canister derives the same field from `Principal.toText(caller)` and never from a request. `protocol/tools/principal.mjs` now implements the textual form: base32 alphabet, CRC32 checksum, and a re-encode round trip that rejects a mis-grouped or wrongly padded spelling of the same blob. Two spellings of one creator would be two commitments for one creator.
- Uppercase principals are now rejected rather than silently lowercased. Accepting them would teach callers that the field is case-insensitive when the bytes that get hashed are not. Hexadecimal input stays case-insensitive, because it denotes octets, and there are accept vectors asserting both forms produce the same commitment.
- The real bounds replaced the guessed ones, in the protocol and in Motoko: a principal blob is 0 to 29 bytes, so the text is 8 to 63 characters, not 5 to 100.
- "No concatenation ambiguity" is now a checked property rather than a claim. `parsePreimage` recovers all three fields from the preimage bytes, and the suite asserts the round trip on every accept vector and that no two distinct triples share a commitment — which is what `salt-all-zero`, `salt-leading-zero` and `digest-all-zero` are for.
- Two implementations sharing no code with the reference reproduce every vector, both written from the specification: `crosscheck/commitment.rs` validating principals with `candid::Principal`, and `crosscheck/commitment.ts` with `@dfinity/principal`. Same verdict and same bytes on all 39. If the principal rules here disagreed with DFINITY's, or the document were not implementable from its own text, that is where it would show.
- `commitmentSpec()` gained `version`, `minPrincipalTextSize` and `maxPrincipalTextSize`, so the published rules are complete enough for a verifier to rebuild the preimage from the deployed canister rather than from a document it hopes matches. Both additions pass the Candid drift and subtyping gates; stable data is unchanged.
- The two vectors published before the freeze reproduce their previous commitments exactly. Freezing the layout did not move it.

- The provenance CLI now implements RFC 8785 (#4), replacing the recursive key sort it described as "a deterministic educational subset". The manifest digest is what the on-chain commitment binds, so two verifiers that disagree about the canonical bytes disagree about whether a record is valid.
- What was missing was never the serialization. RFC 8785 defines number formatting, string escaping and member ordering by pointing at ECMAScript, and `JSON.stringify` already got all three right. What was missing is everything `JSON.parse` discards first, so `protocol/tools/jcs.mjs` scans the text: a duplicate member name is silently resolved to the last occurrence, so `{"a":1,"a":2}` and `{"a":2}` hashed the same; a lone surrogate survives parsing here and is rejected outright by implementations built on UTF-8; `1E400` parses to `Infinity`, which RFC 8785 cannot serialize.
- Two deliberate deviations, both refusals, so the bytes produced for any accepted input still match every conformant implementation. Duplicate member names are rejected rather than resolved. An integer literal that does not round-trip exactly is rejected — `serde_jcs` rounds `12345678901234567890` to `12345678901234567000` the same way this would, and a manifest carrying file sizes and identifiers should not silently sign a different number.
- The round-trip test is exact, not digit-count based. An earlier version rejected any integer literal above `Number.MAX_SAFE_INTEGER`, which rejected `100000000000000000000` — the canonical form of `1e20`, and therefore its own output. The test suite now asserts idempotency on every vector, because a canonicalization with no fixed point is one two verifiers can disagree about by applying it a different number of times.
- Vendored the six official vectors from `cyberphone/json-canonicalization` and added 21 accepted and 26 rejected edge vectors, each pinned to its exact error message so failure behaviour is part of the contract. 87 assertions, offline, in `run_offline_checks.sh`.
- Added `protocol/tools/crosscheck.mjs`, which builds a throwaway `serde_jcs` project and installs the `canonicalize` npm package and runs all three implementations over the same inputs: 29 inputs canonicalized identically, 21 of the 26 rejections shared. It needs cargo, npm and network access, so it is outside CI by design, and it fails if the deviation list changes without the vectors being updated to match.
- Stated Motoko's responsibility: none. The canister takes a 32-byte digest as an opaque value and never parses JSON. A canister-side parser would cost cycles to re-derive a digest the caller already computed, and would be a second implementation to keep in step with the first.
- Manifests may now carry `"canonicalization": "RFC8785"`; absent means RFC8785, and a future scheme must name itself rather than change what an absent field means. The two published examples are unchanged — the old implementation produced byte-identical output for both, which is why the subset survived as long as it did.

- `apps/01_creator_proof_registry` now verifies the commitment on-chain (#3). `reveal` recomputes `SHA-256(domain || 0x00 || principalText || 0x00 || manifestHash || 0x00 || salt)` with `mo:sha2` and rejects a mismatch. Before this the canister stored the commitment and the revealed values side by side without ever comparing them, so a caller could commit to one digest and reveal something unrelated and the registry recorded it as a valid proof.
- The principal in the preimage is always the caller's, never a value from the request, so a commitment cannot be revealed under someone else's name.
- Added `RevealInput.algorithm`, an optional tag naming both the hash function and the layout. `null` means v1, so existing clients keep working. Nothing stores it: the algorithm picks the preimage and the digest is what `commit` already saved, so a wrong algorithm fails the same comparison as a wrong salt — no stable-state change and no migration.
- Added `commitmentSpec()`, so a verifier reads the layout and salt bounds off the canister instead of hardcoding them.
- Added `test/Commitment.test.mo`: the FIPS 180-4 SHA-256 examples, the preimage compared byte for byte, both published protocol vectors, both salt-size boundaries, and each bound field changed on its own.
- Measured the check at 97k–112k instructions across the accepted salt range (`bench/commitment.bench.mo`, `mops bench --replica pocket-ic`). Measuring it from outside the canister does not resolve it — an update call costs ~9.2M cycles whichever branch it takes.
- The mismatch is reported as `#invalidInput`, not a new `Error` tag. A new tag in a result is a break: Candid's special `opt` rule would let a released client decode it as `null` and silently see nothing, which is exactly what `scripts/check_candid_compat.py` rejects.
- `scripts/check_candid_compat.py` now passes every vendored package to `moc --idl`, not only `mo:core`. An app that imports anything else failed to compile, and a compile failure there reads as "no interface to compare", which would let real drift through.
- `scripts/vendor_core_offline.sh` now vendors non-`core` dependencies from the Mops global cache. `research-ag/sha2` stops tagging at `0.2.4`, so there is no pinned tree on raw.githubusercontent.com for the `0.2.5` the app uses.

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
