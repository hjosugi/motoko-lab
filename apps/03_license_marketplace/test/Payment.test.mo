// ICRC-3 block decoding and the payment rules, in the interpreter.
//
// The replica suite pays through a mock ledger and so only ever sees blocks
// that ledger writes. Every other shape a real ledger can produce — the legacy
// `tx.op` form, fees at either level, accounts with and without a subaccount,
// mints, approvals, transfer-froms, malformed data — is exercised here, where
// constructing one is a literal.
import Principal "mo:core/Principal";
import Icrc3 "../backend/src/Icrc3";
import Payment "../backend/src/Payment";

let seller = Principal.fromText("aaaaa-aa");
let buyer = Principal.fromText("2vxsx-fae");
let stranger = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let marketplace = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let zeros : Blob = "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00";
let ones : Blob = "\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01\01";

let memo = Payment.intentMemo(marketplace, 7);
let T0 = 1_000_000_000_000;

func account(owner : Principal) : Icrc3.Value { #Array([#Blob(Principal.toBlob(owner))]) };

func transferBlock(from : Principal, to : Icrc3.Value, amount : Nat, memoValue : ?Blob, ts : Nat) : Icrc3.Value {
  let tx = switch (memoValue) {
    case (?m) [("from", account(from)), ("to", to), ("amt", #Nat(amount)), ("memo", #Blob(m))];
    case null [("from", account(from)), ("to", to), ("amt", #Nat(amount))];
  };
  #Map([("btype", #Text("1xfer")), ("ts", #Nat(ts)), ("fee", #Nat(10_000)), ("tx", #Map(tx))])
};

func transferOf(block : Icrc3.Value) : Icrc3.Transfer {
  switch (Icrc3.decode(block)) {
    case (#transfer(t)) t;
    case _ { assert false; loop {} };
  }
};

let expected : Payment.Expectation = {
  payer = buyer;
  payee = { owner = seller; subaccount = null };
  amount = 1_000_000;
  memo;
  notBefore = T0;
  notAfter = T0 + Payment.intentLifetimeNanos;
};

func verdict(block : Icrc3.Value) : Payment.Verdict { Payment.check(transferOf(block), expected) };
func accepted(v : Payment.Verdict) : Bool { switch v { case (#accepted(_)) true; case _ false } };

// -- the memo --------------------------------------------------------------------
assert memo.size() == 32;
assert Payment.intentMemo(marketplace, 7) == memo;
assert Payment.intentMemo(marketplace, 8) != memo;
// Binding the canister is what stops one payment claiming "intent 7" on every
// marketplace that pays the same seller.
assert Payment.intentMemo(stranger, 7) != memo;

// -- decoding ----------------------------------------------------------------------
let good = transferBlock(buyer, account(seller), 1_000_000, ?memo, T0 + 1);
let decoded = transferOf(good);
assert decoded.amount == 1_000_000 and decoded.fee == ?10_000 and decoded.timestamp == T0 + 1;
assert decoded.memo == ?memo and decoded.createdAtTime == null;

// The fee is read from the transaction when the sender named one, which then
// takes precedence over the block level.
switch (Icrc3.decode(#Map([
  ("btype", #Text("1xfer")), ("ts", #Nat(T0)), ("fee", #Nat(1)),
  ("tx", #Map([("from", account(buyer)), ("to", account(seller)), ("amt", #Nat(5)), ("fee", #Nat(2)), ("ts", #Nat(T0 - 1))])),
]))) {
  case (#transfer(t)) assert t.fee == ?2 and t.createdAtTime == ?(T0 - 1);
  case _ assert false;
};
// Ledgers that predate `btype` say `tx.op = "xfer"`.
switch (Icrc3.decode(#Map([
  ("ts", #Nat(T0)),
  ("tx", #Map([("op", #Text("xfer")), ("from", account(buyer)), ("to", account(seller)), ("amt", #Nat(5))])),
]))) {
  case (#transfer(t)) assert t.fee == null and t.amount == 5;
  case _ assert false;
};
// Everything else is reported as what it is, never as a payment.
for (kind in ["1mint", "1burn", "2approve", "2xfer", "unknown"].values()) {
  switch (Icrc3.decode(#Map([("btype", #Text(kind)), ("ts", #Nat(T0)), ("tx", #Map([]))]))) {
    case (#notTransfer(k)) assert k == kind;
    case _ assert false;
  }
};
switch (Icrc3.decode(#Map([("ts", #Nat(T0)), ("tx", #Map([("op", #Text("mint")), ("amt", #Nat(5))]))]))) {
  case (#notTransfer(k)) assert k == "mint";
  case _ assert false;
};
// Malformed data is refused, not trapped on.
func malformed(block : Icrc3.Value) : Bool { switch (Icrc3.decode(block)) { case (#malformed(_)) true; case _ false } };
assert malformed(#Nat(1));
assert malformed(#Map([("btype", #Text("1xfer")), ("ts", #Nat(T0))]));
assert malformed(#Map([("btype", #Nat(1)), ("ts", #Nat(T0)), ("tx", #Map([]))]));
assert malformed(transferBlock(buyer, #Array([]), 1, null, T0));
assert malformed(transferBlock(buyer, #Array([#Blob(Principal.toBlob(seller)), #Blob("\00")]), 1, null, T0));
// A 30-byte "principal": `Principal.fromBlob` would trap on it.
assert malformed(transferBlock(buyer, #Array([#Blob("\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00")]), 1, null, T0));
assert malformed(#Map([("btype", #Text("1xfer")), ("ts", #Nat(T0)),
  ("tx", #Map([("from", account(buyer)), ("to", account(seller)), ("amt", #Int(5))]))]));
assert malformed(#Map([("btype", #Text("1xfer")), ("ts", #Nat(T0)),
  ("tx", #Map([("from", account(buyer)), ("to", account(seller)), ("amt", #Nat(5)), ("memo", #Text("x"))]))]));

// -- accounts ------------------------------------------------------------------------
// ICRC-1: no subaccount and the all-zero subaccount are one account.
assert Icrc3.sameAccount({ owner = seller; subaccount = null }, { owner = seller; subaccount = ?zeros });
assert not Icrc3.sameAccount({ owner = seller; subaccount = null }, { owner = seller; subaccount = ?ones });
assert not Icrc3.sameAccount({ owner = seller; subaccount = null }, { owner = buyer; subaccount = null });

// -- the rules --------------------------------------------------------------------------
assert accepted(verdict(good));
// Paying into the seller's all-zero subaccount is paying the seller.
assert accepted(verdict(transferBlock(buyer, #Array([#Blob(Principal.toBlob(seller)), #Blob(zeros)]), 1_000_000, ?memo, T0)));
// Overpaying is accepted, and the amount actually paid is what gets recorded.
assert accepted(verdict(transferBlock(buyer, account(seller), 2_000_000, ?memo, T0)));
// Within the clock-skew allowance before the intent opened.
assert accepted(verdict(transferBlock(buyer, account(seller), 1_000_000, ?memo, T0 - Payment.clockSkewNanos)));

func rejected(block : Icrc3.Value, reason : Text) : Bool {
  switch (verdict(block)) { case (#rejected(r)) r == reason; case _ false }
};
assert rejected(transferBlock(buyer, account(stranger), 1_000_000, ?memo, T0), "the payment went to a different account");
assert rejected(transferBlock(buyer, #Array([#Blob(Principal.toBlob(seller)), #Blob(ones)]), 1_000_000, ?memo, T0),
  "the payment went to a different account");
assert rejected(transferBlock(stranger, account(seller), 1_000_000, ?memo, T0), "the payment was not made by the buyer");
// Underpayment by exactly the fee: a buyer who counted the fee as part of the
// price. The fee is the sender's cost on top; the seller receives `amt`.
assert rejected(transferBlock(buyer, account(seller), 1_000_000 - 10_000, ?memo, T0), "the payment is less than the price");
assert rejected(transferBlock(buyer, account(seller), 1_000_000, null, T0), "the payment carries no memo");
assert rejected(transferBlock(buyer, account(seller), 1_000_000, ?Payment.intentMemo(marketplace, 8), T0),
  "the payment memo does not match this intent");
assert rejected(transferBlock(buyer, account(seller), 1_000_000, ?memo, T0 - Payment.clockSkewNanos - 1),
  "the payment was made before the intent was opened");
assert rejected(transferBlock(buyer, account(seller), 1_000_000, ?memo, T0 + Payment.intentLifetimeNanos + 1),
  "the payment was made after the intent expired");
