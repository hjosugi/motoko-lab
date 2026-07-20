# Threat Model

- raw API keys must never be stored or logged
- hash needs high-entropy key; plain human password hash is vulnerable
- reporter compromise can exhaust quota; signed receipts and per-reporter limits are future work
- idempotency prevents duplicate billing events
- controller is high privilege; use organization-controlled keys
- period reset uses canister time and resets on first event after boundary
