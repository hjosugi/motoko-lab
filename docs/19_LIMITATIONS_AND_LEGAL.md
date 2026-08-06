# Limitations and Legal Notes

## Technical limitations

- reference appsはsecurity audit前
- 全5 reference appsはpinned toolchainでcompile/test/Wasm build済みだが、PocketICとupgrade rehearsalは未実行
- commitmentのSHA-256検証はapps/01でon-chain実行済み、RFC 8785 canonicalizationはoff-chain (canisterはdigestのみを受け取る設計)
- payment appsはmanual confirmation model
- certified queryは未実装
- no production frontend
- no automatic legal dispute resolution

## Evidence limitation

registration timeが早いことはauthorshipの十分条件ではありません。盗作品を先に登録する可能性があります。system UI、terms、marketingでは「proof of registration/provenance evidence」と表現します。

## Copyright and AI

AI-generated/assisted workのcopyright、contract、disclosure義務はjurisdiction、tool terms、human contributionで異なります。法律相談ではありません。

## Privacy

immutable public dataへpersonal dataを置くと、deletion requestへ対応できない可能性があります。hashもinput entropyが低い場合はpersonal dataを隠しません。

## Financial

DEX、staking、token、marketplaceの例は投資推奨ではありません。TVL/volume/revenue指標は第三者dataで変動し、profit、solvency、安全性を保証しません。

## Operational

controller compromise、cycle depletion、bad upgrade、dependency vulnerabilityはapplication ownerの責任です。multisig、monitoring、audit、rehearsalが必要です。
