/// Merkle tree v1 (`icp-merkle:v1`), verified on-chain.
///
/// Before this module the anchor stored a root and a leaf count and nothing
/// said how either related to a leaf. A proof was checkable only by whoever
/// built the tree, with whatever rules they had used. The rules are now fixed
/// and specified in `protocol/MERKLE_V1.md`:
///
///     leaf value = 32 bytes, a SHA-256 digest
///     leaf hash  = SHA-256( 0x00 || "icp-merkle:v1" || leaf value )   46-byte preimage
///     node hash  = SHA-256( 0x01 || left || right )                  65-byte preimage
///     shape      = RFC 9162 section 2.1.1: split at the largest power of two
///                  smaller than the number of leaves
///
/// which is an RFC 9162 Merkle Tree Hash whose entries are
/// `"icp-merkle:v1" || leaf value`. Single proofs are RFC 9162 audit paths.
///
/// This is the second implementation of those rules. The first is
/// `protocol/tools/merkle.mjs`, and the two share no code: `test/Merkle.test.mo`
/// runs this one over the vectors the JavaScript side published, including
/// the transparency-dev/merkle probes Certificate Transparency is tested with.
///
/// Everything here is total. A proof that cannot be a proof — a hash of the
/// wrong length, an index outside the tree, a path of the wrong length, a
/// multiproof with a hash missing or left over — is `#err` with a reason. A
/// well-formed proof reconstructs *some* root, returned as `#ok`, and whether
/// it is the anchored root is the caller's comparison to make.
import Blob "mo:core/Blob";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Sha256 "mo:sha2/Sha256";

