import Blob "mo:core/Blob";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
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

  public type AIDisclosure = {
    assisted : Bool;
    mode : { #none; #assist; #generate; #transform; #other : Text };
    provider : ?Text;
    model : ?Text;
    promptHash : ?Blob;
    humanContribution : ?Text;
  };

  public type RecordStatus = {
    #active;
    #revoked : { at : Nat; reason : Text };
  };

  public type ProofRecord = {
    id : Nat;
    commitmentId : Nat;
    owner : Principal;
    artifactHash : Blob;
    manifestHash : Blob;
    salt : Blob;
    title : Text;
    kind : Text;
    mimeType : Text;
    storageUri : Text;
    parents : [Nat];
    ai : AIDisclosure;
    createdAt : Nat;
    status : RecordStatus;
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
  };

  public type Stats = {
    commitments : Nat;
    records : Nat;
    activeRecords : Nat;
    revokedRecords : Nat;
  };

  let commitments = Map.empty<Nat, Commitment>();
  let commitmentHashIndex = Map.empty<Blob, Nat>();
  let records = Map.empty<Nat, ProofRecord>();
  let artifactHashIndex = Map.empty<Blob, Nat>();

  var nextCommitmentId : Nat = 1;
  var nextRecordId : Nat = 1;
  var activeRecordCount : Nat = 0;
  var revokedRecordCount : Nat = 0;

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
        if (expiresAt <= Time.now()) {
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
      committedAt = Time.now();
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
      status = #cancelled(Time.now());
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
        if (Time.now() > expiresAt) {
          return #err(#expired)
        }
      };
      case null {};
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
      createdAt = Time.now();
      status = #active;
    };
    Map.add(records, Nat.compare, recordId, record);
    Map.add(artifactHashIndex, Blob.compare, input.artifactHash, recordId);
    activeRecordCount += 1;

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
      status = #revoked({ at = Time.now(); reason = reason });
    };
    Map.add(records, Nat.compare, id, updated);
    activeRecordCount -= 1;
    revokedRecordCount += 1;
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

  public query func stats() : async Stats {
    {
      commitments = Map.size(commitments);
      records = Map.size(records);
      activeRecords = activeRecordCount;
      revokedRecords = revokedRecordCount;
    }
  };
};
