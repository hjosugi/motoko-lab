/// Counterclaims against proof records: filing, response, determination by
/// registered authorities, appeal, and withdrawal.
///
/// Revocation is the only thing a record could say about itself until now, and
/// only its owner can say it. A third party who believes a record is wrong —
/// someone else made the work, it existed before the commitment, it is derived
/// from something it does not list, its AI disclosure is false — had no way to
/// put that on the record at all.
///
/// Three rules shape everything here:
///
///   * **The record is never touched.** A dispute is a side structure keyed by
///     record id. Nothing in this module can change a `ProofRecord`, its status,
///     or its certified digest. What the creator committed to stays exactly what
///     they committed to, and a reader sees the dispute next to it.
///   * **Technical status and outcome are different things.** `#active` and
///     `#revoked` say what the *owner* did. A determination says what a named
///     authority concluded under its own published policy. The registry records
///     both and decides neither: it never marks a record false, and it never
///     picks between two authorities that disagree.
///   * **The state is a function of the log.** Every transition is an `Event`
///     in a per-dispute hash chain, and a `Dispute` is nothing but `apply`
///     folded over those events. A reader holding the export can replay the log
///     and check it arrives at the state the canister served.
///
/// `docs/DISPUTES.md` has the lifecycle, the abuse controls, and the privacy
/// rules; `DisputeLog.mo` has the event encoding.
import Array "mo:core/Array";
import Principal "mo:core/Principal";
import Text "mo:core/Text";

