# Interoperability Plan

## C2PA

C2PA manifest assertionへ次を含める案:

- registry canister principal
- proof record ID
- artifact/manifest digest
- verification URI
- AI disclosure summary

C2PA asset-specific signingとICP recordは相互参照し、どちらか一方だけをsource of truthにしません。

## W3C Verifiable Credentials

credential use cases:

- organization membership
- delegated project signing authority
- reviewer/agency verification
- identity recovery approval
- dispute outcome

credentialのrevocation/statusを必ず確認します。

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
