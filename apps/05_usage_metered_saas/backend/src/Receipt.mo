/// Signed usage receipts, reporter scopes, and the rules that decide whether a
/// receipt becomes a usage event.
///
/// Before this, `recordUsage` trusted the caller completely: any principal on
/// the reporter list could bill any tenant, in any category, any number of
/// units. A reporter is a metering service, a gateway, a device fleet — the
/// most exposed part of a billing system — and one compromised reporter could
/// exhaust every tenant's quota or inflate every invoice.
///
/// A receipt separates the two things an attacker would have to steal:
///
///   * the **reporter principal**, which authenticates the call that submits
///     receipts, and
///   * a **signing key** registered for that reporter, which signs each receipt
///     where the usage is observed — possibly offline, on a device that never
///     talks to the IC itself.
///
/// Neither alone is enough. A stolen principal cannot forge a receipt, and a
/// stolen device key cannot submit one. Each is revoked on its own, and a
/// policy bounds what even both together can do: which tenants, which
/// categories, how many units per event and per window.
///
/// `docs/RECEIPTS.md` has the byte layout, the key lifecycle, and the clock and
/// replay policy.
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import ECDSA "mo:ecdsa";

module {
  /// What the receipt asserts. `canister` is the metering canister it was
  /// signed for, so a receipt from staging cannot be replayed into production
  /// and one deployment's reporters cannot bill another's tenants.
  public type Receipt = {
    canister : Principal;
    reporter : Principal;
    keyId : Nat;
    tenant : Principal;
    units : Nat;
    category : Text;
    idempotencyKey : Text;
    /// When the usage was observed, in nanoseconds, by the signer's clock.
    observedAt : Nat;
  };

  public type SignedReceipt = {
    receipt : Receipt;
    /// ECDSA over SHA-256 of `encode(receipt)`, P-256, `r || s` as 64 bytes,
    /// low-S. The low-S rule is the library's and a good one: without it every
    /// signature has a twin, and "the same receipt, signed differently" would
    /// be a second receipt to anyone deduplicating on signatures.
    signature : Blob;
  };

  public type KeyStatus = {
    #active;
    /// Rotated out. Receipts observed before `at` still verify, so an offline
    /// batch signed before a rotation is not lost to it.
    #retired : Nat;
    /// Presumed stolen. Nothing signed by it is accepted any more, whatever
    /// time it claims: a thief chooses `observedAt`.
    #compromised : Nat;
  };

  public type ReporterKey = {
    id : Nat;
    reporter : Principal;
    /// SEC1 point on P-256, 33 bytes compressed or 65 uncompressed.
    publicKey : Blob;
    addedAt : Nat;
    status : KeyStatus;
  };

  public type Scope<T> = { #any; #only : [T] };

  /// What a reporter may write, whichever path it uses.
  public type Policy = {
    tenants : Scope<Principal>;
    categories : Scope<Text>;
    maxUnitsPerEvent : Nat;
    /// Units this reporter may record per tumbling window, across all tenants.
    /// The ceiling on what a compromised reporter can inflate before someone
    /// notices, which is the number an operator should size this by.
    maxUnitsPerWindow : Nat;
    windowSeconds : Nat;
    /// When true, the unsigned `recordUsage` path is closed to this reporter,
    /// so a stolen principal cannot route around the signatures.
    requireSignatures : Bool;
  };

  public type Rejection = {
    #unauthorized;
    #invalidReceipt : Text;
    #wrongCanister;
    #unknownKey;
    #keyNotValid;
    #badSignature;
    #stale;
    #future;
    #outOfScope : Text;
    #windowExceeded : { limit : Nat; used : Nat; requested : Nat };
    #quotaExceeded : { quota : Nat; used : Nat; requested : Nat };
    #tenantUnavailable;
    /// The idempotency key was already used by a receipt with different
    /// content. Not a replay, and not silently deduplicated.
    #conflict : Text;
  };

  /// Per reporter, the current window and what happened in it. Rejections are
  /// counted by reason because the reason is the signal: a burst of
  /// `badSignature` is someone guessing, a burst of `windowExceeded` is a
  /// reporter billing more than it should.
  public type Health = {
    windowStart : Nat;
    windowUnits : Nat;
    accepted : Nat;
    replayed : Nat;
    rejected : Nat;
    rejectedInWindow : Nat;
    badSignatures : Nat;
    outOfScope : Nat;
    windowExceeded : Nat;
    lastRejection : ?{ at : Nat; reason : Text };
    /// True when this window shows a rejection burst or usage close to the
    /// window limit — the reporter should be looked at now.
    anomalous : Bool;
  };

  // ---------------------------------------------------------------- limits

  public let domainV1 : Text = "icp-usage-receipt:v1";
  public let curveName : Text = "prime256v1";
  /// How far ahead of the canister's clock a receipt may claim to be. Clocks
  /// drift; five minutes is generous for NTP and useless for backdating.
  public let maxFutureSkewNanos : Nat = 300_000_000_000; // 5 minutes
  /// How old a receipt may be when submitted: long enough for a device to be
  /// offline over a weekend, short enough that a billing period can close.
  public let maxAgeNanos : Nat = 604_800_000_000_000; // 7 days
  /// Verifying one receipt costs about 1.8 billion instructions with
  /// `mo:ecdsa` (~0.7 billion cycles, measured on pocket-ic 14.0.0; see
  /// docs/RECEIPTS.md). An update message may use 40 billion, so the batch
  /// is sized to stay well inside that: 16 receipts is about 28 billion.
  public let maxBatch : Nat = 16;
  public let maxKeysPerReporter : Nat = 8;
  /// Rejections in one window after which a reporter is reported anomalous.
  public let anomalyRejections : Nat = 3;

  // -------------------------------------------------------------- encoding

  /// The bytes that are signed. Same discipline as the provenance layouts in
  /// this kit: a versioned domain separator, fixed-width big-endian integers,
  /// and a length prefix on every variable-length field.
  public func encode(receipt : Receipt) : Blob {
    let out = List.empty<Nat8>();
    appendBlob(out, Text.encodeUtf8(domainV1));
    List.add<Nat8>(out, 0);
    appendShort(out, Principal.toBlob(receipt.canister));
    appendShort(out, Principal.toBlob(receipt.reporter));
    appendU64(out, receipt.keyId);
    appendShort(out, Principal.toBlob(receipt.tenant));
    appendU64(out, receipt.units);
    appendText(out, receipt.category);
    appendText(out, receipt.idempotencyKey);
    appendU64(out, receipt.observedAt);
    Array.toBlob(List.toArray(out))
  };

  func appendBlob(out : List.List<Nat8>, value : Blob) {
    for (byte in value.vals()) List.add(out, byte)
  };

  func appendShort(out : List.List<Nat8>, value : Blob) {
    List.add(out, Nat.toNat8(value.size()));
    appendBlob(out, value)
  };

  func appendText(out : List.List<Nat8>, value : Text) {
    let bytes = Text.encodeUtf8(value);
    appendU32(out, bytes.size());
    appendBlob(out, bytes)
  };

  func appendU64(out : List.List<Nat8>, value : Nat) { appendBigEndian(out, value, 8) };

  func appendU32(out : List.List<Nat8>, value : Nat) { appendBigEndian(out, value, 4) };

  // Masked before narrowing: the narrowing conversions trap rather than
  // truncate. `Nat.toNat64` traps above 2^64, which the bounds on every
  // encoded field keep out of reach.
  func appendBigEndian(out : List.List<Nat8>, value : Nat, width : Nat) {
    let wide = Nat.toNat64(value);
    var index = width;
    while (index > 0) {
      index -= 1;
      List.add(out, Nat64.toNat8((wide >> Nat.toNat64(index * 8)) & 0xFF))
    }
  };

  // ---------------------------------------------------------- verification

  func curve() : ECDSA.Curve { ECDSA.prime256v1Curve() };

  /// `null` if `bytes` is a valid P-256 point, otherwise why not. Checked when a
  /// key is registered, so a key that could never verify anything is refused
  /// then rather than discovered when every receipt fails.
  public func checkPublicKey(bytes : Blob) : ?Text {
    if (bytes.size() != 33 and bytes.size() != 65) return ?"public key must be a 33- or 65-byte SEC1 point";
    switch (ECDSA.publicKeyFromBytes(bytes.vals(), #raw({ curve = curve() }))) {
      case (#ok(_)) null;
      case (#err(message)) ?message
    }
  };

  public func verifySignature(publicKey : Blob, signed : SignedReceipt) : Bool {
    if (signed.signature.size() != 64) return false;
    let c = curve();
    let #ok(key) = ECDSA.publicKeyFromBytes(publicKey.vals(), #raw({ curve = c })) else return false;
    let #ok(signature) = ECDSA.signatureFromBytes(signed.signature.vals(), c, #raw) else return false;
    // The range and low-S checks are made here, on the values as received.
    // `mo:ecdsa` normalizes `s` to its low form when it *constructs* a
    // signature, so the low-S check inside its `verify` only ever sees the
    // normalized value and a high-S signature verifies. Found by the pinned
    // high-S vector in `test/Receipt.test.mo`.
    if (signature.original_r == 0 or signature.original_r >= c.params.r) return false;
    if (signature.original_s == 0 or signature.original_s >= c.params.rHalf) return false;
    key.verify(encode(signed.receipt).vals(), signature)
  };

  // ----------------------------------------------------------------- rules

  public func checkShape(receipt : Receipt) : ?Rejection {
    if (receipt.units == 0 or receipt.units > 1_000_000_000) return ?#invalidReceipt("units is invalid");
    if (receipt.category.size() == 0 or receipt.category.size() > 100) {
      return ?#invalidReceipt("category length is invalid")
    };
    if (receipt.idempotencyKey.size() == 0 or receipt.idempotencyKey.size() > 200) {
      return ?#invalidReceipt("idempotencyKey length is invalid")
    };
    null
  };

  /// The clock policy. Additions only, so a young replica clock cannot trap it.
  public func checkClock(observedAt : Nat, now : Nat) : ?Rejection {
    if (observedAt > now + maxFutureSkewNanos) return ?#future;
    if (observedAt + maxAgeNanos < now) return ?#stale;
    null
  };

  /// Whether `key` may have signed something observed at `observedAt`.
  public func keyValidAt(key : ReporterKey, observedAt : Nat) : Bool {
    if (observedAt < key.addedAt) return false;
    switch (key.status) {
      case (#active) true;
      case (#retired(at)) observedAt < at;
      case (#compromised(_)) false
    }
  };

  func inScope<T>(scope : Scope<T>, value : T, equal : (T, T) -> Bool) : Bool {
    switch (scope) {
      case (#any) true;
      case (#only(allowed)) Array.any<T>(allowed, func(candidate : T) : Bool { equal(candidate, value) })
    }
  };

  /// Scope and per-event size. The window is checked separately because it
  /// needs the reporter's running total.
  public func checkPolicy(policy : Policy, tenant : Principal, category : Text, units : Nat) : ?Rejection {
    if (not inScope<Principal>(policy.tenants, tenant, Principal.equal)) return ?#outOfScope("tenant");
    if (not inScope<Text>(policy.categories, category, Text.equal)) return ?#outOfScope("category");
    if (units > policy.maxUnitsPerEvent) return ?#outOfScope("units per event");
    null
  };

  public func checkPolicyShape(policy : Policy) : ?Text {
    if (policy.maxUnitsPerEvent == 0) return ?"maxUnitsPerEvent must be greater than zero";
    if (policy.maxUnitsPerWindow < policy.maxUnitsPerEvent) {
      return ?"maxUnitsPerWindow must be at least maxUnitsPerEvent"
    };
    if (policy.windowSeconds == 0 or policy.windowSeconds > 31_536_000) return ?"windowSeconds is invalid";
    let tooMany = func(size : Nat) : Bool { size == 0 or size > 100 };
    switch (policy.tenants) {
      case (#only(list)) if (tooMany(list.size())) return ?"tenant scope must list 1 to 100 tenants";
      case (#any) {}
    };
    switch (policy.categories) {
      case (#only(list)) if (tooMany(list.size())) return ?"category scope must list 1 to 100 categories";
      case (#any) {}
    };
    null
  };

  /// The tumbling window `now` falls in. Tumbling rather than rolling so the
  /// state per reporter is two numbers, not a list of every event.
  public func windowStart(now : Nat, windowSeconds : Nat) : Nat {
    let width = windowSeconds * 1_000_000_000;
    // `now % width` is at most `now`, so this cannot underflow.
    Nat.sub(now, now % width)
  };

  public func emptyHealth(start : Nat) : Health {
    {
      windowStart = start;
      windowUnits = 0;
      accepted = 0;
      replayed = 0;
      rejected = 0;
      rejectedInWindow = 0;
      badSignatures = 0;
      outOfScope = 0;
      windowExceeded = 0;
      lastRejection = null;
      anomalous = false;
    }
  };

  /// `health` moved into the window containing `now`, lifetime counters kept.
  public func roll(health : Health, start : Nat) : Health {
    if (health.windowStart == start) return health;
    { health with windowStart = start; windowUnits = 0; rejectedInWindow = 0; anomalous = false }
  };

  public func reasonName(rejection : Rejection) : Text {
    switch (rejection) {
      case (#unauthorized) "unauthorized";
      case (#invalidReceipt(_)) "invalidReceipt";
      case (#wrongCanister) "wrongCanister";
      case (#unknownKey) "unknownKey";
      case (#keyNotValid) "keyNotValid";
      case (#badSignature) "badSignature";
      case (#stale) "stale";
      case (#future) "future";
      case (#outOfScope(_)) "outOfScope";
      case (#windowExceeded(_)) "windowExceeded";
      case (#quotaExceeded(_)) "quotaExceeded";
      case (#tenantUnavailable) "tenantUnavailable";
      case (#conflict(_)) "conflict"
    }
  };

  /// Records a rejection against `health` and re-evaluates the anomaly flag.
  public func noteRejection(health : Health, rejection : Rejection, at : Nat, windowLimit : Nat) : Health {
    let updated = {
      health with
      rejected = health.rejected + 1;
      rejectedInWindow = health.rejectedInWindow + 1;
      badSignatures = health.badSignatures + (switch (rejection) { case (#badSignature) 1; case _ 0 });
      outOfScope = health.outOfScope + (switch (rejection) { case (#outOfScope(_)) 1; case _ 0 });
      windowExceeded = health.windowExceeded + (switch (rejection) { case (#windowExceeded(_)) 1; case _ 0 });
      lastRejection = ?{ at; reason = reasonName(rejection) };
    };
    { updated with anomalous = isAnomalous(updated, windowLimit) }
  };

  public func noteAccepted(health : Health, units : Nat, windowLimit : Nat) : Health {
    let updated = { health with accepted = health.accepted + 1; windowUnits = health.windowUnits + units };
    { updated with anomalous = isAnomalous(updated, windowLimit) }
  };

  /// A rejection burst, or 80% of the window limit used. Either is worth a
  /// human looking before the limit itself starts refusing real usage.
  public func isAnomalous(health : Health, windowLimit : Nat) : Bool {
    health.rejectedInWindow >= anomalyRejections or health.windowUnits * 5 >= windowLimit * 4
  };
};
