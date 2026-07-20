# Start Here

## 目標を3本のtrackに分ける

### Track A: Product Builder

`apps/01`から`apps/05`を順番に動かし、Candid API、persistent data、authorization、pagination、idempotency、upgradeを実装します。

### Track B: Provenance Protocol Builder

`protocol/`と`docs/10`、`docs/11`を使い、AI-assisted creationの来歴を、検証可能かつprivacy-awareな形にします。

### Track C: Motoko Maintainer

`compiler/`を読み、Nix開発環境、OCaml module、parser/type checker/IR/codegen/runtime/testsを理解し、small PRからcompiler fixへ進みます。

## 初日の作業

```bash
python3 scripts/validate_kit.py
cat VERSION_SNAPSHOT.md
cat VALIDATION_STATUS.md
cat apps/01_creator_proof_registry/README.md
```

toolchainを導入できる環境では次を実行します。

```bash
./scripts/bootstrap_toolchain.sh
cd apps/01_creator_proof_registry
mops install
mops check
mops build
icp network start -d
icp deploy
```

## 完了条件

「読んだ」ではなく、次のartifactを残します。

- 自分で変更したMotoko canister 5つ
- upgrade前後のstate preservation test
- Candid API versioning decision log
- threat modelとabuse case test
- mainnet canister ID、cycle alert、incident runbook
- compiler/documentation/coreへの外部contribution
- provenance protocolの第三者verifier
- 1つ以上の有料顧客または明確なpricing experiment

## 学び方

1. 公式documentationで概念を確認する。
2. 最小コードを書く。
3. Candid UIまたはtestから呼ぶ。
4. trap、reentrancy、upgrade、abuseを意図的に起こす。
5. design decisionをMarkdownで残す。
6. issueを小さく分け、PRを1目的に限定する。
