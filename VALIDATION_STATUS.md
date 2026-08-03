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
- 6アプリ・55 public methodsのMotoko/Candid method名、query/update mode、引数個数の機械照合
- 全6アプリの`mops install`、`mops check`、Motoko unit test
- pinned `moc` 1.11.1による全6アプリのWasm build
- 全6アプリのcompiler-generated Candid compatibility check
- 全6アプリの`mops.lock`生成とdependency hash固定
- Nix/read-only npm prefixでのuser/XDG toolchain fallback
- Issue/label作成scriptのdry-run
- ZIP entry検査、kit内`MANIFEST.sha256`、ZIP SHA-256 checksum

機械可読レポート:

- `validation/structural-validation.json`
- `validation/api-surface.json`
- `validation/execution-tests.txt`

## 2026-08-03に追加で実行済み (apps/06_distributed_llm)

- pocket-ic 14.0.0上での実レプリカ配備: worker 4基 + orchestrator + llm shimの計6キャニスターをinstall
- 実レプリカでのinter-canister fan-out、Candid encode/decode、`v1_chat`呼び出しの往復
- 6復号戦略のlossless照合 (`#nearest`量子化を除く全戦略が単一ノード出力と完全一致)
- `moc -r`のactor schedulerによるcluster simulation (`sim/Cluster.mo`)
- Mopsレジストリ非到達環境での`mops check` / `mops test` (`scripts/vendor_core_offline.sh`)

この過程で`moc` 1.11.1のバグを1件検出しました。`Prim.envVar`は名前が実行時連結の`Text`
(rope)のとき`ic0.env_var_name_exists: Variable name is not a valid UTF-8 string`でtrap
します。インタープリタでは再現せず、レプリカへのinstall時にのみ落ちます。詳細と回避策は
`apps/06_distributed_llm/backend/src/Env.mo`、再現条件は`github/issues/041_*`にあります。

## 未実施のproduction gate

- `icp network start -d`
- `icp deploy`
- PocketIC integration test (apps/01-05。app 06は実行済み)
- canister upgrade rehearsal
- mainnet deployment
- third-party security audit

全6アプリはcompile/test/build済みで、app 06はレプリカ上のinter-canister behaviorまで
確認済みです。それでもupgrade後のstable state、負荷・攻撃耐性まではこれだけでは証明でき
ません。したがって、production deploymentには残りのIssue gateと独立監査が必要です。

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
| Motoko compile/test/Wasm/Candid | passed for all 6 applications |
| Nix toolchain bootstrap | passed with read-only global npm prefix |
| PocketIC replica run | passed for app 06 (pocket-ic 14.0.0); pending for apps 01-05 |
| upgrade rehearsal | pending integration gate |
| production readiness | reference implementation; integration, load test, audit required |
