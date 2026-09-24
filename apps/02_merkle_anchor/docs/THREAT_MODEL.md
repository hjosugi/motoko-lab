# Threat Model

- malicious batch owner may anchor false leaves; ownership of root is proven, truth of leaves is not
- inconsistent tree rules break verification; version and vectors are mandatory. `anchor` accepts only `icp-merkle:v1` (protocol/MERKLE_V1.md), and batches anchored under other declared versions are refused by `verifyProof` rather than reinterpreted
- second-preimage (interior node presented as a leaf): leaf and node hashes are prefixed 0x00 / 0x01 and the canister hashes the leaf value itself; vector `interior-node-as-leaf`
- odd-node duplication (CVE-2012-2459): no duplication, RFC 9162 split; vectors `size-3` vs `last-leaf-repeated`
- proof malleability: path length is fixed by (index, size) and checked before hashing; a multiproof must be consumed exactly
- tree size is not authenticated by an audit path: `verifyProof` uses the anchored `leafCount`, never a caller-supplied size
- verification cost: a single path is at most 20 hashes; a multiproof is capped at 256 leaves and oversized input is refused before hashing
- `verifyProof` is an uncertified query: it is a convenience, and an authoritative verifier recomputes against the anchored root itself
- root replay is blocked by unique index
- giant batches are metadata-only but leafCount is capped
- off-chain manifest availability must be redundant
- query certification remains future work
