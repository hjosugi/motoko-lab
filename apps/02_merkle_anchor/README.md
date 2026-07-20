# App 02 — Merkle Anchor

多数のartifact/proofを1つのMerkle rootへまとめ、batch metadataをMotoko canisterへanchorします。個別leafとproof pathはoff-chainで保持し、rootだけをpublic registryへ保存します。

## Why

- one update per batch
- lower on-chain metadata cost
- offline/third-party verification
- studio/export pipelineとの相性

## API

- `anchor`: unique 32-byte root、leaf count、schema/policy URIを登録
- `revoke`: ownerがreason付き失効
- `getBatch` / `getByRoot`
- `listBatches`
- `stats`

## Trust boundary

canisterはMerkle proofを検証しません。anchor時点のrootとownerを保証します。leaf/proof verifier、hash algorithm、tree constructionはprotocol versionで固定する必要があります。

## Production gaps

- audited Merkle implementation and test vectors
- proof verification endpoint
- certified query
- batch fee/quota
- cross-registry references
- key delegation
