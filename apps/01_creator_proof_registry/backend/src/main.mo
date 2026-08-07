import Blob "mo:core/Blob";
import CertTree "mo:ic-certification/CertTree";
import CertifiedData "mo:core/CertifiedData";
import Commitment "Commitment";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import RecordDigest "RecordDigest";
import Time "mo:core/Time";
import Validation "Validation";

persistent actor CreatorProofRegistry {
  public type Error = {
    #anonymousNotAllowed;
    #unauthorized;
    #notFound;
    #invalidInput : Text;
    #duplicate : Text;
    #conflict : Text;
    #expired;
  };

  public type Result<T> = {
    #ok : T;
    #err : Error;
  };

  public type CommitmentStatus = {
    #open;
    #revealed : Nat;
    #cancelled : Nat;
  };

  public type Commitment = {
    id : Nat;
    owner : Principal;
    commitmentHash : Blob;
    metadataHash : ?Blob;
    committedAt : Nat;
    expiresAt : ?Nat;
    status : CommitmentStatus;
  };

  // Aliased rather than redeclared: `RecordDigest.encode` covers every field,
  // so a field added here and forgotten there would silently fall outside what
  // the certificate attests. Sharing the declaration makes that impossible.
  public type AIDisclosure = RecordDigest.AIDisclosure;

  public type RecordStatus = RecordDigest.RecordStatus;

  public type ProofRecord = RecordDigest.Record;

  /// A record together with the evidence that the canister, and not the
  /// transport, produced it.
  public type CertifiedRecord = {
    record : ProofRecord;
    /// The system certificate: a BLS signature over the state tree, which
    /// includes this canister's certified data.
    certificate : Blob;
    /// The pruned hash tree whose root is that certified data, revealing the
    /// digest of this record and nothing else.
    witness : Blob;
  };

  public type CommitInput = {
    commitmentHash : Blob;
    metadataHash : ?Blob;
    expiresAt : ?Nat;
  };

  public type RevealInput = {
    commitmentId : Nat;
    artifactHash : Blob;
    manifestHash : Blob;
    salt : Blob;
    title : Text;
    kind : Text;
    mimeType : Text;
    storageUri : Text;
    parents : [Nat];
    ai : AIDisclosure;
    // Which commitment layout the caller used. `null` means the only layout
    // that has ever existed, so clients written before this field keep working.
    // Naming the wrong one simply fails verification: the algorithm picks the
    // preimage, and the preimage is what `commit` hashed.
    algorithm : ?Commitment.Algorithm;
  };

  public type Stats = {
    commitments : Nat;
    records : Nat;
    activeRecords : Nat;
    revokedRecords : Nat;
  };

  /// The certified hash tree. `Store` is plain data so it persists; `Ops` is
  /// the class that operates on it and is rebuilt on every upgrade.
  let certified : CertTree.Store = CertTree.newStore();
  transient let tree = CertTree.Ops(certified);

  let commitments = Map.empty<Nat, Commitment>();
  let commitmentHashIndex = Map.empty<Blob, Nat>();
  let records = Map.empty<Nat, ProofRecord>();
  let artifactHashIndex = Map.empty<Blob, Nat>();

  var nextCommitmentId : Nat = 1;
  var nextRecordId : Nat = 1;
  var activeRecordCount : Nat = 0;
  var revokedRecordCount : Nat = 0;

  func nowNanos() : Nat { Int.abs(Time.now()) };

  /// Writes a record's digest into the certified tree and republishes the root.
  ///
  /// `setCertifiedData` only works in an update call, and the root it publishes
  /// is only signed once the round ends — so a query in the *same* round as the
  /// write can still see the previous certificate. That is why every mutation
  /// calls this before returning rather than batching, and why a client that
  /// needs certainty right now uses an update call instead.
  func certify(record : ProofRecord) {
    tree.put([RecordDigest.treeLabel, RecordDigest.idKey(record.id)], RecordDigest.digest(record));
    tree.setCertifiedData()
  };

  func rejectAnonymous(caller : Principal) : ?Error {
    if (Principal.isAnonymous(caller)) ?#anonymousNotAllowed else null
  };

  func validateCommit(input : CommitInput) : ?Error {
    if (not Validation.isDigest(input.commitmentHash)) {
      return ?#invalidInput("commitmentHash must be 32 bytes")
    };
    switch (input.metadataHash) {
      case (?hash) {
        if (not Validation.isDigest(hash)) {
          return ?#invalidInput("metadataHash must be 32 bytes")
        }
      };
      case null {};
    };
    switch (input.expiresAt) {
      case (?expiresAt) {
        if (expiresAt <= nowNanos()) {
          return ?#invalidInput("expiresAt must be in the future")
        }
      };
      case null {};
    };
    null
  };

  func validateDisclosure(ai : AIDisclosure) : ?Error {
    switch (ai.promptHash) {
      case (?hash) {
        if (not Validation.isDigest(hash)) {
          return ?#invalidInput("promptHash must be 32 bytes")
        }
      };
      case null {};
    };
    switch (ai.provider) {
      case (?value) {
        if (not Validation.validText(value, 1, 100)) {
          return ?#invalidInput("AI provider length is invalid")
        }
      };
      case null {};
    };
    switch (ai.model) {
      case (?value) {
        if (not Validation.validText(value, 1, 100)) {
          return ?#invalidInput("AI model length is invalid")
        }
      };
      case null {};
    };
    switch (ai.humanContribution) {
      case (?value) {
        if (not Validation.validText(value, 1, 1000)) {
          return ?#invalidInput("humanContribution length is invalid")
        }
      };
      case null {};
    };
    null
  };

  func validateReveal(input : RevealInput) : ?Error {
    if (not Validation.isDigest(input.artifactHash)) {
      return ?#invalidInput("artifactHash must be 32 bytes")
    };
    if (not Validation.isDigest(input.manifestHash)) {
      return ?#invalidInput("manifestHash must be 32 bytes")
    };
    if (not Validation.validSalt(input.salt)) {
      return ?#invalidInput("salt must be between 16 and 64 bytes")
    };
    if (not Validation.validText(input.title, 1, 200)) {
      return ?#invalidInput("title length is invalid")
    };
    if (not Validation.validText(input.kind, 1, 100)) {
      return ?#invalidInput("kind length is invalid")
    };
    if (not Validation.validText(input.mimeType, 1, 100)) {
      return ?#invalidInput("mimeType length is invalid")
    };
    if (not Validation.validText(input.storageUri, 1, 2048)) {
      return ?#invalidInput("storageUri length is invalid")
    };
    if (input.parents.size() > 32) {
      return ?#invalidInput("parents must contain at most 32 records")
    };
    validateDisclosure(input.ai)
  };

  public shared ({ caller }) func commit(input : CommitInput) : async Result<Commitment> {
    switch (rejectAnonymous(caller)) {
      case (?error) return #err(error);
      case null {};
    };
    switch (validateCommit(input)) {
      case (?error) return #err(error);
      case null {};
    };
    switch (Map.get(commitmentHashIndex, Blob.compare, input.commitmentHash)) {
      case (?_) return #err(#duplicate("commitmentHash already exists"));
      case null {};
    };

    let id = nextCommitmentId;
    nextCommitmentId += 1;
    let commitment : Commitment = {
      id = id;
      owner = caller;
      commitmentHash = input.commitmentHash;
      metadataHash = input.metadataHash;
      committedAt = nowNanos();
      expiresAt = input.expiresAt;
      status = #open;
    };
    Map.add(commitments, Nat.compare, id, commitment);
    Map.add(commitmentHashIndex, Blob.compare, input.commitmentHash, id);
    #ok(commitment)
  };

  public shared ({ caller }) func cancelCommitment(id : Nat) : async Result<Commitment> {
    let ?current = Map.get(commitments, Nat.compare, id) else return #err(#notFound);
    if (current.owner != caller) {
      return #err(#unauthorized)
    };
    switch (current.status) {
      case (#open) {};
      case _ return #err(#conflict("commitment is not open"));
    };
    let updated : Commitment = {
      id = current.id;
      owner = current.owner;
      commitmentHash = current.commitmentHash;
      metadataHash = current.metadataHash;
      committedAt = current.committedAt;
      expiresAt = current.expiresAt;
      status = #cancelled(nowNanos());
    };
    Map.add(commitments, Nat.compare, id, updated);
    #ok(updated)
  };

  public shared ({ caller }) func reveal(input : RevealInput) : async Result<ProofRecord> {
    switch (rejectAnonymous(caller)) {
      case (?error) return #err(error);
      case null {};
    };
    switch (validateReveal(input)) {
      case (?error) return #err(error);
      case null {};
    };

    let ?commitment = Map.get(commitments, Nat.compare, input.commitmentId) else return #err(#notFound);
    if (commitment.owner != caller) {
      return #err(#unauthorized)
    };
    switch (commitment.status) {
      case (#open) {};
      case _ return #err(#conflict("commitment is not open"));
    };
    switch (commitment.expiresAt) {
      case (?expiresAt) {
        if (nowNanos() > expiresAt) {
          return #err(#expired)
        }
      };
      case null {};
    };
    // The security gate. Everything above only established that an open,
    // unexpired commitment belongs to the caller; nothing yet tied it to what
    // is being revealed. Recomputing the digest is what makes the commitment
    // binding, and it has to happen before any state changes.
    let algorithm = switch (input.algorithm) {
      case (?value) value;
      case null Commitment.currentAlgorithm;
    };
    let principalText = Commitment.canonicalPrincipalText(caller);
    if (not Commitment.validPrincipalText(principalText)) {
      return #err(#invalidInput("caller principal text length is invalid"))
    };
    let parts : Commitment.Parts = {
      principalText = principalText;
      manifestHash = input.manifestHash;
      salt = input.salt;
    };
    if (not Commitment.matches(algorithm, commitment.commitmentHash, parts)) {
      return #err(#invalidInput("commitment hash does not match the revealed principal, manifestHash, and salt"))
    };

    switch (Map.get(artifactHashIndex, Blob.compare, input.artifactHash)) {
      case (?_) return #err(#duplicate("artifactHash already has a record"));
      case null {};
    };
    for (parentId in input.parents.values()) {
      let ?parent = Map.get(records, Nat.compare, parentId) else {
        return #err(#invalidInput("parent record does not exist"))
      };
      switch (parent.status) {
        case (#active) {};
        case (#revoked(_)) {
          return #err(#invalidInput("parent record is revoked"))
        };
      }
    };

    let recordId = nextRecordId;
    nextRecordId += 1;
    let record : ProofRecord = {
      id = recordId;
      commitmentId = input.commitmentId;
      owner = caller;
      artifactHash = input.artifactHash;
      manifestHash = input.manifestHash;
      salt = input.salt;
      title = input.title;
      kind = input.kind;
      mimeType = input.mimeType;
      storageUri = input.storageUri;
      parents = input.parents;
      ai = input.ai;
      createdAt = nowNanos();
      status = #active;
    };
    Map.add(records, Nat.compare, recordId, record);
    Map.add(artifactHashIndex, Blob.compare, input.artifactHash, recordId);
    activeRecordCount += 1;
    certify(record);

    let updatedCommitment : Commitment = {
      id = commitment.id;
      owner = commitment.owner;
      commitmentHash = commitment.commitmentHash;
      metadataHash = commitment.metadataHash;
      committedAt = commitment.committedAt;
      expiresAt = commitment.expiresAt;
      status = #revealed(recordId);
    };
    Map.add(commitments, Nat.compare, commitment.id, updatedCommitment);
    #ok(record)
  };

  public shared ({ caller }) func revokeRecord(id : Nat, reason : Text) : async Result<ProofRecord> {
    if (not Validation.validText(reason, 1, 1000)) {
      return #err(#invalidInput("reason length is invalid"))
    };
    let ?current = Map.get(records, Nat.compare, id) else return #err(#notFound);
    if (current.owner != caller) {
      return #err(#unauthorized)
    };
    switch (current.status) {
      case (#active) {};
      case (#revoked(_)) return #err(#conflict("record is already revoked"));
    };
    let updated : ProofRecord = {
      id = current.id;
      commitmentId = current.commitmentId;
      owner = current.owner;
      artifactHash = current.artifactHash;
      manifestHash = current.manifestHash;
      salt = current.salt;
      title = current.title;
      kind = current.kind;
      mimeType = current.mimeType;
      storageUri = current.storageUri;
      parents = current.parents;
      ai = current.ai;
      createdAt = current.createdAt;
      status = #revoked({ at = nowNanos(); reason = reason });
    };
    Map.add(records, Nat.compare, id, updated);
    activeRecordCount -= 1;
    revokedRecordCount += 1;
    // Revocation is a status change, and a status change nobody can detect is
    // a revocation that does not work: an intermediary could keep serving the
    // record as active. Re-certifying is what makes the withdrawal visible.
    certify(updated);
    #ok(updated)
  };

  public query func getCommitment(id : Nat) : async ?Commitment {
    Map.get(commitments, Nat.compare, id)
  };

  public query func getRecord(id : Nat) : async ?ProofRecord {
    Map.get(records, Nat.compare, id)
  };

  public query func getByArtifactHash(hash : Blob) : async ?ProofRecord {
    let ?id = Map.get(artifactHashIndex, Blob.compare, hash) else return null;
    Map.get(records, Nat.compare, id)
  };

  public query func listRecords(start : Nat, limit : Nat) : async [ProofRecord] {
    let entries = Iter.take(Map.entriesFrom(records, Nat.compare, start), Validation.pageLimit(limit));
    let values = Iter.map<(Nat, ProofRecord), ProofRecord>(
      entries,
      func(entry : (Nat, ProofRecord)) : ProofRecord { entry.1 }
    );
    Iter.toArray(values)
  };

  /// `getRecord`, with the evidence that the answer came from the canister.
  ///
  /// A plain query response is unsigned, so a boundary node, a proxy, or a
  /// compromised frontend can change any field of it and nothing downstream can
  /// tell. This returns the system certificate and a witness alongside the
  /// record; a reader recomputes `RecordDigest.encode` over what it received,
  /// checks the witness reveals that digest under `["record", id]`, and checks
  /// the witness root is the certified data the certificate signs.
  ///
  /// `null` means no such record. Absence is *not* certified here: the witness
  /// mechanism can prove it, but a reader that needs a proven absence should
  /// call this as an update call, which is answered by consensus and needs no
  /// certificate. See docs/CERTIFIED_QUERIES.md.
  public query func getRecordCertified(id : Nat) : async ?CertifiedRecord {
    let ?record = Map.get(records, Nat.compare, id) else return null;
    let ?certificate = CertifiedData.getCertificate() else return null;
    ?{
      record;
      certificate;
      witness = tree.encodeWitness(tree.reveal([RecordDigest.treeLabel, RecordDigest.idKey(id)]));
    }
  };

  /// Lets a verifier read the commitment rules off the canister instead of
  /// hardcoding them, so a client can tell a v1 registry from a later one
  /// without guessing from a failed reveal.
  public query func commitmentSpec() : async Commitment.Spec {
    Commitment.spec()
  };

  public query func stats() : async Stats {
    {
      commitments = Map.size(commitments);
      records = Map.size(records);
      activeRecords = activeRecordCount;
      revokedRecords = revokedRecordCount;
    }
  };
};
