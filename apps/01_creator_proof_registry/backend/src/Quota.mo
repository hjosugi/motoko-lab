/// The write-side abuse economics: a free allowance per principal, a storage
/// cap, and the counters that make both visible.
///
/// A principal with no cost can fill a canister with records: every `commit`
/// and `reveal` is a free write, and storage grows forever. The registry cannot
/// charge for a record — provenance should not be pay-to-play — but it can
/// bound what one principal can add for free, reject the write that would cross
/// the bound instead of truncating it, and report exactly which bound was hit.
///
/// The policy is operator-owned and changeable: a change applies to new writes
/// and never rewrites a record, an id or a counter's history. Per-principal
/// overrides (an organization, a paid batch, a migration window) are the
/// operator's tool; a paid batch granted here records the operator's reference
/// for the settlement that happened elsewhere, which is why it is controller
/// only and visible in the metrics.
module {
  /// The default limits. `freeWritesPerWindow` is deliberately generous enough
  /// for a person and small enough that a script cannot fill the canister.
  public type Policy = {
    /// `commit` and `reveal` calls per principal per window.
    freeWritesPerWindow : Nat;
    windowSeconds : Nat;
    /// Encoded bytes of one record (`RecordDigest.encode`).
    maxRecordBytes : Nat;
    /// Total encoded record bytes one principal may hold.
    maxStorageBytes : Nat;
    /// Open, un-revealed commitments one principal may hold.
    maxOpenCommitments : Nat;
  };

  /// What a principal is allowed beyond the policy: an operator-granted batch,
  /// with the reference for the settlement recorded elsewhere.
  public type Allowance = {
    extraWrites : Nat;
    extraStorageBytes : Nat;
    reference : Text;
    expiresAt : Nat;
  };

  /// The current window's usage. `windowStart` is when the counter last
  /// rolled; `writes` counts `commit` and `reveal` calls, allowed or not.
  public type Usage = {
    writes : Nat;
    windowStart : Nat;
    storageBytes : Nat;
    openCommitments : Nat;
    extraWrites : Nat;
    extraStorageBytes : Nat;
  };

  public type Rejection = {
    #writeQuota : { limit : Nat; used : Nat; retryAt : Nat };
    #storageQuota : { limit : Nat; used : Nat; requested : Nat };
    #recordTooLarge : { limit : Nat; requested : Nat };
    #tooManyOpen : { limit : Nat; used : Nat };
  };

  public type Decision = {
    #ok;
    #rejected : Rejection;
  };

  public func defaultPolicy() : Policy {
    {
      freeWritesPerWindow = 100;
      windowSeconds = 3_600;
      maxRecordBytes = 65_536;
      maxStorageBytes = 10_485_760;
      maxOpenCommitments = 50;
    }
  };

  public func rejectionTag(rejection : Rejection) : Text {
    switch (rejection) {
      case (#writeQuota(_)) "writeQuota";
      case (#storageQuota(_)) "storageQuota";
      case (#recordTooLarge(_)) "recordTooLarge";
      case (#tooManyOpen(_)) "tooManyOpen";
    }
  };

  /// The write allowance in force, from the policy plus a live allowance.
  public func writeLimit(policy : Policy, allowance : ?Allowance, now : Nat) : Nat {
    policy.freeWritesPerWindow + liveExtraWrites(allowance, now)
  };

  public func storageLimit(policy : Policy, allowance : ?Allowance, now : Nat) : Nat {
    policy.maxStorageBytes + liveExtraStorage(allowance, now)
  };

  func liveExtraWrites(allowance : ?Allowance, now : Nat) : Nat {
    switch (allowance) {
      case (?value) { if (now <= value.expiresAt) value.extraWrites else 0 };
      case null 0;
    }
  };

  func liveExtraStorage(allowance : ?Allowance, now : Nat) : Nat {
    switch (allowance) {
      case (?value) { if (now <= value.expiresAt) value.extraStorageBytes else 0 };
      case null 0;
    }
  };

  /// Rolls the window when it has ended. A quiet principal's next write starts
  /// a fresh window; a policy change does not reset anyone's counter.
  public func roll(usage : Usage, policy : Policy, now : Nat) : Usage {
    let length = policy.windowSeconds * 1_000_000_000;
    if (now < usage.windowStart + length) return usage;
    { usage with writes = 0; windowStart = now }
  };

  /// The `commit` decision: the open-commitment count first, then the window
  /// allowance. A refused call still counts as a write attempt — the counter
  /// bounds how much work a script can make the canister do, not only how many
  /// commitments it ends up holding.
  public func decideCommit(
    usage : Usage,
    policy : Policy,
    allowance : ?Allowance,
    now : Nat
  ) : Decision {
    if (usage.openCommitments + 1 > policy.maxOpenCommitments) {
      return #rejected(#tooManyOpen({ limit = policy.maxOpenCommitments; used = usage.openCommitments }))
    };
    let limit = writeLimit(policy, allowance, now);
    if (usage.writes >= limit) {
      let length = policy.windowSeconds * 1_000_000_000;
      return #rejected(#writeQuota({ limit; used = usage.writes; retryAt = usage.windowStart + length }))
    };
    #ok
  };

  /// The `reveal` decision: the record's own size, then the window allowance,
  /// then the storage total. The first refusal is reported and nothing is
  /// written.
  public func decideReveal(
    usage : Usage,
    policy : Policy,
    allowance : ?Allowance,
    now : Nat,
    recordBytes : Nat
  ) : Decision {
    if (recordBytes > policy.maxRecordBytes) {
      return #rejected(#recordTooLarge({ limit = policy.maxRecordBytes; requested = recordBytes }))
    };
    let limit = writeLimit(policy, allowance, now);
    if (usage.writes >= limit) {
      let length = policy.windowSeconds * 1_000_000_000;
      return #rejected(#writeQuota({ limit; used = usage.writes; retryAt = usage.windowStart + length }))
    };
    let storage = storageLimit(policy, allowance, now);
    if (usage.storageBytes + recordBytes > storage) {
      return #rejected(#storageQuota({ limit = storage; used = usage.storageBytes; requested = recordBytes }))
    };
    #ok
  };
}
