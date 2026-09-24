# Threat Model

- raw API keys must never be stored or logged
- hash needs high-entropy key; plain human password hash is vulnerable
- reporter compromise: a reporter can be scoped to tenants and categories, capped per event and per tumbling window, and required to sign. A signed receipt needs both the reporter principal (to submit) and a registered device key (to sign), so stealing one is not enough; keys are rotated or marked compromised independently, and a compromised key is refused whatever `observedAt` it claims (`docs/RECEIPTS.md`)
- forged or altered receipts: ECDSA P-256 over a domain-separated layout that binds canister, reporter, key, tenant, units, category, idempotency key and time; high-S twins refused
- replayed receipts: a resubmitted receipt returns the original event only; a different receipt reusing an idempotency key is a conflict
- backdated or future receipts: at most 7 days old, at most 5 minutes ahead, never before the key was registered
- a stranger relaying a stolen receipt: refused, and not counted against the named reporter's health
- verification cost as a DoS vector: every cheap check runs before the signature, submissions need an enabled reporter principal, and a batch is capped at 16 receipts (~28B instructions)
- idempotency prevents duplicate billing events
- controller is high privilege; use organization-controlled keys
- period reset uses canister time and resets on first event after boundary
- invoice tampering: invoices are never edited; payments and adjustments are separate appended records, and every amount is recomputable from the named events and plan snapshot (`docs/BILLING.md`)
- late usage rewriting a closed period: usage belongs to the period it is recorded in; a late receipt is billed in the open period and marked late, and the issued invoice stays as it was
- forged or reused payments: a block is read from a controller-registered ledger and must be a transfer to the payee account carrying the invoice's memo (which binds this canister and invoice id), made after the invoice was issued; `(ledger, block)` applies at most once
- double refunds: adjustments carry an operator reference that is unique per invoice, so a retried credit note is not applied twice
- invoice disclosure: invoices are readable only by the tenant and controllers
