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
| C2PA bridge (PNG) | 116 offline checks + 22 on pocket-ic 14.0.0; credentials read as Trusted by c2patool 0.27.22 and c2patool credentials validated here |
| Merkle tree v1 | frozen; 98 transparency-dev RFC 9162 probes, 43 v1 vectors, verified by independent JavaScript and Motoko implementations |
| Motoko/Candid API surface | offline mechanically cross-checked |
| Motoko compile/test/Wasm/Candid | passed for all 6 applications |
| Nix toolchain bootstrap | passed with read-only global npm prefix |
| PocketIC replica run | passed for all 6 applications (pocket-ic 14.0.0), 280 + 55 assertions |
| local replica (`icp deploy`) | passed for app 06 (icp-cli 1.2.0 / launcher 15.0.0) |
| upgrade rehearsal | passed for all 6 applications; across a breaking Candid change, untried |
| documentation site | 128 pages built strict, 0 warnings; published from `main` |
| PocketIC replica run | passed for app 06 (pocket-ic 14.0.0); app 01 benchmarked on pocket-ic 14.0.0 and exercised against a local `icp deploy`; pending for apps 02-05 |
| upgrade rehearsal | pending integration gate |
| production readiness | reference implementation; integration, load test, audit required |
