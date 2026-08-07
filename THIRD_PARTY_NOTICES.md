# Third-Party Notices

本キットは、以下の公開プロジェクトや仕様のAPI、documentation、architectureを参照しています。外部source codeを丸ごと再配布していません。各projectのlicenseとtrademarkは各権利者に帰属します。

- Motoko compiler: https://github.com/caffeinelabs/motoko — Apache-2.0
- Motoko core: https://github.com/caffeinelabs/motoko-core — repository license参照
- `mo:ic-certification`: https://github.com/nomeata/ic-certification — Apache-2.0。`apps/01_creator_proof_registry`がcertified query (IC hash tree・witness・CBOR) のために`mops install`時にdependencyとして取得します。
- `mo:sha2`: https://github.com/research-ag/sha2 — Apache-2.0。`apps/01_creator_proof_registry`がon-chain SHA-256 commitment verificationのために`mops install`時にdependencyとして取得します（source再配布はしていません）。
- ICP Developer Docs: https://docs.internetcomputer.org/
- Mops: https://docs.mops.one/ and https://mops.one/
- Candid: https://github.com/dfinity/candid
- W3C Verifiable Credentials Data Model: https://www.w3.org/TR/vc-data-model-2.0/
- JSON Canonicalization Scheme: https://www.rfc-editor.org/rfc/rfc8785
- C2PA specification: https://c2pa.org/specifications/specifications/2.3/index.html
- DeFiLlama data: https://defillama.com/ — volatile third-party metrics
- Caffeine help center: https://help.caffeine.ai/

ICDex、ICPSwap、WaterNeuron等の名称は説明目的でのみ使用しています。投資推奨ではありません。
