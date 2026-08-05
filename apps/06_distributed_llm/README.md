# 06 Distributed LLM

分散推論を Motoko で実際に動かして測るためのアプリです。6 つの復号戦略を同一の
プロンプト・同一のトークン予算・同一の参照出力で比較し、**何回ネットワークを往復
したか**と**何バイト流れたか**を数えます。

対象は 3 つのキャニスターです。

| キャニスター | 役割 |
|---|---|
| `backend` | オーケストレーター。全戦略の入口 (`generate` / `benchmark`) |
| `worker_0..3` | 語彙シャードを 1 つずつ担当するワーカー |
| `llm_shim` | ICP の LLM キャニスター (`w36hm-eqaaa-aaaal-qr76a-cai`) と同じ `v1_chat` を提供するローカル代替 |

## 一番短い実行手順

レプリカを立てずに、クラスタ全体を Motoko インタープリタのアクタースケジューラで
動かします。`await` は本物のメッセージ送信で、アクタークラスは別々のアクターです。

```bash
cd apps/06_distributed_llm
make sim        # 4 ワーカー + オーケストレーター + LLM shim を起動して全戦略を実行
make test-offline
make latency    # 測定したカウンターをネットワーク条件別のレイテンシに変換
```

レジストリに到達できる環境では通常どおり `make install && make check && make test`
が使えます。到達できない環境 (`icp-api.io` を塞ぐ egress allowlist は珍しくありません)
では `make vendor` を先に実行してください。`mo:core` を raw.githubusercontent.com から
`.mops/core@2.6.0/` に置くので、`mops check` / `mops test` / `mops build` はそのまま
通ります — レジストリが必要なのはパッケージの取得だけで、検査には要らないためです。
`make check-offline` / `make test-offline` は `mops` を介さず `moc` を直接呼ぶ経路です。

## 6 つの戦略

| 戦略 | 何が違うか |
|---|---|
| `baseline` | 素の自己回帰貪欲復号。1 トークン 1 パス |
| `arDraft` | 投機的復号。安価なドラフトヘッドが `block` 個を左から順に提案し、ターゲットが一括検証 |
| `maskedDraft` | 拡散的ドラフト。同じドラフトヘッドが `block` 個を**並列に**埋める (信頼度順アンマスク `steps` 回) → 同じ検証器 |
| `shardedArgmax` | 語彙並列。各ワーカーは自分のシャードの最大値だけ返す |
| `shardedDense` | 同上、ただしスコアスライス全体を返す |
| `shardedQuantized` | 同上、送る前に量子化する (`bits` と丸めモードを指定) |

検証規則は 1 つだけです。ターゲットの貪欲トークン `t_i` を、プロンプト +
`draft[0..i-1]` で求め、`draft[i] != t_i` になる最初の `i` までを採用して `t_i` を出力
し、それ以降のドラフトは捨てます。出力は構成上つねにターゲット自身の貪欲継続に
一致します。全レポートが `lossless` フィールドでこれを実測して報告します。

## 測定結果

`make sim` (2026-08-03, moc 1.11.1, プロンプト `speculative decoding uses`, 24 トークン,
block 4, unmask 2 steps, 語彙 336, 4 シャード) と、同じ内容を pocket-ic 14.0.0 上の
実レプリカで実行した結果は一致します。

### 逐次パス数

```
strategy        target   draft  accept%  lossless
  baseline          10       0        0  yes
  arDraft            6      24       33  yes
  maskedDraft        6      12       20  yes
```

`target` はターゲットモデルの逐次パス数で、分散配置ではこれがネットワーク往復回数
です。`draft` はドラフトモデルの逐次パス数で、ドラフトは呼び出し側に置ける前提な
ので安価とみなします。

読み取れること。

* 投機的復号は往復を 10 → 6 に減らします。減り方は受理率 (33%) で決まります。
* 拡散的ドラフトは**ドラフト側の逐次パスを 24 → 12 に半減**させますが、受理率は
  33% → 20% に落ちます。左から右への条件付けを捨てた代償です。総演算量 (`draftEvals`)
  は逆に増えます。つまり「並列に埋める」のは、ドラフト 1 パスが高価なとき、または
  ドラフト自体が遠いときに効きます。

### ワイヤ形式 (4 ワーカー、24 トークン)

