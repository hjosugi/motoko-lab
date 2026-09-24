// The dispute rules and the event log, in the interpreter.
//
// Every rule in `Dispute.mo` is a pure decision over a dispute, a caller and a
// clock, so every combination is cheap to enumerate here. The replica suite
// adds what the interpreter cannot express: real callers, controller checks,
// the replica clock crossing the response and appeal windows, certification,
// and an upgrade.
//
// The pinned bytes and hashes were produced by `test/dispute-log.mjs`, the
// reader's implementation, so this is also the first cross-implementation check
// of the layout — in seconds, naming the layout, rather than minutes later as a
// head mismatch inside a certificate comparison.

import Blob "mo:core/Blob";
import Runtime "mo:core/Runtime";
import Principal "mo:core/Principal";
import Dispute "../backend/src/Dispute";
import DisputeLog "../backend/src/DisputeLog";

let claimant = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let authorityKey = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let respondent = Principal.fromText("aaaaa-aa");
let otherAuthority = Principal.fromText("2vxsx-fae");

func fill(byte : Nat8) : Blob {
  Blob.fromArray([
    byte, byte, byte, byte, byte, byte, byte, byte, byte, byte, byte, byte, byte, byte, byte, byte,
    byte, byte, byte, byte, byte, byte, byte, byte, byte, byte, byte, byte, byte, byte, byte, byte
  ])
};

// -- the limits, stated in the units a person reasons in --------------------

let day = 24 * 60 * 60 * 1_000_000_000;
assert Dispute.responseWindowNanos == 14 * day;
assert Dispute.appealWindowNanos == 30 * day;
assert Dispute.filingWindowNanos == day;
assert Dispute.strikeWindowNanos == 90 * day;

// -- evidence and the privacy rule ------------------------------------------

