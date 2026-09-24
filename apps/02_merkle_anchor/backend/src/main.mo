import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Merkle "Merkle";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Validation "Validation";

persistent actor MerkleAnchor {
  public type Error = {
    #anonymousNotAllowed;
    #unauthorized;
    #notFound;
    #invalidInput : Text;
    #duplicate;
    #conflict : Text;
  };
  public type Result<T> = { #ok : T; #err : Error };
  public type Status = {
    #active;
    #revoked : { at : Nat; reason : Text };
  };
  public type Batch = {
    id : Nat;
    owner : Principal;
    root : Blob;
    leafCount : Nat;
    hashAlgorithm : Text;
    treeVersion : Text;
    schemaUri : Text;
    policyUri : Text;
    manifestUri : Text;
    supersedes : ?Nat;
    createdAt : Nat;
    status : Status;
  };
  public type AnchorInput = {
    root : Blob;
    leafCount : Nat;
    hashAlgorithm : Text;
    treeVersion : Text;
    schemaUri : Text;
    policyUri : Text;
    manifestUri : Text;
    supersedes : ?Nat;
  };
  public type Stats = { batches : Nat; active : Nat; revoked : Nat };

  public type MerkleSpec = Merkle.Spec;

  /// One leaf and its RFC 9162 audit path, bottom-up. `leaf` is the 32-byte
  /// leaf value (a digest), not its leaf hash: the canister hashes it under the
  /// v1 domain itself, so a caller cannot present an interior node as a leaf.
  public type InclusionProof = {
    leaf : Blob;
    index : Nat;
    path : [Blob];
  };

  public type ProvenLeaf = { index : Nat; leaf : Blob };

  /// Several leaves of one tree, in strictly increasing index order, and the
  /// hashes of every subtree containing none of them. See protocol/MERKLE_V1.md.
  public type Multiproof = {
    leaves : [ProvenLeaf];
    proof : [Blob];
  };

  /// What a verification found. `included` answers exactly one question: does
  /// the proof reconstruct the root anchored in this batch. The batch status is
  /// returned beside it rather than folded into it, because a leaf of a revoked
  /// batch is still in the tree and what that means is the reader's call, not
  /// something a boolean should hide.
  public type ProofCheck = {
    batchId : Nat;
    treeVersion : Text;
    leafCount : Nat;
    root : Blob;
    /// The root the proof actually reconstructs. When `included` is false this
    /// is what to look up with `getByRoot` if the proof belongs elsewhere.
    computedRoot : Blob;
    included : Bool;
    status : Status;
  };

  let batches = Map.empty<Nat, Batch>();
  let rootIndex = Map.empty<Blob, Nat>();
  var nextId : Nat = 1;
  var activeCount : Nat = 0;
  var revokedCount : Nat = 0;

  func nowNanos() : Nat { Int.abs(Time.now()) };

  func validate(input : AnchorInput) : ?Error {
    if (not Validation.isDigest(input.root)) return ?#invalidInput("root must be 32 bytes");
    if (input.leafCount == 0 or input.leafCount > Merkle.maxLeafCount) {
      return ?#invalidInput("leafCount must be between 1 and 1,000,000")
    };
    if (not Validation.validText(input.hashAlgorithm, 1, 50)) return ?#invalidInput("hashAlgorithm length is invalid");
    if (not Validation.validText(input.treeVersion, 1, 50)) return ?#invalidInput("treeVersion length is invalid");
    // A root built under rules nobody wrote down is a root nobody can verify.
    // New batches must name the one tree version this canister implements, so
    // every root anchored from here on can be checked with `verifyProof`.
    // Batches anchored before this rule keep whatever they declared: their
    // roots are never reinterpreted, only reported as unverifiable here.
    if (input.treeVersion != Merkle.treeVersion) {
      return ?#invalidInput("treeVersion must be icp-merkle:v1")
    };
    if (input.hashAlgorithm != Merkle.hashAlgorithm) {
      return ?#invalidInput("hashAlgorithm must be sha256 for icp-merkle:v1")
    };
    if (not Validation.validText(input.schemaUri, 1, 2048)) return ?#invalidInput("schemaUri length is invalid");
    if (not Validation.validText(input.policyUri, 1, 2048)) return ?#invalidInput("policyUri length is invalid");
    if (not Validation.validText(input.manifestUri, 1, 2048)) return ?#invalidInput("manifestUri length is invalid");
    null
  };

  public shared ({ caller }) func anchor(input : AnchorInput) : async Result<Batch> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    switch (validate(input)) { case (?error) return #err(error); case null {} };
    switch (Map.get(rootIndex, Blob.compare, input.root)) {
      case (?_) return #err(#duplicate);
      case null {};
    };
    switch (input.supersedes) {
      case (?previousId) {
        let ?previous = Map.get(batches, Nat.compare, previousId) else return #err(#notFound);
        if (previous.owner != caller) return #err(#unauthorized);
      };
      case null {};
    };
    let id = nextId;
    nextId += 1;
    let batch : Batch = {
      id = id;
      owner = caller;
      root = input.root;
      leafCount = input.leafCount;
      hashAlgorithm = input.hashAlgorithm;
      treeVersion = input.treeVersion;
      schemaUri = input.schemaUri;
      policyUri = input.policyUri;
      manifestUri = input.manifestUri;
      supersedes = input.supersedes;
      createdAt = nowNanos();
      status = #active;
    };
    Map.add(batches, Nat.compare, id, batch);
    Map.add(rootIndex, Blob.compare, input.root, id);
    activeCount += 1;
    #ok(batch)
  };

  public shared ({ caller }) func revoke(id : Nat, reason : Text) : async Result<Batch> {
    if (not Validation.validText(reason, 1, 1000)) return #err(#invalidInput("reason length is invalid"));
    let ?current = Map.get(batches, Nat.compare, id) else return #err(#notFound);
    if (current.owner != caller) return #err(#unauthorized);
    switch (current.status) {
      case (#active) {};
      case (#revoked(_)) return #err(#conflict("batch is already revoked"));
    };
    let updated : Batch = {
      id = current.id;
      owner = current.owner;
      root = current.root;
      leafCount = current.leafCount;
      hashAlgorithm = current.hashAlgorithm;
      treeVersion = current.treeVersion;
      schemaUri = current.schemaUri;
      policyUri = current.policyUri;
      manifestUri = current.manifestUri;
      supersedes = current.supersedes;
      createdAt = current.createdAt;
      status = #revoked({ at = nowNanos(); reason = reason });
    };
    Map.add(batches, Nat.compare, id, updated);
    activeCount -= 1;
    revokedCount += 1;
    #ok(updated)
  };

  public query func getBatch(id : Nat) : async ?Batch { Map.get(batches, Nat.compare, id) };

  public query func getByRoot(root : Blob) : async ?Batch {
    let ?id = Map.get(rootIndex, Blob.compare, root) else return null;
    Map.get(batches, Nat.compare, id)
  };

  public query func listBatches(start : Nat, limit : Nat) : async [Batch] {
    let entries = Iter.take(Map.entriesFrom(batches, Nat.compare, start), Validation.pageLimit(limit));
    Iter.toArray(Iter.map<(Nat, Batch), Batch>(entries, func(entry : (Nat, Batch)) : Batch { entry.1 }))
  };

  /// The tree rules this canister verifies, so a client can check it agrees
  /// before it trusts a `verifyProof` answer.
  public query func merkleSpec() : async MerkleSpec { Merkle.spec() };

  /// Checks one leaf's inclusion in an anchored batch.
  ///
  /// The tree size is the anchored `leafCount`, never a value from the caller:
  /// the audit path is only meaningful for one (index, size) pair, and letting
  /// the caller pick the size would let them pick which tree is being asked
  /// about. `#err` means the input cannot be a proof for this batch at all;
  /// a well-formed proof that does not reach the root is `#ok` with
  /// `included = false`.
  ///
  /// Like every query, the answer is only as trustworthy as the replica that
  /// gave it. The authoritative check is the one a verifier runs itself against
  /// the root, with `protocol/tools/merkle.mjs` or any RFC 9162 implementation.
  public query func verifyProof(batchId : Nat, proof : InclusionProof) : async Result<ProofCheck> {
    let ?batch = Map.get(batches, Nat.compare, batchId) else return #err(#notFound);
    switch (verifiable(batch)) { case (?error) return #err(error); case null {} };
    if (not Validation.isDigest(proof.leaf)) return #err(#invalidInput("leaf must be 32 bytes"));
    switch (Merkle.rootFromPath(proof.index, batch.leafCount, Merkle.leafHash(proof.leaf), proof.path)) {
      case (#err(reason)) #err(#invalidInput(reason));
      case (#ok(computed)) #ok(check(batch, computed));
    }
  };

  /// Checks several leaves of one batch with a single multiproof.
  public query func verifyMultiproof(batchId : Nat, proof : Multiproof) : async Result<ProofCheck> {
    let ?batch = Map.get(batches, Nat.compare, batchId) else return #err(#notFound);
    switch (verifiable(batch)) { case (?error) return #err(error); case null {} };
    if (proof.leaves.size() > Merkle.maxMultiproofLeaves) {
      return #err(#invalidInput("a multiproof proves at most 256 leaves"))
    };
    for (item in proof.leaves.values()) {
      if (not Validation.isDigest(item.leaf)) return #err(#invalidInput("leaf must be 32 bytes"))
    };
    let leaves = Array.map<ProvenLeaf, (Nat, Blob)>(
      proof.leaves,
      func(item : ProvenLeaf) : (Nat, Blob) { (item.index, Merkle.leafHash(item.leaf)) }
    );
    switch (Merkle.rootFromMultiproof(batch.leafCount, leaves, proof.proof)) {
      case (#err(reason)) #err(#invalidInput(reason));
      case (#ok(computed)) #ok(check(batch, computed));
    }
  };

  /// A batch anchored before tree versions were enforced may name rules this
  /// canister does not implement. Reading its root under v1 rules would be
  /// reinterpreting it, so it is refused rather than guessed at.
  func verifiable(batch : Batch) : ?Error {
    if (batch.treeVersion != Merkle.treeVersion or batch.hashAlgorithm != Merkle.hashAlgorithm) {
      return ?#conflict("batch was not anchored under icp-merkle:v1 and cannot be verified here")
    };
    null
  };

  func check(batch : Batch, computed : Blob) : ProofCheck {
    {
      batchId = batch.id;
      treeVersion = batch.treeVersion;
      leafCount = batch.leafCount;
      root = batch.root;
      computedRoot = computed;
      included = Blob.equal(computed, batch.root);
      status = batch.status;
    }
  };

  public query func stats() : async Stats {
    { batches = Map.size(batches); active = activeCount; revoked = revokedCount }
  };
};
