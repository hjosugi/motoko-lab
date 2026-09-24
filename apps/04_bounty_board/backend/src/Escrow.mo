/// Escrow bookkeeping for a bounty: the types, and the arithmetic every
/// transfer amount comes from. Pure, so `test/Escrow.test.mo` checks the
/// accounting invariant over thousands of combinations in the interpreter.
///
/// The money model, in the ledger's base units, with `fee` the ledger fee:
///
///     platformFee = reward * feeBps / 10_000         (snapshot when the bounty is posted)
///     deposit     = reward + fee                     (no platform cut)
///                 = reward + fee + platformFee + fee (with one)
///
/// The owner approves `deposit + fee` — `icrc2_transfer_from` charges its own
/// fee to the owner — and the board pulls `deposit` into a subaccount of its
/// own that belongs to this bounty and nothing else. What leaves it is the
/// winner's `reward` and, if there is a cut, the platform's `platformFee`,
/// each paying one `fee`; or a single refund of everything to the owner,
/// paying one `fee`.
///
/// The fees are in the deposit because the escrow pays them, one per transfer
/// a release makes. If the ledger raises its fee between funding and payout,
/// the winner is paid first and in full while the escrow can afford it, and
/// the platform's share absorbs the difference.
/// The invariant the tests hold every split to:
///
///     winner + platform + fees paid + dust == funded balance,   dust <= fee
import Array "mo:core/Array";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Text "mo:core/Text";
import Ledger "Ledger";

module {
  public type Account = Ledger.Account;

  public type OpKind = { #fund; #payWinner; #payPlatform; #refund };

  public type OpStatus = {
    /// Sent, or about to be, with an outcome not yet known. Retried with
    /// identical arguments until the ledger says what happened.
    #pending;
    /// `block` is null only when the ledger's deduplication window had closed
    /// and the outcome was established from the escrow balance instead.
    #done : { block : ?Nat; at : Nat };
    /// Definitively not executed. A new operation may replace it.
    #failed : { reason : Text; at : Nat };
  };

  /// One ledger transfer, fixed before its first attempt.
  public type Op = {
    kind : OpKind;
    from : Account;
    to : Account;
    amount : Nat;
    fee : Nat;
    memo : Blob;
    createdAtTime : Nat64;
    attempts : Nat;
    status : OpStatus;
  };

  public type State = {
    /// Posted; the reward is not in escrow. Nobody can enter or win.
    #awaitingFunds;
    #funded;
    /// Awarded; payouts in progress or waiting to be retried.
    #releasing;
    #released;
    /// Cancelled after funding; the refund is in progress or waiting.
    #refunding;
    #refunded;
    /// Cancelled before any money arrived.
    #closedUnfunded;
  };

  public type Escrow = {
    bountyId : Nat;
    ledger : Principal;
    funder : Principal;
    /// This canister's subaccount holding this bounty's deposit, and nothing else.
    subaccount : Blob;
    reward : Nat;
    platformFee : Nat;
    platform : ?Account;
    /// The ledger fee the current terms were computed with.
    fee : Nat;
    deposit : Nat;
    state : State;
    /// Every ledger operation, in order, including failed ones: the audit log.
    ops : [Op];
  };

  public let maxFeeBps : Nat = 2_000;

  public func platformFee(reward : Nat, feeBps : Nat) : Nat { reward * feeBps / 10_000 };

  public func deposit(reward : Nat, platformFeeAmount : Nat, fee : Nat) : Nat {
    if (platformFeeAmount == 0) reward + fee else reward + fee + platformFeeAmount + fee
  };

  /// What the owner must approve: the deposit, plus the fee the pull costs.
  public func approval(escrow : Escrow) : Nat { escrow.deposit + escrow.fee };

  /// 32 bytes: the bounty id, big-endian, zero-padded. One subaccount per
  /// bounty, so its balance is exactly that bounty's escrow and can be
  /// reconciled against the books.
  public func subaccount(bountyId : Nat) : Blob {
    let (b7, b6, b5, b4, b3, b2, b1, b0) = Nat64.explode(Nat.toNat64(bountyId));
    let bytes : [Nat8] = [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, b7, b6, b5, b4, b3, b2, b1, b0,
    ];
    Array.toBlob(bytes)
  };

  /// A readable memo: `bounty:<id>:<kind>`, within the ICRC-1 default limit of
  /// 32 bytes for every bounty id below 10^16.
  public func memo(bountyId : Nat, kind : OpKind) : Blob {
    let name = switch (kind) {
      case (#fund) "fund";
      case (#payWinner) "winner";
      case (#payPlatform) "platform";
      case (#refund) "refund";
    };
    Text.encodeUtf8("bounty:" # Nat.toText(bountyId) # ":" # name)
  };

  public type Split = { winner : Nat; platform : Nat; dust : Nat };

  /// How a funded `balance` is released at the current `fee`. The winner is
  /// paid first and in full whenever the balance can cover it; the platform
  /// gets what is left after both fees, and nothing if that is not more than
  /// a fee — a transfer that would move less than it costs is not made.
  public func release(balance : Nat, reward : Nat, fee : Nat) : Split {
    if (balance <= fee) return { winner = 0; platform = 0; dust = balance };
    let winner = Nat.min(reward, balance - fee);
    let left = Nat.sub(balance, fee + winner);
    if (left <= fee) return { winner; platform = 0; dust = left };
    { winner; platform = left - fee; dust = 0 }
  };

  /// Everything back to the funder, less the fee of the refund itself.
  public func refund(balance : Nat, fee : Nat) : Nat {
    if (balance <= fee) 0 else balance - fee
  };

  func outgoing(op : Op) : Bool {
    switch (op.kind) { case (#fund) false; case _ true }
  };

  /// What the escrow subaccount should hold according to the books: the
  /// deposit once funded, less every executed outgoing transfer and its fee.
  public func expectedBalance(escrow : Escrow) : Nat {
    var balance = 0;
    for (op in escrow.ops.values()) {
      switch (op.status) {
        case (#done(_)) {
          if (outgoing(op)) {
            balance := Nat.sub(balance, op.amount + op.fee)
          } else {
            balance += op.amount
          }
        };
        case _ {};
      }
    };
    balance
  };

  public func pendingIndex(escrow : Escrow) : ?Nat {
    var index = 0;
    for (op in escrow.ops.values()) {
      if (op.status == #pending) return ?index;
      index += 1
    };
    null
  };

  public func doneCount(escrow : Escrow, kind : OpKind) : Nat {
    var count = 0;
    for (op in escrow.ops.values()) {
      if (op.kind == kind) switch (op.status) { case (#done(_)) count += 1; case _ {} }
    };
    count
  };
};
