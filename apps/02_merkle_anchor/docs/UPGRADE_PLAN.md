# Upgrade Plan

Preserve root/index mapping forever. Algorithm agility adds new fields/version; never reinterpret an existing root. Rehearse active/revoked/superseded batches before release.

## icp-merkle:v1 (#9)

- Stable data is unchanged: `treeVersion` and `hashAlgorithm` were already stored on every batch. What changed is that `anchor` now validates them, and that the canister can verify proofs.
- Batches anchored before this release under any other declared version keep it. `verifyProof` / `verifyMultiproof` return `#conflict` for them instead of guessing. The replica suite installs the `v2026.09.22` build, anchors an `rfc6962` batch, upgrades with `wasm_memory_persistence = keep`, and checks the batch survives byte-for-byte, stays in the root index, and is refused rather than reinterpreted.
- A future tree version is added next to v1, never in place of it: `Merkle.mo` gains a v2 path selected by the batch's stored `treeVersion`, and v1 batches keep verifying under v1 rules forever.
- Candid is additive: `merkleSpec`, `verifyProof`, `verifyMultiproof` and their record types. No existing type gained a variant tag.
