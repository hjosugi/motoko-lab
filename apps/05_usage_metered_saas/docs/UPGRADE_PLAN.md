# Upgrade Plan

Preserve all usage events and idempotency keys. Plan changes intentionally start a new period in V1. Future invoice entities should be immutable and additive.

Signed receipts (#15) add stable state only: reporter policies, keys and their statuses, per-reporter health, and a receipt index keyed by usage event id. `UsageEvent` is unchanged. The replica suite upgrades after the receipt section and checks that keys, policies and lifetime health counters survive, that a receipt accepted before the upgrade still replays to its original event, and that a compromised key is still refused. A new receipt layout gets a new domain string (`icp-usage-receipt:v2`); a v1 receipt is never reinterpreted.

Billing (#14) adds invoices, per-tenant open-period event lists, payments, adjustments and billing ledgers as new stable state; `Tenant` and `UsageEvent` are unchanged. The replica suite checks that every invoice survives an upgrade unchanged with its payments and adjustments, and that a payment resubmitted after the upgrade still applies only once. Periods are now aligned to plan boundaries; a tenant upgraded mid-period keeps its `periodStartedAt` and continues from it.
