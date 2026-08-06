# Creator Provenance Protocol Package

## Files

- `schemas/provenance-manifest.schema.json`: manifest JSON Schema
- `schemas/verification-report.schema.json`: verifier output schema
- `examples/`: human-only and AI-assisted manifests
- `artifacts/`: tiny example source files
- `test-vectors/test-vectors.json`: deterministic hash/commitment values
- `test-vectors/jcs/`: RFC 8785 conformance vectors (公式vector + edge/reject vector)
- `tools/jcs.mjs`: RFC 8785 canonicalization
- `tools/provenance-cli.mjs`: dependency-free CLI
- `tools/provenance-cli.test.mjs`: Node test
- `tools/crosscheck.mjs`: serde_jcs / canonicalize npmとのcross-implementation照合 (opt-in)
- `CANONICALIZATION.md`: canonicalizationの仕様と決定事項

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

## Canonicalization

manifest digestが対象とするbytesは**RFC 8785 (JSON Canonicalization Scheme)**で決まります。公式vector 6件に加え、accept 21件 / reject 26件のedge vectorで検証し、`serde_jcs` 0.2.0と`canonicalize` npm 3.0.0に対してbyte単位で一致することを確認しています。

RFC 8785より厳しくしている点が2つあります。いずれも「拒否する」方向なので、acceptされる入力のbytesは他の準拠実装と一致します。

- **duplicate member nameを拒否**します。`JSON.parse`は最後の出現を黙って採用するため、`{"a":1,"a":2}`と`{"a":2}`が同じdigestになります
- **正確にround-tripしないinteger literalを拒否**します。`12345678901234567890`は仕様上`12345678901234567000`としてhashしてよいのですが、manifestが運ぶのはfile size・identifier・timestampなので、黙って別の数値を署名させません

canisterはcanonicalizationを一切行いません。32-byte digestを不透明な値として受け取るだけです。理由は`CANONICALIZATION.md`を参照してください。

registration evidenceはlegal authorship proofではありません。

## Commitment layout v1

```text
UTF8("icp-creator-proof:v1") || 0x00 ||
UTF8(lowercase canonical principal text) || 0x00 ||
32-byte manifest hash || 0x00 ||
salt bytes
```

Salt is public at reveal time and must contain at least 128 bits of entropy. The on-chain canister stores commitment and reveal values; an independent verifier recomputes the digest.
