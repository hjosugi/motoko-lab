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

manifest canonical bytesを全languageで一致させます。official vectorsに加えてMotoko/TypeScript/Rust verifier cross-testを作ります。

## Candid

verification APIはlanguage-neutralです。record exportはCandid responseとportable JSON bundleを両方提供します。
