# Source Evidence Ledger

確認日: 2026-07-20 JST

| Claim | Source | Confidence |
|---|---|---|
| Motoko is actor-based language for ICP canisters | https://github.com/caffeinelabs/motoko | High |
| Latest changelog entry is 1.11.1 dated 2026-07-15 | https://github.com/caffeinelabs/motoko/blob/master/Changelog.md | High |
| `core` replaces `base`; README example uses 2.6.0 | https://github.com/caffeinelabs/motoko-core | High |
| `icp-cli` is primary current lifecycle tool | https://docs.internetcomputer.org/developer-tools/ | High |
| Motoko recipe v5 uses Mops config | https://docs.internetcomputer.org/getting-started/project-structure/ | High |
| Enhanced orthogonal persistence is current default | https://docs.internetcomputer.org/languages/motoko/fundamentals/actors/orthogonal-persistence/enhanced/ | High |
| Stable memory max documented as 500 GiB | https://docs.internetcomputer.org/languages/motoko/icp-features/stable-memory/ | High |
| Caffeine backend uses Motoko and code can be exported | https://help.caffeine.ai/hc/en-us/articles/46899814439700-How-Caffeine-Works | High |
| Caffeine GitHub export contains Motoko backend and React frontend | https://help.caffeine.ai/hc/en-us/articles/46899843980692-GitHub-Integration-Overview | High |
| Caffeine Host/Studio paid plans | https://help.caffeine.ai/hc/en-us/articles/46899796807060-Plans-and-Pricing | High |
| ICDex repository/mainnet deployment is documented | https://github.com/iclighthouse/ICDex | High |
| ICDex usage metrics | https://defillama.com/protocol/icdex | Medium; third party and volatile |
| ICPSwap staking pool is written in Motoko | https://github.com/ICPSwap-Labs/icpswap-staking-pool | High |
| ICPSwap usage metrics | https://defillama.com/protocol/icpswap | Medium; third party and volatile |
| WaterNeuron protocol fee/revenue methodology | https://defillama.com/protocol/waterneuron | Medium; third party and volatile |
| W3C VC Data Model 2.0 | https://www.w3.org/TR/vc-data-model-2.0/ | High |
| JSON Canonicalization Scheme | https://www.rfc-editor.org/rfc/rfc8785 | High |
| C2PA specification | https://c2pa.org/specifications/specifications/2.3/index.html | High |

## Evidence discipline

- repository language ratioだけでproduction canister全体のlanguageを断定しない
- pricing pageだけでrevenue/profitを断定しない
- volume/TVLだけでfee revenueを計算しない
- docs sample versionとrepository releaseがずれる場合、snapshot dateとsourceを両方残す
