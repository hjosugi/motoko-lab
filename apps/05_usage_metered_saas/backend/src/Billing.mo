/// Billing periods, invoices, payments and adjustments.
///
/// The metering app had plans and a quota window and nothing that said what a
/// tenant owed. The period counter reset itself on the first event after the
/// boundary and the previous period's usage was simply gone. An invoice has to
/// be the opposite of that: a snapshot that is taken once, never changes, and
/// can be recomputed by anyone from the events and the plan it names.
///
/// The rules:
///
///   * **A period closes once.** It closes when it rolls over (lazily, on the
///     first usage after its end, exactly where the quota already reset), when
///     someone closes it after its end, or early when the plan changes. Closing
///     moves the tenant to its next period in the same step, so there is no
///     second close of the same period to race.
///   * **An invoice never changes.** Payments and adjustments are separate
///     records that point at it; the balance is computed from all three.
///     Nothing is deleted and nothing is edited — a correction is a new record.
///   * **Late usage is billed later, never retroactively.** Usage belongs to
///     the period in which it was *recorded*. A signed receipt observed before
///     its period began (an offline batch) is counted in the open period and
///     marked late there; the closed invoice it would have belonged to stays
///     exactly as it was issued.
///
/// `docs/BILLING.md` has the amount rules, the payment flow and the JSON export.
import Array "mo:core/Array";
import Char "mo:core/Char";
import Error "mo:core/Error";
import Int "mo:core/Int";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";
import Icrc3 "Icrc3";

