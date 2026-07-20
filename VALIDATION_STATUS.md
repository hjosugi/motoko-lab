# Validation Status

検証日: **2026-07-20 JST**

## この成果物内で実行済み

- 全対象ファイルのUTF-8 decode、LF改行、NUL byte、空ファイル検査
- Markdown相対linkの存在確認
- 全`mops.toml`のPython `tomllib` parse
- 全JSON、YAML、JSON Schema、manifest test vectorのparse/validation
- provenance CLIの`node --check`とunit test
- shell scriptの`bash -n`
- Python scriptのsyntax compile
- appごとの必須構成、version pin、recipe pin確認
- Issue draft 40件のfront matter、連番、labels、milestones確認
- Motoko sourceのdelimiter、local import、`persistent actor`、主要core APIの静的確認
- 5アプリ・46 public methodsのMotoko/Candid method名、query/update mode、引数個数の機械照合
- Issue/label作成scriptのdry-run
- ZIP entry検査、kit内`MANIFEST.sha256`、ZIP SHA-256 checksum

機械可読レポート:

- `validation/structural-validation.json`
- `validation/api-surface.json`
- `validation/execution-tests.txt`

## この実行環境で未実施

- `mops install`
- `mops check`
- `mops build`
- native `moc` compile
- compiler-generated Candidとの型単位のdiff
- `icp network start -d`
- `icp deploy`
- PocketIC integration test
- canister upgrade rehearsal
- mainnet deployment
- third-party security audit

理由: 実行環境に`moc`、Mops、`icp-cli`がなく、shellから外部packageを取得する経路も完了しませんでした。したがって、収録Motokoは**reference implementation / static-reviewed**であり、compile済みbinaryとは表示しません。

## ローカルで必ず行うrelease gate

```bash
./scripts/bootstrap_toolchain.sh
python3 scripts/validate_kit.py
python3 scripts/check_api_surface.py
./scripts/check_all_apps.sh

cd apps/01_creator_proof_registry
icp network start -d
icp deploy
```

compile error、generated Candid差分、upgrade failureが出た場合は、`github/issues/001-compile-all-reference-apps-with-the-current-pinned-toolchain.md`を起点に、実version、command、expected、actual、最小再現を記録します。

## 品質表示

| 対象 | 状態 |
|---|---|
| 文書、設計、source evidence | reviewed dated snapshot |
| JavaScript/Python/shell | locally executed and validated |
| JSON Schema/test vectors | locally validated |
| Motoko/Candid API surface | offline mechanically cross-checked |
| Motoko compile/PocketIC | pending external toolchain gate |
| production readiness | reference implementation; integration, load test, audit required |