module {
  public type DisputeId = Nat;

  /// What the counterclaim asserts. A closed set, so a verifier can render and
  /// filter it without parsing free text; `#other` exists so a claimant is
  /// never forced to misfile.
  public type Ground = {
    /// Someone other than the attributed creator made the work.
    #authorship;
    /// The work existed before this record's commitment.
    #priorCreation;
    /// The work derives from something the record does not list as a parent.
    #undisclosedDerivation;
    /// The AI disclosure on the record is inaccurate.
    #aiDisclosure;
    /// The work was registered or published outside the rights held.
    #licensing;
    #other;
  };

  /// Where a piece of evidence can be found.
  ///
  /// `#sealed` is the privacy rule, expressed as a type rather than a policy:
  /// private evidence has only its digest on-chain and names who holds it, and
  /// there is no field in which a URI could be left behind by mistake. Everything
  /// in canister state is readable by anyone who can query it, so "private but
  /// stored" is not an option.
  public type Locator = {
    #uri : Text;
    #sealed : { custodian : Text };
  };

  public type Evidence = {
    /// SHA-256 of the evidence itself, so whatever is produced later can be
    /// checked against what was referenced now.
    digest : Blob;
    locator : Locator;
    description : Text;
  };

  public type Party = { #claimant; #respondent };

  /// The respondent's answer. A concession is a statement by a party, not an
  /// outcome: it does not revoke the record (only the owner's `revokeRecord`
  /// does) and it does not close the dispute (an authority or a withdrawal
  /// does).
  public type Stance = { #contest; #concede; #partial };

  /// What an authority concluded, under its own published policy.
  ///
  /// `#dismissed` is "not decided on the merits" — out of scope, insufficient,
  /// duplicate. `#abusive` is the one outcome that counts against the claimant,
  /// and it is kept apart from `#dismissed` so a claim that was merely weak is
  /// never treated as one filed in bad faith.
  public type Outcome = { #upheld; #rejected; #settled; #dismissed; #abusive };

  public type Submission = {
    by : Principal;
    party : Party;
    evidence : Evidence;
    at : Nat;
  };

  public type Response = {
    by : Principal;
    stance : Stance;
    statement : Text;
    at : Nat;
  };

  public type Determination = {
    authority : Principal;
    outcome : Outcome;
    summary : Text;
    /// The full decision, if the authority publishes one. May be sealed.
    decision : ?Evidence;
    /// 0 for the first instance, n after the n-th appeal.
    round : Nat;
    at : Nat;
  };

  public type Appeal = {
    by : Principal;
    party : Party;
    statement : Text;
    /// The round this appeal opened.
    round : Nat;
    at : Nat;
  };

  /// Where the *process* is. None of these says who is right.
  public type Status = {
    /// Filed; the respondent has not answered and nobody has determined it.
    #open;
    /// Answered; nobody has determined it.
    #responded;
    /// At least one authority has determined the current round.
    #determined;
    /// A party appealed; the new round has no determination yet.
    #appealed;
    /// The claimant withdrew before any determination.
    #withdrawn : { at : Nat; reason : Text };
  };

  public type Dispute = {
    id : DisputeId;
    record : Nat;
    claimant : Principal;
    ground : Ground;
    statement : Text;
    /// The claimant's own record, when the counterclaim is "I registered this
    /// first". A reference, not a verdict: a reader compares the two.
    counterRecord : ?Nat;
    evidence : [Submission];
    filedAt : Nat;
    /// After this, an authority may determine the dispute without an answer.
    respondBy : Nat;
    response : ?Response;
    determinations : [Determination];
    appeals : [Appeal];
    round : Nat;
    status : Status;
    /// How many events the log holds, and the hash of the last one. The head is
    /// what the certified tree carries, so the whole history is attested by 32
    /// bytes.
    events : Nat;
    head : Blob;
  };

  /// One transition. The payload is everything the transition added, so the
  /// log alone is enough to rebuild the dispute.
  public type Action = {
    #filed : {
      record : Nat;
      ground : Ground;
      statement : Text;
      counterRecord : ?Nat;
      evidence : [Evidence];
    };
    #responded : { stance : Stance; statement : Text; evidence : [Evidence] };
    #evidenceAdded : { party : Party; evidence : [Evidence] };
    #determined : { outcome : Outcome; summary : Text; decision : ?Evidence; round : Nat };
    #appealed : { party : Party; statement : Text; evidence : [Evidence]; round : Nat };
    #withdrawn : { reason : Text };
  };

  public type Event = {
    dispute : DisputeId;
    /// Position in this dispute's log, from 0.
    seq : Nat;
    at : Nat;
    by : Principal;
    action : Action;
    /// The previous event's hash; 32 zero bytes for the first.
    prev : Blob;
    /// SHA-256 of `DisputeLog.encode` over every field above.
    hash : Blob;
  };

  /// An authority that may record determinations. Added and retired by the
  /// canister's controllers; the registry trusts none of them on anyone's
  /// behalf, it only records which one said what.
  public type Authority = {
    id : Principal;
    name : Text;
    /// The policy the authority determines under. A reader deciding whether to
    /// rely on a determination reads this, not the registry.
    policyUri : Text;
    addedAt : Nat;
    retiredAt : ?Nat;
  };

  /// `Error` from the registry plus `#rateLimited`. A separate type rather than
  /// a new tag on `Error`: a tag added to a released result type is decoded as
  /// `null` by a client built against the release, which is the break
  /// `scripts/check_candid_compat.py` exists to reject.
  public type Error = {
    #anonymousNotAllowed;
    #unauthorized;
    #notFound;
    #invalidInput : Text;
    #duplicate : Text;
    #conflict : Text;
    #expired;
    /// Refused for volume, not for content. `retryAt` is when the oldest
    /// counted filing or strike leaves its window.
    #rateLimited : { retryAt : Nat };
  };

  public type Result<T> = { #ok : T; #err : Error };

  // ------------------------------------------------------------- the limits

  // Nanosecond literals, because a module's fields must be static. Spelled out
  // in `test/Dispute.test.mo` as days, so a unit slip shows up there.

  /// How long the respondent has before an authority may proceed without them.
  public let responseWindowNanos : Nat = 1_209_600_000_000_000; // 14 days
  /// How long after the latest determination of a round a party may appeal.
  public let appealWindowNanos : Nat = 2_592_000_000_000_000; // 30 days
  /// Each side appeals at most this many times. Without a bound the loser of
  /// every round appeals it, and "determined" never becomes a stable state.
  public let maxAppealsPerParty : Nat = 1;

  /// Filings per claimant per rolling window. Per principal, which a claimant
  /// with many principals can multiply; a bond (#12, #22) is the control that
  /// does not have that weakness, and this is the one that needs no payments.
  public let filingWindowNanos : Nat = 86_400_000_000_000; // 1 day
  public let maxFilingsPerWindow : Nat = 5;
  /// Unresolved disputes one claimant may have open at once, across records.
  public let maxUnresolvedPerClaimant : Nat = 10;
  /// Unresolved disputes one record may carry. Bounds how far a campaign can
  /// bury a record in noise.
  public let maxUnresolvedPerRecord : Nat = 20;
  /// `#abusive` determinations within the window that suspend filing.
  public let strikeWindowNanos : Nat = 7_776_000_000_000_000; // 90 days
  public let strikeLimit : Nat = 3;

  public let maxAuthorities : Nat = 32;
  public let maxEvidencePerSubmission : Nat = 8;
  public let maxEvidencePerDispute : Nat = 32;
  public let maxStatementSize : Nat = 2000;
  public let maxSummarySize : Nat = 1000;
  public let maxDescriptionSize : Nat = 200;
  public let maxCustodianSize : Nat = 200;
  public let maxUriSize : Nat = 2048;
  public let maxNameSize : Nat = 200;
  public let maxReasonSize : Nat = 1000;

  // ------------------------------------------------------------- validation

  func sized(value : Text, max : Nat) : Bool {
    value.size() >= 1 and value.size() <= max
  };

  public func validStatement(value : Text) : Bool { sized(value, maxStatementSize) };
  public func validSummary(value : Text) : Bool { sized(value, maxSummarySize) };
  public func validReason(value : Text) : Bool { sized(value, maxReasonSize) };
  public func validName(value : Text) : Bool { sized(value, maxNameSize) };
  public func validUri(value : Text) : Bool { sized(value, maxUriSize) };

  /// `null` when the reference is acceptable, otherwise why not.
  ///
  /// A sealed custodian that contains `://` is refused: the field names who
  /// holds the evidence, and a URI in it would publish exactly the pointer the
  /// claimant chose not to publish.
  public func checkEvidence(evidence : Evidence) : ?Text {
    if (evidence.digest.size() != 32) return ?"evidence digest must be 32 bytes";
    if (evidence.description.size() > maxDescriptionSize) return ?"evidence description is too long";
    switch (evidence.locator) {
      case (#uri(uri)) {
        if (not validUri(uri)) return ?"evidence URI length is invalid"
      };
      case (#sealed({ custodian })) {
        if (not sized(custodian, maxCustodianSize)) return ?"sealed evidence custodian length is invalid";
        if (Text.contains(custodian, #text "://")) {
          return ?"sealed evidence must not carry a URI; use a #uri locator for public evidence"
        }
      }
    };
    null
  };

  public func checkEvidenceList(list : [Evidence]) : ?Text {
    if (list.size() > maxEvidencePerSubmission) return ?"too many evidence references in one submission";
    for (evidence in list.values()) {
      switch (checkEvidence(evidence)) {
        case (?problem) return ?problem;
        case null {}
      }
    };
    null
  };

  // ------------------------------------------------------------ rate limits

  /// Timestamps from `recent` still inside `window` at `now`. Also what the
  /// actor stores back, so the per-principal lists never grow past the limit.
  public func inWindow(recent : [Nat], now : Nat, window : Nat) : [Nat] {
    Array.filter<Nat>(recent, func(at : Nat) : Bool { at + window > now })
  };

  /// `null` if one more event fits in the window, otherwise when it will.
  ///
  /// Written with additions only: `now - window` would trap below zero on a
  /// young replica, and a guard that traps is a guard that fails open or shut
  /// depending on the clock.
  public func retryAt(recent : [Nat], now : Nat, window : Nat, limit : Nat) : ?Nat {
    let live = inWindow(recent, now, window);
    if (live.size() < limit) return null;
    var oldest = live[0];
    for (at in live.values()) {
      if (at < oldest) oldest := at
    };
    ?(oldest + window)
  };

  // -------------------------------------------------------------- lifecycle

  public func unresolved(status : Status) : Bool {
    switch (status) {
      case (#open or #responded or #appealed) true;
      case (#determined or #withdrawn(_)) false
    }
  };

  /// Determinations of the current round. Earlier rounds stay in the dispute
  /// and in the log; they are history, not the current state.
  public func current(dispute : Dispute) : [Determination] {
    Array.filter<Determination>(
      dispute.determinations,
      func(determination : Determination) : Bool { determination.round == dispute.round }
    )
  };

  /// Whether the authorities that determined the current round disagree.
  /// The registry reports the disagreement; it does not resolve it.
  public func conflicting(dispute : Dispute) : Bool {
    let round = current(dispute);
    if (round.size() < 2) return false;
    let first = round[0].outcome;
    Array.any<Determination>(round, func(determination : Determination) : Bool { determination.outcome != first })
  };

  public func checkRespond(dispute : Dispute, isRespondent : Bool) : ?Error {
    if (not isRespondent) return ?#unauthorized;
    switch (dispute.response) {
      case (?_) return ?#duplicate("the respondent has already responded");
      case null {}
    };
    switch (dispute.status) {
      case (#open) null;
      case _ ?#conflict("the dispute is no longer awaiting a response")
    }
  };

  public func checkAddEvidence(dispute : Dispute, party : ?Party, count : Nat) : ?Error {
    if (party == null) return ?#unauthorized;
    if (not unresolved(dispute.status)) return ?#conflict("evidence can only be added while the dispute is unresolved");
    if (count == 0) return ?#invalidInput("no evidence submitted");
    if (dispute.evidence.size() + count > maxEvidencePerDispute) {
      return ?#invalidInput("the dispute has reached its evidence limit")
    };
    null
  };

  /// Whether `authority` may record a determination at `now`.
  ///
  /// Due process first: until the respondent answers or the response window
  /// closes, nobody may determine anything. An authority that is a party is
  /// refused rather than recused, because the registry cannot tell a recusal
  /// from a determination it would have preferred not to make.
  public func checkDetermine(
    dispute : Dispute,
    authority : ?Authority,
    caller : Principal,
    isRespondent : Bool,
    now : Nat
  ) : ?Error {
    let ?found = authority else return ?#unauthorized;
    if (found.retiredAt != null) return ?#unauthorized;
    if (Principal.equal(caller, dispute.claimant) or isRespondent) {
      return ?#conflict("an authority cannot determine a dispute it is a party to")
    };
    switch (dispute.status) {
      case (#withdrawn(_)) return ?#conflict("the dispute was withdrawn");
      case (#open) {
        if (now < dispute.respondBy) return ?#conflict("the respondent's response window is still open")
      };
      case (#responded or #determined or #appealed) {}
    };
    for (determination in current(dispute).values()) {
      if (Principal.equal(determination.authority, caller)) {
        return ?#duplicate("this authority has already determined the current round")
      }
    };
    null
  };

  public func checkAppeal(dispute : Dispute, party : ?Party, now : Nat) : ?Error {
    let ?side = party else return ?#unauthorized;
    switch (dispute.status) {
      case (#determined) {};
      case _ return ?#conflict("only a determined dispute can be appealed")
    };
    var latest = 0;
    for (determination in current(dispute).values()) {
      if (determination.at > latest) latest := determination.at
    };
    if (now >= latest + appealWindowNanos) return ?#expired;
    let used = Array.filter<Appeal>(dispute.appeals, func(appeal : Appeal) : Bool { appeal.party == side });
    if (used.size() >= maxAppealsPerParty) return ?#conflict("this party has already appealed");
    null
  };

  public func checkWithdraw(dispute : Dispute, caller : Principal) : ?Error {
    if (not Principal.equal(caller, dispute.claimant)) return ?#unauthorized;
    switch (dispute.status) {
      case (#open or #responded) null;
      case (#withdrawn(_)) ?#conflict("the dispute is already withdrawn");
      case (#determined or #appealed) ?#conflict("a dispute can only be withdrawn before it is determined")
    }
  };

  // ------------------------------------------------------------ the fold

  func submissions(by : Principal, party : Party, list : [Evidence], at : Nat) : [Submission] {
    Array.map<Evidence, Submission>(list, func(evidence : Evidence) : Submission { { by; party; evidence; at } })
  };

  /// The dispute a `#filed` event creates, or `null` for any other event.
  public func genesis(event : Event) : ?Dispute {
    switch (event.action) {
      case (#filed(filed)) {
        ?{
          id = event.dispute;
          record = filed.record;
          claimant = event.by;
          ground = filed.ground;
          statement = filed.statement;
          counterRecord = filed.counterRecord;
          evidence = submissions(event.by, #claimant, filed.evidence, event.at);
          filedAt = event.at;
          respondBy = event.at + responseWindowNanos;
          response = null;
          determinations = [];
          appeals = [];
          round = 0;
          status = #open;
          events = 1;
          head = event.hash;
        }
      };
      case _ null
    }
  };

  /// The dispute after `event`. Pure, and the only way the actor changes a
  /// dispute, so the state a reader rebuilds from the log is the state served.
  /// Authorization is not re-checked here: the log records what was accepted.
  public func apply(dispute : Dispute, event : Event) : Dispute {
    let next = switch (event.action) {
      case (#filed(_)) dispute;
      case (#responded(answer)) {
        {
          dispute with
          response = ?{ by = event.by; stance = answer.stance; statement = answer.statement; at = event.at };
          evidence = Array.concat(dispute.evidence, submissions(event.by, #respondent, answer.evidence, event.at));
          status = #responded;
        }
      };
      case (#evidenceAdded(added)) {
        {
          dispute with
          evidence = Array.concat(dispute.evidence, submissions(event.by, added.party, added.evidence, event.at))
        }
      };
      case (#determined(determined)) {
        {
          dispute with
          determinations = Array.concat(
            dispute.determinations,
            [{
              authority = event.by;
              outcome = determined.outcome;
              summary = determined.summary;
              decision = determined.decision;
              round = determined.round;
              at = event.at;
            }]
          );
          status = #determined;
        }
      };
      case (#appealed(appeal)) {
        {
          dispute with
          appeals = Array.concat(
            dispute.appeals,
            [{ by = event.by; party = appeal.party; statement = appeal.statement; round = appeal.round; at = event.at }]
          );
          evidence = Array.concat(dispute.evidence, submissions(event.by, appeal.party, appeal.evidence, event.at));
          round = appeal.round;
          status = #appealed;
        }
      };
      case (#withdrawn(withdrawal)) {
        { dispute with status = #withdrawn({ at = event.at; reason = withdrawal.reason }) }
      };
    };
    { next with events = dispute.events + 1; head = event.hash }
  };

  /// Whether `event` counts as a strike against the claimant.
  public func isStrike(action : Action) : Bool {
    switch (action) {
      case (#determined({ outcome = #abusive })) true;
      case _ false
    }
  };
};
