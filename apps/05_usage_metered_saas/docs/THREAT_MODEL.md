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
