# Production Services and Evidence

確認日: 2026-07-20 JST。指標は変動します。

## Evidence levels

- A: current product/help pageとsourceがMotokoを明示
- B: public repositoryでMotoko implementationを確認
- C: ICP serviceとして稼働するが、Motoko範囲が一部または不明
- D: architecture参考。Motoko実装例として数えない

## Verified examples

| Service | Production evidence | Motoko evidence | Monetization evidence | Level |
|---|---|---|---|---|
| Caffeine | live app builder、apps run on ICP、GitHub/ZIP export | official help says backend is Motoko; export contains Motoko backend | Free/Host/Studio paid plans; Host $5/mo, Studio $25/mo at snapshot | A |
| ICDex | on-chain order-book DEX、mainnet dependencies/canister IDs documented | repository is predominantly Motoko and publishes `.mo` source/module hashes | DEX supports fee-capable trading; public volume/TVL indicates real use, but profit not proven | B |
| ICPSwap staking pool | production ecosystem component and released repository | staking-pool repository explicitly says Motoko, language ratio predominantly Motoko | platform has material DEX volume/TVL; repository includes fee receiver, but retained revenue/profit not verified | B/C |
| Mops | package registry/manager used by Motoko projects | Motoko ecosystem infrastructure hosted on IC | public monetization not established | B |
| Motoko Playground | browser compile/deploy service | official Motoko project | not a monetization example; deprecated in favor of current tooling/ICP Ninja | B, historical |

## ICP examples that should not be mislabeled as Motoko

OpenChat and TAGGR are valuable production references, but their current primary backends are Rust. Use them to study ICP architecture, not as proof that a service is written in Motoko.

WaterNeuron has publicly tracked protocol fee/revenue data on ICP and is a useful monetization reference. This kit did not establish that its current production implementation is Motoko, so it is not counted as a Motoko success case.

## What “successful monetization” means here

公開情報から区別します。

1. paid pricing exists
2. on-chain usage exists
3. protocol fees exist
4. revenue is publicly tracked
5. profit/retained earnings is verified

Caffeineは1を満たします。ICDex/ICPSwapは2とfee mechanismを確認できます。WaterNeuronは4まで第三者dataで確認できますが、Motoko implementation evidenceが不足します。非公開company revenueやprofitを推測しません。
