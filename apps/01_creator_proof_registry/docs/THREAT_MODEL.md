# Threat Model

- front-running: salt and owner-bound commitment
- false authorship: UI must say evidence, not legal proof
- duplicate artifact: one immutable artifact index entry
- large input: hard caps
- anonymous spam: rejected; production adds fee/quota
- compromised key: future delegation/rotation and revocation
- query tampering: future certified query
- bad canonicalization: use standard implementation and vectors
- malicious URI: clients must validate scheme/content; registry stores pointer only
