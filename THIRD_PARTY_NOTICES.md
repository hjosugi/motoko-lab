# Third-Party Notices

本キットは、以下の公開プロジェクトや仕様のAPI、documentation、architectureを参照しています。外部source codeを丸ごと再配布していません。各projectのlicenseとtrademarkは各権利者に帰属します。

- Motoko compiler: https://github.com/caffeinelabs/motoko — Apache-2.0
- Motoko core: https://github.com/caffeinelabs/motoko-core — repository license参照
- `mo:ic-certification`: https://github.com/nomeata/ic-certification — Apache-2.0。`apps/01_creator_proof_registry`がcertified query (IC hash tree・witness・CBOR) のために`mops install`時にdependencyとして取得します。
- `mo:sha2`: https://github.com/research-ag/sha2 — Apache-2.0。`apps/01_creator_proof_registry`がon-chain SHA-256 commitment verificationのために、`apps/02_merkle_anchor`がon-chain Merkle proof verificationのために、`apps/03_license_marketplace`がpayment intent memoのために`mops install`時にdependencyとして取得します（source再配布はしていません）。
- transparency-dev/merkle: https://github.com/transparency-dev/merkle — Apache-2.0, Copyright 2019 Google LLC。`protocol/test-vectors/merkle/rfc9162-inclusion.json`は同repository commit `fbbcd741c3d1c69d8498487baa8edc9e5824847c`の`testdata/inclusion/`にあるinclusion probe 98件を1 fileに集約し、base64をhexに変換したものです（値の変更はありません）。`protocol/tools/merkle.test.mjs`は同repositoryの`testonly/constants.go`にあるRFC 6962 root hash 8件も参照しています。
- Certificate Transparency Version 2.0 (Merkle Tree Hash, audit path): https://www.rfc-editor.org/rfc/rfc9162
- ICP Developer Docs: https://docs.internetcomputer.org/
- Mops: https://docs.mops.one/ and https://mops.one/
- Candid: https://github.com/dfinity/candid
- W3C Verifiable Credentials Data Model: https://www.w3.org/TR/vc-data-model-2.0/
- W3C Data Integrity EdDSA Cryptosuites v1.0: https://www.w3.org/TR/vc-di-eddsa/ — `protocol/test-vectors/vc/eddsa-jcs-2022.json`はAppendix B.3のtest vectorを転記したものです (W3C Software and Document License: https://www.w3.org/copyright/software-license-2023/)
- W3C Bitstring Status List v1.0: https://www.w3.org/TR/vc-bitstring-status-list/
- JSON Canonicalization Scheme: https://www.rfc-editor.org/rfc/rfc8785
- C2PA specification 2.4: https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html
- c2patool (contentauth/c2pa-rs): https://github.com/contentauth/c2pa-rs — MIT/Apache-2.0。`protocol/tools/c2pa-crosscheck.mjs`がopt-inの照合時にrelease binaryを取得します (再配布はしていません)
- IPTC Digital Source Type vocabulary: https://cv.iptc.org/newscodes/digitalsourcetype/
- DeFiLlama data: https://defillama.com/ — volatile third-party metrics
- Caffeine help center: https://help.caffeine.ai/

ICDex、ICPSwap、WaterNeuron等の名称は説明目的でのみ使用しています。投資推奨ではありません。
