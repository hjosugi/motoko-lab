# Contents Guide

## 最初に読む5ファイル

1. `README.md`: 目的、開始手順、重要な制約
2. `docs/00_START_HERE.md`: 学習全体の入口
3. `docs/01_16_WEEK_ROADMAP.md`: 16週間の実行計画
4. `apps/01_creator_proof_registry/README.md`: 旗艦アプリ
5. `docs/11_CREATOR_PROVENANCE_PROTOCOL.md`: AI時代の分散証跡設計

## 主要ディレクトリ

| パス | 主な成果物 |
|---|---|
| `docs/` | 基礎、runtime、production、security、operations、business、protocol、migration、cost |
| `apps/` | 独立配備できる5つのMotoko reference backend |
| `protocol/` | JSON Schema、examples、test vectors、依存なしNode verifier CLI |
| `labs/` | 10個の実装・読解lab |
| `compiler/` | OCaml/Dune/Nix/Wasm compiler architectureと貢献手順 |
| `career/` | 12か月のmaintainer/developer成果物計画 |
| `github/` | 40 Issue drafts、labels、milestones、templates、CI |
| `scripts/` | offline validation、toolchain bootstrap、deploy、Issue dry-run、packaging |
| `validation/` | 実行済み検証のJSON/Markdown/text report |

## 6つのアプリ

| App | 学ぶ内容 | 実サービス化の方向 |
|---|---|---|
| `01_creator_proof_registry` | commit-reveal、AI disclosure、derivation、revocation | creator provenance API |
| `02_merkle_anchor` | Merkle root、batching、supersession | high-volume anchoring |
| `03_license_marketplace` | listing、payment receipt、immutable grant | licensing marketplace |
| `04_bounty_board` | bounty、submission、award | creative work procurement |
| `05_usage_metered_saas` | tenant、API key hash、idempotency、quota | B2B metered SaaS |
| `06_distributed_llm` | inter-canister fan-out、投機的復号、量子化転送、LLM canister連携 | 分散推論オーケストレーター |

## Issue backlogの使い方

`github/issues/`の40ファイルは、未完成部分を隠さず実装単位へ分解したものです。既定はdry-runです。

```bash
./scripts/create_labels.sh
./scripts/create_issues.sh
```

内容をreviewした後だけ、明示的に適用します。

```bash
APPLY=1 TARGET_REPO=owner/repo ./scripts/create_labels.sh
APPLY=1 TARGET_REPO=owner/repo ./scripts/create_issues.sh
```

## 完全なファイル一覧

`FILE_INDEX.md`に、このスナップショットへ収録した全ファイルを列挙します。改ざん/欠落確認には`MANIFEST.sha256`を使用します。
