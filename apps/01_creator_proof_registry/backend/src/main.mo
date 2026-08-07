import Array "mo:core/Array";
import Blob "mo:core/Blob";
import CertTree "mo:ic-certification/CertTree";
import CertifiedData "mo:core/CertifiedData";
import Commitment "Commitment";
import Identity "Identity";
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
    // Which of the creator's collections this record belongs to. `null` means
    // none, which is what a caller holding no creator identity always sends.
    // A collection-scoped delegate cannot use `null`: treating "no collection"
    // as "any collection" would leave the scope up to the delegate to honour.
    collection : ?Identity.CollectionId;
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

  // ------------------------------------------------------- creator identity

  let creators = Map.empty<Nat, Identity.Creator>();
  /// Only the *current* root of each creator. A rotated-away principal is
  /// removed from here and kept in the creator's `keys` history, which is what
  /// stops it registering anything new while leaving old records attributable.
  let creatorByRoot = Map.empty<Principal, Nat>();
  /// Every principal that has ever been a root, including retired ones. A
  /// retired key that fell back to registering as an ordinary caller would
  /// make rotation pointless, so it has to be refused rather than ignored.
  let everRoot = Map.empty<Principal, Nat>();
  let collections = Map.empty<Nat, Identity.Collection>();
  let delegations = Map.empty<Nat, Identity.Delegation>();
  /// Delegation ids per delegate principal, so authorization is a lookup rather
  /// than a scan of every delegation in the registry.
  let delegationsOf = Map.empty<Principal, [Nat]>();
  /// At most one open recovery per creator; completed and cancelled ones stay
  /// for the record.
  let recoveries = Map.empty<Nat, Identity.Recovery>();
  /// Record id to attribution. A side index rather than a field on
  /// `ProofRecord`, so records written before identity existed keep their exact
  /// shape and no stable-data migration is needed to introduce this.
  let attributions = Map.empty<Nat, Identity.Attribution>();

  var nextCreatorId : Nat = 1;
  var nextCollectionId : Nat = 1;
  var nextDelegationId : Nat = 1;

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

  /// Which creator, if any, a caller is registering on behalf of.
  ///
  /// Identity is opt-in: a principal with no creator and no delegation
  /// registers exactly as it did before this existed, and `#ok(null)` says so.
  /// What is *not* optional is that a principal already entangled with an
  /// identity stays governed by it — a revoked delegate or a rotated-away key
  /// that could fall back to registering as itself would make revocation and
  /// rotation decorative.
  func resolveAuthority(
    caller : Principal,
    collection : ?Nat,
    now : Nat
  ) : Result<?(Nat, Identity.Authority)> {
    switch (Map.get(creatorByRoot, Principal.compare, caller)) {
      case (?creatorId) {
        switch (checkCollection(creatorId, collection)) {
          case (?error) return #err(error);
          case null {};
        };
        return #ok(?(creatorId, #root))
      };
      case null {};
    };

    switch (Map.get(everRoot, Principal.compare, caller)) {
      case (?_) return #err(#unauthorized);
      case null {};
    };

    let ids = switch (Map.get(delegationsOf, Principal.compare, caller)) {
      case null return #ok(null);
      case (?ids) ids;
    };
    for (id in ids.values()) {
      switch (Map.get(delegations, Nat.compare, id)) {
        case null {};
        case (?delegation) {
          if (Identity.authorizes(delegation, caller, collection, now)) {
            switch (checkCollection(delegation.creator, collection)) {
              case (?error) return #err(error);
              case null {};
            };
            return #ok(?(delegation.creator, #delegated(delegation.id)))
          }
        }
      }
    };
    // Known delegate, nothing authorizes it: expired, revoked, or out of scope.
    // Which one is not reported, so a probing caller learns nothing about
    // delegations it does not hold.
    #err(#unauthorized)
  };

  func checkCollection(creatorId : Nat, collection : ?Nat) : ?Error {
    let ?requested = collection else return null;
    let ?found = Map.get(collections, Nat.compare, requested) else {
      return ?#invalidInput("collection does not exist")
    };
    if (found.creator != creatorId) {
      return ?#unauthorized
    };
    null
  };

  func requireRoot(caller : Principal) : Result<Identity.Creator> {
    let ?creatorId = Map.get(creatorByRoot, Principal.compare, caller) else {
      return #err(#unauthorized)
    };
    let ?creator = Map.get(creators, Nat.compare, creatorId) else return #err(#notFound);
    #ok(creator)
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

  // ------------------------------------------------------- identity (#7) --

  /// Claims a creator identity for the caller. The caller becomes the root.
  public shared ({ caller }) func registerCreator() : async Result<Identity.Creator> {
    switch (rejectAnonymous(caller)) {
      case (?error) return #err(error);
      case null {};
    };
    switch (Map.get(everRoot, Principal.compare, caller)) {
      case (?_) return #err(#duplicate("principal is already a creator key"));
      case null {};
    };

    let id = nextCreatorId;
    nextCreatorId += 1;
    let now = nowNanos();
    let creator : Identity.Creator = {
      id;
      root = caller;
      keys = [{ principal = caller; activeFrom = now; retiredAt = null; reason = "registered" }];
      recovery = null;
      createdAt = now;
    };
    Map.add(creators, Nat.compare, id, creator);
    Map.add(creatorByRoot, Principal.compare, caller, id);
    Map.add(everRoot, Principal.compare, caller, id);
    #ok(creator)
  };

  /// Retires the current root key and installs a new one.
  ///
  /// Old records are not touched. They keep the principal that signed them,
  /// because at the moment of registration that principal really was the
  /// signer, and a verifier reading a years-old record needs what was true
  /// then. `attribution` resolves them to the creator through the key history.
  public shared ({ caller }) func rotateKey(newRoot : Principal, reason : Text) : async Result<Identity.Creator> {
    let creator = switch (requireRoot(caller)) {
      case (#err(error)) return #err(error);
      case (#ok(creator)) creator;
    };
    if (Principal.isAnonymous(newRoot)) {
      return #err(#invalidInput("the anonymous principal cannot hold an identity"))
    };
    if (Principal.equal(newRoot, caller)) {
      return #err(#conflict("the new root is the current root"))
    };
    if (not Identity.validReason(reason)) {
      return #err(#invalidInput("reason length is invalid"))
    };
    switch (Map.get(everRoot, Principal.compare, newRoot)) {
      case (?_) return #err(#duplicate("principal is already a creator key"));
      case null {};
    };

    let now = nowNanos();
    let retired = Array.map<Identity.KeyRecord, Identity.KeyRecord>(
      creator.keys,
      func(key : Identity.KeyRecord) : Identity.KeyRecord {
        if (Principal.equal(key.principal, caller) and key.retiredAt == null) {
          { key with retiredAt = ?now }
        } else key
      }
    );
    let updated : Identity.Creator = {
      creator with
      root = newRoot;
      keys = Array.concat(retired, [{ principal = newRoot; activeFrom = now; retiredAt = null; reason }]);
    };
    Map.add(creators, Nat.compare, creator.id, updated);
    Map.remove(creatorByRoot, Principal.compare, caller);
    Map.add(creatorByRoot, Principal.compare, newRoot, creator.id);
    Map.add(everRoot, Principal.compare, newRoot, creator.id);
    #ok(updated)
  };

  public shared ({ caller }) func createCollection(name : Text) : async Result<Identity.Collection> {
    let creator = switch (requireRoot(caller)) {
      case (#err(error)) return #err(error);
      case (#ok(creator)) creator;
    };
    if (not Identity.validName(name)) {
      return #err(#invalidInput("collection name length is invalid"))
    };
    let id = nextCollectionId;
    nextCollectionId += 1;
    let collection : Identity.Collection = { id; creator = creator.id; name; createdAt = nowNanos() };
    Map.add(collections, Nat.compare, id, collection);
    #ok(collection)
  };

  /// Authorizes `delegate` to register under this identity until `expiresAt`.
  public shared ({ caller }) func createDelegation(
    delegate : Principal,
    scope : Identity.Scope,
    expiresAt : Nat
  ) : async Result<Identity.Delegation> {
    let creator = switch (requireRoot(caller)) {
      case (#err(error)) return #err(error);
      case (#ok(creator)) creator;
    };
    if (Principal.isAnonymous(delegate)) {
      return #err(#invalidInput("the anonymous principal cannot be a delegate"))
    };
    switch (Map.get(everRoot, Principal.compare, delegate)) {
      case (?_) return #err(#conflict("principal is a creator key and cannot also be a delegate"));
      case null {};
    };
    let now = nowNanos();
    if (expiresAt <= now) {
      return #err(#invalidInput("expiresAt must be in the future"))
    };
    // Written as an addition rather than `expiresAt - now`: `Nat` subtraction
    // traps below zero, and a guard that depends on an earlier guard to stay
    // total is one refactor away from a trap.
    if (expiresAt > now + Identity.maxDelegationNanos) {
      return #err(#invalidInput("expiresAt is beyond the maximum delegation lifetime"))
    };
    switch (scope) {
      case (#all) {};
      case (#collection(id)) {
        let ?found = Map.get(collections, Nat.compare, id) else {
          return #err(#invalidInput("collection does not exist"))
        };
        if (found.creator != creator.id) return #err(#unauthorized)
      }
    };

    let id = nextDelegationId;
    nextDelegationId += 1;
    let delegation : Identity.Delegation = {
      id;
      creator = creator.id;
      delegate;
      scope;
      expiresAt;
      createdAt = now;
      status = #active;
    };
    Map.add(delegations, Nat.compare, id, delegation);
    let existing = switch (Map.get(delegationsOf, Principal.compare, delegate)) {
      case null [];
      case (?ids) ids;
    };
    Map.add(delegationsOf, Principal.compare, delegate, Array.concat(existing, [id]));
    #ok(delegation)
  };

  public shared ({ caller }) func revokeDelegation(id : Nat, reason : Text) : async Result<Identity.Delegation> {
    let creator = switch (requireRoot(caller)) {
      case (#err(error)) return #err(error);
      case (#ok(creator)) creator;
    };
    if (not Identity.validReason(reason)) {
      return #err(#invalidInput("reason length is invalid"))
    };
    let ?delegation = Map.get(delegations, Nat.compare, id) else return #err(#notFound);
    if (delegation.creator != creator.id) return #err(#unauthorized);
    switch (delegation.status) {
      case (#revoked(_)) return #err(#conflict("delegation is already revoked"));
      case (#active) {};
    };
    let updated : Identity.Delegation = {
      delegation with status = #revoked({ at = nowNanos(); reason })
    };
    Map.add(delegations, Nat.compare, id, updated);
    #ok(updated)
  };

  /// Declares, in advance, who may recover this identity and after how long.
  ///
  /// Only the root can declare it, and only while it still holds the key. A
  /// recovery path that could be added afterwards would be a takeover path:
  /// whoever compromised the key would name themselves the guardian.
  public shared ({ caller }) func declareRecovery(guardian : Principal, delayNanos : Nat) : async Result<Identity.Creator> {
    let creator = switch (requireRoot(caller)) {
      case (#err(error)) return #err(error);
      case (#ok(creator)) creator;
    };
    if (Principal.isAnonymous(guardian)) {
      return #err(#invalidInput("the anonymous principal cannot be a guardian"))
    };
    if (Principal.equal(guardian, caller)) {
      return #err(#conflict("the guardian cannot be the root key it recovers"))
    };
    if (delayNanos < Identity.minRecoveryDelayNanos) {
      return #err(#invalidInput("recovery delay is below the minimum"))
    };
    let updated : Identity.Creator = {
      creator with recovery = ?{ guardian; delayNanos; declaredAt = nowNanos() }
    };
    Map.add(creators, Nat.compare, creator.id, updated);
    #ok(updated)
  };

  /// Starts a recovery. It does not take effect until the declared delay has
  /// passed, and it is visible from `getRecovery` the whole time — which is
  /// what makes it something the current root can notice and cancel.
  public shared ({ caller }) func beginRecovery(creatorId : Nat, proposedRoot : Principal) : async Result<Identity.Recovery> {
    let ?creator = Map.get(creators, Nat.compare, creatorId) else return #err(#notFound);
    let ?policy = creator.recovery else return #err(#conflict("no recovery policy is declared"));
    if (not Principal.equal(policy.guardian, caller)) return #err(#unauthorized);
    if (Principal.isAnonymous(proposedRoot)) {
      return #err(#invalidInput("the anonymous principal cannot hold an identity"))
    };
    switch (Map.get(everRoot, Principal.compare, proposedRoot)) {
      case (?_) return #err(#duplicate("principal is already a creator key"));
      case null {};
    };
    switch (Map.get(recoveries, Nat.compare, creatorId)) {
      case (?existing) {
        switch (existing.status) {
          case (#pending) return #err(#conflict("a recovery is already pending"));
          case _ {}
        }
      };
      case null {};
    };

    let now = nowNanos();
    let recovery : Identity.Recovery = {
      creator = creatorId;
      proposedRoot;
      requestedBy = caller;
      requestedAt = now;
      effectiveAt = now + policy.delayNanos;
      status = #pending;
    };
    Map.add(recoveries, Nat.compare, creatorId, recovery);
    #ok(recovery)
  };

  /// Either party may cancel: the root, because it is the defence against a
  /// guardian acting without cause, and the guardian, because a recovery
  /// started by mistake should not have to wait out its own delay.
  public shared ({ caller }) func cancelRecovery(creatorId : Nat) : async Result<Identity.Recovery> {
    let ?creator = Map.get(creators, Nat.compare, creatorId) else return #err(#notFound);
    let ?recovery = Map.get(recoveries, Nat.compare, creatorId) else return #err(#notFound);
    switch (recovery.status) {
      case (#pending) {};
      case _ return #err(#conflict("recovery is not pending"));
    };
    let byRoot = Identity.isCurrentRoot(creator, caller);
    let byGuardian = switch (creator.recovery) {
      case null false;
      case (?policy) Principal.equal(policy.guardian, caller);
    };
    if (not (byRoot or byGuardian)) return #err(#unauthorized);

    let updated : Identity.Recovery = {
      recovery with status = #cancelled({ at = nowNanos(); by = caller })
    };
    Map.add(recoveries, Nat.compare, creatorId, updated);
    #ok(updated)
  };

  /// Completes a recovery once its delay has elapsed. The old key is retired
  /// into the key history exactly as a rotation retires it, so records signed
  /// under it stay attributable.
  public shared ({ caller }) func confirmRecovery(creatorId : Nat) : async Result<Identity.Creator> {
    let ?creator = Map.get(creators, Nat.compare, creatorId) else return #err(#notFound);
    let ?policy = creator.recovery else return #err(#conflict("no recovery policy is declared"));
    if (not Principal.equal(policy.guardian, caller)) return #err(#unauthorized);
    let ?recovery = Map.get(recoveries, Nat.compare, creatorId) else return #err(#notFound);
    switch (recovery.status) {
      case (#pending) {};
      case _ return #err(#conflict("recovery is not pending"));
    };
    let now = nowNanos();
    if (now < recovery.effectiveAt) return #err(#conflict("the recovery delay has not elapsed"));

    let retired = Array.map<Identity.KeyRecord, Identity.KeyRecord>(
      creator.keys,
      func(key : Identity.KeyRecord) : Identity.KeyRecord {
        if (key.retiredAt == null) { { key with retiredAt = ?now } } else key
      }
    );
    let updated : Identity.Creator = {
      creator with
      root = recovery.proposedRoot;
      keys = Array.concat(
        retired,
        [{ principal = recovery.proposedRoot; activeFrom = now; retiredAt = null; reason = "recovered" }]
      );
    };
    Map.add(creators, Nat.compare, creatorId, updated);
    Map.remove(creatorByRoot, Principal.compare, creator.root);
    Map.add(creatorByRoot, Principal.compare, recovery.proposedRoot, creatorId);
    Map.add(everRoot, Principal.compare, recovery.proposedRoot, creatorId);
    Map.add(recoveries, Nat.compare, creatorId, { recovery with status = #completed(now) });
    #ok(updated)
  };

  public query func getCreator(id : Nat) : async ?Identity.Creator {
    Map.get(creators, Nat.compare, id)
  };

  public query func getCollection(id : Nat) : async ?Identity.Collection {
    Map.get(collections, Nat.compare, id)
  };

  public query func getDelegation(id : Nat) : async ?Identity.Delegation {
    Map.get(delegations, Nat.compare, id)
  };

  public query func getRecovery(creatorId : Nat) : async ?Identity.Recovery {
    Map.get(recoveries, Nat.compare, creatorId)
  };

  /// Who a record is attributable to, and which key actually signed it.
  ///
  /// `null` for records registered by a principal holding no creator identity,
  /// which is every record written before #7. Their `owner` is still the
  /// signer; there is simply no identity to resolve it to.
  public query func attribution(recordId : Nat) : async ?Identity.Attribution {
    Map.get(attributions, Nat.compare, recordId)
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

    // Resolved before anything is written, and before the commitment is even
    // looked at: a revoked delegate should be refused because it is revoked,
    // not because it happens not to own the commitment it named.
    let authority = switch (resolveAuthority(caller, input.collection, nowNanos())) {
      case (#err(error)) return #err(error);
      case (#ok(resolved)) resolved;
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
    switch (authority) {
      case null {};
      case (?(creatorId, granted)) {
        Map.add(
          attributions,
          Nat.compare,
          recordId,
          {
            record = recordId;
            creator = creatorId;
            // The principal that actually signed, kept apart from the creator
            // so a record signed by a delegate can never be read as one signed
            // by the root.
            signer = caller;
            authority = granted;
            collection = input.collection;
          }
        )
      }
    };
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
