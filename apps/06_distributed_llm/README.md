# 06 Distributed LLM

分散推論を Motoko で実際に動かして測るためのアプリです。7 つの復号戦略を同一の
プロンプト・同一のトークン予算・同一の参照出力で比較し、**何回ネットワークを往復
したか**と**何バイト流れたか**を数えます。ワーカーを信用しない設定と、呼び出し側を
信用しない設定も、有効にしたときの費用を数えたうえで用意しています。

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

## 7 つの戦略

| 戦略 | 何が違うか |
|---|---|
| `baseline` | 素の自己回帰貪欲復号。1 トークン 1 パス |
| `arDraft` | 投機的復号。安価なドラフトヘッドが `block` 個を左から順に提案し、ターゲットが一括検証 |
| `maskedDraft` | 拡散的ドラフト。同じドラフトヘッドが `block` 個を**並列に**埋める (信頼度順アンマスク `steps` 回) → 同じ検証器 |
| `shardedArgmax` | 語彙並列。各ワーカーは自分のシャードの最大値だけ返す |
| `shardedDense` | 同上、ただしスコアスライス全体を返す |
| `shardedQuantized` | 同上、送る前に量子化する (`bits` と丸めモードを指定) |
| `shardedDraft` | 語彙並列で**ドラフトを作り**、ターゲットの厳密な検証はオーケストレーター側でローカルに行う。悪意あるワーカーが出力を変えられない唯一の分散戦略 |

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

### ワーカーを信用しない場合の費用

```
configuration             rounds  calls  bytes   lossless
dense, replication 1      10      40     27200   yes
dense, replication 2      10      80     54400   yes
dense, replication 4      10      160    108800  yes
dense, spot check         10      40     27200   yes
sharded draft             6+24    96     1536    yes   accept 33%
```

複製は**バイトと呼び出し回数に比例し、ラウンド数は増えません**。呼び出しは互いに
独立で最初の `await` より前に全部発射されるので、`k` 重複は同じレイテンシで `k` 倍の
帯域を使います。合意ラウンドが支配的な ICP サブネットでは安い側の軸で、10 Mbit/s の
回線では高い側の軸です。スポットチェックはバイトを増やさず、ローカル命令だけを
使います。

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

## ワーカーを信用しない

語彙並列の最大値リダクションは、**そのシャードを誰も再計算しない**という前提の上に
成り立っています。つまりワーカー 1 台が自分の範囲について嘘のスコアを返せば、その
範囲の任意のトークンを毎ステップ強制できます。マージには照合がなく、気付きません。

`test/fixtures/LyingWorker.mo` は本物のワーカーと同じ Candid を提供し、範囲は正直に
採点したうえで結果だけを偽るキャニスターです。型ではオーケストレーターから区別
できません。これをシャード 3 に据えて pocket-ic 上で測った結果です。

```
configuration             calls  bytes   probes  output=honest  outcome
trusting (replication 1)  96     1536    0       NO             believed, and WRONG
replication 2             8      128     0       -              rejected on round 0: disagreement shard 2, workers 2/3
replication 4             16     256     0       -              rejected on round 0: disagreement shard 0, workers 0/3
spot check (rotating)     16     256     4       -              rejected on round 3: spot check failed, shard 3, worker 3
sharded draft, verified   160    2560    0       yes            believed, and correct, accept 0%
```

正直な出力が `a diffusion model can fill many positions in parallel.` なのに対し、
偽られた出力は `sharding sharding sharding ...` です。336 語彙のうち 84 を持つ 1 台で
これができます。

`setVerification` で 2 つの対策を選べます。

* **`replication = k`** — 各範囲を `k` 台の**別々の**ワーカーに採点させ、返答が完全に
  一致しなければラウンドごと拒否します。1 台の嘘は決定的に検出されます。費用は呼び
  出しとバイトが `k` 倍、ラウンドは不変。
* **`spotCheck`** — オーケストレーターが 1 ラウンドにつき 1 範囲を自分で再計算して
  照合します。バイトは増えません。巡回は `round % shards` で**公開**です。キャニス
  ターに私的な乱数はなく、`raw_rand` は 1 ラウンドあたり非同期呼び出し 1 回を足す
  ためです。毎回嘘をつくワーカーは `shards` ラウンド以内に必ず捕まります (実測で
  4 シャード中ラウンド 3)。見られていないときだけ嘘をつくワーカーは捕まりません。

そして `shardedDraft` は、対策ではなく**構成そのもの**で問題を消します。ワーカーは
ドラフトを作るだけで、出力を決めるのはローカルの厳密なターゲット検証です。嘘をつく
ワーカーがいても出力は 1 ノードの出力と一致し、実測では呼び出しが 96 → 160 に増え、
受理率が 33% → 0% に落ちました。**嘘は正しさではなく受理率を削ります。**

