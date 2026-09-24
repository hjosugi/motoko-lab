# Creator Provenance Protocol Package

## Files

- `schemas/provenance-manifest.schema.json`: manifest JSON Schema
- `schemas/verification-report.schema.json`: verifier output schema
- `examples/`: human-only and AI-assisted manifests
- `artifacts/`: tiny example source files
- `test-vectors/test-vectors.json`: deterministic hash/commitment values
- `test-vectors/jcs/`: RFC 8785 conformance vectors (公式vector + edge/reject vector)
- `test-vectors/commitment/vectors.json`: commitment v1 conformance vectors (accept 17 / reject 22)
- `test-vectors/merkle/vectors.json`: `icp-merkle:v1` conformance vectors (tree 15 / multiproof 7 / reject 21)
- `test-vectors/merkle/rfc9162-inclusion.json`: transparency-dev/merkleのRFC 9162 inclusion probe 98件 (Apache-2.0)
- `tools/jcs.mjs`: RFC 8785 canonicalization
- `tools/commitment.mjs`: commitment v1 layout
- `tools/principal.mjs`: principal textual formのdecode/validate
- `tools/merkle.mjs`: `icp-merkle:v1` Merkle treeのbuilder / prover / verifier (single proof + multiproof)
- `tools/merkle-vectors.mjs`: Merkle vectorと`apps/02_merkle_anchor/test/MerkleVectors.mo`の生成・鮮度検査
- `tools/merkle.test.mjs`: Merkle test (offline checksで実行)
- `MERKLE_V1.md`: Merkle tree rulesの凍結仕様
- `tools/crosscheck/`: Rust・TypeScriptの独立実装 (`crosscheck.mjs`から実行)
- `COMMITMENT_V1.md`: commitment layoutの凍結仕様
- `tools/provenance-cli.mjs`: dependency-free CLI
- `tools/provenance-cli.test.mjs`: Node test
- `tools/crosscheck.mjs`: serde_jcs / canonicalize npmとのcross-implementation照合 (opt-in)
- `CANONICALIZATION.md`: canonicalizationの仕様と決定事項
- `C2PA_BRIDGE.md`: C2PA content credentialとregistry recordの相互参照、検証手順、trust/revocationの意味
- `tools/cbor.mjs` / `tools/jumbf.mjs` / `tools/cose.mjs` / `tools/x509.mjs`: C2PAが使うCBOR・JUMBF・COSE_Sign1・X.509 (dependency-free)
- `tools/c2pa.mjs`: PNG用C2PA manifest writer / validator
- `tools/c2pa-bridge.mjs`: ICP proof assertion、credential発行、offline bundle、検証CLI
- `tools/c2pa.test.mjs`: C2PA bridgeのoffline test
- `tools/c2pa-crosscheck.mjs`: c2patool 0.27.22との双方向照合 (opt-in、network必須)
- `schemas/c2pa-verification-report.schema.json`: C2PA bridgeの検証レポート
- `examples/c2pa/`: credential付きPNG、record bundle、creator manifest、test root CA
- `VERIFIABLE_CREDENTIALS.md`: W3C VC 2.0 (membership / delegated authority / review)、`eddsa-jcs-2022`、Bitstring Status List、issuer policy、registry cross-check、個人データ最小化review
- `tools/multikey.mjs`: base58-btc、multibase、Ed25519 Multikey、did:key
- `tools/vc.mjs`: credential builder、eddsa-jcs-2022 proof、status list、policy付き検証CLI
- `tools/vc.test.mjs`: VCのoffline test (W3C Recommendationのvectorを含む)
- `test-vectors/vc/eddsa-jcs-2022.json`: W3C Data Integrity EdDSA Cryptosuites v1.0 Appendix B.3のvector
- `schemas/vc-verification-report.schema.json`: VC検証レポート
- `examples/vc/`: membership / delegation / review credential、status list、issuer policy
- `AI_ATTESTATION.md`: AI tool/model attestation (evidence level、sealed prompt、replay防止、threat model)
- `tools/ai-attestation.mjs`: `AIGenerationAttestation` / `AIUsageReviewCredential`、sealed prompt、`evaluateAiEvidence`、CLI
- `tools/ai-attestation.test.mjs`: AI attestationのoffline test
- `schemas/ai-attestation.schema.json`: attestation credential
- `examples/ai-attestation/`: manifest、provider attestation、studio review、policy、auditor向けsealed prompt disclosure

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
node protocol/tools/c2pa.test.mjs
node protocol/tools/vc.test.mjs
node protocol/tools/ai-attestation.test.mjs
node protocol/tools/vc.mjs verify protocol/examples/vc/membership.json \
  --policy protocol/examples/vc/policy.json \
  --status-list https://studio.example/status/1=protocol/examples/vc/status-list.json
node protocol/tools/c2pa-bridge.mjs verify protocol/examples/c2pa/gradient.c2pa.png \
  --bundle protocol/examples/c2pa/record-bundle.json \
  --trust-anchors protocol/examples/c2pa/test-root-ca.pem \
  --manifest protocol/examples/c2pa/manifest.json
