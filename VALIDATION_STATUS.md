# Validation Status

検証日: **2026-07-20 JST**

## この成果物内で実行済み

- 全対象ファイルのUTF-8 decode、LF改行、NUL byte、空ファイル検査
- Markdown相対linkの存在確認
- 全`mops.toml`のPython `tomllib` parse
- 全JSON、YAML、JSON Schema、manifest test vectorのparse/validation
- RFC 8785 canonicalizationのofficial vector 6件とedge vector 47件 (accept 21 / reject 26)
- commitment layout v1のconformance vector 39件 (accept 17 / reject 22) とpreimageの逆パース
- provenance CLIの`node --check`とunit test
- shell scriptの`bash -n`
- Python scriptのsyntax compile
- appごとの必須構成、version pin、recipe pin確認
- Issue draft 40件のfront matter、連番、labels、milestones確認
- Motoko sourceのdelimiter、local import、`persistent actor`、主要core APIの静的確認
- 6アプリ・64 public methodsのMotoko/Candid method名、query/update mode、引数個数の機械照合
- 全8 canister interfaceのCandid drift検査 (pinned compilerの出力とcommitted `.did`の構造的一致) と、
  直近release tagに対するsubtyping互換検査 (`scripts/check_candid_compat.py`)
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
- `apps/06_distributed_llm/docs/MEASUREMENTS.md` (app 06の測定記録。`execution-tests.txt`は
  `run_offline_checks.sh`が毎回上書きするため、手書きの計測結果はこちらに置いています)

## 2026-08-03に追加で実行済み (apps/06_distributed_llm)

- pocket-ic 14.0.0上での実レプリカ配備: worker 4基 + orchestrator + llm shimの計6キャニスターをinstall
- 実レプリカでのinter-canister fan-out、Candid encode/decode、`v1_chat`呼び出しの往復
- 6復号戦略のlossless照合 (`#nearest`量子化を除く全戦略が単一ノード出力と完全一致)
- `moc -r`のactor schedulerによるcluster simulation (`sim/Cluster.mo`)
- Mopsレジストリ非到達環境での`mops check` / `mops test` (`scripts/vendor_core_offline.sh`)

この過程で`moc` 1.11.1のバグを1件検出しました。`Prim.envVar`は名前が実行時連結の`Text`
(rope)のとき`ic0.env_var_name_exists: Variable name is not a valid UTF-8 string`でtrap
します。インタープリタでは再現せず、レプリカへのinstall時にのみ落ちます。詳細と回避策は
`apps/06_distributed_llm/backend/src/Env.mo`、upstream報告のtrackingはissue #42です。

## 2026-08-05に追加で実行済み (apps/06_distributed_llm, issue #44 / #45)

- pocket-ic 14.0.0上で55 assertion。honest worker 4基に加えて、同一Candidを提供する
  ビザンチンノード (`test/fixtures/LyingWorker.mo`) と、残高1Tのオーケストレーターを配備
- アクセス制御: 匿名 / 未許可 / 許可済み / open access の各プリンシパルに対する
  `generate`・`benchmark`・`askLlmCanister` の可否。拒否時に`stats().calls`が増えないこと
  (=fan-outが起きていないこと) まで確認
- クォータ: ウィンドウ予算の消費、超過時に**切り詰めではなく拒否**されること、部分結果が
  残らないこと、owner exemptionの確認。ウィンドウのロールオーバー自体は`now`を引数に取る
  `test/Quota.test.mo`側で確認 (レプリカを1時間進める代わり)
- サイクル計測: `benchmark` 1回で外部観測の残高減少3.21G ≧ `Report.cyclesSpent`合計2.80G
  (差分はメッセージ自身の実行課金がメッセージ終了後に引かれるため)
- 凍結しきい値: 残高1Tのキャニスターが全ゲート済みエンドポイントを`#lowCycles`で拒否
- ビザンチン検出: 無防備な構成では出力が実際に書き換わること (対照条件) を確認したうえで、
  `replication >= 2`はround 0で、rotating spot checkはround 3で検出。`shardedDraft`は
  嘘をつくワーカーがいても出力が単一ノードと一致し、受理率だけが33% → 0%に落ちること
- `make sim`でも同じ構成をインタープリタ上で再現 (カウンターは一致)

## 2026-08-06に追加で実行済み (issue #17)

- `scripts/check_candid_compat.py`: 全6アプリ・8 canister pairでdrift検査とrelease互換検査。
  baselineは`v2026.08.05` tag (tag付きツリーそのものがinterface artifact)
- fixture 9件の判定確認 (`--self-test`)。additive/optional argument field/result field追加はpass、
  method削除・rename、必須argument field追加、argument型の縮小、argument variantのtag削除はfail
- **`didc check`のexit codeだけでは不十分**であることを確認: 結果variantへのtag追加はexit 0を返すが、
  Candidのspecial `opt` ruleにより古いclientが未知のtagを`null`としてdecodeするため、呼び出しは
  成功してclientは黙って何も見ません。checkerは`FIX ME!` bannerを破壊的変更として扱います
