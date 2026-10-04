# Disaster recovery and the quarterly restore drill

An export is a claim until a restore has been rehearsed against it (issue
#25). This runbook defines the disasters the registry plans for, the recovery
targets, and the drill that proves the plan on a replica — including the one
scenario no tooling can rehearse away: the deploy key is gone and someone else
has to take control.

The drill is automated in `scripts/restore_drill.mjs`; its latest report is
`validation/restore-drill.json`; the `Drill` workflow runs it on a quarterly
cron and on manual dispatch. `docs/31_PORTABLE_EXPORT.md` is the format it
exercises.

## Scenarios and targets

| Scenario | What breaks | Recovery | RTO | RPO |
|---|---|---|---|---|
| **Lost deploy key** | No controller can upgrade, restore or change settings | Add a recovery controller through the management canister; if every key is lost, the canister is frozen and recovery is the last export | 1 h | last export |
| **Bad upgrade** | New Wasm traps or corrupts state | Roll forward with a fixed Wasm; rollback is only possible from a snapshot taken before the upgrade, because stable memory is not reverted | 4 h | last snapshot |
| **Index corruption** | Queries miss records although the data is present | Reinstall from the latest verified export; the restore rebuilds the artifact and commitment indexes and re-certifies every record | 1 h | last export |
| **Off-chain vault outage** | Artifacts and private evidence are unreachable | The registry serves and restores without the vault; only availability (#38) degrades. Disputes that need the evidence wait for the vault | — | — |
| **Canister lost** | The canister id is gone or unusable | Install the pinned Wasm under a new controller, restore the export, publish the new canister id | 1 h | last export |

**RPO is the age of the last export, not a property of the chain.** The chain
keeps the state; the export is what makes it portable. A tier-1 deployment
exports at least daily and keeps the last 30 bundles plus one monthly bundle;
the runbook owner records where they live and who can read them.

## Roles

- **Incident owner** — declares the disaster, owns the clock, writes the
  post-drill actions.
- **Operator** — runs the restore, holds the controller keys, publishes the
  new canister id and the module/Candid hashes.
- **Verifier** — independently checks the restored counts and roots against
  the bundle, and a certified query against the subnet key; must not be the
  operator.
- **Counsel / privacy** — decides what may be said publicly and whether any
  personal data is affected (`docs/32_PRIVACY_AND_DATA_PROTECTION.md`).

## The drill

```sh
source scripts/toolchain_env.sh && motoko_add_toolchain_to_path
node scripts/restore_drill.mjs          # writes validation/restore-drill.json
```

On a fresh replica the script:

1. installs the registry and seeds a fixture with two records, one revoked;
2. exports it with the portable format and verifies every page and root;
3. corrupts a page and requires verification to reject it;
4. moves the controller to a second identity through the management canister,
   requires the old key to be powerless and the new key to be able to upgrade;
5. restores into a fresh canister and requires the counts, the revoked ratio,
   the record root, the rebuilt artifact index and a certified query to match;
6. records the elapsed restore time against the RTO and exits non-zero if any
   check failed.

The drill target is 15 minutes of wall clock in CI; the measured restore is
seconds on a replica and the RTO covers the human steps around it. The report
records both.

## Quarterly cadence

The `Drill` workflow runs on `cron: '0 3 1 1,4,7,10 *'` (the first of
January, April, July and October) and on manual dispatch. It uploads
`validation/restore-drill.json` as an artifact; the operator commits the
report with the post-drill actions. A quarter with no report is a finding:
the runbook owner escalates it, and `VALIDATION_STATUS.md` stops claiming a
current drill.

## Post-drill actions

The drill is not complete until the report is reviewed and the actions are
recorded:

- Every failed check becomes an issue with an owner.
- The measured restore time is compared with the RTO; a miss is an incident,
  not a test failure to retry.
- Anything the operator had to look up (a controller, a bundle location, a
  command) is added to this runbook before the next drill.
- The independent operator requirement is exercised by having someone who did
  not write the drill run it from this document alone; if they cannot, the
  runbook is the bug.

## What the drill does not cover

- **A real subnet loss or a compromised controller.** PocketIC proves the
  procedure, not the provider's behaviour or the key ceremony.
- **Legal deletion and notification duties.** Those are the privacy and legal
  checklists (#20, #35).
- **The vault.** The registry does not hold artifacts; the vault's own backup
  and restore are the operator's, and its outage is a degraded-availability
  case (#38), not a registry recovery case.
- **Cross-shard recovery.** The sharding design (#23) exports per tenant from
  one shard; each shard restores into its own canister.
