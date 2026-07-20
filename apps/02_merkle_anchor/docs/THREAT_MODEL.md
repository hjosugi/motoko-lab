# Threat Model

- malicious batch owner may anchor false leaves; ownership of root is proven, truth of leaves is not
- inconsistent tree rules break verification; version and vectors are mandatory
- root replay is blocked by unique index
- giant batches are metadata-only but leafCount is capped
- off-chain manifest availability must be redundant
- query certification remains future work
