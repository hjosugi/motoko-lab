/// ICRC-1 accounts and ICRC-3 blocks: the ledger-agnostic half of payment
/// verification.
///
/// A copy of `apps/03_license_marketplace/backend/src/Icrc3.mo` (#12), kept
/// identical: each application in this kit is an independent project, and a
/// cross-application import would make one depend on another's source tree.
/// A change to one copy is a change to both.
///
/// Every ICRC ledger — the ICP ledger, ckBTC, ckETH, SNS ledgers, anything
/// built from the ICRC-1 reference — exposes its history through ICRC-3
/// `icrc3_get_blocks`, as generically typed `Value` trees. Reading a transfer
/// out of that representation, rather than out of a ledger-specific typed API,
/// is what makes the adapter work with any of them. This module does only that
/// reading, and it is pure, so `test/Payment.test.mo` covers every shape in the
/// interpreter.
///
/// The block schema implemented is ICRC-3's for ICRC-1 transfers:
///
///     block = Map { "btype"? : Text, "ts" : Nat, "fee"? : Nat, "phash"? : Blob, "tx" : Map }
///     tx    = Map { "op"? : Text, "from" : Account, "to" : Account, "amt" : Nat,
///                   "fee"? : Nat, "memo"? : Blob, "ts"? : Nat }
///     Account = Array [ Blob owner ] | Array [ Blob owner, Blob subaccount ]
///
/// A transfer is `btype = "1xfer"`, or, for ledgers that predate `btype`,
/// `tx.op = "xfer"`. The effective fee is `tx.fee` when the sender named one
/// and the block-level `fee` otherwise. Everything else — mints, burns,
/// approvals, `2xfer` transfer-froms, unknown types — is reported as what it is
/// and is never a payment: #12 verifies ICRC-1 transfers, and ICRC-2
/// transfer-from belongs to the escrow flow.
import Array "mo:core/Array";
import Principal "mo:core/Principal";