node protocol/tools/provenance-cli.mjs merkle-root leaves.txt
node protocol/tools/provenance-cli.mjs merkle-prove leaves.txt --index 2 > proof.json
node protocol/tools/provenance-cli.mjs merkle-verify proof.json --root <hex> --leaf-count 7
node protocol/tools/merkle.test.mjs
```

## Canonicalization

manifest digestが対象とするbytesは**RFC 8785 (JSON Canonicalization Scheme)**で決まります。公式vector 6件に加え、accept 21件 / reject 26件のedge vectorで検証し、`serde_jcs` 0.2.0と`canonicalize` npm 3.0.0に対してbyte単位で一致することを確認しています。

RFC 8785より厳しくしている点が2つあります。いずれも「拒否する」方向なので、acceptされる入力のbytesは他の準拠実装と一致します。

- **duplicate member nameを拒否**します。`JSON.parse`は最後の出現を黙って採用するため、`{"a":1,"a":2}`と`{"a":2}`が同じdigestになります
- **正確にround-tripしないinteger literalを拒否**します。`12345678901234567890`は仕様上`12345678901234567000`としてhashしてよいのですが、manifestが運ぶのはfile size・identifier・timestampなので、黙って別の数値を署名させません

canisterはcanonicalizationを一切行いません。32-byte digestを不透明な値として受け取るだけです。理由は`CANONICALIZATION.md`を参照してください。

registration evidenceはlegal authorship proofではありません。

## Commitment layout v1 (frozen)

```text
SHA-256(
  UTF8("icp-creator-proof:v1") || 0x00 ||
  UTF8(canonical principal text) || 0x00 ||
  32-byte manifest digest || 0x00 ||
  16..64-byte salt
)
```

byte-levelの仕様、principal textual formの検証規則、error behaviour、version negotiation、conformance vector 39件 (accept 17 / reject 22) は`COMMITMENT_V1.md`にあります。

連結の曖昧性はありません。`domain`は固定長、`principal`は`0x00`を含み得ない文字集合、`manifest-digest`は位置で読む32 byte固定、`salt`は最後です。これは主張ではなく検査項目で、`parsePreimage`が全accept vectorで3 fieldを復元できることをテストが確認しています。

principalは**canonical formのみ**を受け付けます。uppercaseは黙ってlowercaseにせずrejectします。hashされるbytesがcase-insensitiveではない以上、そう振る舞うべきだからです。

saltはreveal時にpublicになります。128 bit以上のentropyが必要です。canisterは`reveal`時にcommitmentを再計算し、独立したverifierも同じ値を再計算できます。

## C2PA bridge

PNGのC2PA content credentialにregistry recordへの参照 (`io.github.hjosugi.icp-proof` assertion) を埋め込み、verifierはcredentialの署名・hard bindingと、certified queryで取得したrecordのstatusを**別々に**検証してから1つのverdictにまとめます。credentialが有効でもrecordがrevokeされていれば`revoked`、recordが存在しなければ`unlinked` (broken link)、registryに到達できなければ`unverifiable`です。

`c2pa.hash.data`はmanifest storeを除いたfile全体のhashなので、未署名のoriginal fileのSHA-256、つまりrecordの`artifactHash`と一致します。credentialを剥がされたcopyも`getByArtifactHash`でrecordに戻れます。creatorはcommit済みmanifestの`extensions`で署名鍵を事前宣言でき、他人が同じassetに署名したcredential (credential laundering) は`invalid`になります。

writer/validatorはc2patool 0.27.22と双方向に照合済みです (example credentialはtest root CAをtrust anchorにして`Trusted`)。実装範囲と非対応項目は`C2PA_BRIDGE.md`を参照してください。

## Verifiable Credentials

principalは鍵の保持を示すだけで、組織のmemberであること、creatorの代理で登録できること、reviewerが記録を検証したことは示しません。それらは第三者の主張なので、W3C VC 2.0 credentialとして`eddsa-jcs-2022` (RFC 8785 + Ed25519) で署名し、検証します。W3C Recommendation自身のtest vectorを署名bytesまで再現します。

unknown issuerは**warningであって成功ではありません** (verdict `unknown-issuer`、exit 2)。expired / revoked / suspendedはreject、status listが取得できなければfail closedです。issuerの鍵rotationはpolicy上の履歴として表現し (#7と同じ考え方)、`compromised`の鍵は過去の`created`も信用しません。registry adapterを渡すと、delegation credentialはon-chain delegationより多くを主張できません。chain側でrevoke・expire・key rotationが起きれば、credentialを変えずに検証結果がrejectになります。詳細は`VERIFIABLE_CREDENTIALS.md`。

## AI attestation

manifestの`ai` blockはcreator自身の申告 (`self-asserted`) です。生成したtool/providerが署名した`AIGenerationAttestation`があれば`tool-signed`、organizationのreviewがあれば`organization-reviewed`になり、verifierはこの3段階を区別して報告します。attestationは出力のSHA-256に束縛されるので別のartifactへ流用 (replay) できず、promptは`icp-ai-prompt:v1`のsalt付きcommitmentとしてのみ扱われ、公開の場には出ません。modelはaliasではなく解決済みversionを必須にし、model名などへの制御文字・bidi override (prompt injection) は署名が正しくても拒否します。詳細は`AI_ATTESTATION.md`。
