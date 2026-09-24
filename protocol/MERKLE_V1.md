# Merkle tree v1 — `icp-merkle:v1`

Issue #9. `apps/02_merkle_anchor` anchors a Merkle root and a leaf count for a
batch of artifacts, and until v1 nothing said how that root related to a leaf.
A proof could only be checked by whoever built the tree, with whatever rules
they had used — which is to say an anchored root was evidence that *someone*
committed to *something*. These are the rules. Like the commitment layout
([COMMITMENT_V1.md](COMMITMENT_V1.md)), they are frozen once a batch exists on
mainnet: a later version gets a new name and a new leaf domain, never an edit.

Implementations:

- `protocol/tools/merkle.mjs` — the reference builder, prover and verifier
  (Node, no dependencies), and `provenance-cli.mjs merkle-root | merkle-prove | merkle-verify`.
- `apps/02_merkle_anchor/backend/src/Merkle.mo` — the canister's verifier, behind
  the `verifyProof`, `verifyMultiproof` and `merkleSpec` queries.

The two share no code. `test/Merkle.test.mo` runs the Motoko one over every
published vector, and the replica suite verifies proofs built by the JavaScript
one on-chain.

## The rules

```abnf
leaf-value   = 32OCTET                                ; a SHA-256 digest
leaf-entry   = %s"icp-merkle:v1" leaf-value           ; 13 + 32 octets
leaf-hash    = SHA-256( %x00 leaf-entry )             ; 46-octet preimage
node-hash    = SHA-256( %x01 left right )             ; 65-octet preimage
left, right  = 32OCTET                                ; leaf or node hashes
```

The tree shape is RFC 9162 section 2.1.1 — the Merkle Tree Hash of Certificate
Transparency v2 (unchanged from RFC 6962): for `n > 1` leaves, the left subtree
holds the first `k` leaves where `k` is the largest power of two smaller than
`n`, and the right subtree holds the rest. With `D[0:n]` the list of leaf
entries:

```text
MTH(D[0:1]) = SHA-256(0x00 || D[0])
MTH(D[0:n]) = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n]))
```

Equivalently, and this is how `buildTree` constructs it: hash the leaves, then
pair neighbours level by level, carrying a lone last node up unchanged.

