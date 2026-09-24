// A local ICRC-1 / ICRC-3 ledger for the replica suite. Never deployed.
//
// A copy of `apps/03_license_marketplace/test/fixtures/MockLedger.mo` (#12),
// with one addition: `setSymbol`, so the billing suite can stand up ledgers
// for two currencies. Apps in this kit do not import each other's sources.
//
// It implements what the marketplace's payment adapter calls — the ICRC-1
// metadata queries and ICRC-3 `icrc3_get_blocks`, including archived ranges
// served through a callback — and what a buyer calls to pay: `icrc1_transfer`,
// with balances and the fee charged on top. Blocks are emitted in the ICRC-3
// generic `Value` form a production ledger uses, so the adapter reads them
// exactly as it would read the ICP ledger's or ckBTC's.
//
// Three test controls, none of which a real ledger has:
//   * `mint`         funds an account (a `1mint` block, which is not a payment);
//   * `appendBlock`  appends an arbitrary block, for shapes a transfer never
//                    produces — an approval, a transfer-from, a burn;
//   * `setAvailable` makes `icrc3_get_blocks` trap, which is what a ledger that
//                    rejects, is stopped, or times out looks like to a caller;
//   * `archiveBelow` moves blocks below an index behind the archive callback.
import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Icrc3 "../../backend/src/Icrc3";

persistent actor MockLedger {
  public type Value = Icrc3.Value;
  public type Account = Icrc3.Account;
  public type GetBlocksArgs = Icrc3.GetBlocksArgs;
  public type GetBlocksResult = Icrc3.GetBlocksResult;

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
    #InsufficientFunds : { balance : Nat };
    #GenericError : { error_code : Nat; message : Text };
  };

  let fee : Nat = 10_000;
  var symbol : Text = "TKN";
  let blocks = List.empty<Value>();
  let balances = Map.empty<Text, Nat>();
  var available = true;
  var archivedBelow : Nat = 0;

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

  func now() : Nat { Int.abs(Time.now()) };

  func append(block : Value) : Nat {
    List.add(blocks, block);
    List.size(blocks) - 1
  };

  public query func icrc1_symbol() : async Text { symbol };
  public func setSymbol(value : Text) : async () { symbol := value };
  public query func icrc1_decimals() : async Nat8 { 8 };
  public query func icrc1_fee() : async Nat { fee };
  public query func icrc1_balance_of(account : Account) : async Nat { balanceOf(account) };

  public func mint(to : Account, amount : Nat) : async Nat {
    Map.add(balances, Text.compare, key(to), balanceOf(to) + amount);
    append(#Map([
      ("btype", #Text("1mint")),
      ("ts", #Nat(now())),
      ("tx", #Map([("to", Icrc3.encodeAccount(to)), ("amt", #Nat(amount))])),
    ]))
  };

  public shared ({ caller }) func icrc1_transfer(arg : TransferArg) : async { #Ok : Nat; #Err : TransferError } {
    switch (arg.fee) {
      case (?offered) { if (offered != fee) return #Err(#BadFee({ expected_fee = fee })) };
      case null {};
    };
    let from : Account = { owner = caller; subaccount = arg.from_subaccount };
    let balance = balanceOf(from);
    let debit = arg.amount + fee;
    if (balance < debit) return #Err(#InsufficientFunds({ balance }));
    Map.add(balances, Text.compare, key(from), Nat.sub(balance, debit));
    Map.add(balances, Text.compare, key(arg.to), balanceOf(arg.to) + arg.amount);

    var tx : [(Text, Value)] = [
      ("from", Icrc3.encodeAccount(from)),
      ("to", Icrc3.encodeAccount(arg.to)),
      ("amt", #Nat(arg.amount)),
    ];
    switch (arg.memo) { case (?memo) tx := Array.concat(tx, [("memo", #Blob(memo))]); case null {} };
    switch (arg.created_at_time) {
      case (?at) tx := Array.concat(tx, [("ts", #Nat(Nat64.toNat(at)))]);
      case null {};
    };
    // ICRC-3: the fee goes in the transaction when the sender named it, and at
    // the block level otherwise. The adapter has to read both.
    let block = switch (arg.fee) {
      case (?named) #Map([("btype", #Text("1xfer")), ("ts", #Nat(now())), ("tx", #Map(Array.concat(tx, [("fee", #Nat(named))])))]);
      case null #Map([("btype", #Text("1xfer")), ("ts", #Nat(now())), ("fee", #Nat(fee)), ("tx", #Map(tx))]);
    };
    #Ok(append(block))
  };

  public func appendBlock(block : Value) : async Nat { append(block) };

  public func setAvailable(value : Bool) : async () { available := value };

  public func archiveBelow(index : Nat) : async () { archivedBelow := index };

  func slice(start : Nat, length : Nat, from : Nat, to : Nat) : [Icrc3.BlockWithId] {
    let lo = Nat.max(start, from);
    let hi = Nat.min(start + length, to);
    if (lo >= hi) return [];
    Array.tabulate<Icrc3.BlockWithId>(Nat.sub(hi, lo), func(i) = { id = lo + i; block = List.at(blocks, lo + i) })
  };

  public query func icrc3_get_blocks(args : GetBlocksArgs) : async GetBlocksResult {
    if (not available) Runtime.trap("mock ledger is unavailable");
    let size = List.size(blocks);
    var live : [Icrc3.BlockWithId] = [];
    var archived : GetBlocksArgs = [];
    for (range in args.values()) {
      live := Array.concat(live, slice(range.start, range.length, archivedBelow, size));
      let hi = Nat.min(range.start + range.length, archivedBelow);
      if (range.start < hi) archived := Array.concat(archived, [{ start = range.start; length = Nat.sub(hi, range.start) }]);
    };
    {
      log_length = size;
      blocks = live;
      archived_blocks = if (archived.size() == 0) [] else [{ args = archived; callback = icrc3_get_archived }];
    }
  };

  /// The archive: serves exactly the ranges `icrc3_get_blocks` sent here.
  public query func icrc3_get_archived(args : GetBlocksArgs) : async GetBlocksResult {
    if (not available) Runtime.trap("mock ledger archive is unavailable");
    var found : [Icrc3.BlockWithId] = [];
    for (range in args.values()) {
      found := Array.concat(found, slice(range.start, range.length, 0, archivedBelow));
    };
    { log_length = List.size(blocks); blocks = found; archived_blocks = [] }
  };
};
