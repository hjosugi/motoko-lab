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
- 全5アプリの`mops install`、`mops check`、Motoko unit test
- pinned `moc` 1.11.1による全5アプリのWasm build
- 全5アプリのcompiler-generated Candid compatibility check
- 全5アプリの`mops.lock`生成とdependency hash固定
- Nix/read-only npm prefixでのuser/XDG toolchain fallback
- Issue/label作成scriptのdry-run
- ZIP entry検査、kit内`MANIFEST.sha256`、ZIP SHA-256 checksum

機械可読レポート:

- `validation/structural-validation.json`
- `validation/api-surface.json`
- `validation/execution-tests.txt`

## 未実施のproduction gate

- `icp network start -d`
- `icp deploy`
- PocketIC integration test
- canister upgrade rehearsal
- mainnet deployment
- third-party security audit

全5アプリはcompile/test/build済みですが、replica上のinter-canister behavior、upgrade後のstable state、負荷・攻撃耐性まではcompileだけでは証明できません。したがって、production deploymentには残りのIssue gateと独立監査が必要です。

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

compile error、generated Candid差分、upgrade failureが出た場合は、実version、command、expected、actual、最小再現をIssueへ記録します。

## 品質表示

| 対象 | 状態 |
|---|---|
| 文書、設計、source evidence | reviewed dated snapshot |
| JavaScript/Python/shell | locally executed and validated |
| JSON Schema/test vectors | locally validated |
| Motoko/Candid API surface | offline mechanically cross-checked |
| Motoko compile/test/Wasm/Candid | passed for all 5 applications |
| Nix toolchain bootstrap | passed with read-only global npm prefix |
| PocketIC/upgrade rehearsal | pending integration gate |
| production readiness | reference implementation; integration, load test, audit required |
