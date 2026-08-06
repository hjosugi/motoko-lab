# Testing, CI, and Deployment

## Test pyramid

### Pure unit tests

- input bounds
- status transition
- payment/idempotency key construction
- commitment preimage test vector
- pagination cap

### Model tests

domain modelをpure moduleとして実装し、command sequenceを生成します。

- create -> revoke -> create duplicate
- listing -> order -> accept/reject
- quota reset boundary
- bounty cancel/award conflict

### Canister integration tests

PocketIC上で実行します。全6アプリで実行済みで、apps/01-05 は
`apps/NN_*/test/replica.test.mjs`、app 06 は `apps/06_distributed_llm/tools/pocket-ic-e2e.mjs`
です。

```bash
make replica-tests          # 初回はレプリカと didc を取得します
node tools/pocket-ic/run.mjs 03   # 1アプリだけ
```

**インタープリタでは到達できないものだけを置いています。** `mops test` は純粋な
モジュールを `moc -r` で回すもので、そこには caller も upgrade も時計もありません。
つまり各アプリが README や `docs/UPGRADE_PLAN.md` で主張していることの大半は、
ここで走らせるまで未証明です。

| 検査できるもの | なぜレプリカでしか無理か |
|---|---|
| 匿名/所有者/第三者の分岐 | `moc -r` に `caller` がない |
| `Principal.isController` | コントローラー集合はレプリカが持つ (app 05 の管理ゲート) |
| upgrade 後の state 保持 | インタープリタに upgrade がない |
| 期限・課金ウィンドウ | `pic.setTime` で時計を動かせる (app 04 / 05) |
| 重複抑止インデックスの永続 | upgrade をまたいで初めて意味を持つ |

**upgrade には `wasm_memory_persistence` が要ります。** 全アプリが `persistent actor`
で、enhanced orthogonal persistence を使います。この指定なしに upgrade すると
レプリカが拒否します。

```
Missing upgrade option: Enhanced orthogonal persistence requires the
`wasm_memory_persistence` upgrade option.
```

`@dfinity/pic@0.22.0` の `upgradeCanister()` にはこれを渡す口がないので、
`tools/pocket-ic/harness.mjs` は管理キャニスターの `install_code` を直接呼びます。
`keep` を指定します — `replace` はヒープを捨てるので、「state が残る」系の検査が
**全部誤って通ります**（空のキャニスターには矛盾する古い state がないため）。

各スイートは fresh なレプリカで走ります。共有すると、先に立てたキャニスターが後の
観測を変え得るからです。検査数は毎回出力します。緑でも前回より減っていれば退行です。

### Protocol conformance tests

- same manifest -> same hash
- key order change -> same canonical hash
- number/Unicode edge case
- domain version mismatch -> failure
- wrong principal/salt -> commitment mismatch
- Merkle proof corruption -> failure

## CI gates

1. source formatting
2. `mops install`
3. `mops check`
4. unit test
5. `mops build`
6. generated Candid diff — `scripts/check_candid_compat.py`
7. released-interface compatibility — 同スクリプト
8. stable compatibility check
9. PocketIC integration — `.github/workflows/replica.yml`
10. dependency/license scan
11. reproducible Wasm hash

このリポジトリで実際に走っているのは 2-7 (`.github/workflows/ci.yml`) と 9
(`.github/workflows/replica.yml`) です。8・10・11 は backlog の gate で、Issue で
追跡しています。

## Candid compatibility

canister の upgrade は、client が既に握っている principal の裏側で service を差し替え
ます。だから interface について確認すべきことは 2 つあり、**落ち方が違うので別々に**
検査します。

| 検査 | 問い | 失敗が意味すること |
|---|---|---|
| drift | committed `.did` は、pinned compiler が source から吐くものと今も一致するか | `.did` が嘘をついている。client が binding を生成して初めて露見する |
| compatibility | 現在の interface は、直近 release の interface の Candid subtype か | upgrade が既存 client を壊す |

baseline は **git tag そのもの**です。全 `.did` は tag 付きツリーの中にあり、immutable
で公開済みなので、リポジトリに複製を置く必要も、それが実際の release とずれる余地も
ありません。

```bash
./scripts/install_didc.sh                       # pinned didc (0.4.0)
python3 scripts/check_candid_compat.py . --self-test
python3 scripts/check_candid_compat.py . --baseline v2026.07.20
```

### 許される変更・許されない変更

Candid の subtyping 規則そのものです。引数は反変、結果は共変。