module {
  public type Plan = {
    name : Text;
    quota : Nat;
    periodSeconds : Nat;
    priceMinorUnits : Nat;
    currency : Text;
  };

  public type CloseReason = {
    /// The period ran its full length.
    #periodEnd;
    /// The plan changed before the period ended; the old plan is billed pro
    /// rata for the time it was in force.
    #planChange;
  };

  public type LineKind = {
    #subscription;
    /// Units recorded in this category. Included in the plan: the plan is a
    /// flat fee with a hard quota, so usage cannot exceed what was paid for.
    #usage : Text;
  };

  public type Line = {
    kind : LineKind;
    quantity : Nat;
    amount : Nat;
  };

  public type Invoice = {
    id : Nat;
    tenant : Principal;
    /// 1 for the tenant's first invoice, and so on without gaps.
    sequence : Nat;
    /// The plan as it was during the period, not as it is now.
    plan : Plan;
    currency : Text;
    periodStart : Nat;
    /// The end of the billed window: a period boundary, or the moment of a
    /// plan change.
    billedUntil : Nat;
    closedAt : Nat;
    reason : CloseReason;
    /// Every usage event the invoice covers, in id order.
    eventIds : [Nat];
    /// Of those, how many were observed before the period began.
    lateEvents : Nat;
    lines : [Line];
    total : Nat;
    /// What an ICRC-1 transfer paying this invoice must carry as its memo.
    paymentMemo : Blob;
  };

  public type AdjustmentKind = { #credit; #debit };

  /// A credit note or a debit note. Appended, never edited: the history of
  /// what was owed is part of what an invoice is.
  public type Adjustment = {
    id : Nat;
    invoice : Nat;
    kind : AdjustmentKind;
    amount : Nat;
    reason : Text;
    /// The operator's own reference, unique per invoice, so a retried request
    /// cannot credit twice.
    reference : Text;
    by : Principal;
    at : Nat;
  };

  /// A ledger transfer applied to an invoice. Every field about the transfer
  /// is read from the ledger block, never from the caller.
  public type Payment = {
    invoice : Nat;
    ledger : Principal;
    block : Nat;
    symbol : Text;
    decimals : Nat8;
    from : Icrc3.Account;
    amount : Nat;
    /// The ledger's timestamp for the block.
    paidAt : Nat;
    appliedAt : Nat;
  };

  public type Status = { #unpaid; #partiallyPaid; #paid; #creditBalance };

  // ------------------------------------------------------------- amounts

  let nanosPerSecond : Nat = 1_000_000_000;

  /// Whole periods in `[start, billedUntil)`.
  public func periods(plan : Plan, start : Nat, billedUntil : Nat) : Nat {
    if (billedUntil <= start) return 0;
    Nat.sub(billedUntil, start) / (plan.periodSeconds * nanosPerSecond)
  };

  /// The subscription fee for `[start, billedUntil)`: the price for every whole
  /// period, and the remainder pro rata by the nanosecond, rounded down so a
  /// tenant is never billed for time it did not have the plan.
  ///
  /// A window can hold several periods: a tenant with no usage for three
  /// periods owes three fees, and they are billed together when the period
  /// next closes rather than lost to the gap.
  public func subscription(plan : Plan, start : Nat, billedUntil : Nat) : Nat {
    if (billedUntil <= start) return 0;
    let length = plan.periodSeconds * nanosPerSecond;
    let used = Nat.sub(billedUntil, start);
    plan.priceMinorUnits * (used / length) + plan.priceMinorUnits * (used % length) / length
  };

  /// The invoice lines for a period, from the plan and the recorded usage.
  /// Pure, and the only place an amount is computed, so recomputing an
  /// invoice means calling this with what the invoice names.
  public func lines(plan : Plan, start : Nat, billedUntil : Nat, usage : [(Text, Nat)]) : ([Line], Nat) {
    let fee = subscription(plan, start, billedUntil);
    let subscriptionLine : Line = { kind = #subscription; quantity = periods(plan, start, billedUntil); amount = fee };
    let usageLines = Array.map<(Text, Nat), Line>(
      usage,
      func((category, units) : (Text, Nat)) : Line { { kind = #usage(category); quantity = units; amount = 0 } }
    );
    (Array.concat([subscriptionLine], usageLines), fee)
  };

  /// Units per category, categories in first-seen order.
  public func tally(entries : [(Text, Nat)]) : [(Text, Nat)] {
    var out : [(Text, Nat)] = [];
    for ((category, units) in entries.values()) {
      switch (Array.findIndex<(Text, Nat)>(out, func((name, _)) = name == category)) {
        case (?index) {
          out := Array.tabulate<(Text, Nat)>(
            out.size(),
            func(i : Nat) : (Text, Nat) { if (i == index) (out[i].0, out[i].1 + units) else out[i] }
          )
        };
        case null out := Array.concat(out, [(category, units)]);
      }
    };
    out
  };

  public func balance(total : Nat, payments : [Payment], adjustments : [Adjustment]) : Int {
    var owed : Int = total;
    for (adjustment in adjustments.values()) {
      switch (adjustment.kind) {
        case (#credit) owed -= adjustment.amount;
        case (#debit) owed += adjustment.amount;
      }
    };
    for (payment in payments.values()) owed -= payment.amount;
    owed
  };

  public func status(total : Nat, payments : [Payment], adjustments : [Adjustment]) : Status {
    let owed = balance(total, payments, adjustments);
    if (owed < 0) return #creditBalance;
    if (owed == 0) return #paid;
    if (payments.size() == 0) #unpaid else #partiallyPaid
  };

  // --------------------------------------------------------------- memo

  public let memoDomain : Text = "icp-usage-invoice:v1";

  /// `SHA-256("icp-usage-invoice:v1" || 0x00 || canister principal bytes ||
  /// 0x00 || invoice id as 8 bytes BE)`. The canister is inside it for the
  /// reason #12 gives for the licence memo: deduplication by (ledger, block) is
  /// only as wide as one canister, and invoice ids are small predictable
  /// numbers on every deployment.
  public func paymentMemo(canister : Principal, invoiceId : Nat) : Blob {
    let digest = Sha256.new(#sha256);
    digest.writeBlob(Text.encodeUtf8(memoDomain));
    digest.writeBlob("\00");
    digest.writeBlob(Principal.toBlob(canister));
    digest.writeBlob("\00");
    let (b7, b6, b5, b4, b3, b2, b1, b0) = Nat64.explode(Nat.toNat64(invoiceId));
    digest.writeArray([b7, b6, b5, b4, b3, b2, b1, b0]);
    digest.sum()
  };

  // ------------------------------------------------------------ payments

  /// Ledger and our clock are both IC time but not the same reading.
  public let clockSkewNanos : Nat = 300_000_000_000; // five minutes

  /// `null` if `transfer` may be applied to `invoice`, otherwise why not.
  ///
  /// Anyone may pay an invoice — a finance department, a reseller — so the
  /// payer is recorded, not checked. What binds a transfer to one invoice is
  /// the memo, which names this canister and the invoice id; and a transfer
  /// made before the invoice existed was not made for it, whatever its memo.
  public func checkPayment(transfer : Icrc3.Transfer, payee : Icrc3.Account, invoice : Invoice) : ?Text {
    if (not Icrc3.sameAccount(transfer.to, payee)) return ?"the payment went to a different account";
    if (transfer.amount == 0) return ?"the payment is empty";
    switch (transfer.memo) {
      case (?memo) { if (memo != invoice.paymentMemo) return ?"the payment memo does not match this invoice" };
      case null return ?"the payment carries no memo";
    };
    if (transfer.timestamp + clockSkewNanos < invoice.closedAt) {
      return ?"the payment was made before the invoice was issued"
    };
    null
  };

  public type Fetched = {
    #block : Icrc3.Value;
    #missing;
    /// The ledger could not be asked: rejected, trapped, or timed out. Nothing
    /// is known about the payment, and the same request can be retried.
    #unavailable : Text;
  };

  /// Fetches one block, following the ledger's archive callback if the block
  /// has been archived. Every failure of a call is caught and reported as
  /// `#unavailable`; nothing here can trap the caller. The same fetch as
  /// `apps/03_license_marketplace/backend/src/Payment.mo` (#12).
  public func fetchBlock(ledger : Icrc3.Ledger, index : Nat) : async* Fetched {
    let args = [{ start = index; length = 1 }];
    let result = try {
      await ledger.icrc3_get_blocks(args)
    } catch (error) {
      return #unavailable("the ledger did not answer: " # Error.message(error))
    };
    for (entry in result.blocks.values()) {
      if (entry.id == index) return #block(entry.block)
    };
    for (archive in result.archived_blocks.values()) {
      for (range in archive.args.values()) {
        if (index >= range.start and index < range.start + range.length) {
          let archived = try {
            await archive.callback(args)
          } catch (error) {
            return #unavailable("the ledger archive did not answer: " # Error.message(error))
          };
          for (entry in archived.blocks.values()) {
            if (entry.id == index) return #block(entry.block)
          };
          return #missing
        }
      }
    };
    #missing
  };

  // --------------------------------------------------------------- JSON

  /// The invoice as a customer reads it. Amounts stay integers in minor units
  /// with the currency and, when a ledger for it is registered, its decimals —
  /// formatting money is the reader's job, and a float here would be a bug
  /// waiting for a large invoice.
  public func json(
    invoice : Invoice,
    customer : Text,
    decimals : ?Nat8,
    payments : [Payment],
    adjustments : [Adjustment]
  ) : Text {
    let lineJson = Array.map<Line, Text>(
      invoice.lines,
      func(line : Line) : Text {
        let (kind, description) = switch (line.kind) {
          case (#subscription) ("subscription", "Plan " # invoice.plan.name # ", whole periods: " # Nat.toText(line.quantity));
          case (#usage(category)) ("usage", "Usage: " # category # " (included in plan)");
        };
        jsonObject([
          ("kind", string(kind)),
          ("description", string(description)),
          ("quantity", number(line.quantity)),
          ("amountMinorUnits", number(line.amount)),
        ])
      }
    );
    let paymentJson = Array.map<Payment, Text>(
      payments,
      func(payment : Payment) : Text {
        jsonObject([
          ("ledger", string(Principal.toText(payment.ledger))),
          ("block", number(payment.block)),
          ("symbol", string(payment.symbol)),
          ("amountMinorUnits", number(payment.amount)),
          ("paidAt", string(isoTime(payment.paidAt))),
        ])
      }
    );
    let adjustmentJson = Array.map<Adjustment, Text>(
      adjustments,
      func(adjustment : Adjustment) : Text {
        jsonObject([
          ("kind", string(switch (adjustment.kind) { case (#credit) "credit"; case (#debit) "debit" })),
          ("amountMinorUnits", number(adjustment.amount)),
          ("reason", string(adjustment.reason)),
          ("reference", string(adjustment.reference)),
          ("at", string(isoTime(adjustment.at))),
        ])
      }
    );
    let statusText = switch (status(invoice.total, payments, adjustments)) {
      case (#unpaid) "unpaid";
      case (#partiallyPaid) "partially paid";
      case (#paid) "paid";
      case (#creditBalance) "credit balance";
    };
    jsonObject([
      ("format", string(memoDomain)),
      ("invoice", number(invoice.id)),
      ("sequence", number(invoice.sequence)),
      ("tenant", string(Principal.toText(invoice.tenant))),
      ("customer", string(customer)),
      ("plan", string(invoice.plan.name)),
      ("currency", string(invoice.currency)),
      ("decimals", switch (decimals) { case (?value) number(Nat8.toNat(value)); case null "null" }),
      ("periodStart", string(isoTime(invoice.periodStart))),
      ("billedUntil", string(isoTime(invoice.billedUntil))),
      ("closedAt", string(isoTime(invoice.closedAt))),
      ("closeReason", string(switch (invoice.reason) { case (#periodEnd) "period end"; case (#planChange) "plan change" })),
      ("lines", array(lineJson)),
      ("totalMinorUnits", number(invoice.total)),
      ("payments", array(paymentJson)),
      ("adjustments", array(adjustmentJson)),
      ("balanceMinorUnits", integer(balance(invoice.total, payments, adjustments))),
      ("status", string(statusText)),
      ("usageEvents", number(invoice.eventIds.size())),
      ("lateUsageEvents", number(invoice.lateEvents)),
      ("paymentMemo", string(hex(invoice.paymentMemo))),
    ])
  };

  func jsonObject(fields : [(Text, Text)]) : Text {
    let parts = Array.map<(Text, Text), Text>(fields, func((key, value)) = string(key) # ":" # value);
    "{" # Text.join(parts.values(), ",") # "}"
  };

  func array(items : [Text]) : Text { "[" # Text.join(items.values(), ",") # "]" };

  func number(value : Nat) : Text { Nat.toText(value) };

  func integer(value : Int) : Text { Int.toText(value) };

  /// RFC 8259 string: quote, backslash and every control character escaped.
  public func string(value : Text) : Text {
    var out = "\"";
    for (char in value.chars()) {
      let code = Nat32.toNat(Char.toNat32(char));
      // Compared by code point rather than with character literals, so no
      // quote character appears in the source outside a string.
      out #= if (code == 0x22) "\\\"" else if (code == 0x5C) "\\\\" else if (code == 0x0A) "\\n" else if (code == 0x0D) "\\r" else if (code == 0x09) "\\t" else if (code < 0x20) "\\u00" # hexByte(code) else Char.toText(char)
    };
    out # "\""
  };

  let digits : [Char] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];

  func hexByte(value : Nat) : Text {
    Char.toText(digits[value / 16]) # Char.toText(digits[value % 16])
  };

  public func hex(bytes : Blob) : Text {
    var out = "";
    for (byte in bytes.vals()) out #= hexByte(Nat8.toNat(byte));
    out
  };

  func pad(value : Nat, width : Nat) : Text {
    var text = Nat.toText(value);
    while (text.size() < width) text := "0" # text;
    text
  };

  /// Nanoseconds since the epoch as an RFC 3339 UTC timestamp, to the second.
  /// Civil-from-days after Howard Hinnant's algorithm, for non-negative days.
  public func isoTime(nanos : Nat) : Text {
    let seconds = nanos / nanosPerSecond;
    let days = seconds / 86_400;
    let secondOfDay = seconds % 86_400;
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = Nat.sub(z, era * 146_097);
    let yoe = Nat.sub(Nat.sub(doe + doe / 36_524, doe / 1_460), doe / 146_096) / 365;
    let doy = Nat.sub(doe, Nat.sub(365 * yoe + yoe / 4, yoe / 100));
    let mp = (5 * doy + 2) / 153;
    let day = Nat.sub(doy, (153 * mp + 2) / 5) + 1;
    let month = if (mp < 10) mp + 3 else Nat.sub(mp, 9);
    let year = yoe + era * 400 + (if (month <= 2) 1 else 0);
    pad(year, 4) # "-" # pad(month, 2) # "-" # pad(day, 2) # "T" # pad(secondOfDay / 3_600, 2) # ":" # pad(secondOfDay % 3_600 / 60, 2) # ":" # pad(secondOfDay % 60, 2) # "Z"
  };
};
