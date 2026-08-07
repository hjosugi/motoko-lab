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

## Data limits

- digest: exactly 32 bytes
- salt: 16–64 bytes
- title: 1–200 chars
- URI: <=2048 chars
- parents: <=32
- page limit: <=100

## Production gaps

- key rotation/delegation
- C2PA/W3C VC bridge
- abuse fee/rate limit
- PocketIC and upgrade tests
- production frontend

`docs/THREAT_MODEL.md`とroot backlogを参照してください。
