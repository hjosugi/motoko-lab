// The on-chain verifier against the published icp-merkle:v1 vectors.
//
// `MerkleVectors.mo` is generated from protocol/test-vectors/merkle/ by
// protocol/tools/merkle-vectors.mjs, and the offline checks fail if it is
// stale. So everything below runs the canister's implementation over exactly
// what the JavaScript reference published: every root it can rebuild, every
// audit path and multiproof, every rejection, and the transparency-dev/merkle
// probes. The two implementations share no code; agreeing here is the
// evidence that a proof built by one verifies in the other.
import Blob "mo:core/Blob";
import Array "mo:core/Array";
import Merkle "../backend/src/Merkle";
import V "MerkleVectors";

func verifies(outcome : Merkle.Outcome, root : Blob) : Bool {
  switch (outcome) {
    case (#ok(computed)) Blob.equal(computed, root);
    case (#err(_)) false;
  }
};

func matches(outcome : Merkle.Outcome, root : Blob, expect : V.Expect) : Bool {
  switch (expect, outcome) {
    case (#malformed, #err(_)) true;
    case (#notIncluded, #ok(computed)) not Blob.equal(computed, root);
    case _ false;
  }
};

// -- the published rules -------------------------------------------------------
let spec = Merkle.spec();
assert spec.treeVersion == "icp-merkle:v1";
assert spec.hashAlgorithm == "sha256";
assert spec.leafDomain == "icp-merkle:v1";
assert spec.leafPrefix == 0 and spec.nodePrefix == 1;
assert spec.digestSize == 32 and spec.shape == "rfc9162";
assert spec.maxLeafCount == 1_000_000 and spec.maxMultiproofLeaves == 256;

// The leaf hash of leafRule(0), as pinned in vectors.json's leafPreimageExample.
assert Merkle.leafHash("\A1\F3\D9\27\DE\D2\EA\B8\6A\BF\6D\82\9D\67\C4\C9\C1\61\CE\56\87\85\15\D3\92\D8\16\EB\16\8C\13\C0")
  == "\19\35\3E\2F\7C\3F\A7\16\9C\49\5A\F9\07\87\46\51\F2\2D\B6\8E\DC\D6\01\F8\6A\29\47\9C\8B\17\36\E7";

// -- roots: the shape, not only the proofs --------------------------------------
for (tree in V.trees.values()) {
  let hashes = Array.map<Blob, Blob>(tree.leaves, Merkle.leafHash);
  assert Merkle.rootOf(hashes) == ?tree.root;
};
assert Merkle.rootOf([]) == null;

// -- every audit path, including the 100,000- and 1,000,000-leaf trees -----------
for (proof in V.proofs.values()) {
  assert proof.path.size() == Merkle.pathLength(proof.index, proof.leafCount);
  assert verifies(Merkle.rootFromPath(proof.index, proof.leafCount, Merkle.leafHash(proof.leaf), proof.path), proof.root);
};

for (multi in V.multiproofs.values()) {
  let leaves = Array.map<(Nat, Blob), (Nat, Blob)>(multi.leaves, func((index, leaf)) = (index, Merkle.leafHash(leaf)));
  assert verifies(Merkle.rootFromMultiproof(multi.leafCount, leaves, multi.proof), multi.root);
};

// -- rejections: refused for the same reason the reference refuses them ----------
for ((proof, expect) in V.rejectedProofs.values()) {
  assert matches(Merkle.rootFromPath(proof.index, proof.leafCount, Merkle.leafHash(proof.leaf), proof.path), proof.root, expect);
};

for ((multi, expect) in V.rejectedMultiproofs.values()) {
  let leaves = Array.map<(Nat, Blob), (Nat, Blob)>(multi.leaves, func((index, leaf)) = (index, Merkle.leafHash(leaf)));
  assert matches(Merkle.rootFromMultiproof(multi.leafCount, leaves, multi.proof), multi.root, expect);
};

// -- the RFC 9162 core against transparency-dev/merkle ---------------------------
for (probe in V.probes.values()) {
  let accepted = verifies(Merkle.rootFromPath(probe.index, probe.size, probe.leafHash, probe.path), probe.root);
  assert accepted == not probe.wantErr;
};

// -- bounds that must be answered rather than trapped on --------------------------
let someHash = Merkle.leafHash("\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00");
switch (Merkle.rootFromPath(0, 0, someHash, [])) { case (#err(_)) {}; case (#ok(_)) assert false };
switch (Merkle.rootFromPath(0, 2 ** 64, someHash, [])) { case (#err(_)) {}; case (#ok(_)) assert false };
switch (Merkle.rootFromPath(5, 5, someHash, [])) { case (#err(_)) {}; case (#ok(_)) assert false };
switch (Merkle.rootFromMultiproof(4, [], [])) { case (#err(_)) {}; case (#ok(_)) assert false };
switch (Merkle.rootFromMultiproof(2 ** 64, [(0, someHash)], [])) { case (#err(_)) {}; case (#ok(_)) assert false };
// One leaf is its own root, with an empty path.
assert Merkle.rootFromPath(0, 1, someHash, []) == #ok(someHash);
assert Merkle.pathLength(0, 1) == 0;
assert Merkle.pathLength(999_999, 1_000_000) == 12 and Merkle.pathLength(0, 1_000_000) == 20;