module {
  public type Value = {
    #Blob : Blob;
    #Text : Text;
    #Nat : Nat;
    #Int : Int;
    #Array : [Value];
    #Map : [(Text, Value)];
  };

  public type Account = { owner : Principal; subaccount : ?Blob };

  public type GetBlocksArgs = [{ start : Nat; length : Nat }];

  public type BlockWithId = { id : Nat; block : Value };

  public type ArchivedBlocks = {
    args : GetBlocksArgs;
    callback : shared query GetBlocksArgs -> async GetBlocksResult;
  };

  public type GetBlocksResult = {
    log_length : Nat;
    blocks : [BlockWithId];
    archived_blocks : [ArchivedBlocks];
  };

  /// The part of a ledger the adapter calls. ICRC-1 for the token metadata
  /// that makes amounts explicit, ICRC-3 for history. No ledger-specific
  /// method appears here; a ledger that implements these standards works.
  public type Ledger = actor {
    icrc1_symbol : shared query () -> async Text;
    icrc1_decimals : shared query () -> async Nat8;
    icrc1_fee : shared query () -> async Nat;
    icrc3_get_blocks : shared query GetBlocksArgs -> async GetBlocksResult;
  };

  /// An ICRC-1 transfer as recorded by the ledger.
  public type Transfer = {
    from : Account;
    to : Account;
    amount : Nat;
    /// The effective fee the sender paid, if the block states one.
    fee : ?Nat;
    memo : ?Blob;
    /// The ledger's timestamp for the block, nanoseconds since the epoch.
    timestamp : Nat;
    /// `created_at_time` as the sender set it, if they did.
    createdAtTime : ?Nat;
  };

  public type Decoded = {
    #transfer : Transfer;
    /// A well-formed block that is not an ICRC-1 transfer: its type.
    #notTransfer : Text;
    #malformed : Text;
  };

  let defaultSubaccount : Blob = "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00";

  /// ICRC-1: an absent subaccount *is* the all-zero subaccount. Comparing the
  /// raw optionals would treat `[owner]` and `[owner, 0x00 * 32]` as different
  /// accounts, and a payment to one would fail against the other.
  public func sameAccount(a : Account, b : Account) : Bool {
    Principal.equal(a.owner, b.owner) and normal(a.subaccount) == normal(b.subaccount)
  };

  func normal(subaccount : ?Blob) : Blob {
    switch (subaccount) {
      case (?value) value;
      case null defaultSubaccount;
    }
  };

  public func field(entries : [(Text, Value)], name : Text) : ?Value {
    switch (Array.find<(Text, Value)>(entries, func((key, _)) = key == name)) {
      case (?(_, value)) ?value;
      case null null;
    }
  };

  func natField(entries : [(Text, Value)], name : Text) : { #absent; #value : Nat; #wrongType } {
    switch (field(entries, name)) {
      case null #absent;
      case (?#Nat(n)) #value(n);
      case (?_) #wrongType;
    }
  };

  public func decodeAccount(value : Value) : ?Account {
    let #Array(parts) = value else return null;
    let principalOf = func(bytes : Blob) : ?Principal {
      // `Principal.fromBlob` traps above 29 bytes, and a trap in the middle of
      // verification would tell the buyer nothing.
      if (bytes.size() > 29) null else ?Principal.fromBlob(bytes)
    };
    switch (parts.size()) {
      case 1 {
        let #Blob(owner) = parts[0] else return null;
        let ?principal = principalOf(owner) else return null;
        ?{ owner = principal; subaccount = null }
      };
      case 2 {
        let #Blob(owner) = parts[0] else return null;
        let #Blob(subaccount) = parts[1] else return null;
        if (subaccount.size() != 32) return null;
        let ?principal = principalOf(owner) else return null;
        ?{ owner = principal; subaccount = ?subaccount }
      };
      case _ null;
    }
  };

  public func encodeAccount(account : Account) : Value {
    switch (account.subaccount) {
      case null #Array([#Blob(Principal.toBlob(account.owner))]);
      case (?subaccount) #Array([#Blob(Principal.toBlob(account.owner)), #Blob(subaccount)]);
    }
  };

  /// Reads an ICRC-1 transfer out of a generic ICRC-3 block.
  public func decode(block : Value) : Decoded {
    let #Map(entries) = block else return #malformed("block is not a map");
    let ?#Map(tx) = field(entries, "tx") else return #malformed("block has no tx map");

    let kind = switch (field(entries, "btype"), field(tx, "op")) {
      case (?#Text(btype), _) btype;
      case (null, ?#Text("xfer")) "1xfer";
      case (null, ?#Text(op)) op;
      case (?_, _) return #malformed("btype is not text");
      case (null, _) return #malformed("block has neither btype nor tx.op");
    };
    if (kind != "1xfer") return #notTransfer(kind);

    let ?fromValue = field(tx, "from") else return #malformed("transfer has no from");
    let ?from = decodeAccount(fromValue) else return #malformed("from is not an account");
    let ?toValue = field(tx, "to") else return #malformed("transfer has no to");
    let ?to = decodeAccount(toValue) else return #malformed("to is not an account");
    let amount = switch (natField(tx, "amt")) {
      case (#value(n)) n;
      case _ return #malformed("transfer has no amt");
    };
    let timestamp = switch (natField(entries, "ts")) {
      case (#value(n)) n;
      case _ return #malformed("block has no ts");
    };
    let fee = switch (natField(tx, "fee"), natField(entries, "fee")) {
      case (#value(n), _) ?n;
      case (#absent, #value(n)) ?n;
      case (#absent, #absent) null;
      case _ return #malformed("fee is not a nat");
    };
    let memo = switch (field(tx, "memo")) {
      case null null;
      case (?#Blob(bytes)) ?bytes;
      case (?_) return #malformed("memo is not a blob");
    };
    let createdAtTime = switch (natField(tx, "ts")) {
      case (#value(n)) ?n;
      case (#absent) null;
      case (#wrongType) return #malformed("tx.ts is not a nat");
    };
    #transfer({ from; to; amount; fee; memo; timestamp; createdAtTime })
  };
};