So an `icp-merkle:v1` tree **is** an RFC 9162 tree whose entries are
`"icp-merkle:v1" || leaf value`. Any RFC 9162 verifier checks our proofs if it is
handed that entry, which is why the core is tested against the
[transparency-dev/merkle](https://github.com/transparency-dev/merkle) inclusion
probes as well as our own vectors.

| Parameter | Value |
|-|-|
| `treeVersion` | `icp-merkle:v1` |
| `hashAlgorithm` | `sha256` |
| leaf domain | `icp-merkle:v1`, 13 octets US-ASCII |
| leaf / node prefix | `0x00` / `0x01` |
| leaf value | exactly 32 octets |
| minimum / maximum leaf count | 1 / 1,000,000 |
| deepest audit path | 20 hashes |
| leaves per on-chain multiproof | at most 256 |

`merkleSpec()` on the canister returns exactly these, and the replica suite
checks them against `spec()` in `merkle.mjs` field for field.

## Why each rule

**Leaf and node prefixes.** Without them an interior node is a valid leaf: its
hash is the hash of 64 octets, and nothing distinguishes "a leaf whose value is
these 64 octets" from "a node whose children are these two hashes". That is the
classic second-preimage attack on Merkle trees. With `0x00` and `0x01` the two
preimages cannot coincide, and here they also differ in length (46 against 65).
The vector `interior-node-as-leaf` presents a real interior node with its real
sibling as a leaf, and it is refused.

**The leaf domain.** It versions the leaf encoding. A v2 tree hashes every leaf
under a different string, so no v1 root can be read under v2 rules, and a leaf
hash from some other RFC 9162 system cannot be mistaken for one of ours. It is
also why `leaf-hash-as-leaf` fails: a leaf hash handed in as a leaf value is
hashed again.

**Fixed-size leaf values.** A leaf value is always a 32-octet digest — of a
manifest, a record, an artifact; the batch's `schemaUri` says which. With every
field fixed-length there is no concatenation to be ambiguous about.

**No odd-node duplication.** Bitcoin pairs an odd last node with a copy of
itself, so `[a, b, c]` and `[a, b, c, c]` have the same root and a proof of the
phantom fourth leaf verifies (CVE-2012-2459). Under the RFC 9162 split the right
subtree is simply smaller; the vectors `size-3` and `last-leaf-repeated` have
different roots and the suite asserts it.

**Positional pairs, never sorted.** Some trees (OpenZeppelin's, for instance)
sort each pair before hashing, so a proof needs no left/right flags. It also
stops proving *where* a leaf is. Here the order of the leaves is the order of the
batch, the verifier derives every left/right decision from `(index, size)`, and
for a given `(index, size)` there is exactly one valid proof length — which is
checked before anything is hashed.

**Duplicate leaf values are allowed.** A proof proves "this value at this
position". Where two positions hold the same value under the same sibling their
paths coincide and each proves both, which is true of both
(`duplicate-leaves`). Whether a batch lists an artifact twice is a property of
the leaf list, which only the batch manifest can show; a tree cannot enforce it
and v1 does not pretend to.

## Proofs

### Single leaf: RFC 9162 audit path

A proof is `(index, leaf value, path)` with `path` the RFC 9162 audit path,
bottom-up. Verification is RFC 9162 section 2.1.3.2, preceded by one extra
check: the path length must equal

```text
inner  = bit_length(index XOR (size - 1))
border = popcount(index >> inner)
length = inner + border
```

A path of any other length cannot verify and is refused as malformed rather
than hashed. The tree size is always the **anchored** `leafCount`. See below for
why that is not a detail.

As JSON (what `provenance-cli.mjs merkle-prove --index` emits):

```json
{ "treeVersion": "icp-merkle:v1", "leafCount": 7, "root": "<hex>",
  "index": 2, "leaf": "<hex>", "path": ["<hex>", "<hex>", "<hex>"] }
```

### Several leaves: multiproof

A multiproof is a list of `(index, leaf value)` pairs in strictly increasing
index order, and `proof`: the hash of every subtree that contains none of the
proven leaves, in the order a left-to-right, depth-first walk of the RFC 9162
shape reaches them. The verifier performs that walk: a subtree with no proven
leaf consumes the next proof hash, a single proven leaf is its leaf hash, and
everything else is `node-hash(left, right)`.

For a given size and index set the number and order of proof hashes are fixed,
so there is exactly one valid multiproof. A hash left over is refused exactly
like a hash missing — a proof with room for extra data has more than one
encoding. Indices out of order or repeated are refused.

A multiproof is never larger than the separate audit paths combined, and is
usually much smaller: proving leaves 0, 3 and 6 of a 7-leaf tree takes 3 hashes
instead of 8, and proving every leaf of a tree takes none. The one-leaf case
contains exactly the hashes of that leaf's audit path, in walk order rather than
bottom-up; the suite asserts the two sets are equal for every size to 40.

The canister accepts up to 256 leaves per call. A query is bounded in
instructions like any other message, and this keeps the worst case measured and
well inside the limit. More leaves means more calls.

Measured with `mops bench --replica pocket-ic` on pocket-ic 14.0.0
(`apps/02_merkle_anchor/bench/merkle.bench.mo`), in instructions:

| Proof | Instructions |
|-|-:|
| audit path, 1 hash (includes hashing the leaf) | 89,646 |
| audit path, 5 hashes | 303,286 |
| audit path, 10 hashes | 572,394 |
| audit path, 17 hashes | 944,412 |
| audit path, 20 hashes (the deepest the anchor allows) | 1,104,618 |
| multiproof, 16 leaves across 1,000,000 | 14,807,077 |
| multiproof, 64 leaves across 1,000,000 | 52,216,791 |
| multiproof, 256 leaves across 1,000,000 | 180,554,767 |

A node hash is one SHA-256 over 65 octets — two compression blocks — at roughly
50,000 instructions. The worst multiproof the canister accepts is under 4% of a
query's 5 billion instruction limit, plus about 11M for hashing its 256 leaves.

As JSON (`merkle-prove --indices 0,3,6`):

```json
{ "treeVersion": "icp-merkle:v1", "leafCount": 7, "root": "<hex>",
  "leaves": [{ "index": 0, "leaf": "<hex>" }, ...], "proof": ["<hex>", ...] }
```

## What a proof does not prove

**The tree size.** An RFC 9162 audit path does not authenticate the size of the
tree. Leaf 2's path is the same in every tree of 5 to 8 leaves, so against one
root it verifies for all four sizes; `merkle.test.mjs` asserts this rather than
leaving it as a claim. That is harmless exactly when the verifier takes the size
from somewhere it trusts, so `verifyProof` uses the batch's anchored
`leafCount` and has no size parameter at all, and `provenance-cli.mjs
merkle-verify` refuses to run without `--root` and `--leaf-count` supplied from
the anchor. The `root` and `leafCount` inside a proof file are the prover's
claims, and a proof checked against the root it brought with it proves nothing.

**That the leaves are true.** The anchor proves that its owner committed to this
root at this time. It says nothing about whether a leaf describes a real
artifact; that is the batch manifest's and the verifier's business.

**Current status.** A leaf of a revoked batch is still in the tree. `verifyProof`
answers `included` and returns the batch `status` beside it rather than folding
one into the other, so a reader sees both.

**That the canister answered honestly.** `verifyProof` is a query, and a query
response is not certified. It is a convenience. The authoritative check is one
the verifier runs itself, against a root it read by an update call (or, once app
02 has them, a certified query), with `merkle.mjs` or any RFC 9162
implementation.

## Tree versions and existing batches

`anchor` now accepts only `treeVersion = "icp-merkle:v1"` with
`hashAlgorithm = "sha256"`. A root built under rules nobody wrote down is a
root nobody can verify, and the field was free text: the replica suite had been
anchoring `rfc6962`.

Batches anchored before this keep whatever they declared. Their roots are never
reinterpreted: `verifyProof` on such a batch returns `#conflict` rather than
reading it under v1 rules, because a guess that happened to verify would be
worse than a refusal. The replica suite installs the `v2026.09.22` build,
anchors a batch as `rfc6962`, upgrades to the current build, and checks exactly
that.

## Vectors

- `test-vectors/merkle/vectors.json` — generated by
  `protocol/tools/merkle-vectors.mjs`: 15 trees (every size 1–9, 16, 17, duplicate
  leaves, a repeated last leaf, 100,000 derived leaves, and the 1,000,000-leaf
  maximum with a 20-hash path), 7 multiproofs, and 21 rejections, each pinned to
  its exact error message or to `included: false`. Leaf values are derived
  (`SHA-256("icp-merkle-vector:" i)`), so nothing large is stored.
- `test-vectors/merkle/rfc9162-inclusion.json` — the 98 inclusion probes from
  transparency-dev/merkle (Apache-2.0) at commit `fbbcd741`, base64 converted to
  hex and nothing else changed. 6 must verify and 92 must be refused.
- `apps/02_merkle_anchor/test/MerkleVectors.mo` — both files as Motoko values,
  generated by the same script. `merkle.test.mjs` fails if either generated file
  is stale, so the canister's verifier is always tested against what was
  published.

```bash
node protocol/tools/merkle.test.mjs                 # offline checks run this
node protocol/tools/merkle-vectors.mjs --write      # after changing the vectors
node protocol/tools/provenance-cli.mjs merkle-root leaves.txt
node protocol/tools/provenance-cli.mjs merkle-prove leaves.txt --index 2 > proof.json
node protocol/tools/provenance-cli.mjs merkle-verify proof.json --root <hex> --leaf-count 7
```

`merkle-verify` exits 0 when the proof is included, 2 when it is well formed but
reconstructs another root, and 1 when the input is malformed.