| 変更 | 判定 | なぜ |
|---|---|---|
| method 追加 | **allowed** | release 時点の client からは見えない |
| method 削除 / rename | **breaking** | rename は削除 + 追加であり、Candid には削除しか見えない |
| 引数 record に必須 field 追加 | **breaking** | 既存 client は知らない field を送れない |
| 引数 record に `opt` field 追加 | allowed | 省略が有効な値になる |
| 引数の型を狭める (`nat` -> `nat32`) | **breaking** | release が受け付けていた値を拒否する |
| 引数 variant から tag 削除 | **breaking** | まだその tag を送る client を拒否する |
| 引数 variant に tag 追加 | allowed | 受け付ける値が増えるだけ |
| 結果 variant に tag 追加 | **deprecated** | 下記 |
| 結果 record に field 追加 | allowed | 古い client は無視する |

**結果 variant への tag 追加が最も危険です。** `didc check` は exit 0 を返します —
Candid の special `opt` rule により、古い client は未知の tag を trap ではなく `null`
として decode できてしまうからです。呼び出しは成功し、client は**黙って何も見ません**。
exit code は「互換」と言い、運用上は data loss です。`check_candid_compat.py` はこの
`FIX ME!` banner を破壊的変更として扱います。

破壊的変更をどうしても入れる場合は、interface を分岐させます (新しい method 名、または
新しい canister) 。既存 method の型を変えるのは、全 client を同時に更新できる場合に
限られ、mainnet ではまず成立しません。

### gate が実際に噛むことの確認

`validation/candid-fixtures/` に、判定が既知の interface 対を置いてあります。
`--self-test` が各 case を期待どおりに判定できなければ CI が落ちます。**一度も何も
拒否したことのない gate は、拒否できない gate と区別がつかない**ためです。

## Documentation site

収録文書 128 ページを MkDocs (Material theme) で公開しています。build は
`.github/workflows/docs.yml`、公開は `main` への push のみで、pull request は build
までしか走りません。

<https://hjosugi.github.io/motoko-lab/>

```bash
python3 -m pip install -r requirements-docs.txt
make docs          # self-test → stage → strict build
make docs-serve    # http://127.0.0.1:8000
```

### 3 つの gate

このキットの文書は**それが説明する対象の隣**にあり、MkDocs の `docs_dir` は 1 つです。
`scripts/build_docs_site.py` が path を保ったまま `site-src/` へステージするので、
ページ間のリンクは書き換えなしで解決します。gate はその周りに 3 つあります。

| gate | 落とすもの |
|---|---|
| `--self-test` | リンク書き換え器の挙動が変わった |
| `--check` | ステージされたのに `mkdocs.yml` の nav にないページ / nav にあるのにステージされないページ |
| `mkdocs build --strict` | サイト内で解決しないリンク |

**2 番目**は、書いたのに誰からも辿れない文書を防ぐためです。Issue draft 45 件だけは
`ISSUE_BACKLOG.md` の表を索引とするので nav から除外しています。

**1 番目**が必要な理由は他の 2 つと違います。ページにならないもの (`.mo`、script、
ディレクトリ) へのリンクは GitHub 上の同じ path へ書き換えられます。これがないと、
コードを参照する文書が書けません — 参照した瞬間に `--strict` が落ちるからです。そして
**書き換えが黙って行われなくなっても `--strict` は気づきません**。リンクが解決するか
どうかは見ますが、書き換えるべきだったかは見ないからです。build は緑のまま、中身だけが
dead link になります。

```bash
python3 scripts/build_docs_site.py --self-test   # 17 cases
```

17 件は相対リンク維持、file/directory の出し分け、`README.md` → `index.md` の付け替え、
link text 内の code span、title 付き、image、code span と fenced block、外部/絶対/解決
不能を固定しています。書き換えを無効化した回帰版では 17 件中 9 件が落ちます。
`check_candid_compat.py --self-test` と同じ理由で、**一度も何も落としたことのない gate は、
落とせない gate と区別がつきません**。

### 公開設定

**Settings → Pages → Source が "GitHub Actions"** であることが前提です。workflow から
自リポジトリの Pages を有効化することはできないため、ここだけは 1 度だけ手作業になります。
このリポジトリでは設定済みで、`main` への push で `deploy` job が成功しています。

fork して使う場合は、最初の `main` への push で `deploy` job が失敗します。Pages を
有効化してから re-run してください。

## Environments

- local: disposable identities and canisters
- staging: production-like data shape, no real funds
- production: restricted deploy identity, monitored cycles

config、identity、canister IDを混在させません。

## Release procedure

1. issue/PR scope fixed
2. migration and Candid review — `scripts/check_candid_compat.py . --self-test --require-baseline`
3. staging upgrade rehearsal
4. state/export checksum
5. Wasm hash approval
6. production upgrade
7. smoke queries and writes
8. cycle/memory/error monitoring
9. release note and rollback decision window

## Rollback

code rollbackはstable state rollbackではありません。migration後の旧Wasm再installが安全とは限りません。

- forward fixを基本にする
- destructive migrationを避ける
- migration markerとversionを保存
- old dataを一定期間保持
- emergency read-only modeを用意
