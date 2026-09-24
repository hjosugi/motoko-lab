/// The ledger adapter: every call the bounty board makes to an ICRC ledger,
/// and the one place that decides what a ledger answer *means*.
///
/// The board moves money with ICRC-2 `icrc2_transfer_from` (funding: the owner
/// approves, the board pulls) and ICRC-1 `icrc1_transfer` (payouts and
/// refunds, out of the bounty's escrow subaccount). Every answer is reduced to
/// four outcomes, because those are the only four things the escrow state
/// machine has to distinguish:
///
/// * `#executed(block)` — the transfer happened. `Ok`, and also `Duplicate`:
///   the ledger saw these exact arguments before and returns the block they
///   produced. That is how a retry after a lost answer finds out it succeeded.
/// * `#refused(reason)` — definitively not executed: the ledger evaluated the
///   request and said no. Only after this may the arguments change.
/// * `#badFee(expected)` — refused because the fee changed; the escrow redoes
///   its arithmetic with the new fee.
/// * `#unknown(reason)` — the call itself failed: rejected, trapped, timed out.
///   The transfer may or may not have happened. The only safe next step is the
///   *identical* call again — same amount, fee, memo and `created_at_time` —
///   which the ledger's deduplication turns into `Duplicate` if it did happen.
/// * `#stale` — `TooOld`: the identical retry came after the ledger's
///   deduplication window closed, so the ledger can no longer say whether the
///   first attempt happened. The escrow settles that from the escrow
///   subaccount's balance instead, which only its own transfers move.
///
/// Types follow the ICRC-1 and ICRC-2 standards, so any conforming ledger
/// (ICP, ckBTC, ckETH, SNS ledgers) answers them.
import Error "mo:core/Error";

module {
  public type Account = { owner : Principal; subaccount : ?Blob };

  public type TransferArg = {
    from_subaccount : ?Blob;
    to : Account;
    amount : Nat;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
  };

  public type TransferError = {
    #BadFee : { expected_fee : Nat };
    #BadBurn : { min_burn_amount : Nat };
    #InsufficientFunds : { balance : Nat };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #Duplicate : { duplicate_of : Nat };
    #TemporarilyUnavailable;
    #GenericError : { error_code : Nat; message : Text };
  };

  public type TransferFromArgs = {
    spender_subaccount : ?Blob;
    from : Account;
    to : Account;
    amount : Nat;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
  };

  public type TransferFromError = {
    #BadFee : { expected_fee : Nat };
    #BadBurn : { min_burn_amount : Nat };
    #InsufficientFunds : { balance : Nat };
    #InsufficientAllowance : { allowance : Nat };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #Duplicate : { duplicate_of : Nat };
    #TemporarilyUnavailable;
    #GenericError : { error_code : Nat; message : Text };
  };

  public type Ledger = actor {
    icrc1_symbol : shared query () -> async Text;
    icrc1_decimals : shared query () -> async Nat8;
    icrc1_fee : shared query () -> async Nat;
    icrc1_balance_of : shared query Account -> async Nat;
    icrc1_transfer : shared TransferArg -> async { #Ok : Nat; #Err : TransferError };
    icrc2_transfer_from : shared TransferFromArgs -> async { #Ok : Nat; #Err : TransferFromError };
  };

  public type Outcome = {
    #executed : Nat;
    #refused : Text;
    #badFee : Nat;
    #unknown : Text;
    #stale;
  };

  /// One outgoing transfer, fully determined before the first attempt so that
  /// every retry sends exactly the same bytes.
  public type Transfer = {
    fromSubaccount : ?Blob;
    to : Account;
    amount : Nat;
    fee : Nat;
    memo : Blob;
    createdAtTime : Nat64;
  };

  public type Pull = {
    from : Account;
    toSubaccount : Blob;
    amount : Nat;
    fee : Nat;
    memo : Blob;
    createdAtTime : Nat64;
  };

  public func transfer(ledger : Ledger, t : Transfer) : async* Outcome {
    let result = try {
      await ledger.icrc1_transfer({
        from_subaccount = t.fromSubaccount;
        to = t.to;
        amount = t.amount;
        fee = ?t.fee;
        memo = ?t.memo;
        created_at_time = ?t.createdAtTime;
      })
    } catch (error) {
      return #unknown("the ledger did not answer: " # Error.message(error))
    };
    switch (result) {
      case (#Ok(block)) #executed(block);
      case (#Err(#Duplicate({ duplicate_of }))) #executed(duplicate_of);
      case (#Err(#BadFee({ expected_fee }))) #badFee(expected_fee);
      case (#Err(#InsufficientFunds({ balance }))) #refused("insufficient funds: balance " # debug_show (balance));
      case (#Err(#TooOld)) #stale;
      case (#Err(#CreatedInFuture(_))) #refused("created_at_time is ahead of the ledger clock");
      case (#Err(#TemporarilyUnavailable)) #unknown("the ledger is temporarily unavailable");
      case (#Err(#BadBurn(_))) #refused("bad burn");
      case (#Err(#GenericError({ message }))) #refused(message);
    }
  };

  /// `icrc2_transfer_from` with this canister as the spender, pulling the
  /// approved deposit into the bounty's escrow subaccount.
  public func pull(ledger : Ledger, self : Principal, p : Pull) : async* Outcome {
    let result = try {
      await ledger.icrc2_transfer_from({
        spender_subaccount = null;
        from = p.from;
        to = { owner = self; subaccount = ?p.toSubaccount };
        amount = p.amount;
        fee = ?p.fee;
        memo = ?p.memo;
        created_at_time = ?p.createdAtTime;
      })
    } catch (error) {
      return #unknown("the ledger did not answer: " # Error.message(error))
    };
    switch (result) {
      case (#Ok(block)) #executed(block);
      case (#Err(#Duplicate({ duplicate_of }))) #executed(duplicate_of);
      case (#Err(#BadFee({ expected_fee }))) #badFee(expected_fee);
      case (#Err(#InsufficientAllowance({ allowance }))) {
        #refused("insufficient allowance: approved " # debug_show (allowance) # ", or the approval has expired")
      };
      case (#Err(#InsufficientFunds({ balance }))) #refused("insufficient funds: balance " # debug_show (balance));
      case (#Err(#TooOld)) #stale;
      case (#Err(#CreatedInFuture(_))) #refused("created_at_time is ahead of the ledger clock");
      case (#Err(#TemporarilyUnavailable)) #unknown("the ledger is temporarily unavailable");
      case (#Err(#BadBurn(_))) #refused("bad burn");
      case (#Err(#GenericError({ message }))) #refused(message);
    }
  };
};
