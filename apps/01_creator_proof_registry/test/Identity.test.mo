// The authorization rules, in the interpreter.
//
// These are pure decisions over a delegation and a clock, so they belong here
// rather than in the replica suite: every combination is cheap to enumerate,
// and a rule that is wrong is wrong before any canister is involved. What the
// replica suite adds is that `reveal` actually consults them, with a real
// caller and a real clock.

import Principal "mo:core/Principal";
import Identity "../backend/src/Identity";

let creatorKey = Principal.fromText("aaaaa-aa");
let rotatedKey = Principal.fromText("2vxsx-fae");
let delegateKey = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let strangerKey = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");

let base : Identity.Delegation = {
  id = 1;
  creator = 1;
  delegate = delegateKey;
  scope = #all;
  expiresAt = 1000;
  createdAt = 0;
  status = #active;
};

// -- the happy case, and each way of losing it ------------------------------

assert Identity.authorizes(base, delegateKey, null, 999);
assert Identity.authorizes(base, delegateKey, ?7, 999);

// Someone else holding the delegation id is not the delegate.
assert not Identity.authorizes(base, strangerKey, null, 999);

// Expiry is exclusive at the boundary: at `expiresAt` the delegation is over.
// A delegation valid *at* its deadline would be valid for one instant longer
// than the creator asked for, and boundaries are where offboarding fails.
assert Identity.authorizes(base, delegateKey, null, 999);
assert not Identity.authorizes(base, delegateKey, null, 1000);
assert not Identity.authorizes(base, delegateKey, null, 1001);

assert not Identity.authorizes({ base with status = #revoked({ at = 500; reason = "left" }) }, delegateKey, null, 999);

// Revocation beats a still-valid expiry, and expiry beats a still-active
// status. Neither is allowed to rescue the other.
assert not Identity.authorizes({ base with status = #revoked({ at = 500; reason = "left" }) }, delegateKey, null, 1);
assert not Identity.authorizes(base, delegateKey, null, 5000);

// -- scope ------------------------------------------------------------------

let scoped : Identity.Delegation = { base with scope = #collection(7) };

assert Identity.authorizes(scoped, delegateKey, ?7, 999);
assert not Identity.authorizes(scoped, delegateKey, ?8, 999);

// A collection-scoped delegate registering outside any collection is out of
// scope. Reading `null` as "any collection" would leave the scope for the
// delegate to honour, which is the opposite of what a scope is for.
assert not Identity.authorizes(scoped, delegateKey, null, 999);

// An unscoped delegation is not narrowed by naming a collection.
assert Identity.authorizes(base, delegateKey, ?7, 999);

// -- liveness, which is a report rather than a decision ---------------------

assert Identity.isLive(base, 999);
assert not Identity.isLive(base, 1000);
assert not Identity.isLive({ base with status = #revoked({ at = 1; reason = "x" }) }, 0);

// -- key history ------------------------------------------------------------

let rotated : Identity.Creator = {
  id = 1;
  root = rotatedKey;
  keys = [
    { principal = creatorKey; activeFrom = 100; retiredAt = ?500; reason = "registered" },
    { principal = rotatedKey; activeFrom = 500; retiredAt = null; reason = "scheduled rotation" }
  ];
  recovery = null;
  createdAt = 100;
};

assert Identity.isCurrentRoot(rotated, rotatedKey);
assert not Identity.isCurrentRoot(rotated, creatorKey);

// A record signed before the rotation resolves to the key that signed it, not
// to whatever the root happens to be now. This is what "old records remain
// attributable" means: the history is read, not overwritten.
switch (Identity.keyAt(rotated, 200)) {
  case (?key) assert Principal.equal(key.principal, creatorKey);
  case null assert false;
};
switch (Identity.keyAt(rotated, 600)) {
  case (?key) assert Principal.equal(key.principal, rotatedKey);
  case null assert false;
};

// The instant of the rotation belongs to the new key: `retiredAt` is exclusive
// and `activeFrom` inclusive, so no instant is covered by two keys and none by
// none.
switch (Identity.keyAt(rotated, 500)) {
  case (?key) assert Principal.equal(key.principal, rotatedKey);
  case null assert false;
};

// Before the identity existed there is no key, and saying so is better than
// guessing the first one.
switch (Identity.keyAt(rotated, 99)) {
  case (?_) assert false;
  case null {};
};

// -- bounds -----------------------------------------------------------------

assert Identity.validName("a");
assert not Identity.validName("");
assert Identity.validReason("left the organization");
assert not Identity.validReason("");

// A year, and a week. Stated as literals in the source, so a unit slip is
// visible here rather than as a delegation that outlives the contract.
assert Identity.maxDelegationNanos == 365 * 24 * 60 * 60 * 1_000_000_000;
assert Identity.minRecoveryDelayNanos == 7 * 24 * 60 * 60 * 1_000_000_000;
