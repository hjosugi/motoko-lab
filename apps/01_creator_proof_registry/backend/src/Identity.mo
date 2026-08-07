/// Creator identity: rotation, scoped delegation, and recovery.
///
/// Until now a record's creator *was* the principal that signed it. That makes
/// a lost key a lost body of work, gives an organization no way to offboard a
/// member without abandoning everything they registered, and gives a creator no
/// way to say "this assistant may publish for me, in this collection, until
/// March".
///
/// The separation this module introduces is between **who a creator is** and
/// **which key signed a particular record**:
///
///   * A `Creator` is a long-lived identity with a root principal that can be
///     rotated. The identity survives the rotation; the id never changes.
///   * A `Delegation` lets another principal register under that identity,
///     limited to a collection and to a deadline, and revocable.
///   * A record keeps the principal that actually signed it, forever.
///
/// That last point is the one everything else follows from. Rewriting old
/// records to point at a new key would be falsifying provenance: at the moment
/// of registration, that key really was the signer, and a verifier checking a
/// years-old record needs to see what was true then. So rotation adds to a
/// history rather than editing one, and attribution is resolved by reading that
/// history rather than by trusting a mutable field.
///
/// `docs/IDENTITY.md` has the model, the threat cases, and the reasoning behind
/// the recovery delay.
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

module {
  public type CreatorId = Nat;
  public type CollectionId = Nat;
  public type DelegationId = Nat;

  /// What a delegate is allowed to register.
  ///
  /// `#collection` is the reason this is a variant rather than a flag: an
  /// organization delegating to a contractor for one project should not be
  /// handing over the whole identity, and "the whole identity" is the only
  /// thing a boolean could express.
  public type Scope = {
    #all;
    #collection : CollectionId;
  };

  public type DelegationStatus = {
    #active;
    #revoked : { at : Nat; reason : Text };
  };

  public type Delegation = {
    id : DelegationId;
    creator : CreatorId;
    delegate : Principal;
    scope : Scope;
    /// Absolute, in nanoseconds. There is no "never expires": a delegation
    /// nobody has to renew is one nobody remembers to withdraw.
    expiresAt : Nat;
    createdAt : Nat;
    status : DelegationStatus;
  };

  /// One entry per principal that has ever been this creator's root.
  ///
  /// `retiredAt` is null for the key in use. A record signed while a key was
  /// current stays attributable to the creator through this history even after
  /// the key is retired, which is what makes rotation safe to perform.
  public type KeyRecord = {
    principal : Principal;
    activeFrom : Nat;
    retiredAt : ?Nat;
    reason : Text;
  };

  /// How this creator may recover from losing its root key.
  ///
  /// Declared in advance, by the root, while it still controls the identity.
  /// A recovery path that could be *added* after the fact would be a takeover
  /// path: whoever compromised the key would simply declare themselves the
  /// guardian.
  public type RecoveryPolicy = {
    guardian : Principal;
    /// How long a recovery sits pending before it can complete. The delay
    /// exists so a compromised key has time to cancel a recovery it did not
    /// start, and so the change is visible before it takes effect.
    delayNanos : Nat;
    declaredAt : Nat;
  };

  public type RecoveryStatus = {
    #pending;
    #completed : Nat;
    #cancelled : { at : Nat; by : Principal };
  };

  public type Recovery = {
    creator : CreatorId;
    proposedRoot : Principal;
    requestedBy : Principal;
    requestedAt : Nat;
    /// The earliest time `confirmRecovery` can succeed.
    effectiveAt : Nat;
    status : RecoveryStatus;
  };

  public type Creator = {
    id : CreatorId;
    root : Principal;
    keys : [KeyRecord];
    recovery : ?RecoveryPolicy;
    createdAt : Nat;
  };

  public type Collection = {
    id : CollectionId;
    creator : CreatorId;
    name : Text;
    createdAt : Nat;
  };

  /// Why a caller was allowed to register a record, recorded per record.
  ///
  /// `signer` is the principal that made the call, kept separately from
  /// `creator` so a record signed by a delegate can never be mistaken for one
  /// signed by the root.
  public type Authority = {
    #root;
    #delegated : DelegationId;
  };

  public type Attribution = {
    record : Nat;
    creator : CreatorId;
    signer : Principal;
    authority : Authority;
    collection : ?CollectionId;
  };

  /// Delegations may not outlive this, from the moment they are created.
  ///
  /// A cap rather than a default: the expiry is chosen by the creator, but a
  /// ten-year delegation is indistinguishable from an unbounded one in every
  /// way that matters for offboarding.
  public let maxDelegationNanos : Nat = 31_536_000_000_000_000; // 365 days

  /// The floor on a recovery delay. Long enough that a compromised key's owner
  /// can notice and cancel, short enough to be usable.
  public let minRecoveryDelayNanos : Nat = 604_800_000_000_000; // 7 days

  public let maxNameSize : Nat = 200;
  public let maxReasonSize : Nat = 1000;

  public func validName(value : Text) : Bool {
    value.size() >= 1 and value.size() <= maxNameSize
  };

  public func validReason(value : Text) : Bool {
    value.size() >= 1 and value.size() <= maxReasonSize
  };

  public func isCurrentRoot(creator : Creator, caller : Principal) : Bool {
    Principal.equal(creator.root, caller)
  };

  /// Whether `delegation` authorizes `caller` to register into `collection` at
  /// time `now`.
  ///
  /// Every clause is a separate reason to refuse, and all of them are checked:
  /// a delegation can be simultaneously revoked, expired, and out of scope, and
  /// which one is reported first is not something a caller should be able to
  /// learn anything from.
  public func authorizes(
    delegation : Delegation,
    caller : Principal,
    collection : ?CollectionId,
    now : Nat
  ) : Bool {
    if (not Principal.equal(delegation.delegate, caller)) return false;
    switch (delegation.status) {
      case (#revoked(_)) return false;
      case (#active) {};
    };
    if (now >= delegation.expiresAt) return false;
    switch (delegation.scope) {
      case (#all) true;
      case (#collection(scoped)) {
        switch (collection) {
          // A collection-scoped delegate registering outside any collection is
          // out of scope. Treating "no collection" as "any collection" would
          // make the scope opt-in for the delegate to honour.
          case null false;
          case (?requested) Nat.equal(scoped, requested)
        }
      }
    }
  };

  /// Whether a delegation is still usable, ignoring who is asking. Used by the
  /// read paths, which report a delegation's standing rather than authorize.
  public func isLive(delegation : Delegation, now : Nat) : Bool {
    switch (delegation.status) {
      case (#revoked(_)) false;
      case (#active) now < delegation.expiresAt
    }
  };

  /// The key record covering `at`, or null if this creator held no key then.
  ///
  /// Attribution of an old record goes through here rather than through
  /// `creator.root`, which is by then a different principal.
  public func keyAt(creator : Creator, at : Nat) : ?KeyRecord {
    for (key in creator.keys.values()) {
      let started = at >= key.activeFrom;
      let ended = switch (key.retiredAt) {
        case null false;
        case (?retired) at >= retired
      };
      if (started and not ended) return ?key
    };
    null
  };
};