- 実アプリでの実証: `apps/02_merkle_anchor`の`.did`にmethodを1つ手で足すとdrift検査が落ちること、
  および`--baseline v2026.07.20`ではapp 06の全canisterが`new` (当時未存在) と報告されることを確認

## 2026-08-06に追加で実行済み (issue #46, documentation site)

- `icp network start -d` / `icp deploy` をローカルネットワーク上で実行 (icp-cli 1.2.0、
  network launcher 15.0.0)。`icp.yaml`の6キャニスター配備、`autoWire`による
  `PUBLIC_CANISTER_ID:worker_N`からのクラスタ自動構成、`llm_shim`への`v1_chat`往復を確認
- upgrade rehearsal: 同一versionで`icp deploy`を再実行し、stable state (`calls`、`workers`、
  `wireBytes`)、`llmOverride`、各workerのシャード割当が保存され、benchmark出力がbyte単位で
  同一であることを確認
- この過程で文書化された手順自体の欠陥を2件検出・修正 (deploy前のidentity作成が必須、
  ローカル初期残高1.4Tが`MIN_CYCLE_RESERVE` 3Tに届かない)。詳細は
  `apps/06_distributed_llm/docs/MEASUREMENTS.md`
- documentation site: 128ページを`mkdocs build --strict`で警告0でbuild
  (mkdocs 1.6.1 / mkdocs-material 9.7.7)。`main`へのpushでPagesへdeployするjobが成功し、
  <https://hjosugi.github.io/motoko-lab/> が公開されています
- リンク書き換え器の`--self-test` 17件。書き換えを無効化した回帰版では9件が落ちることまで
  確認。`--strict`はリンクが解決するかは見ますが書き換えるべきだったかは見ないため、
  この経路は他の2つのgateでは検出できません
- `site-src/`と`site/`が`.gitignore`、`FILE_INDEX.md`、`MANIFEST.sha256`、structural
  validator、packaging inventoryのすべてから除外されることを、サイトをbuildした状態で
  `run_offline_checks.sh`と`package_kit.py`を通して確認
- この過程で、`FILE_INDEX.md`と`MANIFEST.sha256`に
  `apps/06_distributed_llm/tools/package-lock.json`が載っていたのを解消しました。この
  ファイルはapp側の`.gitignore`で除外されており配布物には入りません。npm実行済みの
  作業ツリーでinventoryを生成したため混入していたものです
## 2026-08-06に追加で実行済み (apps/01_creator_proof_registry, issue #3)

- `reveal`のon-chain commitment検証。`mo:sha2` 0.2.5で
  `SHA-256(domain || 0x00 || principalText || 0x00 || manifestHash || 0x00 || salt)`
  を再計算し、caller principal・manifest hash・saltのいずれかが違えばrejectします。
  従来はcommitmentとreveal値を並べて保存するだけで一度も突き合わせておらず、
  別物をrevealしても記録されていました (commitmentがbindingではなかった)
- `test/Commitment.test.mo`: FIPS 180-4のSHA-256例4件、preimageのbyte単位一致、
  公開test vector 2件、salt境界 (16 / 64 byte)、3つのbound fieldそれぞれの単独改変、
  saltの1bit反転
- icp-cli 1.2.0 / network launcher 15.0.0上での`icp network start -d`と`icp deploy`。
  実キャニスターに対して正しいtripleは`ok`、wrong salt / wrong manifest hash /
  「他人のprincipalをpreimageに含むcommitmentをownerがreveal」の3件はいずれも
  `#invalidInput`で拒否されることを確認。**他人のidentityから呼ぶ形では検証できません**
  (ownership checkが先に`#unauthorized`を返し、hashまで到達しないため)
- `mops bench --replica pocket-ic` (pocket-ic 14.0.0): 検証コストは受理するsalt範囲全体で
  97,406〜111,631 instructions、heap 38.18〜39.96 KiB、GC 0 B。キャニスター外からの
  cycle測定では分解できません (updateコールはどの分岐でも約9.2M cycles)
- Candid: `RevealInput.algorithm`をoptional fieldとして追加し、`commitmentSpec`を新設。
  いずれも`scripts/check_candid_compat.py`のdrift / subtyping検査を通過。
  mismatchは新tagではなく既存の`#invalidInput`で返します (結果variantへのtag追加は
  special `opt` ruleにより古いclientが黙って`null`と解釈するため破壊的変更)

詳細は`apps/01_creator_proof_registry/docs/COMMITMENT_V1.md`。

## 2026-08-07に追加で実行済み (protocol, issue #4)

- RFC 8785 (JCS)準拠のcanonicalization (`protocol/tools/jcs.mjs`)。従来のrecursive key sortが
  取りこぼしていたのはserializationではなく、`JSON.parse`が捨てた後では見えないもの
  (duplicate member name、lone surrogate、double範囲外のnumber literal) でした
- `cyberphone/json-canonicalization`のofficial vector 6件をvendorし、reference outputと
  byte単位で照合。さらにaccept 21件 / reject 26件のedge vectorを追加。
  reject vectorはerror message文字列まで固定しているので、failure behaviourも契約の一部です