既定は `replication = 1` / スポットチェックなし、つまり「ワーカーは同一運用者の
インフラである」という信頼モデルです。`icp.yaml` を素直に読めばそうなっています
(同じプロジェクト、同じプリンシパル、同じ wasm)。第三者ノードを使う配置に持って
いくときに何を選ぶべきかは `docs/THREAT_MODEL.md` に表で置いてあります。

## アクセス制御とクォータ

`benchmark` は 1 回の ingress メッセージが 8 回の復号と
`tokens x workers x replication` 回の inter-canister call になります。費用は全額この
キャニスター持ちで、呼び出し側は 1 メッセージ分しか払いません。参照アプリとしては
正しく、サイクルを持つ配置としては誤りです。

* **誰が呼べるか。** 復号系エンドポイントは匿名を拒否し、オーナーか許可リストの
  プリンシパルだけを通します。オーナーは管理エンドポイントを最初に呼んだ非匿名の
  プリンシパルです。`setOpenAccess(true)` でデモ用に開放できます (既定は閉)。
* **どれだけ使えるか。** `Quota` は 1 ウィンドウあたりの**モデルパス数**で課金し、
  実行**前**に上限で見積もって、超えるなら**切り詰めずに拒否**します。切り詰めると
  「モデルが早く止まった」のか「予算切れ」なのか呼び出し側から区別できません。
* **`askLlmCanister` の支払い。** 有料モデルはオーナー限定です (1 プロンプトで 100B
  サイクル、モデル選択を他人に渡すのは支払鍵を渡すのと同じ)。無料モデルは許可リスト
  のプリンシパルにクォータ内で開いています。
* **凍結しきい値。** 残高が `MIN_CYCLE_RESERVE` (3T) を割ると全ゲート済み
  エンドポイントが `#lowCycles` で拒否します。凍結したキャニスターは診断や補充の
  ためのエンドポイントごと応答しなくなるためです。

```
anonymous principal        generate / benchmark / askLlmCanister  -> #anonymousNotAllowed
unknown principal          generate                               -> #unauthorized (stats().calls は不変)
allowlisted principal      generate                               -> ok
                           askLlmCanister("gemma3:27b", ...)      -> #unauthorized
fresh principal            remaining 200 -> 24 トークン復号 -> remaining 176
                           benchmark -> #quotaExceeded { limit 200, used 24, requested 672 }
owner                      benchmark ok / quotaOf().exempt = true
1T のキャニスター          generate -> #lowCycles { balance 918_327_983_516; reserve 3_000_000_000_000 }
```

サイクルは `Report.cyclesSpent` と `stats()` で見えます。実測では 1 回の `benchmark`
で外から観測した残高減少が 3.21G、レポートの合計が 2.80G でした。レポートは
メッセージ**内**の残高差なので送った呼び出しの費用を含み、そのメッセージ自身の実行
課金はメッセージ終了後に引かれるため外から見た値のほうが大きくなります。

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
node tools/pocket-ic-e2e.mjs     # 8 キャニスターを配備し、benchmark とアクセス制御・
                                 # クォータ・サイクル・ビザンチン検出の 55 項目を検証
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
| `backend/src/Sharding.mo` | 語彙分割と 3 つのワイヤ形式、マージ規則、複製割り当てと照合 |
| `backend/src/Quota.mo` | プリンシパル単位のレート会計。`now` を引数に取る純粋関数 |
| `backend/src/Quant.mo` | 整数量子化。`#floor` と `#nearest` |
| `backend/src/Pipeline.mo` | パイプライン並列と、量子化が損失を出す唯一の場所 |
| `backend/src/LlmClient.mo` | LLM キャニスターのクライアント (`mo:llm` 互換) |
| `backend/src/Env.mo` | 環境変数と rope 回避 |
| `../../scripts/vendor_core_offline.sh` | レジストリなしで `mo:core` を `.mops/` に置く |
| `sim/Cluster.mo` | インタープリタ上で動くクラスタ全体 (嘘をつくワーカーを含む) |
| `test/fixtures/LyingWorker.mo` | 本物のワーカーと同じ Candid を提供するビザンチンノード (テスト専用、配備しない) |
| `tools/latency-model.mjs` | カウンター → レイテンシ推定 |
| `tools/pocket-ic-e2e.mjs` | 実レプリカでの end-to-end 実行 |
| `docs/DESIGN.md` | 設計と、測定から言えること・言えないこと |
| `docs/THREAT_MODEL.md` | 戦略ごとの「1 台の悪意あるワーカーが出力を変えられるか」と、対策の実測費用 |
| `docs/MEASUREMENTS.md` | 全測定値と再現手順 |
