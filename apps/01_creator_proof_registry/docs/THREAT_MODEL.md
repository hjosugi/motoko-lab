# Threat Model

- front-running: salt and owner-bound commitment, recomputed on-chain at reveal so the commitment actually binds (`docs/COMMITMENT_V1.md`)
- reveal substitution: rejected; the caller's own principal goes into the preimage, so a commitment cannot be revealed under a different principal, manifest hash, or salt
- false authorship: UI must say evidence, not legal proof
- duplicate artifact: one immutable artifact index entry
- large input: hard caps
- anonymous spam: rejected; production adds fee/quota
- compromised key: rotate the root key; the retired key keeps its old records but registers nothing new. Scoped, expiring, revocable delegations bound what a compromised delegate can do, and recovery is pre-declared, delayed and cancellable so it cannot silently transfer the identity (`docs/IDENTITY.md`)
- query tampering: `getRecordCertified` returns the subnet certificate and a witness over a digest covering every field, including revocation status, so an altered response is detectable (`docs/CERTIFIED_QUERIES.md`). Other read paths remain uncertified; the fallback is an update call
- bad canonicalization: use standard implementation and vectors
- malicious URI: clients must validate scheme/content; registry stores pointer only
- false counterclaims and dispute spam: per-claimant filing rate, unresolved caps per claimant and per record, one unresolved dispute per claimant and record, and suspension after three `#abusive` findings in 90 days. All per principal, so a Sybil campaign is bounded per record but not in total; a bond (#12, #22) is the control without that weakness (`docs/DISPUTES.md`)
- a counterclaim used to rewrite provenance: disputes are a side structure; no dispute endpoint can change a record, its status or its certified digest, and an authority's outcome is reported as that authority's statement, never as the registry's verdict
- a rotated-away key or revoked delegate answering a counterclaim: the respondent is the attributed creator's current root, resolved the same way registration is
- tampered or truncated dispute history: every transition is a hash-chained event whose head is certified; `exportDispute` carries one witness for the record digest and the log head
- private evidence leaking through the dispute: sealed references carry a digest and a custodian only, and a custodian containing a URI is refused
