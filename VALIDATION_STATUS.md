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
- 6アプリ・79 public methodsのMotoko/Candid method名、query/update mode、引数個数の機械照合
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

## 2026-08-07に追加で実行済み (issue #2, PocketIC integration)

- apps/01-05 の全アプリを pocket-ic 14.0.0 上で実行。**280 assertion、失敗0**
  (01: 118 / 02: 31 / 03: 44 / 04: 39 / 05: 48)。共有 harness は `tools/pocket-ic/`、
  各スイートは `apps/NN_*/test/replica.test.mjs`
- app 01 の commitment検証 (#3) をレプリカ上で確認。commitmentは
  `protocol/tools/commitment.mjs` — canister側ではなくverifier側の実装 — で構築するので、
  各`reveal`はstate machineの検査であると同時にcross-implementation検査でもあります。
  誤ったsalt / 誤ったmanifest hash / 他人のprincipalをpreimageに含むcommitmentの3件が
  拒否されること、`commitmentSpec()`が凍結仕様と一致すること、upgrade後も検証が
  効くことを確認
- harness の `--package` はapp の `.mops` にある全依存を渡すよう修正。`core`固定では
  `mo:sha2`を使うapp 01がコンパイルできませんでした
- 各アプリで匿名・所有者・第三者の分岐を実 principal で確認。拒否が正しい variant で
  返ることまで検査しています (「失敗した」だけの検査は、無関係な理由で壊れていても通るため)
- 全5アプリで upgrade を実行し、カウンター・重複抑止インデックス・認可 state が
  保存されることを確認。**id が upgrade をまたいで継続する**ことも確認しています
  (再利用は退役した id を新しい記録が取ることを意味し、来歴レジストリでは許されません)
- app 04 の締切と app 05 のクォータ窓は `pic.setTime` で時計を進めて確認。
  インタープリタには時計がないため、この経路は従来一度も走っていませんでした
- app 05 の管理ゲートは `Principal.isController` で、コントローラー集合はレプリカが
  持ちます。`moc -r` では原理的に検証できません
- この過程で判明: `persistent actor` (enhanced orthogonal persistence) の upgrade には
  `wasm_memory_persistence` が必須で、`@dfinity/pic@0.22.0` の `upgradeCanister()` には
  それを渡す口がありません。harness は管理キャニスターの `install_code` を直接呼びます。
  `keep` を指定します — `replace` はヒープを捨てるため、「state が残る」系の検査が全部
  誤って通ります

## 2026-08-07に追加で実行済み (apps/01_creator_proof_registry, issue #6)

- certified query。`getRecordCertified`がsubnet certificateとpruned hash treeを返し、
  readerはBLS署名を検証し、`/canister/<id>/certified_data`を取り出し、witnessを
  reconstructしてrootが一致することを確認し、`["record", id]`の値をローカルで
  再計算したdigestと突き合わせます
- **witness rootがcertified dataであることの確認**が、抜けやすくかつ抜けると致命的な
  ステップです。内部的にreconstructできても別のtreeを記述しているwitnessは何も証明
  しません。mutation前に取得したwitnessを現在のcertificateと組み合わせるケースを
  スイートに入れており、まさにこのステップで落ちます
- certified digestは**全フィールド**を対象にします。identityだけを対象にすると
  `storageUri` (artifactの実在場所) が検出不能に書き換え可能になり、失効も
  「activeのまま配り続ける」ことで無効化できてしまいます
- record encodingは意図的に2実装あります (`backend/src/RecordDigest.mo` と
  `test/record-digest.mjs`)。canisterにdigestを聞くverifierは何も検証していないためです。
  replica suiteは証明書付きrecordごとに両者を比較します
- pocket-ic 14.0.0上で app 01 は 40 → 66 checks、全体で 228 assertion、失敗0。
  検証はレプリカから取得したsubnet公開鍵に対して行います (検証対象から鍵を取れば
  何も証明しません)
- コスト測定 (`mops bench --replica pocket-ic`): certificationは`reveal` /
  `revokeRecord`に約0.9M〜1.2M instructionsを追加。commitment検査の約100kに対して
  一桁大きく、両エンドポイントの支配的コストです。`put`はrecord数に対して単調では
  ありません — radix trieなので挿入の深さはキーの分岐位置で決まります
- `scripts/check_candid_compat.py`と`tools/pocket-ic/harness.mjs`はpackage pathを
  `.mops/`のディレクトリ名からではなく`mops sources`から取得するよう変更。
  `ic-certification`が`core@1`・`sha2@0`を持ち込むため、ディレクトリ走査では
  `--package core`が2回出てコンパイラがどちらかを選んでしまいます

詳細は`apps/01_creator_proof_registry/docs/CERTIFIED_QUERIES.md`。

## 2026-08-07に追加で実行済み (apps/01_creator_proof_registry, issue #7)

- creator identity・key rotation・scoped delegation・recovery。**recordは署名した
  principalを恒久的に保持します**。rotationで旧recordを新しい鍵に書き換えるのは
  provenanceの偽造です (登録時点ではその鍵が本当に署名者だった)。rotationはkey history
  への追記で、attributionはその履歴を読んで解決します
- identityはopt-inですが、**一度identityに紐づいたprincipalは統治から外れません**。
  rotate済みの旧鍵・失効したdelegate・期限切れdelegate・scope外のdelegateはいずれも
  拒否されます。そうでなければ各々が「ただのcaller」として登録し直せてしまい、
  revocationもrotationも飾りになります。拒否理由は4つのどれかを明かしません
- delegationはcollection単位または全体にscope可能、絶対期限が必須 (最大365日)、失効可能。
  期限はdeadlineであってstatus変化ではないので、期限切れdelegationは`#active`のまま
  何も認可しません。この点をスイートでassertしています
- collection-scopedなdelegateがcollection指定なしで登録するのはscope**外**です。
  `null`を「任意のcollection」と読むと、scopeの遵守がdelegate任せになります
- recoveryはrootが鍵を保持しているうちに事前宣言し、最低7日の遅延を置き、双方が
  キャンセルでき、`getRecovery`で常時可視です。後から追加できるrecovery経路は
  乗っ取り経路であり、遅延は現rootが気づくための時間です
- app 01 は 66 → 118 checks、全体で **280 assertion、失敗0**。#7のacceptance criteria
  とtest planの全ケース (期限切れ・鍵の危殆化・組織メンバーの離脱・同時rotation) を含みます
- Candid・stable dataともに追加のみ。`ProofRecord`は不変なので#6のcertified digestも
  不変で、migrationは不要です

詳細は`apps/01_creator_proof_registry/docs/IDENTITY.md`。

## 2026-09-24に追加で実行済み (protocol, issue #10, C2PA bridge)

- C2PA Technical Specification 2.4 (April 2026) を確認し、byte-levelの規則は
  c2patool 0.27.22 (c2pa-rs 0.90.22) の出力を実測して確定。assertionのhashed URIは
  superboxの**payload** (description boxとcontent box、superbox自身のLBox/TBoxは除く)、
  `c2pa.hash.data`のexclusionは`caBX` chunk全体 (length・CRCを含む) を覆います
- PNG用のmanifest writer / validatorをdependency-freeで実装 (CBOR、JUMBF、COSE_Sign1、
  X.509 test PKI)。offline suite `protocol/tools/c2pa.test.mjs` は**116 check**:
  CBOR preferred serializationの境界値、JUMBF UUID、証明書profile、Ed25519/ES256署名、
  pixel改変・assertion改変・claim改変・manifest storeの移動・CRC破損の検出、
  example 5 fileのbyte単位再現、全verdict (revoked / broken link / unreachable /
  certification failure / credential laundering / AI disclosureのunderstate /
  gathered assertionによるlinkの拒否)
- **c2patoolとの双方向照合** (`protocol/tools/c2pa-crosscheck.mjs`、network必須のためCI外):
  example credentialはtest root CAをtrust anchorにして`validation_state: Trusted`・failure 0件、
  anchorなしでは`Valid`でfailureは`signingCredential.untrusted`の1件のみ。ここで書いた
  ES256 credentialも`Trusted`。逆方向にc2patoolが自身のsample ES256 chainで署名したPNG
  (thumbnail・ingredient・gathered assertionを含む) の署名・全hashed URI・data hashを
  ここのvalidatorが検証
- pocket-ic 14.0.0上のend-to-end (`tools/pocket-ic/c2pa-bridge.test.mjs`、**22 check**):
  app 01にPNGをcommit/revealし、そのrecordを参照するcredentialを埋め込み、
  `getRecordCertified`経由のonline検証 (BLS証明書をsubnet keyで検証) と保存bundleからの
  offline検証の両方で`verified`。bundle内recordの書き換え・誤ったroot key・存在しない
  record (broken link)・到達できないcanisterをそれぞれ区別して報告。revoke後は同じ
  credentialが`revoked`になり、revoke前のbundleは「保存時点ではactive」と日付付きで
  報告、revoke前のrecordを新しい証明書に継ぎ合わせるとcertificationが失敗します。
  credentialを剥がしたcopyも`getByArtifactHash`でrecordへ戻れることを確認
- 非対応 (明記): JPEG/BMFFなど他container、ingredient/update manifest、redaction、
  RFC 3161 timestamp、OCSP、trust list policy全体

詳細は`protocol/C2PA_BRIDGE.md`。

## 2026-09-24に追加で実行済み (apps/02_merkle_anchor + protocol, issue #9)

- Merkle tree rules `icp-merkle:v1`を`protocol/MERKLE_V1.md`に凍結。leafは32-byte digest、
  leaf hashは`SHA-256(0x00 || "icp-merkle:v1" || leaf)`、nodeは`SHA-256(0x01 || left || right)`、
  shapeはRFC 9162。各規則は既知の攻撃 (interior nodeをleafとして提示するsecond preimage、
  奇数node複製によるCVE-2012-2459型の曖昧性、sortによるindex情報の喪失、proof malleability)
  に対応し、それぞれvectorがあります
- reference実装 `protocol/tools/merkle.mjs` と canister実装 `backend/src/Merkle.mo` はコードを
  共有しません。JavaScript側はtransparency-dev/merkle (commit `fbbcd741`) のRFC 9162
  inclusion probe **98件すべて**でverdictが一致し、RFC 6962 reference root 8件を再現します。
  recursive定義とbottom-up builderがsize 1〜130の全proofで一致することも検査しています
- conformance vector: tree 15件 (size 1〜9・16・17、duplicate leaves、最後のleafの繰り返し、
  100,000 leaf、上限の1,000,000 leaf = 20-hash path)、multiproof 7件、reject 21件
  (error message文字列または`included: false`まで固定)。`merkle.test.mjs` 568 checks
- Motoko側 (`mops test`): 公開vectorを`merkle-vectors.mjs`がMotoko値として生成した
  `test/MerkleVectors.mo`に対し、全tree rootの再構築、全audit path、全multiproof、全reject、
  transparency-dev probe 98件を検証。生成物が古ければoffline checksが落ちます
- **audit pathはtree sizeを認証しない**ことをtestでassert (leaf 2のpathはsize 5〜8で同一)。
  そのため`verifyProof`はanchor済みの`leafCount`を使い、size引数を持ちません。
  CLIの`merkle-verify`もanchor由来の`--root`と`--leaf-count`なしでは実行しません
- replica suite (pocket-ic 14.0.0): app 02 は **31 → 102 checks**。JavaScriptで作ったproofの
  on-chain検証、leaf/path/rootの改変、wrong index、path長の過不足、multiproofの過不足・
  順序違反・上限超過、1 leaf、duplicate leaves、100,000 leafと1,000,000 leafのvector、
  revoked batch。さらに**`v2026.09.22` buildをinstallして`rfc6962` batchをanchorし、現buildへ
  upgradeして、batchがbyte単位で保存され、root indexに残り、`verifyProof`では`#conflict`で
  拒否される (v1として読み替えない)** ことを確認。このため`replica.yml`はtagをfetchします
- `mops bench --replica pocket-ic` (`bench/merkle.bench.mo`): audit pathは1 hashで89,646、
  20 hash (上限)で1,104,618 instructions。multiproofは1,000,000 leafの木に均等配置で
  16 leaf 14.8M、64 leaf 52.2M、256 leaf (上限) 180.6M instructions / heap 3.23 MiB。
  query上限5B instructionsに対し約4%です
- harness修正: PocketIC serverは60秒間requestがないと終了するため、負荷の高いmachineで
  compileが60秒を超えると`fetch failed`でsuiteが落ち、さらに`server.stop()`が既に終了した
  processのexitを待ち続けてNodeがawait途中で終了し、本当のerrorが表示されませんでした。
  compileを非同期化してheartbeatでserverを維持し、`stop()`に上限を設けました
- Candid: `merkleSpec`・`verifyProof`・`verifyMultiproof`と付随するrecord型の追加のみ。
  既存型へのvariant tag追加なし。stable dataは不変 (`treeVersion`は既に全batchに保存済み)

詳細は`protocol/MERKLE_V1.md`。

## 2026-09-24に追加で実行済み (apps/01_creator_proof_registry, issue #8)

- counterclaim / dispute workflow。**recordには一切触れません**。disputeはrecord idを
  キーとする別構造で、dispute系のどのendpointもrecord・status・certified digestを変更
  できません。upheldのdetermination後もrecord digestがbyte単位で同一で、subnetが同じ
  digestをattestし続けることをreplica suiteで確認しています
- technical status (`#active` / `#revoked`、ownerの操作) とauthorityのoutcomeを分離。
  determinationは「登録済みauthorityが自らのpolicyの下でそう判断した」という記録で、
  registryは法的な真偽を宣言せず、authority同士が食い違っても勝者を選びません。
  verifier向けの文言 (`test/dispute-log.mjs`の`render`) がrecordを「無効」「虚偽」と
  呼ばないことまでassertしています
- 全遷移はper-disputeのhash chain (`DisputeLog.mo`) に記録され、headは`["dispute", id]`で
  certifiedされます。`Dispute`は`Dispute.apply`をevent logにfoldしたものに過ぎず、
  readerはexportからstateを再構築して照合できます。event encodingは意図的に2実装
  (`backend/src/DisputeLog.mo` / `test/dispute-log.mjs`) で、suiteはcanisterが生成した
  全eventをJS側で再hashし、`test/Dispute.test.mo`はJS側が生成したbyte列とhashを固定します
- `exportDispute`は1つのwitnessで`["record", r]`と`["dispute", d]`の両方を明かします。
  eventの改変・削除、logと食い違うdispute、改変されたrecord、そして**古いlogを現在の
  certificateと組み合わせたもの** (chainは健全でrecordも一致し、certified headでしか
  検出できない) をそれぞれ意図したステップで拒否することを確認
- abuse control: claimantごとの24時間5件のfiling rate (取り下げても枠は戻らない)、
  claimant・recordごとの未解決上限、claimant×recordで未解決1件、90日内に`#abusive`
  3件でfiling停止 (`#dismissed`は数えない)。すべてper-principalなのでSybilには
  record単位でしか効きません。それに効くbondは#12/#22の範囲です
- privacy rule: private evidenceは`#sealed { custodian }` — digestとcustodianのみで、
  URIを残せるfieldが型に存在しません。custodianにURIを入れる抜け道も拒否します
- respondentはattribution先creatorの**現在の**root。署名したdelegateやrotate済みの鍵は
  回答できないことをsuiteで確認
- app 01 は 118 → 214 checks、app 02 (#9) と合わせて全体で **447 assertion、失敗0** (pocket-ic 14.0.0)。
  #8のtest plan (false report spam / private evidence pointer / appeal / conflicting
  authorities) を全て含み、upgrade後もexportが同じcertified headに検証されること、
  suspensionが残ること、dispute idが継続することを確認
- Candid: 14 methodと関連typeの追加のみ。`check_candid_compat.py`はdrift・subtyping
  (baseline `v2026.09.22`) ともにpass。stable data: 新しいmapとcounterの追加のみで、
  certified treeに`record`と並ぶ`dispute` labelが増えるだけなので、既存のrecord witnessは
  発行時のtreeに対して引き続き検証できます

詳細は`apps/01_creator_proof_registry/docs/DISPUTES.md`。

## 2026-09-24に追加で実行済み (protocol, issue #11, Verifiable Credentials)

- VC Data Model 2.0 / Data Integrity EdDSA Cryptosuites v1.0 (`eddsa-jcs-2022`) /
  Bitstring Status List v1.0 (いずれもW3C Recommendation, 2025-05-15) を確認
- **W3C Recommendation自身のtest vector (Appendix B.3) をbyte単位で再現**: canonical
  document、canonical proof config、両hash、連結hash、64-byte Ed25519署名、proofValue。
  Ed25519は決定的なので、署名一致はpipeline全体の一致を意味します
- offline suite `protocol/tools/vc.test.mjs` は**80 check**: Multikey / did:key、
  base58-btc、status listのbit順 (index 0 = 先頭byteのMSB)・gzip bomb上限・privacy最小長、
  example 4 fileのbyte単位再現、verdict (expired / not-yet-valid / revoked / suspended /
  unknown issuer / type外issuer / issuer偽装 / key rotation前後 / compromised key /
  status list取得不能・他issuer署名・短すぎ・purpose違い・bit改竄 / status必須 /
  registryとの不整合)
- pocket-ic 14.0.0上のregistry cross-check (`tools/pocket-ic/vc.test.mjs`、**20 check**):
  app 01でcreator登録・collection・delegationを作成し、それを提示するcredentialがacceptされ、
  `revokeDelegation`後は**credentialを変えずに**rejectされること。2日のdelegationは
  replica clockがexpiryを越えるとreject。membershipはcreatorの`rotateKey`でstaleになり、
  新rootへの再発行でaccept。reviewはrecordのhash不一致でreject、record revoke後はwarning
- selective disclosureは調査のみ (SD-JWT = RFC 9901、`ecdsa-sd-2023`、`bbs-2023` CRD)

詳細は`protocol/VERIFIABLE_CREDENTIALS.md`。
## 2026-09-25に追加で実行済み (apps/03_license_marketplace, issue #12)

- ICRC-1 payment verification adapter。`backend/src/Icrc3.mo` (ICRC-1 account・ICRC-3 generic
  block `Value`のdecode、subaccount正規化) と`backend/src/Payment.mo` (検査規則と、archive
  callbackを辿る`fetchBlock`)。`Ledger` actor型は標準の4 method (`icrc1_symbol`・
  `icrc1_decimals`・`icrc1_fee`・`icrc3_get_blocks`) だけで、特定ledger固有のAPIを使いません
- controllerが`registerLedger`したledgerのlistingは`#verified`になり、buyerは
  `openPurchase`で得たintent (payTo・base unitsのamount・decimals・上乗せのfee・32-byte memo・
  24時間の窓) どおりに送金して`confirmPayment(intent, block)`します。grantはledgerが読んだ
  blockが送金先・送金者・金額 (fee別)・memo・時刻・未使用の全条件を満たしたときだけ発行され、
  `#verified` listingでは`submitPurchase` (forged receiptがgrantになる経路) が拒否されます
- memoは`SHA-256("icp-license-intent:v1" || 0x00 || marketplace principal || 0x00 || intent id)`。
  dedupはcanister単位なので、canisterを含めないと同じ支払いを別のmarketplace deploymentでも
  主張できます。intent idは予測可能なので、時刻窓で「intentより前の支払い」を拒否します
- `confirmPayment`はledger呼び出しの**後**でintent状態・`(ledger, block)` index・在庫を
  読み直し、その読み取りとgrant書き込みの間にawaitを挟みません
- interpreter (`test/Payment.test.mo`): legacy `tx.op`形式、両レベルのfee、mint・burn・
  approve・`2xfer`、30-byte principal、短いsubaccount、型違いのfield、全reject理由
- replica suite (pocket-ic 14.0.0、`test/fixtures/MockLedger.mo`でbuyerが実際に送金):
  app 03 は **44 → 110 checks**。test planの wrong recipient・underpayment (ちょうどfee分)・
  duplicate block (別intent、同じledgerのmanual flow、upgrade後)・timeout after success
  (同じgrantが返り、grant数が増えない) に加え、他人の支払い、memoなし、mint、ICRC-2
  transfer-from、存在しないblock、intent前の支払い、期限後の支払い、archive経由のblock、
  ledgerのreject (状態不変で、retryで成功)、支払い後の売り切れ (`#paidSoldOut`、blockは消費)、
  ledgerでないcanisterの登録
- Candid: 7 methodと新しい型の追加のみ。既存`Error`にtagを足さず、新設の`PaymentError`を返します。
  stable dataはside tableの追加のみで`Listing`・`Order`・`LicenseGrant`は不変、migration不要
- 未実施: refund / escrow (#13)、mainnet ledgerでの実行、ICRC-3 `phash` chain・certificateの検証

詳細は`apps/03_license_marketplace/docs/PAYMENTS.md`。

## 2026-09-25に追加で実行済み (protocol, issue #39, AI attestation)

- `AIGenerationAttestation` (provider / local tool) と`AIUsageReviewCredential` (organization) を
  #11のVC基盤 (eddsa-jcs-2022、issuer policy、key rotation、status list) の上に定義。
  evidence levelは`none` / `self-asserted` / `tool-signed` / `organization-reviewed`
- offline suite `protocol/tools/ai-attestation.test.mjs` は**51 check**: example 5 fileの
  byte単位再現、sealed promptの開示と誤開示、**平文SHA-256のpromptは推測リストで復元でき、
  sealed commitmentは復元できない**ことの実演、3段階の区別、他artifactへのreplay (単独 /
  有効なattestationと併用 / reviewのreplay)、編集前draftをparentとして束縛、manifestとの
  矛盾 (AI使用のunderstate、prompt commitment不一致、未記載model、別principal宛て)、
  provider key rotation前後・compromised key・status listによるrevoke、provider不在
  (生成時 / 検証時、fail closedとwarn)、model aliasの解決とversion欠落、local modelと
  未登録local key、model名・provider名へのprompt injection (改行・ANSI escape・RLO)
- attestation schema (`protocol/schemas/ai-attestation.schema.json`) とexample manifestを
  jsonschema 4.x (Draft 2020-12) で検証

詳細は`protocol/AI_ATTESTATION.md`。

## 2026-09-25に追加で実行済み (apps/05_usage_metered_saas, issue #15)

- 署名付きusage receipt。攻撃者が盗むべきものを2つに分けます: receiptを**提出**する
  reporter principal (callの認証) と、usageを観測した場所でreceiptに**署名**する
  登録済みdevice鍵 (P-256)。片方だけでは請求を偽造できません。`requireSignatures`の
  reporterは未署名の`recordUsage`経路も閉じられます
- receipt layoutは`canister`・reporter・keyId・tenant・units・category・
  idempotencyKey・observedAtをdomain separator付きで束縛します。`canister`により
  stagingのreceiptをproductionへ流用できません。署名は`test/receipt.mjs` (node:crypto)
  で生成し、canisterが受理したreceiptはすべてcross-implementation検査になります
- **`mo:ecdsa` 8.0.1はhigh-S署名を受理します**。`verify`内のlow-S検査は、
  `Signature`の構築時に`s`が正規化された後の値しか見ないためです。pinしたhigh-S vector
  (`test/Receipt.test.mo`) で発見し、受信した値に対してrangeとlow-Sを自前で検査しています
- replayは元のeventだけを返し何も記録しません (再提出・batch内の重複・upgrade後の
  再提出)。同じidempotency keyで内容が違うreceiptは`#conflict`
- 時計: 5分より未来は`#future`、7日より古いものは`#stale`、鍵の登録前は`#keyNotValid`。
  rotationで退役した鍵は退役前に観測したreceiptだけ有効、compromisedの鍵は
  `observedAt`に関係なく全て拒否 (時刻は盗んだ側が選べるため)
- reporter policy: tenant・category scope、1件あたり・tumbling windowあたりの上限。
  `getReporter`のhealthはwindow内のunits・rejection・理由別counter・anomaly flag
  (window内3件のrejectionまたはwindow上限の80%) を返します
- `exportUsageAudit`はeventを署名付きreceiptと公開鍵つきで返し、auditorは
  node:cryptoだけで請求を再検証できます
- コスト (pocket-ic 14.0.0で測定): receipt 1件の検証は約**0.7B cycles**
  (application subnetで約1.8B instructions)、replayは約0.7M cycles。update messageの
  上限40B instructionsから`maxBatch`を16 (約28B) とし、suiteは最大batchが1 messageに
  収まることを確認しています
- app 05 は 48 → 121 checks、全体で **586 assertion、失敗0** (pocket-ic 14.0.0)。
  #15のtest plan (key rotation / offline batch / future timestamp / reporter compromise)
  とacceptance criteria (invalid signature / replay / scope / rate anomaly) を全て含み、
  upgrade後も鍵・policy・health・receipt indexが残ることを確認
- Candid: 追加のみ (`recordUsage`はpolicyのないreporterに対して従来どおり)。
  stable data: map追加のみで`UsageEvent`は不変。依存に`mo:ecdsa` 8.0.1 (Apache-2.0) を追加

詳細は`apps/05_usage_metered_saas/docs/RECEIPTS.md`。

## 2026-09-25に追加で実行済み (apps/04_bounty_board, issue #13)

- ICRC-2 escrow。controllerが`registerLedger`したledgerのbountyはescrow必須で、ownerが
  `icrc2_approve`したdepositを`fundEscrow`がbounty専用subaccount (bounty idのbig-endian 32 byte)
  へ`icrc2_transfer_from`で引き込むまで、`submit`・`award`は拒否されます。`award`はwinnerへ
  reward、platformへcut (bounty作成時にsnapshotしたrate) を送金、funded後の`cancelBounty`は返金
- ledger呼び出しは`backend/src/Ledger.mo`に隔離し、応答を executed (`Ok`/`Duplicate`)・refused・
  bad fee・unknown (reject/trap/timeout)・stale (`TooOld`) の5つに還元。全transferは金額・fee・
  memo・`created_at_time`を最初の試行前に確定し、**結果不明なら同一引数で再試行**して
  ledgerのdeduplicationで`Duplicate`として解決します。引数を変えるのは確定的なrefusalの後だけ
  (結果不明のまま引数を変えると別取引として二重払いになるため)。dedup窓 (24時間) を過ぎた
  `TooOld`はescrow subaccountの残高で判定します (そのbountyの送金しか残高を動かさないため)
- `award`はお金を動かす前にawardを確定し、送金はledgerが落ちていれば`settleEscrow`
  (誰でも呼べ、固定済みの宛先にしか送金しない) が後で完了させます
- fee変更: funding前は`#feeChanged`で新しいdeposit/approvalを返し、funding後はwinnerを満額で
  払ってplatformが差額を吸収。`BadFee`を見るとregistryのfeeも更新し、以後のbountyは実際のfeeで
  価格付けされます
- 会計不変条件 `winner + platform + 実行した送金のfee + dust = deposit, dust <= fee` を
  `test/Escrow.test.mo`で576組合せ (reward 6 × rate 4 × funding時fee 4 × payout時fee 6) 検査
- replica suite (pocket-ic 14.0.0、`test/fixtures/MockLedger.mo`はfee上乗せ・期限付きallowance・
  dedup優先・24時間後の`TooOld`を参照実装どおりに実装し、送金を実行してから**replyを落とす**
  controlを持つ): app 04 は **39 → 123 checks**。test planの allowance expires・fee changes
  (funding前/payout時)・insufficient funds・duplicate callback (pullとwinner payoutの両方で
  replyを落とし、ownerは1回だけ課金、winnerは1回だけ受領) に加え、approvalなしのfunding、
  award時のledger停止と復旧後のsettle、funded bountyの返金、pull結果不明のままのcancel
  (pullを解決してから返金)、未fundのclose、`TooOld`の残高による解決、再settleで何も動かない
  こと、upgrade越しの保存。**全8 escrowでledger上のsubaccount残高がop logから計算した帳簿と一致**
- Candid: 7 methodと型の追加のみ。`award`・`cancelBounty`のsignatureと既存`Error`は不変。
  stable dataはside tableの追加のみで`Bounty`・`Award`は不変、migration不要
- 未実施: mainnet ledger、複数winner・部分award、award自体のdispute

詳細は`apps/04_bounty_board/docs/ESCROW.md`。

## 2026-09-25に追加で実行済み (apps/05_usage_metered_saas, issue #14)

- billing period・invoice・payment・adjustment。**invoiceは一度だけ作られ、以後変更されません**。
  支払いとadjustment (credit / debit note) は別レコードとして追記し、balanceと状態は
  3つから計算します。credit適用後もinvoice recordがbyte単位で同一であることを確認
- periodはplanの境界に揃い、一度だけcloseされます (rollover時・`closePeriod`・plan変更時)。
  closeと次期間への移行が同じ処理なので同じ期間を2回closeする経路はなく、
  期間終了前や2回目の`closePeriod`は`#conflict`
- 締め後に届いたreceipt (#15のoffline batch) は**記録された期間**に計上され`lateEvents`で
  示されます。閉じたinvoiceは遡って変わりません
- plan変更は旧planの日割り (切り捨て) で締め、新planは新しい期間から。通貨変更後も
  旧invoiceは旧通貨のままで、そのledgerでしか支払えません
- 支払いはICRC-1 transferのblockをledgerから読んで検証 (#12と同じICRC-3 adapter):
  payee account・invoice memo (canister principalとinvoice idを束縛)・発行後のtimestamp。
  `(ledger, block)`は一度しか適用されず、ledger不通は何も変えずに再試行可能
- 全invoiceをsuite側 (JavaScript) で`getUsageEvent`とplan snapshotから再計算して一致を確認
- `invoiceJson`は顧客向けJSON (RFC 8259 escape、RFC 3339時刻、整数minor unitとdecimals)
- app 05 は 121 → 183 checks、全体で **732 assertion、失敗0** (pocket-ic 14.0.0)。
  #14のtest plan (late event / plan change mid-period / refund・credit / currency change)
  とacceptance criteriaを全て含み、upgrade後もinvoice・payment・adjustmentが残り
  支払いの再提出が二重適用されないことを確認
- Candid: 追加のみ。stable data: map追加のみで`Tenant`・`UsageEvent`は不変。
  挙動の変更: periodの開始が「境界後最初のevent」からplan境界に揃います (quotaのreset位置のみ)

詳細は`apps/05_usage_metered_saas/docs/BILLING.md`。
## 2026-09-25に追加で実行済み (labs/migration-chain, issue #16)

- moc 1.11.1の`--enhanced-migration`で、V1 → V2 (eager) → V3 (lazy) のmigration chainを
  3つの版としてbuild。stable変数は初期化子を持たず、値はmigration chainのみが決めます
- pocket-ic 14.0.0上のrehearsal (`labs/migration-chain/test/migration-chain.test.mjs`、
  **40 check**): empty state、30,001件のlarge map、revoked variant、中断したrollout
  (trapするmigration 3はrollbackされV2がそのまま稼働、修正版で再適用)、V1からV3への
  fast-forward、同一版の再deployがno-opであること。各段階でsampleしたrecordがfixture規則と
  完全一致することを確認
- data size: eager step (V1→V2) は0件で42,092、1,000件で1,029,357、10,000件で9,983,954、
  30,001件で29,870,466 instructions (約1,000/record、線形)。lazy step (V2→V3) は
  件数によらず約40.9k instructions
- gate: 型検査は通るがchainに説明のない変更はcompile時に**M0170**で拒否。
  `moc --stable-compatible`はV1→V2・V2→V3・V1→V3でpass、V3→V2・V2→V1はM0169でfail。
  replicaはV3→V2・V3→V1のdowngradeを`Memory-incompatible program upgrade`で拒否し、
  V3とdataはそのまま残ります

詳細は`labs/migration-chain/README.md`。

## 2026-09-25に追加で実行済み (governance, issue #40)

- `docs/26_GOVERNANCE_DECISION_RECORD.md`: phase 0 (単一controller、価値のあるものが依存しない間のみ)、
  phase 1 (k-of-n threshold controller、module hashの事前告知と再現buildとの照合、特権呼び出しの公開log、
  parameter変更の遅延)、緊急権限 (サービスを止めるだけ・小さいthreshold・72時間で失効)、
  SNSのgo/no-go基準 (#21 / #28 / #29 / #35 / #20 / #24 / #25 / #36が前提で、既定はno)
- 特権メソッドの一覧を**CIで強制**: `scripts/check_privileged_actions.py`は`isController`・app 06の
  owner・workerのfirst-caller controllerで保護されたpublic methodを、private helper経由のもの
  (`isReporter`、`mayRead`) まで含めて検出し、一覧との過不足でCIを落とします。self-testは各検出経路が
  効くことを確認します。現在36 method
- 一覧作成で見つかったphase 1のblocker: app 06のorchestratorとworkerは最初の呼び出し者がownerになる
  (公開環境ではfront-runされうる)、app 05のcontrollerはreporter policyの外で任意のtenantのusageを記録できる

## 2026-09-25に追加で実行済み (compiler, issue #31)

- `caffeinelabs/motoko`のopen issue 211件 (PR除く) をread-onlyで取得・分類
- 再現9件をmoc 1.11.1 (pinned) と1.16.1 (最新release、2026-09-16) で実行
  (`compiler/repros/triage-2026-09/run.mjs`)。両versionで結果は同一: 4件は再現
  (#3464 OOPS、#3819 IR type error、#4701 `compile_lit_pat`、#2017)、5件は記載どおりには
  再現せず (#3624はcrashが消えたが`--check`と`-c`が不一致、#3993・#3117・#4733・#3855)
- masterはbuildしていません (docに明記)。upstreamへのcomment・反応は一切行っていません
## 2026-09-25に追加で実行済み (design, issue #23)

- `docs/27_TENANT_SHARDING_DESIGN.md`とexecutable model `tools/sharding/` (61 checks、offline・依存なし・
  決定的、`run_offline_checks.sh`の[8/12])。routing keyはtenant (hot tenantはcollectionで分割)、
  writeはepoch付きで、staleなrouteはredirect 1回で済みます
- 重複artifact hashはshardが受理し、rebuildableなindexが`(committedAt, shard, commitment)`最小で決定。
  後の主張は削除せず重複として報告。3者の重複を全6通りの到着順で配送して同じ結果になることを確認
- indexはshardごとの連番event logだけから構築 (冪等・gap拒否・shard間の順序非依存)。50通りの
  interleavingと二重配送の結果がlogからのreplayと一致
- tenant移動は再実行可能な冪等step (freeze・checksum付きcopy・content hashで検証・flip)。
  中断後の再実行、移動中writeの再試行可能な拒否、cross-shard parentの同期検証
  (到達不能はretryable refusalで、未検証のまま受理しない) を確認
- 未実施: shard / router canister本体、#19のexport形式、#30の測定値による閾値、pocket-ic上の実移動rehearsal

## 未実施のproduction gate
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
| Enhanced multi-migration chain (labs) | V1→V2→V3 rehearsed on pocket-ic 14.0.0, 40 checks; incompatible edit fails with M0170; downgrade refused |
| AI tool/model attestation | 51 offline checks; three evidence levels, replay, sealed prompts, rotation/revocation, prompt injection |
| Verifiable Credentials (eddsa-jcs-2022) | W3C Recommendation vector reproduced byte for byte; 80 offline checks + 20 on pocket-ic 14.0.0 against app 01 identity |
| C2PA bridge (PNG) | 116 offline checks + 22 on pocket-ic 14.0.0; credentials read as Trusted by c2patool 0.27.22 and c2patool credentials validated here |
| Merkle tree v1 | frozen; 98 transparency-dev RFC 9162 probes, 43 v1 vectors, verified by independent JavaScript and Motoko implementations |
| Motoko/Candid API surface | offline mechanically cross-checked |
| Motoko compile/test/Wasm/Candid | passed for all 6 applications |
| Nix toolchain bootstrap | passed with read-only global npm prefix |
| PocketIC replica run | passed for all 6 applications (pocket-ic 14.0.0), 732 + 55 assertions |
| local replica (`icp deploy`) | passed for app 06 (icp-cli 1.2.0 / launcher 15.0.0) |
| upgrade rehearsal | passed for all 6 applications; across a breaking Candid change, untried |
| documentation site | 128 pages built strict, 0 warnings; published from `main` |
| PocketIC replica run | passed for app 06 (pocket-ic 14.0.0); app 01 benchmarked on pocket-ic 14.0.0 and exercised against a local `icp deploy`; pending for apps 02-05 |
| upgrade rehearsal | pending integration gate |
| production readiness | reference implementation; integration, load test, audit required |
