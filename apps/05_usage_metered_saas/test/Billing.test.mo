// Invoice arithmetic, payment matching and the JSON export, in the interpreter.
//
// Amounts are the part of billing that must be reproducible by anyone, so the
// rules are pinned here as plain numbers. The replica suite covers what needs
// a clock and a ledger: periods closing, plan changes, late receipts, payments.

import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Billing "../backend/src/Billing";

let second = 1_000_000_000;
let day = 86_400 * second;
let plan : Billing.Plan = { name = "daily"; quota = 100; periodSeconds = 86_400; priceMinorUnits = 3_000; currency = "TKN" };

// -- the subscription fee ---------------------------------------------------

assert Billing.subscription(plan, 0, day) == 3_000;
assert Billing.periods(plan, 0, day) == 1;
// Pro rata, rounded down: a tenant is never billed for time it did not have.
assert Billing.subscription(plan, 0, day / 4) == 750;
assert Billing.subscription(plan, 0, day / 3) == 1_000;
assert Billing.subscription(plan, 0, 1) == 0;
// A quiet stretch of several periods is billed, not lost to the gap.
assert Billing.subscription(plan, 0, 3 * day) == 9_000;
assert Billing.periods(plan, 0, 3 * day + day / 2) == 3;
assert Billing.subscription(plan, 0, 3 * day + day / 2) == 10_500;
assert Billing.subscription(plan, 5, 5) == 0;
assert Billing.subscription(plan, 10, 5) == 0;

// -- lines ------------------------------------------------------------------

assert Billing.tally([("api", 10), ("storage", 5), ("api", 3)]) == [("api", 13), ("storage", 5)];
assert Billing.tally([]) == [];
let (lines, total) = Billing.lines(plan, 0, day, [("api", 13), ("storage", 5)]);
assert total == 3_000;
assert lines.size() == 3;
assert lines[0] == { kind = #subscription; quantity = 1; amount = 3_000 };
// Usage is included in the plan: a hard quota means it cannot exceed what was paid for.
assert lines[1] == { kind = #usage("api"); quantity = 13; amount = 0 };

// -- balance and status -----------------------------------------------------

let tenant = Principal.fromText("aaaaa-aa");
let payment = func(amount : Nat) : Billing.Payment {
  {
    invoice = 1;
    ledger = tenant;
    block = 0;
    symbol = "TKN";
    decimals = 8;
    from = { owner = tenant; subaccount = null };
    amount;
    paidAt = 0;
    appliedAt = 0;
  }
};
let credit = func(amount : Nat) : Billing.Adjustment {
  { id = 1; invoice = 1; kind = #credit; amount; reason = "r"; reference = "c"; by = tenant; at = 0 }
};
assert Billing.status(3_000, [], []) == #unpaid;
assert Billing.status(3_000, [payment(1_000)], []) == #partiallyPaid;
assert Billing.balance(3_000, [payment(1_000)], []) == 2_000;
assert Billing.status(3_000, [payment(1_000), payment(2_000)], []) == #paid;
assert Billing.status(3_000, [payment(3_000)], [credit(500)]) == #creditBalance;
assert Billing.balance(3_000, [payment(3_000)], [credit(500)]) == -500;
// A credit can settle an invoice without a payment.
assert Billing.status(3_000, [], [credit(3_000)]) == #paid;
assert Billing.balance(3_000, [], [{ credit(100) with kind = #debit }]) == 3_100;

// -- the payment memo -------------------------------------------------------

let canister = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let memo = Billing.paymentMemo(canister, 1);
assert memo.size() == 32;
assert memo != Billing.paymentMemo(canister, 2);
// The canister is inside the memo, so invoice 1 here is not invoice 1 elsewhere.
assert memo != Billing.paymentMemo(Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai"), 1);

// -- matching a transfer to an invoice --------------------------------------

let payee = { owner = canister; subaccount = null };
let invoice : Billing.Invoice = {
  id = 1;
  tenant;
  sequence = 1;
  plan;
  currency = "TKN";
  periodStart = 0;
  billedUntil = day;
  closedAt = day + 1_000 * second;
  reason = #periodEnd;
  eventIds = [];
  lateEvents = 0;
  lines;
  total;
  paymentMemo = memo;
};
let transfer = {
  from = { owner = tenant; subaccount = null };
  to = payee;
  amount = 3_000;
  fee = ?10_000;
  memo = ?memo;
  timestamp = invoice.closedAt;
  createdAtTime = null;
};
assert Billing.checkPayment(transfer, payee, invoice) == null;
// ICRC-1: an absent subaccount and the all-zero one are the same account.
assert Billing.checkPayment({ transfer with to = { owner = canister; subaccount = ?"\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00" } }, payee, invoice) == null;
assert Billing.checkPayment({ transfer with to = { owner = tenant; subaccount = null } }, payee, invoice) != null;
assert Billing.checkPayment({ transfer with memo = null }, payee, invoice) != null;
assert Billing.checkPayment({ transfer with memo = ?Billing.paymentMemo(canister, 2) }, payee, invoice) != null;
assert Billing.checkPayment({ transfer with amount = 0 }, payee, invoice) != null;
// Made before the invoice existed: not for it, whatever the memo says. Within
// the skew allowance is fine.
assert Billing.checkPayment({ transfer with timestamp = invoice.closedAt - Billing.clockSkewNanos }, payee, invoice) == null;
assert Billing.checkPayment({ transfer with timestamp = invoice.closedAt - Billing.clockSkewNanos - 1 }, payee, invoice) != null;

// -- JSON -------------------------------------------------------------------

assert Billing.string("plain") == "\"plain\"";
assert Billing.string("a \"b\" \\ c\n") == "\"a \\\"b\\\" \\\\ c\\n\"";
assert Billing.string("\u{01}") == "\"\\u0001\"";
assert Billing.isoTime(0) == "1970-01-01T00:00:00Z";
assert Billing.isoTime(951_782_400 * second) == "2000-02-29T00:00:00Z";
assert Billing.isoTime(1_790_000_000 * second + 999) == "2026-09-21T14:13:20Z";
assert Billing.hex("\00\ff\10") == "00ff10";

let document = Billing.json(invoice, "Acme", ?8, [payment(3_000)], [credit(500)]);
assert Text.startsWith(document, #text "{\"format\":\"icp-usage-invoice:v1\",\"invoice\":1,");
assert Text.contains(document, #text "\"balanceMinorUnits\":-500");
assert Text.contains(document, #text "\"status\":\"credit balance\"");
assert Text.contains(document, #text "\"decimals\":8");
