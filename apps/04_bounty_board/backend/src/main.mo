import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Escrow "Escrow";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Ledger "Ledger";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Validation "Validation";

persistent actor CreatorBountyBoard {
  public type Error = {
    #anonymousNotAllowed;
    #unauthorized;
    #notFound;
    #invalidInput : Text;
    #duplicate;
    #conflict : Text;
    #deadlinePassed;
  };
  public type Result<T> = { #ok : T; #err : Error };
  public type BountyStatus = {
    #open;
    #awarded : { submissionId : Nat; awardId : Nat; at : Nat };
    #cancelled : { at : Nat; reason : Text };
  };
  public type Bounty = {
    id : Nat;
    owner : Principal;
    title : Text;
    descriptionHash : Blob;
    descriptionUri : Text;
    criteriaHash : Blob;
    reward : Nat;
    ledger : Principal;
    deadline : Nat;
    createdAt : Nat;
    status : BountyStatus;
  };
  public type BountyInput = {
    title : Text;
    descriptionHash : Blob;
    descriptionUri : Text;
    criteriaHash : Blob;
    reward : Nat;
    ledger : Principal;
    deadline : Nat;
  };
  public type Submission = {
    id : Nat;
    bountyId : Nat;
    submitter : Principal;
    artifactHash : Blob;
    proofCanister : Principal;
    proofRecordId : Nat;
    evidenceUri : Text;
    note : Text;
    submittedAt : Nat;
  };
  public type SubmissionInput = {
    bountyId : Nat;
    artifactHash : Blob;
    proofCanister : Principal;
    proofRecordId : Nat;
    evidenceUri : Text;
    note : Text;
  };
  public type Award = {
    id : Nat;
    bountyId : Nat;
    submissionId : Nat;
    owner : Principal;
    winner : Principal;
    reward : Nat;
    ledger : Principal;
    awardedAt : Nat;
  };
  public type Stats = { bounties : Nat; submissions : Nat; awards : Nat };

  // ----------------------------------------------------------- escrow (#13)

  public type Account = Ledger.Account;
  public type EscrowRecord = Escrow.Escrow;

  public type TokenInfo = {
    ledger : Principal;
    symbol : Text;
    decimals : Nat8;
    fee : Nat;
    registeredAt : Nat;
  };

  public type PlatformConfig = { account : Account; feeBps : Nat; updatedAt : Nat };

  public type EscrowError = {
    #anonymousNotAllowed;
    #unauthorized;
    #notFound;
    #invalidInput : Text;
    #conflict : Text;
    /// The ledger refused the transfer; it did not happen.
    #refused : Text;
    /// The ledger's fee changed before funding. The escrow's terms were
    /// recomputed: approve `approval` and fund again.
    #feeChanged : { fee : Nat; deposit : Nat; approval : Nat };
    /// The ledger could not be asked, or did not say whether the transfer
    /// happened. Nothing is lost: `settleEscrow` retries it identically.
    #ledgerUnavailable : Text;
  };

  public type EscrowResult<T> = { #ok : T; #err : EscrowError };

  let bounties = Map.empty<Nat, Bounty>();
  let submissions = Map.empty<Nat, Submission>();
  let awards = Map.empty<Nat, Award>();
  let submitterIndex = Map.empty<Text, Nat>();
  var nextBountyId : Nat = 1;
  var nextSubmissionId : Nat = 1;
  var nextAwardId : Nat = 1;

  // Escrow (#13). Side tables, so `Bounty` and `Award` keep their stable shape.
  let ledgers = Map.empty<Principal, TokenInfo>();
  var platform : ?PlatformConfig = null;
  /// Only bounties posted against a registered ledger have an entry, and for
  /// those the reward must be in escrow before anyone can enter or win.
  let escrows = Map.empty<Nat, Escrow.Escrow>();

  func nowNanos() : Nat { Int.abs(Time.now()) };

  func submissionKey(bountyId : Nat, submitter : Principal) : Text {
    Nat.toText(bountyId) # ":" # Principal.toText(submitter)
  };

  public shared ({ caller }) func createBounty(input : BountyInput) : async Result<Bounty> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    if (not Validation.validText(input.title, 1, 200)) return #err(#invalidInput("title length is invalid"));
    if (not Validation.isDigest(input.descriptionHash)) return #err(#invalidInput("descriptionHash must be 32 bytes"));
    if (not Validation.isDigest(input.criteriaHash)) return #err(#invalidInput("criteriaHash must be 32 bytes"));
    if (not Validation.validText(input.descriptionUri, 1, 2048)) return #err(#invalidInput("descriptionUri length is invalid"));
    if (input.reward == 0) return #err(#invalidInput("reward must be greater than zero"));
    if (Principal.isAnonymous(input.ledger)) return #err(#invalidInput("ledger is invalid"));
    if (input.deadline <= nowNanos()) return #err(#invalidInput("deadline must be in the future"));

    let id = nextBountyId;
    nextBountyId += 1;
    let bounty : Bounty = {
      id = id; owner = caller; title = input.title; descriptionHash = input.descriptionHash;
      descriptionUri = input.descriptionUri; criteriaHash = input.criteriaHash;
      reward = input.reward; ledger = input.ledger; deadline = input.deadline;
      createdAt = nowNanos(); status = #open;
    };
    Map.add(bounties, Nat.compare, id, bounty);
    switch (Map.get(ledgers, Principal.compare, input.ledger)) {
      case (?token) {
        // The terms are fixed now, before the owner approves anything: the
        // platform's rate is a snapshot, so changing it later rewrites no
        // bounty already posted.
        let (platformAccount, rate) = switch (platform) {
          case (?config) (?config.account, config.feeBps);
          case null (null, 0);
        };
        let cut = Escrow.platformFee(input.reward, rate);
        Map.add(escrows, Nat.compare, id, {
          bountyId = id;
          ledger = input.ledger;
          funder = caller;
          subaccount = Escrow.subaccount(id);
          reward = input.reward;
          platformFee = if (platformAccount == null) 0 else cut;
          platform = platformAccount;
          fee = token.fee;
          deposit = Escrow.deposit(input.reward, if (platformAccount == null) 0 else cut, token.fee);
          state = #awaitingFunds;
          ops = [];
        })
      };
      case null {};
    };
    #ok(bounty)
  };

  public shared ({ caller }) func submit(input : SubmissionInput) : async Result<Submission> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    let ?bounty = Map.get(bounties, Nat.compare, input.bountyId) else return #err(#notFound);
    switch (bounty.status) { case (#open) {}; case _ return #err(#conflict("bounty is not open")) };
    if (not escrowReady(bounty.id)) return #err(#conflict("the bounty's reward is not in escrow yet"));
    if (nowNanos() > bounty.deadline) return #err(#deadlinePassed);
    if (not Validation.isDigest(input.artifactHash)) return #err(#invalidInput("artifactHash must be 32 bytes"));
    if (Principal.isAnonymous(input.proofCanister)) return #err(#invalidInput("proofCanister is invalid"));
    if (not Validation.validText(input.evidenceUri, 1, 2048)) return #err(#invalidInput("evidenceUri length is invalid"));
    if (not Validation.validText(input.note, 0, 1000)) return #err(#invalidInput("note length is invalid"));
    let key = submissionKey(input.bountyId, caller);
    switch (Map.get(submitterIndex, Text.compare, key)) { case (?_) return #err(#duplicate); case null {} };

    let id = nextSubmissionId;
    nextSubmissionId += 1;
    let submission : Submission = {
      id = id; bountyId = input.bountyId; submitter = caller; artifactHash = input.artifactHash;
      proofCanister = input.proofCanister; proofRecordId = input.proofRecordId;
      evidenceUri = input.evidenceUri; note = input.note; submittedAt = nowNanos();
    };
    Map.add(submissions, Nat.compare, id, submission);
    Map.add(submitterIndex, Text.compare, key, id);
    #ok(submission)
  };

  public shared ({ caller }) func award(bountyId : Nat, submissionId : Nat) : async Result<Award> {
    let ?bounty = Map.get(bounties, Nat.compare, bountyId) else return #err(#notFound);
    if (bounty.owner != caller) return #err(#unauthorized);
    switch (bounty.status) { case (#open) {}; case _ return #err(#conflict("bounty is already closed")) };
    // No award without the reward in escrow. An award the board cannot pay is
    // a promise, which is what this bounty board used to be.
    if (not escrowReady(bountyId)) return #err(#conflict("the bounty's reward is not in escrow"));
    let ?submission = Map.get(submissions, Nat.compare, submissionId) else return #err(#notFound);
    if (submission.bountyId != bountyId) return #err(#invalidInput("submission belongs to another bounty"));

    let id = nextAwardId;
    nextAwardId += 1;
    let now = nowNanos();
    let award : Award = {
      id = id; bountyId = bountyId; submissionId = submissionId; owner = bounty.owner;
      winner = submission.submitter; reward = bounty.reward; ledger = bounty.ledger; awardedAt = now;
    };
    Map.add(awards, Nat.compare, id, award);
    let updated : Bounty = {
      id = bounty.id; owner = bounty.owner; title = bounty.title;
      descriptionHash = bounty.descriptionHash; descriptionUri = bounty.descriptionUri;
      criteriaHash = bounty.criteriaHash; reward = bounty.reward; ledger = bounty.ledger;
      deadline = bounty.deadline; createdAt = bounty.createdAt;
      status = #awarded({ submissionId = submissionId; awardId = id; at = now });
    };
    Map.add(bounties, Nat.compare, bountyId, updated);
    // The award is final before any money moves: a second `award` now sees a
    // closed bounty, whatever the ledger does next. The payout runs here and,
    // if the ledger cannot be reached, is finished later by `settleEscrow`.
    switch (Map.get(escrows, Nat.compare, bountyId)) {
      case (?escrow) {
        Map.add(escrows, Nat.compare, bountyId, { escrow with state = #releasing });
        ignore await* drive(bountyId)
      };
      case null {};
    };
    #ok(award)
  };

  public shared ({ caller }) func cancelBounty(id : Nat, reason : Text) : async Result<Bounty> {
    if (not Validation.validText(reason, 1, 1000)) return #err(#invalidInput("reason length is invalid"));
    let ?bounty = Map.get(bounties, Nat.compare, id) else return #err(#notFound);
    if (bounty.owner != caller) return #err(#unauthorized);
    switch (bounty.status) { case (#open) {}; case _ return #err(#conflict("bounty is already closed")) };
    let updated : Bounty = {
      id = bounty.id; owner = bounty.owner; title = bounty.title;
      descriptionHash = bounty.descriptionHash; descriptionUri = bounty.descriptionUri;
      criteriaHash = bounty.criteriaHash; reward = bounty.reward; ledger = bounty.ledger;
      deadline = bounty.deadline; createdAt = bounty.createdAt;
      status = #cancelled({ at = nowNanos(); reason = reason });
    };
    Map.add(bounties, Nat.compare, id, updated);
    switch (Map.get(escrows, Nat.compare, id)) {
      case (?escrow) {
        let next : Escrow.State = switch (escrow.state, Escrow.pendingIndex(escrow)) {
          // A pull whose outcome is unknown may have moved the money; the
          // refund path resolves it first and returns whatever arrived.
          case (#awaitingFunds, ?_) #refunding;
          case (#awaitingFunds, null) #closedUnfunded;
          case _ #refunding;
        };
        Map.add(escrows, Nat.compare, id, { escrow with state = next });
        if (next == #refunding) ignore await* drive(id)
      };
      case null {};
    };
    #ok(updated)
  };

  func escrowReady(bountyId : Nat) : Bool {
    switch (Map.get(escrows, Nat.compare, bountyId)) {
      case null true;
      case (?escrow) escrow.state == #funded;
    }
  };

  func self() : Principal { Principal.fromActor(CreatorBountyBoard) };

  func escrowAccount(escrow : Escrow.Escrow) : Account { { owner = self(); subaccount = ?escrow.subaccount } };

  func ledgerOf(escrow : Escrow.Escrow) : Ledger.Ledger { actor (Principal.toText(escrow.ledger)) };

  /// Controllers only: which tokens escrow is offered for is operator policy.
  public shared ({ caller }) func registerLedger(ledger : Principal) : async EscrowResult<TokenInfo> {
    if (not Principal.isController(caller)) return #err(#unauthorized);
    if (Principal.isAnonymous(ledger)) return #err(#invalidInput("ledger is invalid"));
    let token : Ledger.Ledger = actor (Principal.toText(ledger));
    let metadata = try {
      (await token.icrc1_symbol(), await token.icrc1_decimals(), await token.icrc1_fee())
    } catch (error) {
      return #err(#ledgerUnavailable("the ledger did not answer its ICRC-1 metadata queries: " # Error.message(error)))
    };
    let info : TokenInfo = { ledger; symbol = metadata.0; decimals = metadata.1; fee = metadata.2; registeredAt = nowNanos() };
    Map.add(ledgers, Principal.compare, ledger, info);
    #ok(info)
  };

  /// Where the platform's cut goes and how large it is, for bounties posted
  /// from now on. Posted bounties keep the terms they were posted with.
  public shared ({ caller }) func setPlatform(account : Account, feeBps : Nat) : async EscrowResult<PlatformConfig> {
    if (not Principal.isController(caller)) return #err(#unauthorized);
    if (feeBps > Escrow.maxFeeBps) return #err(#invalidInput("feeBps is above the maximum of 2000"));
    switch (account.subaccount) {
      case (?bytes) { if (bytes.size() != 32) return #err(#invalidInput("subaccount must be 32 bytes")) };
      case null {};
    };
    let config : PlatformConfig = { account; feeBps; updatedAt = nowNanos() };
    platform := ?config;
    #ok(config)
  };

  /// Pulls the approved deposit into the bounty's escrow subaccount.
  ///
  /// The owner first approves this canister, with ICRC-2 `icrc2_approve`, for
  /// `Escrow.approval` — the deposit plus the pull's own fee — and optionally an
  /// expiry. Nobody can enter or win the bounty until this succeeds.
  public shared ({ caller }) func fundEscrow(bountyId : Nat) : async EscrowResult<Escrow.Escrow> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    let ?bounty = Map.get(bounties, Nat.compare, bountyId) else return #err(#notFound);
    let ?escrow = Map.get(escrows, Nat.compare, bountyId) else return #err(#conflict("this bounty is not escrowed"));
    if (bounty.owner != caller) return #err(#unauthorized);
    switch (bounty.status) { case (#open) {}; case _ return #err(#conflict("bounty is not open")) };
    if (escrow.state != #awaitingFunds) return #err(#conflict("the escrow is already funded"));
    if (nowNanos() > bounty.deadline) return #err(#conflict("the bounty's deadline has passed"));
    switch (Escrow.pendingIndex(escrow)) {
      // A pull is already in flight with an unknown outcome: repeat that one,
      // never start a second, or an approval large enough would be pulled twice.
      case (?_) {};
      case null {
        let op : Escrow.Op = {
          kind = #fund;
          from = { owner = bounty.owner; subaccount = null };
          to = escrowAccount(escrow);
          amount = escrow.deposit;
          fee = escrow.fee;
          memo = Escrow.memo(bountyId, #fund);
          createdAtTime = Nat.toNat64(nowNanos());
          attempts = 0;
          status = #pending;
        };
        Map.add(escrows, Nat.compare, bountyId, { escrow with ops = Array.concat(escrow.ops, [op]) })
      };
    };
    await* drive(bountyId)
  };

  /// Finishes whatever the escrow is waiting for: an in-flight transfer whose
  /// outcome is unknown, a payout after an award, a refund after a
  /// cancellation. Idempotent — every transfer is retried with identical
  /// arguments and the ledger deduplicates — so anyone may call it, and it only
  /// ever moves money to the destinations the bounty already fixed.
  public shared ({ caller }) func settleEscrow(bountyId : Nat) : async EscrowResult<Escrow.Escrow> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    let ?_ = Map.get(escrows, Nat.compare, bountyId) else return #err(#notFound);
    await* drive(bountyId)
  };

  public query func getEscrow(bountyId : Nat) : async ?Escrow.Escrow { Map.get(escrows, Nat.compare, bountyId) };
  public query func getLedger(ledger : Principal) : async ?TokenInfo { Map.get(ledgers, Principal.compare, ledger) };
  public query func getPlatform() : async ?PlatformConfig { platform };

  func setOp(bountyId : Nat, index : Nat, change : Escrow.Op -> Escrow.Op) {
    let ?escrow = Map.get(escrows, Nat.compare, bountyId) else return;
    let ops = Array.tabulate<Escrow.Op>(escrow.ops.size(), func(i) = if (i == index) change(escrow.ops[i]) else escrow.ops[i]);
    Map.add(escrows, Nat.compare, bountyId, { escrow with ops })
  };

  func appendOps(bountyId : Nat, ops : [Escrow.Op], state : Escrow.State) {
    let ?escrow = Map.get(escrows, Nat.compare, bountyId) else return;
    Map.add(escrows, Nat.compare, bountyId, { escrow with ops = Array.concat(escrow.ops, ops); state })
  };

  func outgoing(escrow : Escrow.Escrow, kind : Escrow.OpKind, to : Account, amount : Nat) : Escrow.Op {
    {
      kind;
      from = escrowAccount(escrow);
      to;
      amount;
      fee = escrow.fee;
      memo = Escrow.memo(escrow.bountyId, kind);
      createdAtTime = Nat.toNat64(nowNanos());
      attempts = 0;
      status = #pending;
    }
  };

  /// Plans the next transfers from the books, or reports that nothing is left.
  /// Every amount comes from `Escrow.release` / `Escrow.refund` over the
  /// balance the books say the escrow holds.
  func plan(bountyId : Nat) : Bool {
    let ?escrow = Map.get(escrows, Nat.compare, bountyId) else return false;
    let ?bounty = Map.get(bounties, Nat.compare, bountyId) else return false;
    let balance = Escrow.expectedBalance(escrow);
    let funded = Escrow.doneCount(escrow, #fund) > 0;
    switch (escrow.state, bounty.status) {
      case (#releasing, #awarded(awarded)) {
        let ?submission = Map.get(submissions, Nat.compare, awarded.submissionId) else return false;
        if (Escrow.doneCount(escrow, #payWinner) == 0) {
          let split = Escrow.release(balance, escrow.reward, escrow.fee);
          let winner = outgoing(escrow, #payWinner, { owner = submission.submitter; subaccount = null }, split.winner);
          appendOps(bountyId, [winner], #releasing);
          return true
        };
        switch (escrow.platform) {
          case (?account) {
            if (Escrow.doneCount(escrow, #payPlatform) == 0) {
              // Whatever the winner's payout left, less this transfer's fee.
              let amount = Escrow.refund(balance, escrow.fee);
              if (amount > 0) {
                appendOps(bountyId, [outgoing(escrow, #payPlatform, account, amount)], #releasing);
                return true
              }
            }
          };
          case null {};
        };
        Map.add(escrows, Nat.compare, bountyId, { escrow with state = #released });
        false
      };
      case (#refunding, _) {
        if (not funded) {
          Map.add(escrows, Nat.compare, bountyId, { escrow with state = #closedUnfunded });
          return false
        };
        if (Escrow.doneCount(escrow, #refund) == 0) {
          let amount = Escrow.refund(balance, escrow.fee);
          if (amount > 0) {
            appendOps(bountyId, [outgoing(escrow, #refund, { owner = escrow.funder; subaccount = null }, amount)], #refunding);
            return true
          }
        };
        Map.add(escrows, Nat.compare, bountyId, { escrow with state = #refunded });
        false
      };
      case _ false;
    }
  };

  /// The escrow state machine. Runs the pending transfer, if there is one,
  /// then plans the next, until nothing is left to do or the ledger cannot be
  /// reached. Each step re-reads the escrow after its `await`: two callers can
  /// drive the same escrow at once, and the second must not act on what the
  /// first already settled — which, for the transfer itself, the ledger's
  /// deduplication guarantees anyway.
  func drive(bountyId : Nat) : async* EscrowResult<Escrow.Escrow> {
    var steps = 0;
    label running while (steps < 8) {
      steps += 1;
      let ?escrow = Map.get(escrows, Nat.compare, bountyId) else return #err(#notFound);
      let index = switch (Escrow.pendingIndex(escrow)) {
        case (?i) i;
        case null { if (plan(bountyId)) continue running else break running };
      };
      let op = escrow.ops[index];
      let ledger = ledgerOf(escrow);
      let outcome = switch (op.kind) {
        case (#fund) {
          await* Ledger.pull(ledger, self(), {
            from = op.from;
            toSubaccount = escrow.subaccount;
            amount = op.amount;
            fee = op.fee;
            memo = op.memo;
            createdAtTime = op.createdAtTime;
          })
        };
        case _ {
          await* Ledger.transfer(ledger, {
            fromSubaccount = ?escrow.subaccount;
            to = op.to;
            amount = op.amount;
            fee = op.fee;
            memo = op.memo;
            createdAtTime = op.createdAtTime;
          })
        };
      };
      // ---- the escrow may have moved on while the ledger answered ----
      let ?current = Map.get(escrows, Nat.compare, bountyId) else return #err(#notFound);
      if (index >= current.ops.size() or current.ops[index].status != #pending
        or current.ops[index].createdAtTime != op.createdAtTime) {
        continue running
      };
      let now = nowNanos();
      switch (outcome) {
        case (#executed(block)) {
          setOp(bountyId, index, func(o) = { o with status = #done({ block = ?block; at = now }); attempts = o.attempts + 1 });
          if (op.kind == #fund) markFunded(bountyId)
        };
        case (#unknown(reason)) {
          setOp(bountyId, index, func(o) = { o with attempts = o.attempts + 1 });
          return #err(#ledgerUnavailable(reason))
        };
        case (#refused(reason)) {
          setOp(bountyId, index, func(o) = { o with status = #failed({ reason; at = now }); attempts = o.attempts + 1 });
          return #err(#refused(reason))
        };
        case (#badFee(fee)) {
          // Definitively not executed, so the terms may change. Before funding
          // the owner has to approve the new amount; after it, the books are
          // redone at the new fee and the next plan pays out from them.
          setOp(bountyId, index, func(o) = {
            o with status = #failed({ reason = "the ledger fee changed to " # debug_show (fee); at = now });
            attempts = o.attempts + 1
          });
          let ?latest = Map.get(escrows, Nat.compare, bountyId) else return #err(#notFound);
          // Bounties posted from now on are priced at the fee the ledger
          // actually charges, not the one it charged at registration.
          switch (Map.get(ledgers, Principal.compare, latest.ledger)) {
            case (?token) Map.add(ledgers, Principal.compare, latest.ledger, { token with fee });
            case null {};
          };
          if (op.kind == #fund) {
            let deposit = Escrow.deposit(latest.reward, latest.platformFee, fee);
            Map.add(escrows, Nat.compare, bountyId, { latest with fee; deposit });
            return #err(#feeChanged({ fee; deposit; approval = deposit + fee }))
          };
          Map.add(escrows, Nat.compare, bountyId, { latest with fee })
        };
        case (#stale) {
          switch (await* reconcile(bountyId, index)) {
            case (#err(error)) return #err(error);
            case (#ok(_)) {};
          }
        };
      };
    };
    let ?final = Map.get(escrows, Nat.compare, bountyId) else return #err(#notFound);
    #ok(final)
  };

  func markFunded(bountyId : Nat) {
    let ?escrow = Map.get(escrows, Nat.compare, bountyId) else return;
    // A cancellation may have landed while the pull was in flight; the money
    // is in escrow either way, and the refund path takes it from here.
    if (escrow.state == #awaitingFunds) {
      Map.add(escrows, Nat.compare, bountyId, { escrow with state = #funded })
    }
  };

  /// The identical retry came too late for the ledger to deduplicate, so
  /// whether the first attempt happened is read from the escrow subaccount:
  /// only this bounty's own transfers ever move it.
  func reconcile(bountyId : Nat, index : Nat) : async* EscrowResult<()> {
    let ?escrow = Map.get(escrows, Nat.compare, bountyId) else return #err(#notFound);
    let op = escrow.ops[index];
    let observed = try {
      await ledgerOf(escrow).icrc1_balance_of(escrowAccount(escrow))
    } catch (error) {
      return #err(#ledgerUnavailable("the ledger did not report the escrow balance: " # Error.message(error)))
    };
    let ?current = Map.get(escrows, Nat.compare, bountyId) else return #err(#notFound);
    if (current.ops[index].status != #pending) return #ok(());
    let before = Escrow.expectedBalance(current);
    let happened = switch (op.kind) {
      case (#fund) observed >= before + op.amount;
      case _ observed + op.amount + op.fee <= before;
    };
    let now = nowNanos();
    if (happened) {
      setOp(bountyId, index, func(o) = { o with status = #done({ block = null; at = now }); attempts = o.attempts + 1 });
      if (op.kind == #fund) markFunded(bountyId)
    } else {
      setOp(bountyId, index, func(o) = {
        o with status = #failed({ reason = "not executed; the ledger's deduplication window had closed"; at = now });
        attempts = o.attempts + 1
      })
    };
    #ok(())
  };

  public query func getBounty(id : Nat) : async ?Bounty { Map.get(bounties, Nat.compare, id) };
  public query func getSubmission(id : Nat) : async ?Submission { Map.get(submissions, Nat.compare, id) };
  public query func getAward(id : Nat) : async ?Award { Map.get(awards, Nat.compare, id) };

  public query func listBounties(start : Nat, limit : Nat) : async [Bounty] {
    let entries = Iter.take(Map.entriesFrom(bounties, Nat.compare, start), Validation.pageLimit(limit));
    Iter.toArray(Iter.map<(Nat, Bounty), Bounty>(entries, func(entry : (Nat, Bounty)) : Bounty { entry.1 }))
  };

  public query func stats() : async Stats {
    { bounties = Map.size(bounties); submissions = Map.size(submissions); awards = Map.size(awards) }
  };
};