```
wire format           rounds  calls   bytes  lossless
argmax                    10     40     640  yes
dense                     10     40   27200  yes
quantized 8b floor        10     40    4000  yes
quantized 2b floor        10     40    1480  yes
quantized 4b near         21     84    4872  NO
quantized 2b near         15     60    2220  NO
```

最大値リダクションで済むなら `argmax` が 42 倍安く、しかも厳密です。

### 量子化が答えを変えるのはいつか

コーパス全位置での実測です。

```
head     rounding  bits  bytes/step  flipped      near-ties (top2 within 1%)
target   floor     2     92          0 / 398      78 / 398
target   nearest   2     92          43 / 398     78 / 398
target   nearest   8     344         19 / 398     78 / 398
draft    nearest   8     344         37 / 398     138 / 398
exact    -         64    2688        0 (by definition)
```

**切り捨て量子化は argmax を壊しません。** `code = v * L / max` は単調非減少で、
`code = L` になるのは `v = max` のときだけなので、最大値だけが最上位コードに到達
します。誤差が片側にしか出ないため、現在の首位は決して順位を落とせません。2 ビット
でも 0 件です。

**最近傍丸めだと壊れます。** 誤差が両側になるので 8 ビットで 398 回中 19 回、2 ビット
で 43 回、選ばれるトークンが変わります。ドラフトヘッドは分布が平坦なぶん悪化します
(37 / 398)。

つまり「アクティベーションを量子化する」は 1 つの決定ではありません。**リダクション
上では無料、アキュムレーション上では損失あり**です。そして損失ありでも、厳密な検証
器の後段に置けば出力は変わりません — 変わるのは受理率だけです。これが量子化と投機
的復号が噛み合う理由です。

### パイプライン並列

3 ステージ (trigram → bigram → unigram) に分割し、ホップごとに再量子化します。

```
profile   rounding  bits   bytes    hops  =exact
natural   floor     2      1840     20    yes
natural   nearest   8      6880     20    yes
natural   nearest   4      6688     38    NO
natural   -         exact  53760    20    yes
```

`natural` はこのモデル自身の 1000:60:1 の重みです。ステージ 1 が単独で勝者を決める
ので、下流の量子化では覆せません。`balanced` プロファイルは各ステージを同じ大きさに
正規化したもので、Transformer の残差ストリーム (層ごとの寄与が同程度) に近い状況を
作るためのものです。対照実験として両方を測っています。

### ネットワーク条件を入れると何が効くか

`make latency` は上のカウンターを `rounds x rtt + bytes / bandwidth + compute` に
かけます。粗いモデルですが、どの項が大きいかを示すには足ります。

| プロファイル | 支配項 | 効く手 |
|---|---|---|
| `ic-subnet` (rtt 1s) | network | 往復を減らす。`arDraft` で 10.0s → 6.0s |
| `home-p2p` (10 Mbit/s, 実サイズ換算 `--scale 1000`) | transfer | バイトを減らす。dense 22.2s → 8bit 3.6s → 2bit 1.6s |
| `datacenter` | compute | 分散しても得るものがない |

ICP のサブネット上では合意ラウンドが 1 往復ぶんの支配項なので、**アクティベーション
圧縮は何も買いません**。逆に 10 Mbit/s の家庭回線では往復ではなくバイトが支配的に
なり、圧縮が効きます。同じ「分散推論」でも、どちらのレバーを引くべきかは配置で
決まります。

## LLM キャニスターとの接続

`backend/src/LlmClient.mo` は `mo:llm` (dfinity/llm の Motoko パッケージ) と同じワイヤ
型を持ちます。依存を取らずに同じ相手を呼べるようにするためで、理由は 2 つです。

1. `mo:llm` は Mops レジストリ経由でしか入らず、`icp-api.io` を塞ぐネットワークでは
   ビルドごと失敗します。この実装の依存は `mo:core` と prim だけです。
2. 型が手元にあるので、`llm_shim` が同じ Candid をローカルで提供する差し替え先に
   なります。Ollama も Gateway の API キーも要りません。

呼び先の解決順は `mo:llm` と同じです。

1. 運用者が明示した上書き先 (`setLlmCanister`、shim を指すときに使う)
2. `icp deploy` が注入する `PUBLIC_CANISTER_ID:llm`
3. メインネットの `w36hm-eqaaa-aaaal-qr76a-cai`

無料モデル (`llama3.1:8b`, `qwen3:32b`) にはサイクルを添付せず、それ以外には 100B
サイクルを添付します。逆にすると呼び出し側が trap します。

