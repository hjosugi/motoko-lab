// A local ICRC-1 / ICRC-2 ledger for the bounty board's replica suite. Never
// deployed.
//
// What the escrow depends on is implemented the way the ICRC reference ledger
// implements it, because the escrow's correctness rests on exactly these
// semantics:
//
//   * fees charged to the sender on top of the amount, for transfers,
//     transfer-froms and approvals;
//   * allowances with an optional expiry, which a transfer-from must cover
//     together with its fee — an expired allowance is no allowance;
//   * deduplication: a transaction carrying `created_at_time` that matches an
//     earlier one from the same caller within 24 hours is not executed again,
//     and `Duplicate { duplicate_of }` names the block the first one produced.
//     Checked before anything else, so an identical retry learns the outcome
//     even when a balance or allowance check would now fail; `TooOld` once the
//     window has closed.
//
// Test controls a real ledger does not have:
//   * `mint`           funds an account;
//   * `setFee`         changes the fee, as a ledger upgrade can;
//   * `setAvailable`   makes transfers trap without executing;
//   * `dropNextReply`  executes the next transfer or transfer-from and then
//                      rejects the call — "the transfer happened, the caller
//                      was told it failed". A Motoko `throw` commits the state
//                      changes before it, unlike a trap, which is what makes
//                      this expressible at all.
import Error "mo:core/Error";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Ledger "../../backend/src/Ledger";

