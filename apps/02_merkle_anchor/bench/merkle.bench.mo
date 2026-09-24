// What on-chain proof verification costs, in instructions.
//
// Run with:
//   mops bench --replica pocket-ic
//
// `audit path` columns are path lengths, using real published proofs: a leaf
// of a 2-leaf tree (1 hash), of the 17-leaf tree (5), the right edge and the
// first leaf of the 100,000-leaf tree (10 and 17), and the first leaf of the
// 1,000,000-leaf maximum (20). The row includes hashing the leaf under the v1
// domain, as `verifyProof` does. Each hash is one SHA-256 over a 65-byte node
// preimage, which is two compression blocks.
//
// `multiproof` columns are leaf counts, spread evenly across a 1,000,000-leaf
// tree, up to `maxMultiproofLeaves`. The 256-leaf column is the worst case the
// canister accepts in one call and the number the limit was chosen against.

import Bench "mo:bench";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Array "mo:core/Array";
import Merkle "../backend/src/Merkle";
import V "../test/MerkleVectors";

module {
  func proofNamed(name : Text) : V.Proof {
    switch (Array.find<V.Proof>(V.proofs, func(p) { p.name == name })) {
      case (?p) p;
      case null { assert false; V.proofs[0] };
    }
  };

  /// A uniform tree — every leaf the same — has one subtree hash per subtree
  /// size, so a valid multiproof over a million leaves costs O(log n) hashes to
  /// build here instead of two million.
  func uniformMultiproof(size : Nat, count : Nat) : (Blob, [(Nat, Blob)], [Blob]) {
    let leaf = Merkle.leafHash("\A1\F3\D9\27\DE\D2\EA\B8\6A\BF\6D\82\9D\67\C4\C9\C1\61\CE\56\87\85\15\D3\92\D8\16\EB\16\8C\13\C0");
    let memo = Map.empty<Nat, Blob>();
    func mth(n : Nat) : Blob {
      if (n == 1) return leaf;
      switch (Map.get(memo, Nat.compare, n)) {
        case (?hash) return hash;
        case null {};
      };
      let k = Merkle.splitPoint(n);
      let hash = Merkle.hashChildren(mth(k), mth(n - k));
      Map.add(memo, Nat.compare, n, hash);
      hash
    };
    let indices = Array.tabulate<Nat>(count, func(i) = i * (size / count));
    var proof : [Blob] = [];
    func walk(lo : Nat, hi : Nat, from : Nat, to : Nat) {
      if (from == to) {
        proof := Array.concat(proof, [mth(hi - lo)]);
        return
      };
      if (hi == lo + 1) return;
      let mid = lo + Merkle.splitPoint(hi - lo);
      var split = from;
      while (split < to and indices[split] < mid) split += 1;
      walk(lo, mid, from, split);
      walk(mid, hi, split, to)
    };
    walk(0, size, 0, count);
    (mth(size), Array.map<Nat, (Nat, Blob)>(indices, func(i) = (i, leaf)), proof)
  };

  public func init() : Bench.Bench {
    let bench = Bench.Bench();

    bench.name("icp-merkle:v1 verification");
    bench.description("Audit path by path length; multiproof by leaves proven in a 1,000,000-leaf tree");

    bench.rows(["audit path", "multiproof"]);
    bench.cols(["1", "5", "10", "17", "20", "16 leaves", "64 leaves", "256 leaves"]);

    let paths = [
      ("1", proofNamed("size-2#0")),
      ("5", proofNamed("size-17#0")),
      ("10", proofNamed("large-100000#99999")),
      ("17", proofNamed("large-100000#0")),
      ("20", proofNamed("uniform-1000000#0")),
    ];
    let multis = [
      ("16 leaves", uniformMultiproof(1_000_000, 16)),
      ("64 leaves", uniformMultiproof(1_000_000, 64)),
      ("256 leaves", uniformMultiproof(1_000_000, 256)),
    ];

    bench.runner(
      func(row, col) {
        switch (row) {
          case "audit path" {
            for ((name, p) in paths.values()) {
              if (name == col) {
                switch (Merkle.rootFromPath(p.index, p.leafCount, Merkle.leafHash(p.leaf), p.path)) {
                  case (#ok(root)) assert root == p.root;
                  case (#err(_)) assert false;
                }
              }
            }
          };
          case _ {
            for ((name, (root, leaves, proof)) in multis.values()) {
              if (name == col) {
                switch (Merkle.rootFromMultiproof(1_000_000, leaves, proof)) {
                  case (#ok(computed)) assert computed == root;
                  case (#err(_)) assert false;
                }
              }
            }
          };
        }
      }
    );

    bench
  };
};