本物のモデルが要る場合は `llm_shim` を使わず、`dfx deps pull` で取得した `llm`
キャニスター (ローカルの Ollama か Intelligence Gateway の API キーが必要) を
`setLlmCanister` で指してください。shim の応答は `[shim] ` で始まるので、テスト
フィクスチャの中で本物と取り違えることはありません。

## ローカルレプリカで動かす

`icp` を使う通常の手順です。

```bash
make deploy-local
# icp network start -d
# icp deploy
# icp canister call backend autoWire '()'
# icp canister call backend benchmark '("speculative decoding uses", 24, 4, 2)'
```

`autoWire` は `icp deploy` が注入する `PUBLIC_CANISTER_ID:worker_N` を順に読んで
クラスタを組み立てます。プリンシパルを手で貼る必要はありません。環境変数が使えない
場合は `setWorkers` に直接渡します。

pocket-ic を使う経路もあります。こちらは本アプリの検証で実際に通した経路です。

```bash
node tools/pocket-ic-setup.mjs   # pocket-ic と didc を取得する
node tools/pocket-ic-e2e.mjs     # 6 キャニスターを配備して benchmark を実行
```

## 注意している設計上の制約

* **決定性。** スコアはすべて `Nat` です。浮動小数点はレプリカ間の分岐の典型的な原因
  で、サブネットはビット単位の一致を要求します。同点は必ず最小のトークン ID で
  割ります。この規則がないとシャード構成と単一ノードが別の答えを返し得ます。
* **`query` は inter-canister call を作れません。** だからオーケストレーターの
  `generate` は update call です。ワーカー側は `query` なので、クライアントは合意を
  介さず直接ワーカーを読めます。
* **複製は消えません。** シャーディングはキャニスターごとのメモリを割りますが、
  サブネットの複製係数は割りません。ワーカーはこのデモでは全モデルを持ち、自分の
  範囲だけを評価します。本番のシャードはパラメータも分割します。
* **これは LLM ではありません。** モデルは語彙 336 の 3-gram バックオフです。測って
  いるのは通信パターンと復号アルゴリズムであって、生成品質ではありません。

## 途中で見つけた `moc` のバグ

`Prim.envVar` は、名前が実行時に連結された `Text` (rope) のとき

```
ic0.env_var_name_exists: Variable name is not a valid UTF-8 string
```

で trap します。moc 1.11.1 / pocket-ic 14.0.0 で再現しました。

| 名前の式 | 結果 |
|---|---|
| `"PUBLIC_CANISTER_ID:llm"` (リテラル) | 動く |
| `"PUBLIC_CANISTER_ID:" # suffix` (rope) | trap |
| 同じ rope を平坦化してから渡す | 動く |

リテラルはコンパイラが 1 つの blob に畳むので通ります (ヘルパー関数経由でも同じ)。
`mo:llm` は名前が定数なので踏みません。名前を変数から組み立てる実装だけが踏みます。
`backend/src/Env.mo` の `flatten` が `Blob` 経由で平坦化して回避しています。`prim`
側で平坦化されるようになったら外せます。挙動は `test/Env.test.mo` で固定しています。

## ファイル

| パス | 内容 |
|---|---|
| `backend/src/Lm.mo` | 整数演算のみの 3-gram バックオフモデル。`TARGET` (order 3) と `DRAFT` (order 2) の 2 ヘッド |
| `backend/src/Speculative.mo` | 3 つの復号器と共通の検証規則 |
| `backend/src/Sharding.mo` | 語彙分割と 3 つのワイヤ形式、マージ規則 |
| `backend/src/Quant.mo` | 整数量子化。`#floor` と `#nearest` |
| `backend/src/Pipeline.mo` | パイプライン並列と、量子化が損失を出す唯一の場所 |
| `backend/src/LlmClient.mo` | LLM キャニスターのクライアント (`mo:llm` 互換) |
| `backend/src/Env.mo` | 環境変数と rope 回避 |
| `../../scripts/vendor_core_offline.sh` | レジストリなしで `mo:core` を `.mops/` に置く |
| `sim/Cluster.mo` | インタープリタ上で動くクラスタ全体 |
| `tools/latency-model.mjs` | カウンター → レイテンシ推定 |
| `tools/pocket-ic-e2e.mjs` | 実レプリカでの end-to-end 実行 |
| `docs/DESIGN.md` | 設計と、測定から言えること・言えないこと |
