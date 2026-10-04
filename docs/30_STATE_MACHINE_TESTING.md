# State-machine testing

The replica suites in `apps/*/test/replica.test.mjs` are examples: each one
walks a hand-written path through an application and asserts what happens at
every step. They are the right shape for a feature under development — the
comments say *why* each refusal exists — but they only visit the sequences
someone thought of. Lifecycle bugs live in the sequences nobody thought of:
the second cancellation after an upgrade, the reveal that reuses an artifact
from a record revoked two commands earlier, the quota fill that lands exactly
on the boundary and then asks for one unit more.

This directory adds the other half: property-based state-machine tests. A
**pure model** of each application is written down in JavaScript, a seeded
generator draws long random command sequences against it, every command is
executed against a **real replica**, and the observation is compared with the
model's prediction. When the two disagree, the sequence is **shrunk** by
deleting steps until the smallest reproduction remains, and that sequence is
written to a file so it can be replayed exactly.

## Running

```sh
# The framework and the models, no replica and no toolchain needed. Runs in the
# ordinary CI job.
node tools/state-machine/framework.test.mjs

# The real thing: four canisters, two seeds each, 120 steps per seed.
node tools/state-machine/run.mjs

# One model, more seeds, longer sequences.
node tools/state-machine/run.mjs --seed 7 --steps 300 registry
node tools/state-machine/run.mjs --seeds 1,2,3,4,5

# What is available.
node tools/state-machine/run.mjs --list
```

`make state-machine-tests` runs the replica half; the Replica workflow runs it
after the per-app suites. The default seeds are fixed (`1, 2`), so "it failed
once" is something a second run can see, and `--seed 7` names the same sequence
forever.

## The four acceptance criteria

The issue's criteria are the models' central invariants, and each is checked
twice: `predict` says what must happen, and `observe` sweeps the canister for
the property itself.

| Criterion | Where the model says it | Where the canister is swept |
| --- | --- | --- |
| Revoked records never reactivate | `models/registry.mjs`, `revokeRecord` predicts `conflict` on a second revocation | Every record's status is compared with the canister on a full sweep; `getByArtifactHash` must index back to the same record |
| One receipt creates at most one grant | `models/marketplace.mjs`, `acceptPurchase` predicts `conflict` on a settled order | Every grant is reached from its order and no two grants may name one order |
| A closed bounty cannot be re-awarded | `models/bounty.mjs`, `award` predicts `conflict` on an awarded or cancelled bounty | At most one award per bounty, and an awarded bounty still names that award |
| Usage never exceeds quota | `models/metering.mjs`, `recordUsage` predicts `quotaExceeded` from the remaining quota | `used <= plan.quota` on the canister after every single step, not only where the model predicted a refusal |

Boundary Nat values are drawn rather than written as one-off cases: zero units,
an exact quota fill, `1_000_000_000` (the accepted maximum) and
`1_000_000_001` (refused) for usage; zero and huge prices and a zero supply for
listings; zero and `10^18` rewards and a past deadline for bounties; a 31-byte
digest and a Nat-1 expiry for commitments. An `__upgrade` step is generated
between commands, so every model also asserts that its state — including the
indexes that authorize and deduplicate — survives an upgrade.

## How it works

`framework.mjs` has no canister dependencies. It provides:

- a deterministic PRNG (`mulberry32`), a weighted chooser and `generateSteps`,
  which runs the **pure model forward** while drawing commands. Generation
  never touches a replica, so the same seed always yields the same steps.
- `runSequence`, which replays steps through an `io` object supplied by the
  runner, comparing every observation with the model's prediction and wrapping
  the first disagreement in a `StepFailure` naming the step.
- `shrinkSequence`, delta debugging over the step list. It only accepts a
  candidate that fails the *same* step the same way (`sameFailure`), so
  removing a step cannot quietly turn one refusal into a different bug.
- `failureBundle` / `failureSignature`, the reproduction file and its
  fingerprint.

A model is a plain object: `init`, `commands`, and `observe`. Each command has
four parts kept apart on purpose:

| Part | Pure? | Responsibility |
| --- | --- | --- |
| `generate(model, rng, index)` | yes | Draw legal arguments from the state the command will find; `null` means "not applicable now" |
| `predict(model, args)` | yes | The specification: the expected result and the next model state |
| `run(io, args)` | no | The canister call |
| `check(model, args, prediction, observed)` | no | Compare the observation with the prediction, or fail |

The runner (`run.mjs`) installs a **fresh canister per attempt**. Sharing one
across seeds or shrink candidates would let an earlier sequence's state decide
a later one, which is exactly the carry-over the tests exist to rule out. The
replica is created with `canisterExecutionRateLimiting` disabled and the
install is retried on `SysTransient`, because shrinking installs a canister per
candidate and the install limiter would otherwise refuse long before the
shrinking is done.

A failing run writes `.state-machine-failures/<model>-seed-<seed>.json`
(gitignored): the model, the seed, the minimal step list and the message. The
step list is the reproduction; the same seed regenerates it without the file.

## What is deliberately not modelled

A model that mirrors everything is a second implementation, and a divergence
then says nothing about which side is wrong. The models cover the lifecycle and
the authorization/deduplication state each acceptance criterion needs, and stop
at the boundaries where the per-app replica suite already goes deeper:

- **registry**: identity, delegation and disputes are not modelled. The
  commitment/record/revocation state machine is.
- **marketplace**: only the manual payment path (an unregistered ledger), so
  `submitPurchase`/`acceptPurchase`/`rejectPurchase` and the receipt index are
  modelled; `openPurchase`/`confirmPayment` and the ledger adapter are not.
- **bounty**: the unregistered-ledger path, so the board's own lifecycle is
  modelled; escrow funding, payouts and refunds are not.
- **metering**: the unsigned `recordUsage` path and the quota/period machine.
  Signed receipts, reporter policies, health and billing are not.

Each boundary is where a future model can grow; the framework does not change
when one does.

## Adding a model

1. Write `models/<app>.mjs` following the four-part command shape above. Use
   `expectOk` / `expectErr` from the framework so a refusal with the wrong
   variant fails.
2. Give it `appDir`, `canister` (name, main, did), `identities`, and — only if
   the app's admin gate is `Principal.isController` — `controller`.
3. Run `node tools/state-machine/framework.test.mjs`: it simulates every model
   forward over several seeds without a replica, which catches generator and
   prediction errors before the slow run.
4. Run `node tools/state-machine/run.mjs <app>` against a replica.

When a run fails, the disagreement is real until decided otherwise. The model
and the canister are two implementations of one promise; the reproduction says
where they part, and the fix is whichever side the specification says is
wrong — never "change the model until the test is green".