- 全vectorでidempotency (canonical formを再度canonicalizeしても同一) を検証。
  この検査が実装のバグを1件検出しました: 当初のinteger制限が`1e20`のcanonical form
  `100000000000000000000`、つまり自分自身の出力を拒否しており、不動点がありませんでした
- cross-implementation照合 (`protocol/tools/crosscheck.mjs`、cargo/npm/network必須のためCI外):
  `serde_jcs` 0.2.0 / `serde_json` 1.0.151 / `canonicalize` npm 3.0.0に対して
  **29件の入力が3実装すべてでbyte単位一致**。reject 26件のうち21件は`serde_jcs`も拒否
- RFC 8785より厳しい2点は意図的で、いずれも「拒否」方向のためacceptされる入力のbytesは
  他の準拠実装と一致します: duplicate member nameの拒否と、正確にround-tripしない
  integer literalの拒否。`crosscheck.mjs`はこの差分リストが記録と食い違えば失敗します
- canisterのcanonicalization責務は**なし**と確定。32-byte digestを不透明な値として
  受け取るだけで、JSONを解析しません

詳細は`protocol/CANONICALIZATION.md`。

## 2026-08-07に追加で実行済み (protocol, issue #5)

- commitment layout v1の凍結。byte-level ABNF、principal textual formの検証規則、
  error behaviour、version negotiationを`protocol/COMMITMENT_V1.md`に確定
- conformance vector 39件 (accept 17 / reject 22)。accept vectorはpreimageの全bytes・
  長さ・commitmentを、reject vectorは入力と正確なerror messageを固定しています
- **連結の曖昧性がないことを検査項目に変換**: `parsePreimage`が全accept vectorで
  3 fieldをbytesから復元できること、およびdistinctなtripleがdistinctなcommitmentに
  なることをassertします。`salt-all-zero`・`salt-leading-zero`・`digest-all-zero`は
  そのために存在します
- principal検証を「長さ5..100」から実際のtextual formへ。base32 alphabet、CRC32
  checksum、再encodeによるcanonical form確認。従来は`hello`や`not-a-principal`が
  そのままcommitmentになっていました (canister側は`Principal.toText(caller)`から
  同じfieldを導出するので、決して一致しない)
- uppercase principalは黙ってlowercaseにせずrejectするよう変更。hex入力は
  case-insensitiveのまま (bytesを表すため) で、両形式が同じcommitmentになることを
  accept vectorでassert
- 境界値を実際の値へ: principal blobは0..29 byteなので、text長は5..100ではなく8..63。
  protocol側とMotoko側の両方を修正
- **独立実装2件が全vectorを再現** (`protocol/tools/crosscheck.mjs`):
  `crosscheck/commitment.rs` (principal検証は`candid::Principal`)と
  `crosscheck/commitment.ts` (同`@dfinity/principal`)。39件すべてでverdictとbytesが一致。
  どちらも`protocol/tools/principal.mjs`のbase32/CRC32コードを使っていません
- Motoko実装もparsing専用でないaccept vector 14件を再現 (`mops test`)
- `commitmentSpec()`に`version`・`minPrincipalTextSize`・`maxPrincipalTextSize`を追加。
  Candid drift / subtyping検査を通過、stable dataは不変

詳細は`protocol/COMMITMENT_V1.md`。

## 未実施のproduction gate

- PocketIC integration test (apps/01-05。app 06は実行済み)
- PocketIC integration test (apps/01-05。app 06は実行済み。app 01の上記ケースは
  ローカルdeployに対する手動実行で、自動化はissue #2)
- 結託するワーカー (ビザンチン測定はいずれも1台構成)
- 破壊的Candid変更をまたぐupgrade。同一version間のrehearsalは実行済みですが、
  releaseをまたぐ移行は`icp deploy`のcompatibility gateが拒否する側の挙動しか確認して
  いません
- mainnet deployment、および`v1_chat`の実モデル呼び出し
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
| RFC 8785 canonicalization | official vectors passed; byte-identical to serde_jcs 0.2.0 and canonicalize 3.0.0 |
| Commitment layout v1 | frozen; 39 conformance vectors reproduced by independent Rust and TypeScript implementations |
| Motoko/Candid API surface | offline mechanically cross-checked |
| Motoko compile/test/Wasm/Candid | passed for all 6 applications |
| Nix toolchain bootstrap | passed with read-only global npm prefix |
| PocketIC replica run | passed for app 06 (pocket-ic 14.0.0); pending for apps 01-05 |
| local replica (`icp deploy`) | passed for app 06 (icp-cli 1.2.0 / launcher 15.0.0) |
| upgrade rehearsal | passed same-version for app 06; across a breaking Candid change, untried |
| documentation site | 128 pages built strict, 0 warnings; published from `main` |
| PocketIC replica run | passed for app 06 (pocket-ic 14.0.0); app 01 benchmarked on pocket-ic 14.0.0 and exercised against a local `icp deploy`; pending for apps 02-05 |
| upgrade rehearsal | pending integration gate |
| production readiness | reference implementation; integration, load test, audit required |
