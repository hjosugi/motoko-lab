# App 01 — Creator Proof Registry

## Product

creatorがpublication前にsalted commitmentを登録し、後からartifact/manifest metadataをrevealするreference canisterです。recordは失効できますが削除せず、派生元をlinkします。

## What it proves

- caller principalがcommitment hashをあるnetwork timeまでに登録した
- reveal recordとcommitmentを第三者がoff-chainで再計算できる
- record lifecycleとrevocationが改ざん困難な履歴になる

## What it does not prove

- legal authorship
- originality or plagiarism-free status
- human-only creation
- self-declared AI disclosureのtruthfulness

## Run

```bash
mops install
mops check
mops test
mops build
icp network start -d
icp deploy
```

Candid UI URLは`icp deploy`のoutputに表示されます。

## API

| Method | Caller | Purpose |
|---|---|---|
| `commit` | authenticated | 32-byte commitmentを登録 |
| `cancelCommitment` | commitment owner | unrevealed commitmentをcancel |
| `reveal` | commitment owner | proof recordを作成 |
| `revokeRecord` | record owner | reason付き失効 |
| `getCommitment` | anyone | commitment取得 |
| `getRecord` | anyone | record取得 (uncertified) |
| `getRecordCertified` | anyone | recordをsubnet certificate + witness付きで取得 |
| `getByArtifactHash` | anyone | artifact digest検索 |
| `listRecords` | anyone | bounded pagination |
| `commitmentSpec` | anyone | commitment layoutとsalt boundsを取得 |
| `registerCreator` | authenticated | creator identityを取得 |
| `rotateKey` | creator root | root keyを交代 (旧recordはそのまま) |
| `createCollection` | creator root | delegationのscope単位を作成 |
| `createDelegation` | creator root | scope・期限付きでdelegateを承認 |
| `revokeDelegation` | creator root | delegateを失効 |
| `declareRecovery` | creator root | guardianと遅延を事前宣言 |
| `beginRecovery` / `cancelRecovery` / `confirmRecovery` | guardian / root | 遅延付きrecovery |
| `attribution` | anyone | recordのcreator・signer・authorityを取得 |
| `fileDispute` | authenticated (respondent以外) | recordへのcounterclaimを提出 (rate limit付き) |
| `respondToDispute` | respondent | counterclaimに一度だけ回答 |
| `addDisputeEvidence` | claimant / respondent | 未解決の間evidenceを追加 |
| `determineDispute` | 登録済みauthority | roundごとに一度determinationを記録 |
| `appealDispute` / `withdrawDispute` | 当事者 / claimant | appeal (各側1回) / determination前の取り下げ |
| `addDisputeAuthority` / `retireDisputeAuthority` | controller | authorityの登録・退任 |
| `getDispute` / `listDisputes` / `disputeEvents` / `disputeSummary` | anyone | dispute・event log・集計を取得 |
| `exportDispute` | anyone | record + event log + certificate付きのportable export |
| `exportSummary` / `exportCommitments` / `exportRecords` | anyone | commitment/recordのpage export、checksum・roots・policy付き (#19) |
| `restoreBegin` / `restoreCommitments` / `restoreRecords` / `restoreFinish` | controller、空canisterのみ | exportからのrestore。countsとrootsが一致しなければfinishは拒否 (#19) |
| `stats` | anyone | count取得 |

## Commitment

off-chain CLI:

```bash
node ../../protocol/tools/provenance-cli.mjs manifest-hash ../../protocol/examples/ai-assisted.json
node ../../protocol/tools/provenance-cli.mjs commitment \
  --principal aaaaa-aa \
  --manifest-hash <64-hex> \
  --salt <32-or-more-hex>
```

canisterは`reveal`時にcommitmentを`mo:sha2`で再計算し、caller principal・manifest hash・saltのいずれかが一致しなければrejectします。off-chain verifierとcanisterは同じpreimage layoutを使うので、CLIが出したcommitmentはそのまま`commit`に渡せます。

```
SHA-256( "icp-creator-proof:v1" || 0x00 || principalText || 0x00 || manifestHash || 0x00 || salt )
```

preimage中のprincipalは常にcallerのものです。requestから来た値ではないので、他人名義でcommitすることはできません。layoutとsalt boundsは`commitmentSpec`で取得できます。詳細・conformance vector・instruction costは`docs/COMMITMENT_V1.md`を参照してください。

## Disputes

第三者はrecordに対してcounterclaimを提出できます (#8)。recordそのものは一切変更されず、status (`#active` / `#revoked`) はownerの操作だけが決めます。authorityのdeterminationは「そのauthorityが自らのpolicyの下でそう判断した」という記録であり、registryは法的な真偽を宣言せず、authority同士が食い違っても勝者を選びません。すべての遷移はhash chainで連結されたevent logに記録され、headは`["dispute", id]`でcertifiedされます。`exportDispute`はrecordとdisputeの両方を1つのcertificateで検証できる自己完結の文書です。privateなevidenceはdigestとcustodianだけをon-chainに置きます。lifecycle、abuse control、privacy rule、byte layoutは`docs/DISPUTES.md`を参照してください。

## Portable export and restore

commitmentとrecord全体を、canisterの外部で検証・保管・復元できる形式で取り出せます (#19)。`exportSummary`がcountsとroots (id順のdigest列へのSHA-256) を返し、`exportCommitments` / `exportRecords`がbounded pageをchecksum付きで返します。reader (`tools/export/format.mjs`) はpage checksumとrootsを独立に再計算し、bundle (`tools/export/bundle.mjs`) は中断したexportをpage単位で再開します。`includeStorageUris=false`のredactionはdigest計算の前に適用されるので、redacted exportのrootsは実際に渡した内容を指します。

restoreはcontroller専用で、何も持たないcanisterにしか開けません。id順にimportし、同じpageの再送はbyte-identicalなときだけ受理され、`restoreFinish`がcounts・roots・record/commitmentの相互参照をすべて検証して初めて閉じます。recordはimport時に再certifyされるため、restored canisterでもcertified queryが使えます。設計、byte layout、限界は`docs/31_PORTABLE_EXPORT.md`を参照してください。

## Data limits

- digest: exactly 32 bytes
- salt: 16–64 bytes
- title: 1–200 chars
- URI: <=2048 chars
- parents: <=32
- page limit: <=100

## Production gaps

- C2PA/W3C VC bridge
- abuse fee/rate limit (disputesにはper-principal rate limitとstrikeがある; bondは#12/#22)
- PocketIC and upgrade tests
- production frontend

`docs/THREAT_MODEL.md`とroot backlogを参照してください。