let publicEvidence : Dispute.Evidence = { digest = fill(0xAA); locator = #uri("ipfs://e"); description = "d" };
let sealedEvidence : Dispute.Evidence = {
  digest = fill(0xBB);
  locator = #sealed({ custodian = "mediator" });
  description = "";
};

assert Dispute.checkEvidence(publicEvidence) == null;
assert Dispute.checkEvidence(sealedEvidence) == null;
assert Dispute.checkEvidence({ publicEvidence with digest = "short" }) != null;
assert Dispute.checkEvidence({ publicEvidence with locator = #uri("") }) != null;
assert Dispute.checkEvidence({ sealedEvidence with locator = #sealed({ custodian = "" }) }) != null;

// A sealed reference whose custodian is a URI would publish exactly the pointer
// the claimant chose to keep private.
assert Dispute.checkEvidence({ sealedEvidence with locator = #sealed({ custodian = "https://vault.example/case/42" }) }) != null;

let nine = [publicEvidence, publicEvidence, publicEvidence, publicEvidence, publicEvidence, publicEvidence, publicEvidence, publicEvidence, publicEvidence];
assert Dispute.checkEvidenceList(nine) != null;
assert Dispute.checkEvidenceList([publicEvidence, sealedEvidence]) == null;

// -- the rolling window -----------------------------------------------------

// Below the limit there is nothing to wait for.
assert Dispute.retryAt([], 100, 50, 2) == null;
assert Dispute.retryAt([90], 100, 50, 2) == null;
// At the limit, the wait ends when the oldest counted event leaves the window.
assert Dispute.retryAt([60, 90], 100, 50, 2) == ?110;
// Exclusive at the edge: an event exactly `window` old no longer counts.
assert Dispute.retryAt([50, 90], 100, 50, 2) == null;
assert Dispute.inWindow([10, 50, 51, 99], 100, 50) == [51, 99];
// A young clock: no subtraction, so nothing traps before `now >= window`.
assert Dispute.retryAt([0, 1], 2, 50, 2) == ?50;

// -- a dispute, built the way the actor builds it ---------------------------

let filed = DisputeLog.seal(
  1,
  0,
  1_000,
  claimant,
  #filed({ record = 7; ground = #authorship; statement = "mine"; counterRecord = null; evidence = [publicEvidence] }),
  DisputeLog.genesisPrev
);
let ?opened = Dispute.genesis(filed) else Runtime.trap("a #filed event opens a dispute");
assert opened.status == #open;
assert opened.respondBy == 1_000 + Dispute.responseWindowNanos;
assert opened.events == 1 and Blob.equal(opened.head, filed.hash);
assert opened.evidence.size() == 1 and opened.evidence[0].party == #claimant;
assert Dispute.unresolved(opened.status);

// Only `#filed` opens a dispute.
assert Dispute.genesis({ filed with action = #withdrawn({ reason = "x" }) }) == null;

let authority : Dispute.Authority = {
  id = authorityKey;
  name = "Mediation panel";
  policyUri = "https://example.org/policy";
  addedAt = 0;
  retiredAt = null;
};

// -- response ---------------------------------------------------------------

assert Dispute.checkRespond(opened, false) == ?#unauthorized;
assert Dispute.checkRespond(opened, true) == null;

// -- due process before determination ---------------------------------------

// Nobody may determine an unanswered dispute while the respondent still has
// time to answer it.
assert Dispute.checkDetermine(opened, ?authority, authorityKey, false, 2_000) != null;
// After the window, silence does not block the process forever.
assert Dispute.checkDetermine(opened, ?authority, authorityKey, false, opened.respondBy) == null;
// Unregistered and retired authorities determine nothing.
assert Dispute.checkDetermine(opened, null, authorityKey, false, opened.respondBy) == ?#unauthorized;
assert Dispute.checkDetermine(opened, ?{ authority with retiredAt = ?5 }, authorityKey, false, opened.respondBy) == ?#unauthorized;
// A party cannot be its own judge, on either side.
assert Dispute.checkDetermine(opened, ?{ authority with id = claimant }, claimant, false, opened.respondBy) != null;
assert Dispute.checkDetermine(opened, ?authority, authorityKey, true, opened.respondBy) != null;

let answer = DisputeLog.seal(
  1,
  1,
  2_000,
  respondent,
  #responded({ stance = #contest; statement = "it is mine"; evidence = [sealedEvidence] }),
  opened.head
);
let responded = Dispute.apply(opened, answer);
assert responded.status == #responded;
assert responded.evidence.size() == 2 and responded.evidence[1].party == #respondent;
assert Dispute.checkRespond(responded, true) != null;
// Once answered, determination does not wait for the window.
assert Dispute.checkDetermine(responded, ?authority, authorityKey, false, 2_001) == null;

// -- evidence ---------------------------------------------------------------

assert Dispute.checkAddEvidence(responded, null, 1) == ?#unauthorized;
assert Dispute.checkAddEvidence(responded, ?#claimant, 0) != null;
assert Dispute.checkAddEvidence(responded, ?#claimant, 1) == null;
assert Dispute.checkAddEvidence(responded, ?#respondent, Dispute.maxEvidencePerDispute) != null;

// -- conflicting authorities ------------------------------------------------

let firstRuling = DisputeLog.seal(
  1,
  2,
  3_000,
  authorityKey,
  #determined({ outcome = #upheld; summary = "prior work shown"; decision = null; round = 0 }),
  responded.head
);
let determined = Dispute.apply(responded, firstRuling);
assert determined.status == #determined;
assert not Dispute.unresolved(determined.status);
assert not Dispute.conflicting(determined);
// One determination per authority per round.
assert Dispute.checkDetermine(determined, ?authority, authorityKey, false, 3_001) != null;

let secondAuthority = { authority with id = otherAuthority; name = "Other body" };
assert Dispute.checkDetermine(determined, ?secondAuthority, otherAuthority, false, 3_001) == null;
let secondRuling = DisputeLog.seal(
  1,
  3,
  3_500,
  otherAuthority,
  #determined({ outcome = #rejected; summary = "not shown"; decision = null; round = 0 }),
  determined.head
);
let disagreed = Dispute.apply(determined, secondRuling);
// Recorded, both of them, and reported as a disagreement. Not resolved.
assert disagreed.determinations.size() == 2;
assert Dispute.conflicting(disagreed);

// -- withdrawal -------------------------------------------------------------

assert Dispute.checkWithdraw(responded, claimant) == null;
assert Dispute.checkWithdraw(responded, respondent) == ?#unauthorized;
// After a determination, the way to stop is not to appeal.
assert Dispute.checkWithdraw(disagreed, claimant) != null;

// -- appeal -----------------------------------------------------------------

assert Dispute.checkAppeal(responded, ?#claimant, 3_000) != null;
assert Dispute.checkAppeal(disagreed, null, 3_600) == ?#unauthorized;
assert Dispute.checkAppeal(disagreed, ?#claimant, 3_600) == null;
// The window runs from the latest determination of the round, not the first.
assert Dispute.checkAppeal(disagreed, ?#claimant, 3_500 + Dispute.appealWindowNanos - 1) == null;
assert Dispute.checkAppeal(disagreed, ?#claimant, 3_500 + Dispute.appealWindowNanos) == ?#expired;

let appealEvent = DisputeLog.seal(
  1,
  4,
  4_000,
  claimant,
  #appealed({ party = #claimant; statement = "reconsider"; evidence = []; round = 1 }),
  disagreed.head
);
let appealed = Dispute.apply(disagreed, appealEvent);
assert appealed.status == #appealed and appealed.round == 1;
assert Dispute.unresolved(appealed.status);
// A new round has no determinations yet, so the old disagreement is history.
assert Dispute.current(appealed).size() == 0;
assert not Dispute.conflicting(appealed);
// The first authority may determine again, in the new round.
assert Dispute.checkDetermine(appealed, ?authority, authorityKey, false, 4_001) == null;

let reRuling = DisputeLog.seal(
  1,
  5,
  5_000,
  authorityKey,
  #determined({ outcome = #rejected; summary = "on reflection"; decision = null; round = 1 }),
  appealed.head
);
let final = Dispute.apply(appealed, reRuling);
assert final.status == #determined;
// Each side appeals once. The claimant has used theirs; the respondent has not.
assert Dispute.checkAppeal(final, ?#claimant, 5_001) != null;
assert Dispute.checkAppeal(final, ?#respondent, 5_001) == null;

// Strikes come from `#abusive` and nothing else.
assert Dispute.isStrike(#determined({ outcome = #abusive; summary = "x"; decision = null; round = 0 }));
assert not Dispute.isStrike(#determined({ outcome = #dismissed; summary = "x"; decision = null; round = 0 }));

// -- the log ----------------------------------------------------------------

let log = [filed, answer, firstRuling, secondRuling, appealEvent, reRuling];
switch (DisputeLog.verify(1, log)) {
  case (?head) assert Blob.equal(head, final.head);
  case null assert false;
};
// Dropped, reordered, re-attributed or edited events all break the chain.
assert DisputeLog.verify(1, [filed, firstRuling]) == null;
assert DisputeLog.verify(1, [answer, filed]) == null;
assert DisputeLog.verify(2, log) == null;
assert DisputeLog.verify(1, [filed, { answer with by = claimant }]) == null;
assert DisputeLog.verify(1, [filed, { answer with action = #responded({ stance = #concede; statement = "it is mine"; evidence = [sealedEvidence] }) }]) == null;

// -- pinned against the reader's implementation ------------------------------

let vectorFiled = DisputeLog.seal(
  3,
  0,
  1_234_567_890,
  claimant,
  #filed({
    record = 7;
    ground = #priorCreation;
    statement = "prior";
    counterRecord = ?2;
    evidence = [publicEvidence, sealedEvidence];
  }),
  DisputeLog.genesisPrev
);
assert DisputeLog.encode(vectorFiled).size() == 233;
assert vectorFiled.hash == "\54\ba\18\57\58\70\43\3f\00\dc\49\e4\d4\72\2f\9f\12\e0\6f\cc\73\69\c6\6c\20\7c\48\4f\d8\bb\62\94";

let vectorDetermined = DisputeLog.seal(
  3,
  1,
  1_234_567_999,
  authorityKey,
  #determined({
    outcome = #rejected;
    summary = "no";
    decision = ?{ digest = fill(0xCC); locator = #sealed({ custodian = "panel" }); description = "" };
    round = 0;
  }),
  vectorFiled.hash
);
assert vectorDetermined.hash == "\d9\ed\b6\d2\64\be\fd\52\9b\f8\8d\ea\43\ef\04\e2\4f\cb\4b\1f\06\79\f2\a0\25\d0\74\5d\8f\ec\46\a7";
assert DisputeLog.verify(3, [vectorFiled, vectorDetermined]) == ?vectorDetermined.hash;
