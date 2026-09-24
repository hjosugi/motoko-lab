/// The byte encoding of a dispute event, and the hash chain it forms.
///
/// Every transition of a dispute is an event, and every event carries the hash
/// of the one before it. The last hash — the head — is what the certified tree
/// holds under `["dispute", id]`, so one certificate attests the entire
/// history: altering, dropping, or reordering any event changes every hash
/// after it and the head no longer matches.
///
/// Same discipline as `RecordDigest.mo` and `protocol/COMMITMENT_V1.md`, and the
/// same primitives: a versioned domain separator, fixed-width big-endian
/// integers, a length prefix on every variable-length field, a present-flag on
/// every optional, and a tag byte on every variant. `test/dispute-log.mjs` is
/// the independent implementation a reader uses; `docs/DISPUTES.md` has the
/// grammar.
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";
import Dispute "Dispute";
import RecordDigest "RecordDigest";

module {
  public let domainV1 : Text = "icp-creator-proof:dispute-event:v1";

  /// The tree label dispute heads live under, beside `RecordDigest.treeLabel`.
  public let treeLabel : Blob = "dispute";

  /// The `prev` of a dispute's first event.
  public let genesisPrev : Blob = "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00";

  public func idKey(id : Nat) : Blob { RecordDigest.idKey(id) };

  /// The event with its hash filled in. The caller supplies everything else;
  /// `hash` on the input is ignored.
  public func seal(
    dispute : Nat,
    seq : Nat,
    at : Nat,
    by : Principal,
    action : Dispute.Action,
    prev : Blob
  ) : Dispute.Event {
    let unsealed : Dispute.Event = { dispute; seq; at; by; action; prev; hash = "" };
    { unsealed with hash = Sha256.fromBlob(#sha256, encode(unsealed)) }
  };

  public func hash(event : Dispute.Event) : Blob {
    Sha256.fromBlob(#sha256, encode(event))
  };

  /// Everything except `hash`, which is what is computed from it.
  public func encode(event : Dispute.Event) : Blob {
    let out = List.empty<Nat8>();
    RecordDigest.appendBlob(out, Text.encodeUtf8(domainV1));
    RecordDigest.append(out, 0);
    // Exactly 32 bytes: the genesis value or a previous SHA-256.
    RecordDigest.appendBlob(out, event.prev);
    RecordDigest.appendAll(out, RecordDigest.u64(event.dispute));
    RecordDigest.appendAll(out, RecordDigest.u64(event.seq));
    RecordDigest.appendAll(out, RecordDigest.u64(event.at));
    RecordDigest.appendShort(out, Principal.toBlob(event.by));

    switch (event.action) {
      case (#filed(filed)) {
        RecordDigest.append(out, 0);
        RecordDigest.appendAll(out, RecordDigest.u64(filed.record));
        RecordDigest.append(out, groundTag(filed.ground));
        RecordDigest.appendText(out, filed.statement);
        switch (filed.counterRecord) {
          case null RecordDigest.append(out, 0);
          case (?id) {
            RecordDigest.append(out, 1);
            RecordDigest.appendAll(out, RecordDigest.u64(id))
          }
        };
        appendEvidenceList(out, filed.evidence)
      };
      case (#responded(answer)) {
        RecordDigest.append(out, 1);
        RecordDigest.append(out, stanceTag(answer.stance));
        RecordDigest.appendText(out, answer.statement);
        appendEvidenceList(out, answer.evidence)
      };
      case (#evidenceAdded(added)) {
        RecordDigest.append(out, 2);
        RecordDigest.append(out, partyTag(added.party));
        appendEvidenceList(out, added.evidence)
      };
      case (#determined(determined)) {
        RecordDigest.append(out, 3);
        RecordDigest.append(out, outcomeTag(determined.outcome));
        RecordDigest.appendText(out, determined.summary);
        switch (determined.decision) {
          case null RecordDigest.append(out, 0);
          case (?evidence) {
            RecordDigest.append(out, 1);
            appendEvidence(out, evidence)
          }
        };
        RecordDigest.appendAll(out, RecordDigest.u64(determined.round))
      };
      case (#appealed(appeal)) {
        RecordDigest.append(out, 4);
        RecordDigest.append(out, partyTag(appeal.party));
        RecordDigest.appendText(out, appeal.statement);
        appendEvidenceList(out, appeal.evidence);
        RecordDigest.appendAll(out, RecordDigest.u64(appeal.round))
      };
      case (#withdrawn(withdrawal)) {
        RecordDigest.append(out, 5);
        RecordDigest.appendText(out, withdrawal.reason)
      };
    };
    Array.toBlob(List.toArray(out))
  };

  /// Recomputes every hash and link. `?head` when the chain is intact and
  /// belongs to `dispute`, `null` otherwise. What a reader of an export runs
  /// before believing any of it; exposed here so the interpreter tests can run
  /// the same check the JavaScript reader does.
  public func verify(dispute : Nat, events : [Dispute.Event]) : ?Blob {
    var prev = genesisPrev;
    var seq = 0;
    for (event in events.values()) {
      if (event.dispute != dispute or event.seq != seq) return null;
      if (not Blob.equal(event.prev, prev)) return null;
      if (not Blob.equal(hash(event), event.hash)) return null;
      prev := event.hash;
      seq += 1
    };
    ?prev
  };

  func appendEvidenceList(out : List.List<Nat8>, list : [Dispute.Evidence]) {
    RecordDigest.appendAll(out, RecordDigest.u32(list.size()));
    for (evidence in list.values()) appendEvidence(out, evidence)
  };

  func appendEvidence(out : List.List<Nat8>, evidence : Dispute.Evidence) {
    // Exactly 32 bytes, enforced by `Dispute.checkEvidence`.
    RecordDigest.appendBlob(out, evidence.digest);
    switch (evidence.locator) {
      case (#uri(uri)) {
        RecordDigest.append(out, 0);
        RecordDigest.appendText(out, uri)
      };
      case (#sealed({ custodian })) {
        RecordDigest.append(out, 1);
        RecordDigest.appendText(out, custodian)
      }
    };
    RecordDigest.appendText(out, evidence.description)
  };

  public func groundTag(ground : Dispute.Ground) : Nat8 {
    switch (ground) {
      case (#authorship) 0;
      case (#priorCreation) 1;
      case (#undisclosedDerivation) 2;
      case (#aiDisclosure) 3;
      case (#licensing) 4;
      case (#other) 5
    }
  };

  public func stanceTag(stance : Dispute.Stance) : Nat8 {
    switch (stance) {
      case (#contest) 0;
      case (#concede) 1;
      case (#partial) 2
    }
  };

  public func outcomeTag(outcome : Dispute.Outcome) : Nat8 {
    switch (outcome) {
      case (#upheld) 0;
      case (#rejected) 1;
      case (#settled) 2;
      case (#dismissed) 3;
      case (#abusive) 4
    }
  };

  public func partyTag(party : Dispute.Party) : Nat8 {
    switch (party) {
      case (#claimant) 0;
      case (#respondent) 1
    }
  };
};