module {
  /// What `merkleSpec()` returns. Mirrors `spec()` in
  /// `protocol/tools/merkle.mjs`, so a verifier can check that the canister it
  /// is talking to uses the rules it implements rather than assume it.
  public type Spec = {
    treeVersion : Text;
    hashAlgorithm : Text;
    leafDomain : Text;
    leafPrefix : Nat8;
    nodePrefix : Nat8;
    digestSize : Nat;
    shape : Text;
    maxLeafCount : Nat;
    maxMultiproofLeaves : Nat;
  };

  /// The root a proof reconstructs, or why the input cannot be a proof.
  public type Outcome = {
    #ok : Blob;
    #err : Text;
  };

  /// Names the whole rule set, and doubles as the leaf domain: a later version
  /// hashes every leaf differently, so no v1 root can be read under v2 rules.
  public let treeVersion : Text = "icp-merkle:v1";

  public let hashAlgorithm : Text = "sha256";

  public let digestSize : Nat = 32;

  /// The anchor's existing `leafCount` cap. The deepest leaf of a tree this
  /// size has a 20-hash audit path.
  public let maxLeafCount : Nat = 1_000_000;

  /// How many leaves one on-chain multiproof may prove. A query is bounded in
  /// instructions like any other message; this keeps the worst case well
  /// inside the limit (measured in `bench/merkle.bench.mo`) and is published in
  /// the spec so a client splits a larger set rather than finding out.
  public let maxMultiproofLeaves : Nat = 256;

  let leafTag : Blob = "\00";
  let nodeTag : Blob = "\01";
  // The same 13 ASCII bytes as `treeVersion`, as a Blob literal: a module-level
  // binding has to be static, so it cannot be `Text.encodeUtf8(treeVersion)`.
  // Merkle.test.mo checks the two against the published leaf hash.
  let leafDomain : Blob = "icp-merkle:v1";

  public func spec() : Spec {
    {
      treeVersion;
      hashAlgorithm;
      leafDomain = treeVersion;
      leafPrefix = 0;
      nodePrefix = 1;
      digestSize;
      shape = "rfc9162";
      maxLeafCount;
      maxMultiproofLeaves;
    }
  };

  func isDigest(value : Blob) : Bool { value.size() == digestSize };

  // ------------------------------------------------------- the RFC 9162 core

  /// RFC 9162 leaf hash of arbitrary entry bytes: SHA-256(0x00 || data).
  public func hashLeafData(data : Blob) : Blob {
    let digest = Sha256.new(#sha256);
    digest.writeBlob(leafTag);
    digest.writeBlob(data);
    digest.sum()
  };

  public func hashChildren(left : Blob, right : Blob) : Blob {
    let digest = Sha256.new(#sha256);
    digest.writeBlob(nodeTag);
    digest.writeBlob(left);
    digest.writeBlob(right);
    digest.sum()
  };

  /// The v1 leaf hash of a 32-byte leaf value. Written as one digest rather
  /// than `hashLeafData(domain || value)` so no intermediate blob is built.
  public func leafHash(value : Blob) : Blob {
    let digest = Sha256.new(#sha256);
    digest.writeBlob(leafTag);
    digest.writeBlob(leafDomain);
    digest.writeBlob(value);
    digest.sum()
  };

  /// The largest power of two strictly smaller than `n`, for `n >= 2`.
  public func splitPoint(n : Nat) : Nat {
    var k = 1;
    while (k * 2 < n) k *= 2;
    k
  };

  /// MTH over leaf hashes. `null` for no leaves: a tree has at least one.
  ///
  /// The canister never builds a tree — the leaves are off-chain — so this
  /// exists for the tests and the benchmark, where it is the check that the
  /// two implementations agree on the shape and not only on the proofs.
  public func rootOf(leafHashes : [Blob]) : ?Blob {
    if (leafHashes.size() == 0) return null;
    func mth(lo : Nat, hi : Nat) : Blob {
      if (hi == lo + 1) return leafHashes[lo];
      let mid = lo + splitPoint(hi - lo);
      hashChildren(mth(lo, mid), mth(mid, hi))
    };
    ?mth(0, leafHashes.size())
  };

  /// The exact number of hashes in the audit path of `index` in a tree of
  /// `size`, for `index < size < 2^63`. Fixed by (index, size) alone, which is
  /// what lets a wrong-length path be refused before anything is hashed.
  ///
  /// `inner` is the number of levels at which `index` and the last leaf are
  /// still in different subtrees; above those the path runs up the right edge,
  /// where only the levels with a left sibling contribute a hash (`border`).
  public func pathLength(index : Nat, size : Nat) : Nat {
    let i = Nat.toNat64(index);
    let last = Nat.toNat64(size) - 1;
    let inner = 64 - Nat64.bitcountLeadingZero(i ^ last);
    let border = Nat64.bitcountNonZero(i >> inner);
    Nat64.toNat(inner + border)
  };

  /// Bounds shared by every entry point, checked before any conversion, because
  /// a query that traps tells the caller nothing. `Nat.toNat64` traps above
  /// 2^64 - 1, and `pathLength` needs `size` below 2^63 so that
  /// `index ^ (size - 1)` has a free top bit.
  func checkPosition(index : Nat, size : Nat) : ?Text {
    if (size == 0) return ?"tree size must be at least 1";
    if (size > 0x7FFF_FFFF_FFFF_FFFF) return ?"tree size is too large";
    if (index >= size) return ?"leaf index is outside the tree";
    null
  };

  /// RFC 9162 section 2.1.3.2: the root an audit path reconstructs.
  public func rootFromPath(index : Nat, size : Nat, leafHash : Blob, path : [Blob]) : Outcome {
    switch (checkPosition(index, size)) {
      case (?reason) return #err(reason);
      case null {};
    };
    if (not isDigest(leafHash)) return #err("leaf hash must be 32 bytes");
    for (sibling in path.values()) {
      if (not isDigest(sibling)) return #err("every path hash must be 32 bytes")
    };
    if (path.size() != pathLength(index, size)) {
      return #err("the path length does not match the leaf index and tree size")
    };

    var hash = leafHash;
    var fn = index;
    var sn : Nat = size - 1;
    for (sibling in path.values()) {
      if (sn == 0) return #err("the path continues past the root");
      if (fn % 2 == 1 or fn == sn) {
        hash := hashChildren(sibling, hash);
        // A right-edge node with no sibling at this level is carried up as is.
        while (fn % 2 == 0 and fn != 0) {
          fn /= 2;
          sn /= 2
        }
      } else {
        hash := hashChildren(hash, sibling)
      };
      fn /= 2;
      sn /= 2
    };
    if (sn != 0) return #err("the path ended below the root");
    #ok(hash)
  };

  /// The root a multiproof reconstructs.
  ///
  /// `leaves` are (index, leaf hash) pairs in strictly increasing index order;
  /// `proof` is the hash of every subtree containing none of them, in the
  /// order a left-to-right, depth-first walk of the tree needs them. For a
  /// given size and index set that order and count are fixed, so the proof is
  /// consumed exactly: a hash left over is refused like a hash missing, or the
  /// same claim would have more than one valid encoding.
  public func rootFromMultiproof(size : Nat, leaves : [(Nat, Blob)], proof : [Blob]) : Outcome {
    if (leaves.size() == 0) return #err("a multiproof must prove at least one leaf");
    if (leaves.size() > maxMultiproofLeaves) return #err("a multiproof proves at most 256 leaves");
    // Every hash of a valid proof is the sibling of some leaf's path, so a
    // proof longer than this cannot be valid and is refused before hashing.
    if (proof.size() > leaves.size() * 64) return #err("the multiproof has unused hashes");
    var previous : ?Nat = null;
    for ((index, hash) in leaves.values()) {
      switch (checkPosition(index, size)) {
        case (?reason) return #err(reason);
        case null {};
      };
      switch (previous) {
        case (?p) if (index <= p) return #err("multiproof leaf indices must be strictly increasing");
        case null {};
      };
      previous := ?index;
      if (not isDigest(hash)) return #err("leaf hash must be 32 bytes")
    };
    for (hash in proof.values()) {
      if (not isDigest(hash)) return #err("every proof hash must be 32 bytes")
    };

    var next = 0;
    var short = false;
    func walk(lo : Nat, hi : Nat, from : Nat, to : Nat) : Blob {
      if (from == to) {
        if (next >= proof.size()) {
          short := true;
          return ""
        };
        let hash = proof[next];
        next += 1;
        return hash
      };
      if (hi == lo + 1) return leaves[from].1;
      let mid = lo + splitPoint(hi - lo);
      var split = from;
      while (split < to and leaves[split].0 < mid) split += 1;
      let left = walk(lo, mid, from, split);
      let right = walk(mid, hi, split, to);
      if (short) return "";
      hashChildren(left, right)
    };

    let root = walk(0, size, 0, leaves.size());
    if (short) return #err("the multiproof has too few hashes");
    if (next != proof.size()) return #err("the multiproof has unused hashes");
    #ok(root)
  };
};
