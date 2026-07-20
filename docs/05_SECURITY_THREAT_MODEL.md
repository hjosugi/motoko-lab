# Security Threat Model

## Security objectives

1. 他人のprincipalになりすませない。
2. commitmentより前の作品を後から主張できない。
3. recordを黙って変更できない。
4. revocationとderivationが検証可能である。
5. payment、quota、license grantのduplicateを防ぐ。
6. unbounded inputでmemory/cyclesを枯渇させない。
7. upgradeでstate/interfaceを壊さない。
8. private source、prompt、personal dataを漏らさない。

## Main threats

| Threat | Example | Mitigation |
|---|---|---|
| Front-running | 公開manifest hashを見て先に登録 | salted commit-reveal、ownerをcommit preimageへ含める |
| Replay | 同じpayment blockを再利用 | ledger+block unique index、idempotency key |
| False authorship | 盗作品hashを先に登録 | “registration evidence”と表現、external evidence、dispute |
| AI disclosure fraud | AI利用をhuman-onlyと申告 | tool-signed attestation、workflow logs、risk score |
| Hash confusion | algorithm/domainの取り違え | versioned domain separator、algorithm agility、test vectors |
| Canonicalization mismatch | 同じJSONが別hash | RFC 8785準拠library、schema version、binary rules |
| Storage DoS | 巨大Text/Blob/parents | hard size caps、fee/quota、batching |
| Query spoofing | uncertified query response改ざん | certified data、update verification、client certificate check |
| Key loss | creatorがidentityを失う | delegated keys、rotation policy、recovery credential |
| Admin abuse | controllerがcode/stateを変更 | multisig/governance、reproducible Wasm、audit trail |
| Upgrade loss | incompatible stable type | migration chain、staging rehearsal、backup/export |
| Metadata privacy | personal dataを永続公開 | hash/pointer only、encryption、data minimization |

## Authorization matrix

各app READMEのmethod tableに、caller、controller、owner、reporterを明示します。実装reviewではmethodごとに次を答えます。

- 誰が呼べるか
- anonymousはどうなるか
- caller-supplied principalを信頼していないか
- ownershipがrecordから再取得されるか
- await後にauthorization/stateを再検証するか

## Trap policy

trapはmessage全体をrollbackしますが、利用者へtyped errorを返せず、operational visibilityも落ちます。

- validation、not found、unauthorized、conflictは`Result`
- impossible invariantだけtrap
- external call errorは`#externalFailure`
- secretをerror textに含めない

## Economic security

無料registrationはspamの入口です。

- free quota + paid batches
- refundable bond
- per-principal rate limit
- record size price
- duplicate hash rejection
- abuse report bond/slashingは慎重に設計

## Audit scope

production auditには次を含めます。

- Motoko sourceとgenerated Wasm reproducibility
- Candid and stable compatibility
- payment adapter
- canonicalization and crypto library
- certified query verification
- controller/governance configuration
- upgrade and disaster recovery drill
