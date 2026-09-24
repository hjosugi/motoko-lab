# Upgrade Plan

Never alter accepted grants. New payment adapter fields should be optional/additive. Rehearse pending, accepted, rejected orders and sold-out listing behavior.

## Verified payment (#12)

- Stable data: additive side tables only (`ledgers`, `paymentModes`, `intents`, `grantPayments`). `Listing`, `Order` and `LicenseGrant` keep their exact shape, so no migration.
- Listings created before the upgrade have no `paymentModes` entry and read as `#manual`: their behaviour does not change under them. Registering a ledger later does not flip existing listings either; the mode is fixed at creation.
- Candid: new methods and new types only. The verified flow returns the new `PaymentError`; the existing `Error` gained no tag.
- The replica suite upgrades mid-flow and checks the allowlist, the listing modes, every grant's payment record, the idempotent re-confirmation and the `(ledger, block)` refusal survive.