persistent actor MockLedger {
  public type Account = Ledger.Account;
  public type TransferArg = Ledger.TransferArg;
  public type TransferError = Ledger.TransferError;
  public type TransferFromArgs = Ledger.TransferFromArgs;
  public type TransferFromError = Ledger.TransferFromError;

  public type ApproveArgs = {
    from_subaccount : ?Blob;
    spender : Account;
    amount : Nat;
    expected_allowance : ?Nat;
    expires_at : ?Nat64;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
  };

  public type ApproveError = {
    #BadFee : { expected_fee : Nat };
    #InsufficientFunds : { balance : Nat };
    #AllowanceChanged : { current_allowance : Nat };
    #Expired : { ledger_time : Nat64 };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #Duplicate : { duplicate_of : Nat };
    #TemporarilyUnavailable;
    #GenericError : { error_code : Nat; message : Text };
  };

  public type Allowance = { allowance : Nat; expires_at : ?Nat64 };

  let window : Nat = 86_400_000_000_000; // 24 hours
  let drift : Nat = 60_000_000_000; // one minute
  var fee : Nat = 10_000;
  var available = true;
  var dropReply = false;
  var blockCount : Nat = 0;
  let log = List.empty<Text>();
  let balances = Map.empty<Text, Nat>();
  let allowances = Map.empty<Text, Allowance>();
  let seen = Map.empty<Text, Nat>();

  func key(account : Account) : Text {
    let subaccount : Blob = switch (account.subaccount) {
      case (?bytes) bytes;
      case null "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00";
    };
    Principal.toText(account.owner) # "/" # debug_show (subaccount)
  };

  func balanceOf(account : Account) : Nat {
    switch (Map.get(balances, Text.compare, key(account))) { case (?n) n; case null 0 }
  };

  func setBalance(account : Account, amount : Nat) { Map.add(balances, Text.compare, key(account), amount) };

  func now() : Nat { Int.abs(Time.now()) };

  func record(entry : Text) : Nat {
    List.add(log, entry);
    blockCount += 1;
    blockCount - 1
  };

  /// `#fresh`, or the reason the transaction must not execute.
  func dedup(caller : Principal, createdAt : ?Nat64, fingerprint : Text) : { #fresh : ?Text; #duplicate : Nat; #tooOld; #future } {
    let ?at64 = createdAt else return #fresh(null);
    let at = Nat64.toNat(at64);
    if (at + window < now()) return #tooOld;
    if (at > now() + drift) return #future;
    let id = Principal.toText(caller) # "|" # fingerprint;
    switch (Map.get(seen, Text.compare, id)) {
      case (?block) #duplicate(block);
      case null #fresh(?id);
    }
  };

  func remember(id : ?Text, block : Nat) {
    switch (id) { case (?k) Map.add(seen, Text.compare, k, block); case null {} }
  };

  func finish(block : Nat) : async* Nat {
    if (dropReply) {
      dropReply := false;
      throw Error.reject("mock ledger: the transfer executed and this reply was dropped")
    };
    block
  };

  public query func icrc1_symbol() : async Text { "TKN" };
  public query func icrc1_decimals() : async Nat8 { 8 };
  public query func icrc1_fee() : async Nat { fee };
  public query func icrc1_balance_of(account : Account) : async Nat { balanceOf(account) };
  public query func icrc2_allowance(args : { account : Account; spender : Account }) : async Allowance {
    switch (Map.get(allowances, Text.compare, key(args.account) # "->" # key(args.spender))) {
      case (?a) a;
      case null { { allowance = 0; expires_at = null } };
    }
  };

  /// Everything ever minted, less every fee burned: what the balances must sum to.
  public query func totalSupply() : async Nat {
    var total = 0;
    for ((_, amount) in Map.entries(balances)) total += amount;
    total
  };

  public func mint(to : Account, amount : Nat) : async Nat {
    setBalance(to, balanceOf(to) + amount);
    record("mint")
  };
  public func setFee(value : Nat) : async () { fee := value };
  public func setAvailable(value : Bool) : async () { available := value };
  public func dropNextReply() : async () { dropReply := true };

  public shared ({ caller }) func icrc1_transfer(arg : TransferArg) : async { #Ok : Nat; #Err : TransferError } {
    if (not available) Runtime.trap("mock ledger is unavailable");
    let id = switch (dedup(caller, arg.created_at_time, debug_show (arg))) {
      case (#duplicate(block)) return #Err(#Duplicate({ duplicate_of = block }));
      case (#tooOld) return #Err(#TooOld);
      case (#future) return #Err(#CreatedInFuture({ ledger_time = Nat.toNat64(now()) }));
      case (#fresh(id)) id;
    };
    switch (arg.fee) { case (?f) { if (f != fee) return #Err(#BadFee({ expected_fee = fee })) }; case null {} };
    let from : Account = { owner = caller; subaccount = arg.from_subaccount };
    let balance = balanceOf(from);
    if (balance < arg.amount + fee) return #Err(#InsufficientFunds({ balance }));
    setBalance(from, Nat.sub(balance, arg.amount + fee));
    setBalance(arg.to, balanceOf(arg.to) + arg.amount);
    let block = record("1xfer");
    remember(id, block);
    #Ok(await* finish(block))
  };

  public shared ({ caller }) func icrc2_approve(arg : ApproveArgs) : async { #Ok : Nat; #Err : ApproveError } {
    let id = switch (dedup(caller, arg.created_at_time, debug_show (arg))) {
      case (#duplicate(block)) return #Err(#Duplicate({ duplicate_of = block }));
      case (#tooOld) return #Err(#TooOld);
      case (#future) return #Err(#CreatedInFuture({ ledger_time = Nat.toNat64(now()) }));
      case (#fresh(id)) id;
    };
    switch (arg.fee) { case (?f) { if (f != fee) return #Err(#BadFee({ expected_fee = fee })) }; case null {} };
    switch (arg.expires_at) {
      case (?at) { if (Nat64.toNat(at) <= now()) return #Err(#Expired({ ledger_time = Nat.toNat64(now()) })) };
      case null {};
    };
    let from : Account = { owner = caller; subaccount = arg.from_subaccount };
    let balance = balanceOf(from);
    if (balance < fee) return #Err(#InsufficientFunds({ balance }));
    setBalance(from, Nat.sub(balance, fee));
    Map.add(allowances, Text.compare, key(from) # "->" # key(arg.spender), { allowance = arg.amount; expires_at = arg.expires_at });
    let block = record("2approve");
    remember(id, block);
    #Ok(block)
  };

  public shared ({ caller }) func icrc2_transfer_from(arg : TransferFromArgs) : async { #Ok : Nat; #Err : TransferFromError } {
    if (not available) Runtime.trap("mock ledger is unavailable");
    let id = switch (dedup(caller, arg.created_at_time, debug_show (arg))) {
      case (#duplicate(block)) return #Err(#Duplicate({ duplicate_of = block }));
      case (#tooOld) return #Err(#TooOld);
      case (#future) return #Err(#CreatedInFuture({ ledger_time = Nat.toNat64(now()) }));
      case (#fresh(id)) id;
    };
    switch (arg.fee) { case (?f) { if (f != fee) return #Err(#BadFee({ expected_fee = fee })) }; case null {} };
    let spender : Account = { owner = caller; subaccount = arg.spender_subaccount };
    let allowanceKey = key(arg.from) # "->" # key(spender);
    let current = switch (Map.get(allowances, Text.compare, allowanceKey)) {
      case (?a) {
        switch (a.expires_at) {
          case (?at) { if (Nat64.toNat(at) <= now()) 0 else a.allowance };
          case null a.allowance;
        }
      };
      case null 0;
    };
    let needed = arg.amount + fee;
    if (current < needed) return #Err(#InsufficientAllowance({ allowance = current }));
    let balance = balanceOf(arg.from);
    if (balance < needed) return #Err(#InsufficientFunds({ balance }));
    setBalance(arg.from, Nat.sub(balance, needed));
    setBalance(arg.to, balanceOf(arg.to) + arg.amount);
    switch (Map.get(allowances, Text.compare, allowanceKey)) {
      case (?a) Map.add(allowances, Text.compare, allowanceKey, { a with allowance = Nat.sub(current, needed) });
      case null {};
    };
    let block = record("2xfer");
    remember(id, block);
    #Ok(await* finish(block))
  };

  public query func blocks() : async [Text] { List.toArray(log) };

};
