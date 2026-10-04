# Limitations and Legal Notes

## Technical limitations

- reference appsはsecurity audit前 (issue #21)
- 全6 reference appsはpinned toolchainでcompile/test/Wasm build済みで、PocketIC suiteとupgrade rehearsalも実行済み
- commitmentのSHA-256検証はapps/01でon-chain実行済み、RFC 8785 canonicalizationはoff-chain (canisterはdigestのみを受け取る設計)
- payment appsはmanual confirmation model
- certified queryはapps/01で実装済み
- no production frontend (#26)
- no automatic legal dispute resolution

## Evidence limitation

registration timeが早いことはauthorshipの十分条件ではありません。盗作品を先に登録する可能性があります。system UI、terms、marketingでは「proof of registration/provenance evidence」と表現します。

## Copyright and AI

AI-generated/assisted workのcopyright、contract、disclosure義務はjurisdiction、tool terms、human contributionで異なります。法律相談ではありません。

## Privacy

immutable public dataへpersonal dataを置くと、deletion requestへ対応できない可能性があります。hashもinput entropyが低い場合はpersonal dataを隠しません。

fieldごとのclassification (public / metadata / hashed / user-content / sealed)、warning文言、retention・off-chain deletion、dictionary attackの分析、DPIA checklistは`docs/32_PRIVACY_AND_DATA_PROTECTION.md`にあります。classificationは`privacy/fields.json`として機械可読で、`scripts/check_privacy.py`が全`.did` fieldの分類漏れ、`raw-personal` class、low-entropy hashのmitigation欠落、user-contentのwarning欠落をCIで落とします。

UIはirreversible publicationの前に`privacy/warnings.json`のwarningを表示する必要があります (#26)。termsは「registrationはauthorshipの証明ではない」「hashは低entropy入力の秘密を守らない」「on-chain dataは削除できない」を明記します (#35)。

## Financial

DEX、staking、token、marketplaceの例は投資推奨ではありません。TVL/volume/revenue指標は第三者dataで変動し、profit、solvency、安全性を保証しません。

## Operational

controller compromise、cycle depletion、bad upgrade、dependency vulnerabilityはapplication ownerの責任です。multisig、monitoring、audit、rehearsalが必要です。
