# Creator Provenance Protocol v0.1

Status: **experimental design draft**

## 1. Goals

- creatorがpublication前にcommitできる
- artifact、manifest、AI usage、parents、licenseをlinkできる
- anyoneがoff-chain verificationできる
- key rotationとrevocationを表現できる
- central serviceが消えてもrecordを読める

## 2. Non-goals

- legal authorshipの自動確定
- plagiarism detection
- biometric identity
- raw private prompt/sourceのpublic storage
- fully automated dispute judgment

## 3. Objects

### Manifest

canonical JSON document。schemaは`protocol/schemas/provenance-manifest.schema.json`。

### Artifact hash

original bytesのcryptographic digest。textの場合もencodingとnormalizationをmanifestへ記録します。

### Manifest hash

canonical manifest bytesのdigest。

### Commitment

```text
SHA-256(
  UTF8("icp-creator-proof:v1") || 0x00 ||
  UTF8(lowercase canonical principal text) || 0x00 ||
  manifest_hash || 0x00 ||
  salt
)
```

separatorとversionを固定します。productionではbinary layoutを正式仕様化し、test vectorを共有します。

### Proof record

commitment reveal後に、artifact hash、manifest hash、salt、owner、parents、AI disclosure、storage URIを保存します。

## 4. Commit-reveal flow

1. clientがartifact hashとmanifest hashを計算
2. 128-bit以上のrandom saltを生成
3. domain-separated commitmentを計算
4. canisterへcommitment hashだけを登録
5. block/network timeを待つ
6. manifest hash、salt、metadataをreveal
7. verifierがcommitmentを再計算

`apps/01`のcanisterはSHA-256を内部計算しません。external verifierが検証します。on-chain crypto verificationはIssue 003で追加します。

## 5. Canonicalization

JSONのkey sortだけでは不十分です。productionではRFC 8785準拠implementationを使用します。

- Unicode handling
- number serialization
- escaping
- duplicate keys rejection
- UTF-8 encoding

本キットのCLIはlearning用のdeterministic subsetであり、RFC 8785完全実装ではありません。

## 6. AI disclosure

最低field:

- `assisted`: Bool
- `mode`: none/assist/generate/transform
- provider/model/version
- prompt hash or sealed prompt reference
- tool execution attestation
- human contribution summary
- output selection/editing statement

truthfulnessはself-reportだけでは保証できません。tool vendor signature、local trusted execution、organization policy credentialを追加可能にします。

## 7. Derivation graph

recordはparent record ID/hashを持ちます。graphはDAGを想定します。

- source inspiration
- licensed derivative
- remix
- translation
- model-assisted transformation
- composite work

cycle detection、cross-registry URI、license compatibilityはfuture workです。

## 8. Revocation and correction

recordをdeleteせず、reason付きでrevokedにします。

reason例:

- key compromised
- incorrect metadata
- disputed ownership
- replaced by corrected record
- content removed

revocationはoriginal claimを消すのではなく、current trust stateを更新します。

## 9. Identity and delegation

principalだけではreal-world identityではありません。

- organization VC
- pseudonymous long-lived identity
- delegated signing key
- key rotation record
- recovery quorum
- scoped delegation by collection/project

## 10. Verification result

verifierはBoolだけでなくreportを返します。

```json
{
  "commitmentValid": true,
  "artifactHashValid": true,
  "manifestSchemaValid": true,
  "recordActive": true,
  "identityCredentialValid": null,
  "contentAvailable": true,
  "warnings": ["AI disclosure is self-asserted"]
}
```

## 11. Interoperability

- C2PA: content credential claimへregistry URI/record IDを埋める
- W3C VC: creator organization、membership、review resultをcredential化
- RFC 8785: JSON canonicalization
- ICRC ledger: payment/license settlement
- content-addressed storage: artifact availability

## 12. Privacy

public chainへ次を直接保存しません。

- raw prompt
- private source file
- email/address
- client IP/device fingerprint
- unreleased artwork bytes

hashはlow-entropy personal dataを匿名化しません。dictionary attack可能な値にはsalt/encryptionが必要です。

## 13. Governance

protocol version、accepted hash algorithm、credential issuer list、dispute policyをcanister ownerだけで変更しない設計へ進めます。初期はmultisig、成熟後にDAO/SNSを検討します。
