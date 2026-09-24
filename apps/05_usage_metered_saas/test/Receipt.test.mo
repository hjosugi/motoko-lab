// Receipt rules and the receipt layout, in the interpreter.
//
// The pinned bytes, key and signature were produced by `test/receipt.mjs` with
// `node:crypto`, the signer's implementation. So `verifySignature` accepting
// them is a cross-implementation check of the layout and of the low-S rule
// before any canister is involved; the replica suite then repeats it for every
// receipt it submits.

import Principal "mo:core/Principal";
import Receipt "../backend/src/Receipt";

let receipt : Receipt.Receipt = {
  canister = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  reporter = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  keyId = 1;
  tenant = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");
  units = 42;
  category = "api-call";
  idempotencyKey = "evt-1";
  observedAt = 1_700_000_000_000_000_000;
};

// -- the layout -------------------------------------------------------------

assert Receipt.encode(receipt) == "\69\63\70\2d\75\73\61\67\65\2d\72\65\63\65\69\70\74\3a\76\31\00\0a\00\00\00\00\00\00\00\01\01\01\0a\00\00\00\00\00\00\00\02\01\01\00\00\00\00\00\00\00\01\0a\00\00\00\00\00\00\00\03\01\01\00\00\00\00\00\00\00\2a\00\00\00\08\61\70\69\2d\63\61\6c\6c\00\00\00\05\65\76\74\2d\31\17\97\9c\fe\36\2a\00\00";

// -- the signature ----------------------------------------------------------

let publicKey : Blob = "\04\7f\83\b6\b2\e1\f4\99\9b\fe\59\d2\1e\66\8e\ce\b0\59\b8\91\f4\98\b0\02\63\3f\c9\e5\41\75\93\24\6a\cc\ae\fc\f1\dc\f9\8a\d3\b7\10\6f\b7\ff\3b\9f\a4\5d\ab\a0\a0\3d\6c\ac\48\ea\9d\93\c5\f7\76\20\b7";
let signature : Blob = "\c3\7e\e7\48\dc\16\64\76\4d\94\e9\ff\86\9d\59\84\33\db\11\f6\aa\56\d7\6e\b6\30\47\9a\76\67\eb\3d\73\3f\9c\6e\e8\68\8a\cd\a3\bb\13\fc\7b\43\c2\66\f8\1d\2a\ab\93\d5\5f\d9\af\29\a0\78\52\5b\e2\7c";
// The same signature with `s` replaced by `n - s`. Mathematically valid ECDSA;
// refused, because a receipt with two signatures is two receipts to anyone who
// deduplicates on them.
let highS : Blob = "\c3\7e\e7\48\dc\16\64\76\4d\94\e9\ff\86\9d\59\84\33\db\11\f6\aa\56\d7\6e\b6\30\47\9a\76\67\eb\3d\8c\c0\63\90\17\97\75\33\5c\44\ec\03\84\bc\3d\98\c4\c9\d0\02\13\42\3e\ab\44\90\2a\4a\aa\07\42\d5";

assert Receipt.checkPublicKey(publicKey) == null;
assert Receipt.verifySignature(publicKey, { receipt; signature });
assert not Receipt.verifySignature(publicKey, { receipt; signature = highS });
// Every bound field is covered.
assert not Receipt.verifySignature(publicKey, { receipt = { receipt with units = 43 }; signature });
assert not Receipt.verifySignature(publicKey, { receipt = { receipt with tenant = Principal.fromText("aaaaa-aa") }; signature });
assert not Receipt.verifySignature(publicKey, { receipt = { receipt with keyId = 2 }; signature });
assert not Receipt.verifySignature(publicKey, { receipt = { receipt with observedAt = 1_700_000_000_000_000_001 }; signature });
assert not Receipt.verifySignature(publicKey, { receipt = { receipt with idempotencyKey = "evt-2" }; signature });
assert not Receipt.verifySignature(publicKey, { receipt; signature = "\00" });

// A key that is not a point on P-256 is refused when it is registered, not
// discovered later when every receipt fails.
assert Receipt.checkPublicKey("\04\00") != null;
assert Receipt.checkPublicKey("\02\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff\ff") != null;

