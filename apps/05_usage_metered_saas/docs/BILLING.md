# Billing periods, invoices, payments and adjustments

Issue #14. The metering app had plans and a quota window and nothing that said
what a tenant owed. The period counter reset itself on the first event after
the boundary, and the previous period's usage was simply gone. An invoice has
to be the opposite of that: a snapshot taken once, never changed, and
recomputable by anyone from the events and the plan it names.

## Rules

**A period closes once.** A period closes when it rolls over — lazily, on the
first usage after its end, exactly where the quota already reset — when the
tenant or a controller calls `closePeriod` after its end, or early when the plan
changes. Closing moves the tenant into its next period in the same step, so
there is no second close of the same period to race; `closePeriod` before the
end, or twice, is `#conflict`.

**Periods are aligned to the plan.** The next period starts where the last one
ended, not at the first event after it. A quiet stretch is still billed: a
tenant with no usage for three periods owes three fees, billed together on one
invoice (`quantity` 3 on the subscription line) when the period next closes.

**An invoice never changes.** Payments and adjustments are separate records
that point at it, and the balance is computed from all three. Nothing is
deleted and nothing is edited; a correction is a new record. The suite checks
the invoice record is byte-identical after credits are applied.

**Late usage is billed later, never retroactively.** Usage belongs to the period
in which it was *recorded*. A signed receipt (#15) observed before its period
began — an offline batch relayed after the boundary — is counted in the open
period and marked late there (`lateEvents`); the invoice it would have belonged
to stays exactly as it was issued.

## Amounts

```
subscription = price × whole periods + price × remainder / period length   (rounded down)
usage lines  = units per category, amount 0 (included in the plan)
total        = subscription
```

The plan is a flat fee with a hard quota — usage above the quota is refused,
not billed — so usage lines report quantity and cost nothing. They are on the
invoice because they are what the tenant received, and because they make the
invoice checkable against the event log.

**Plan change mid-period.** `setTenantPlan` first closes any whole periods that
ended under the old plan, then bills the old plan pro rata up to the change
(`reason = #planChange`), and starts the new plan in a fresh period. Usage
recorded before the change stays on the old plan's invoice; it happened under
that plan. Rounding down means a tenant is never billed for time it did not
have the plan.

**Currency change.** The invoice carries the plan *as it was* during the period,
including its currency. An invoice in `TKN` stays in `TKN` after the plan moves
to `XTK`, and is paid through the `TKN` ledger.

**Reproducibility.** `Billing.lines` is pure and is the only place an amount is
computed. The invoice names the plan, the window (`periodStart`, `billedUntil`)
and every event id; the suite recomputes each invoice from `getUsageEvent` and
the plan, in JavaScript, and compares.

## Payment

A controller registers the ledger for a currency with `registerBillingLedger`;
the symbol, decimals and fee are read from the ledger (ICRC-1), so amounts are
explicit integers in minor units with their decimals beside them. One ledger
per symbol.

The tenant (or anyone — a finance department, a reseller) pays with an ordinary
`icrc1_transfer` to the account in `getInvoice(id).payTo`, carrying the
invoice's `paymentMemo`, and calls `payInvoice(invoice, ledger, block)`. The
canister reads the block with ICRC-3 `icrc3_get_blocks`, following an archive
callback if it has to — the same ledger-agnostic adapter as the licence
marketplace (#12). A block pays an invoice only if it is an ICRC-1 transfer to
the payee account, of a non-zero amount, carrying that invoice's memo, stamped
no earlier than the invoice was issued (less five minutes of clock skew).

```
paymentMemo = SHA-256("icp-usage-invoice:v1" || 0x00 || canister principal bytes || 0x00 || invoice id as u64 BE)
```

The canister is inside the memo for the reason #12 gives: deduplication by
`(ledger, block)` is only as wide as one canister, and invoice ids are small
predictable numbers on every deployment.

**Exactly once.** `(ledger, block)` is indexed: the same block for the same
invoice returns the invoice as it is and applies nothing; the same block for a
different invoice is `#duplicate`. Partial payments accumulate; an overpayment
leaves a credit balance rather than being refused, because the money has
already moved.

**Retry-safe.** A ledger that rejects or times out is `#ledgerUnavailable` and
changes nothing; the same call can be repeated. Everything is re-checked after
the ledger call, because another message may have applied the same block while
this one waited.

## Adjustments

`adjustInvoice(invoice, { kind; amount; reason; reference })`, controllers only:
a `#credit` (refund, service credit) or `#debit` note, appended and never
edited. `reference` is the operator's own id: a retry with the same reference
and content returns the invoice unchanged, and the same reference with
different content is `#duplicate`, so a retried refund cannot credit twice.
Up to 100 adjustments per invoice.

| Status | |
|---|---|
| `#unpaid` | balance > 0, no payment |
| `#partiallyPaid` | balance > 0 after payments |
| `#paid` | balance = 0 |
| `#creditBalance` | balance < 0: the tenant is owed the difference |

## Customer-readable JSON

`invoiceJson(id)` returns the invoice as a JSON document (RFC 8259 escaping,
RFC 3339 UTC times, integer minor units, the currency and — when a ledger is
registered — its decimals; formatting money is the reader's job, and a float
here would be a bug waiting for a large invoice):

```json
{"format":"icp-usage-invoice:v1","invoice":1,"sequence":1,"tenant":"…","customer":"Initech",
 "plan":"daily","currency":"TKN","decimals":8,
 "periodStart":"2026-09-24T00:00:00Z","billedUntil":"2026-09-25T00:00:00Z",
 "closedAt":"2026-09-25T01:00:00Z","closeReason":"period end",
 "lines":[{"kind":"subscription","description":"Plan daily, whole periods: 1","quantity":1,"amountMinorUnits":3000},
          {"kind":"usage","description":"Usage: api-call (included in plan)","quantity":13,"amountMinorUnits":0}],
 "totalMinorUnits":3000,"payments":[…],"adjustments":[…],
 "balanceMinorUnits":0,"status":"paid","usageEvents":3,"lateUsageEvents":0,"paymentMemo":"…"}
```

Invoices are readable by the tenant and by controllers; `getInvoice`,
`listInvoices` and `invoiceJson` return nothing to anyone else.

## Test plan

| Case | Where |
|---|---|
| late event | replica: a receipt observed in a closed period and relayed afterwards is recorded in the open period and marked late; the closed invoice is unchanged |
| plan change mid-period | replica: the old plan is invoiced pro rata up to the change, periods stay contiguous, the invoice is reproducible |
| refund/credit | replica: credit note, retried credit note, reused reference refused, credit on a paid invoice shows a credit balance, invoice record unchanged |
| currency change | replica: the pre-change invoice stays in TKN, the next is in XTK, each is paid only through its own ledger |
| same period closes once | replica: `closePeriod` before the end and twice both conflict |
| amount reproducible | replica: every invoice recomputed in JavaScript from its events and plan; interpreter: the fee arithmetic |
| payment applies exactly once | replica: resubmission (also after an upgrade), a block reused for another invoice, wrong account, wrong memo, ledger unavailable then retried |

## Compatibility

Candid: new methods and types, all additive; `setTenantPlan` keeps its
signature and now issues the pro-rata invoice. Behaviour change: periods are
aligned to plan boundaries instead of restarting at the first event after the
end, which only moves where the quota resets and is what an invoice period has
to be. Stable data: new maps and counters; `Tenant` and `UsageEvent` are
unchanged. New dependency: `mo:sha2` 0.2.5, already used by apps 01–03.
