# Threat Model

- front-running: salt and owner-bound commitment, recomputed on-chain at reveal so the commitment actually binds (`docs/COMMITMENT_V1.md`)
- reveal substitution: rejected; the caller's own principal goes into the preimage, so a commitment cannot be revealed under a different principal, manifest hash, or salt
- false authorship: UI must say evidence, not legal proof
- duplicate artifact: one immutable artifact index entry
- large input: hard caps
- anonymous spam: rejected; production adds fee/quota
- compromised key: future delegation/rotation and revocation
- query tampering: `getRecordCertified` returns the subnet certificate and a witness over a digest covering every field, including revocation status, so an altered response is detectable (`docs/CERTIFIED_QUERIES.md`). Other read paths remain uncertified; the fallback is an update call
- bad canonicalization: use standard implementation and vectors
- malicious URI: clients must validate scheme/content; registry stores pointer only