// -- the clock --------------------------------------------------------------

let now = 10_000_000_000_000_000;
assert Receipt.checkClock(now, now) == null;
assert Receipt.checkClock(now + Receipt.maxFutureSkewNanos, now) == null;
assert Receipt.checkClock(now + Receipt.maxFutureSkewNanos + 1, now) == ?#future;
assert Receipt.checkClock(now - Receipt.maxAgeNanos, now) == null;
assert Receipt.checkClock(now - Receipt.maxAgeNanos - 1, now) == ?#stale;
// A young clock: no subtraction, so nothing traps.
assert Receipt.checkClock(0, 1) == null;
assert Receipt.maxFutureSkewNanos == 5 * 60 * 1_000_000_000;
assert Receipt.maxAgeNanos == 7 * 24 * 60 * 60 * 1_000_000_000;

// -- keys -------------------------------------------------------------------

let key : Receipt.ReporterKey = {
  id = 1;
  reporter = receipt.reporter;
  publicKey;
  addedAt = 100;
  status = #active;
};
assert Receipt.keyValidAt(key, 100);
// A key cannot have signed anything before it existed.
assert not Receipt.keyValidAt(key, 99);
// Rotation keeps what was signed before it, exclusive at the boundary.
assert Receipt.keyValidAt({ key with status = #retired(500) }, 499);
assert not Receipt.keyValidAt({ key with status = #retired(500) }, 500);
// Compromise keeps nothing: a thief chooses `observedAt`.
assert not Receipt.keyValidAt({ key with status = #compromised(500) }, 200);

// -- scope ------------------------------------------------------------------

let policy : Receipt.Policy = {
  tenants = #only([receipt.tenant]);
  categories = #only(["api-call", "storage"]);
  maxUnitsPerEvent = 100;
  maxUnitsPerWindow = 1_000;
  windowSeconds = 3_600;
  requireSignatures = true;
};
assert Receipt.checkPolicyShape(policy) == null;
assert Receipt.checkPolicy(policy, receipt.tenant, "api-call", 100) == null;
assert Receipt.checkPolicy(policy, Principal.fromText("aaaaa-aa"), "api-call", 1) == ?#outOfScope("tenant");
assert Receipt.checkPolicy(policy, receipt.tenant, "egress", 1) == ?#outOfScope("category");
assert Receipt.checkPolicy(policy, receipt.tenant, "api-call", 101) == ?#outOfScope("units per event");
assert Receipt.checkPolicy({ policy with tenants = #any; categories = #any }, Principal.fromText("aaaaa-aa"), "egress", 1) == null;
assert Receipt.checkPolicyShape({ policy with maxUnitsPerWindow = 99 }) != null;
assert Receipt.checkPolicyShape({ policy with tenants = #only([]) }) != null;
assert Receipt.checkPolicyShape({ policy with windowSeconds = 0 }) != null;

// -- the window and the anomaly flag ----------------------------------------

let hour = 3_600_000_000_000;
assert Receipt.windowStart(5 * hour + 17, 3_600) == 5 * hour;
assert Receipt.windowStart(5 * hour, 3_600) == 5 * hour;

let fresh = Receipt.emptyHealth(5 * hour);
let busy = Receipt.noteAccepted(fresh, 799, 1_000);
assert not busy.anomalous;
// 80% of the window limit is worth a look before the limit starts refusing.
assert Receipt.noteAccepted(busy, 1, 1_000).anomalous;

let one = Receipt.noteRejection(fresh, #badSignature, 1, 1_000);
let two = Receipt.noteRejection(one, #badSignature, 2, 1_000);
assert not two.anomalous and two.badSignatures == 2;
let three = Receipt.noteRejection(two, #outOfScope("tenant"), 3, 1_000);
assert three.anomalous and three.outOfScope == 1 and three.rejected == 3;
// A new window starts clean, and the lifetime counters stay.
let next = Receipt.roll(three, 6 * hour);
assert not next.anomalous and next.rejectedInWindow == 0 and next.rejected == 3 and next.windowUnits == 0;
assert Receipt.roll(three, 5 * hour) == three;
