# Creator Provenance Protocol Package

## Files

- `schemas/provenance-manifest.schema.json`: manifest JSON Schema
- `schemas/verification-report.schema.json`: verifier output schema
- `examples/`: human-only and AI-assisted manifests
- `artifacts/`: tiny example source files
- `test-vectors/test-vectors.json`: deterministic hash/commitment values
- `tools/provenance-cli.mjs`: dependency-free learning CLI
- `tools/provenance-cli.test.mjs`: Node test

## Commands

```bash
node protocol/tools/provenance-cli.mjs canonicalize protocol/examples/ai-assisted.json
node protocol/tools/provenance-cli.mjs manifest-hash protocol/examples/ai-assisted.json
node protocol/tools/provenance-cli.mjs artifact-hash protocol/artifacts/ai-assisted-note.txt
node protocol/tools/provenance-cli.mjs commitment \
  --principal aaaaa-aa \
  --manifest-hash <64-hex> \
  --salt 00112233445566778899aabbccddeeff
node protocol/tools/provenance-cli.test.mjs
```

## Warning

CLI canonicalization is a deterministic educational subset. It sorts object keys recursively and uses JavaScript JSON serialization. It is **not a complete RFC 8785 implementation**. Production conformance is Issue 004.

## Commitment layout v1

```text
UTF8("icp-creator-proof:v1") || 0x00 ||
UTF8(lowercase canonical principal text) || 0x00 ||
32-byte manifest hash || 0x00 ||
salt bytes
```

Salt is public at reveal time and must contain at least 128 bits of entropy. The on-chain canister stores commitment and reveal values; an independent verifier recomputes the digest.
