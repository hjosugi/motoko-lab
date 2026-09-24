# App 02 — Merkle Anchor

多数のartifact/proofを1つのMerkle rootへまとめ、batch metadataをMotoko canisterへanchorします。個別leafとproof pathはoff-chainで保持し、rootだけをpublic registryへ保存します。

## Why

- one update per batch
- lower on-chain metadata cost
- offline/third-party verification
- studio/export pipelineとの相性

## API

- `anchor`: unique 32-byte root、leaf count、schema/policy URIを登録。`treeVersion`は`icp-merkle:v1`、`hashAlgorithm`は`sha256`のみ受け付けます
- `revoke`: ownerがreason付き失効
- `getBatch` / `getByRoot`
- `listBatches`
- `stats`
- `verifyProof`: 1 leafのRFC 9162 audit pathをanchor済みrootに対して検証 (query)
- `verifyMultiproof`: 最大256 leafを1つのmultiproofで検証 (query)
- `merkleSpec`: canisterが実装しているtree rules

## Tree rules (`icp-merkle:v1`)

leafは32-byte digest、leaf hashは`SHA-256(0x00 || "icp-merkle:v1" || leaf)`、nodeは`SHA-256(0x01 || left || right)`、shapeはRFC 9162 (Certificate Transparency) と同じです。奇数nodeを複製しない (CVE-2012-2459型の曖昧性がない)、pairはsortせず位置で並べる、proof長は`(index, size)`で一意に決まる、という規則と理由は[protocol/MERKLE_V1.md](../../protocol/MERKLE_V1.md)にあります。

reference実装は`protocol/tools/merkle.mjs` (Node)、canister側は`backend/src/Merkle.mo`で、コードを共有していません。`test/Merkle.test.mo`は公開vector全件とtransparency-dev/merkleのprobe 98件をMotoko実装で検証し、replica suiteはJavaScriptで作ったproofをon-chainで検証します。

```bash
node ../../protocol/tools/provenance-cli.mjs merkle-root leaves.txt
node ../../protocol/tools/provenance-cli.mjs merkle-prove leaves.txt --index 2 > proof.json
node ../../protocol/tools/provenance-cli.mjs merkle-verify proof.json --root <anchorのroot> --leaf-count <anchorのleafCount>
mops bench --replica pocket-ic   # bench/merkle.bench.mo
```

## Trust boundary

canisterはanchor時点のrootとowner、そしてleafがそのrootの木に含まれるかを保証します。leafの内容が真実かは保証しません。tree sizeは常にanchor済みの`leafCount`を使います (RFC 9162のaudit pathはtree sizeを認証しないため、callerにsizeを選ばせない)。`verifyProof`はqueryなので、最終的な検証はverifier自身が`merkle.mjs`などで行うのが正です。

`icp-merkle:v1`導入前に別の`treeVersion`でanchorされたbatchは、そのまま保存され、`verifyProof`では`#conflict`になります。v1 rulesで読み替えることはしません。

## Production gaps

- independent audit of the Merkle implementation
- certified query
- batch fee/quota
- cross-registry references
- key delegation
