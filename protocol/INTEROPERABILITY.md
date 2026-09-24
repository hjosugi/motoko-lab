# Interoperability Plan

## C2PA

実装済みです (#10)。仕様・検証手順・trust/revocationの意味は`C2PA_BRIDGE.md`。

- custom assertion `io.github.hjosugi.icp-proof`: network、canister id、record id、owner principal、artifact/manifest digest、AI disclosure summary、certified query名
- `c2pa.hash.data` = 未署名fileのSHA-256 = recordの`artifactHash`。credentialを剥がしても`getByArtifactHash`でrecordに戻れます
- `c2pa.actions.v2`の`digitalSourceType`はrecordのAI disclosureから導出し、understateを拒否します
- creatorはcommit済みmanifestの`extensions["io.github.hjosugi.c2pa"].signers`でC2PA署名鍵 (SPKI SHA-256) を宣言できます。宣言外の鍵によるcredentialは`invalid`
- verifierはcredential (X.509 trust list) とrecord (IC root key) を別々のtrust rootで検証し、どちらか一方をsource of truthにしません
- c2patool 0.27.22と双方向に照合済み

## W3C Verifiable Credentials

実装済みです (#11)。仕様・policy・data minimizationは`VERIFIABLE_CREDENTIALS.md`。

- VC Data Model 2.0、Data Integrity `eddsa-jcs-2022` (W3C Recommendationのvectorをbyte単位で再現)、Bitstring Status List v1.0
- credential type: `CreatorMembershipCredential`、`DelegatedAuthorityCredential`、`ProvenanceReviewCredential`
- issuer allowlist/policy (type単位の権限、鍵履歴によるrotation、compromised key)
- unknown issuerはwarning (`unknown-issuer`) で成功扱いしません。expired/revoked/suspendedはreject、status取得不能はfail closed
- registry (#7) とのread-only cross-check: on-chain delegationのrevoke・expire、creatorのkey rotationがcredentialの検証結果に直接反映されます
- 未実装 (研究のみ): selective disclosure (SD-JWT VC / `ecdsa-sd-2023` / `bbs-2023`)、identity recovery approval・dispute outcome credential

## AI tool and model attestation

実装済みです (#39)。`AI_ATTESTATION.md`。W3C VC (#11) の上に`AIGenerationAttestation` (provider / local tool) と`AIUsageReviewCredential` (organization) を定義し、証拠の強さを`self-asserted` / `tool-signed` / `organization-reviewed`で報告します。promptはsalt付きcommitmentのみ、attestationは出力digestに束縛されます。

## RFC 8785

manifest canonical bytesは全languageで一致します。`tools/jcs.mjs`が実装し、official vector 6件とedge vector 47件で検証、`tools/crosscheck.mjs`が`serde_jcs` (Rust)と`canonicalize` (npm)に対して同一bytesを確認します。

Motokoにcanonicalizerはありません。canisterは32-byte digestを受け取るだけで、JSONを見ません。canonicalizationが意味を持つのはJSONがある場所、つまりcreatorとverifierの側だけです。詳細と根拠は`CANONICALIZATION.md`。

verifierを自分で書く場合の推奨実装:

| Language | Package |
|---|---|
| Rust | `serde_jcs` |
| JavaScript/TypeScript | `canonicalize` |

どちらもduplicate member nameを拒否しないので、その保証が必要ならparse前に自前で弾いてください。

## Candid

verification APIはlanguage-neutralです。record exportはCandid responseとportable JSON bundleを両方提供します。
