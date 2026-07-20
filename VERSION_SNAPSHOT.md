# Version Snapshot

確認日: **2026-07-20 JST**

| 対象 | このキットの基準 | 2026-07-20時点の確認根拠 | 注意 |
|---|---:|---|---|
| Motoko compiler (`moc`) | `1.11.1` | `caffeinelabs/motoko/Changelog.md`, 2026-07-15 | 公式ポータルの例が遅れる場合があるためrelease/changelogを再確認 |
| `core` package | `2.6.0` | `caffeinelabs/motoko-core/README.md` | 旧`base`ではなく新規開発は`mo:core`中心 |
| Motoko recipe | `@dfinity/motoko@v5.0.0` | ICP Developer Docsの現行project例 | recipe versionは独立して更新される |
| Node.js | `>=22` | `motoko-core`開発環境と現行ICP tooling | Active LTS以上を推奨 |
| Mops CLI | `ic-mops 2.16.1` | npm publisher profile | projectでは`[toolchain]`で`moc`もpin |
| Node Motoko | `motoko 4.10.0` | npm package / repository `package.json` | browser/Node用。native `moc`と同一用途ではない |
| ICP CLI | `@icp-sdk/icp-cli 1.1.0`系列 | npm platform packageとofficial docs | OS別packageではなくmetapackageを導入し、`npm view`で再確認 |
| Wasm utility | `@icp-sdk/ic-wasm 0.9.11` | npm package | package名と実行binary名の差を導入時に確認 |
| Persistence | enhanced orthogonal persistence | current Motoko model | `persistent actor`を使用 |
| Interface | Candid | ICP standard IDL | public API変更はgenerated Candidとcompatibility checkが必須 |

## このスナップショットの読み方

versionは「ZIPを再現するための固定値」と「導入時に追随すべきCLI版」を分けています。

- `moc`と`core`は5アプリ内で固定しています。
- `icp-cli`、Mops、`ic-wasm`は導入scriptでpackage名を固定し、versionは導入直前に再確認します。
- `@dfinity/motoko@v5.0.0`は`icp-cli`のbuild recipeであり、compiler versionそのものではありません。
- official docs、repository、npmで表示が食い違う場合は、release note、package metadata、実compileの順に判断します。

## Drift detection

月1回、または本番release前に実行します。

```bash
git ls-remote --tags https://github.com/caffeinelabs/motoko.git | tail
npm view @icp-sdk/icp-cli version
npm view @icp-sdk/ic-wasm version
npm view ic-mops version
npm view motoko version
```

`core`はMops package pageとrepository READMEの両方を確認します。version更新PRでは、全appのcompile、compiler-generated Candidとの差分、upgrade rehearsal、cycle/heap benchmarkを同時に行います。
