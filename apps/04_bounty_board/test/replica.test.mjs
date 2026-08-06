// Replica suite for the bounty board.
//
// Two things here exist nowhere else in the kit. The one-submission-per-caller
// rule is keyed on `(bountyId, caller)`, so it cannot be tested without real
// callers at all. And the deadline is wall-clock: the replica lets time be
// moved, which is the only way to reach `#deadlinePassed` without waiting.
//
//   node tools/pocket-ic/run.mjs 04

import { bigintSafe, buildCanister, digest, upgradeCanister } from '../../../tools/pocket-ic/harness.mjs';

export const name = '04_bounty_board';

const HOUR_NS = 3_600_000_000_000n;
const HOUR_MS = 3_600_000;

export async function suite({ appDir, pic, createIdentity, checks: c }) {
  const { wasm, idl } = await buildCanister({
    appDir,
    name: 'bounty_board',
    main: 'backend/src/main.mo',
    did: 'backend/candid/backend.did',
  });
  const { idlFactory } = await import(idl);

  const deployer = createIdentity('deployer');
  const sender = deployer.getPrincipal();
  const fixture = await pic.setupCanister({ idlFactory, wasm, sender });
  const actor = fixture.actor;

  const owner = createIdentity('owner');
  const anna = createIdentity('anna');
  const ben = createIdentity('ben');
  const ledger = createIdentity('ledger').getPrincipal();
  const proofCanister = createIdentity('proof-canister').getPrincipal();

  const nowNs = async () => BigInt(await pic.getTime()) * 1_000_000n;

  const bountyInput = async (seed, overrides = {}) => ({
    title: `bounty ${seed}`,
    descriptionHash: digest(seed),
    descriptionUri: `ipfs://brief-${seed}`,
    criteriaHash: digest(seed + 60),
    reward: 500n,
    ledger,
    deadline: (await nowNs()) + HOUR_NS,
    ...overrides,
  });

  const submissionInput = (bountyId, seed, overrides = {}) => ({
    bountyId,
    artifactHash: digest(seed),
    proofCanister,
    proofRecordId: BigInt(seed),
    evidenceUri: `ipfs://evidence-${seed}`,
    note: '',
    ...overrides,
  });

  // -------------------------------------------------------- anonymous caller
  actor.setPrincipal(null);
  c.expectErr(await actor.createBounty(await bountyInput(1)), 'anonymousNotAllowed',
    'createBounty refuses the anonymous principal');
  c.expectErr(await actor.submit(submissionInput(1n, 1)), 'anonymousNotAllowed',
    'submit refuses the anonymous principal');

  // -------------------------------------------------------------- validation
  actor.setIdentity(owner);
  c.expectErr(await actor.createBounty(await bountyInput(1, { reward: 0n })),
    'invalidInput', 'a bounty cannot offer nothing');
  c.expectErr(await actor.createBounty(await bountyInput(1, { title: '' })),
    'invalidInput', 'a bounty needs a title');
  c.expectErr(await actor.createBounty(await bountyInput(1, { deadline: 1n })),
    'invalidInput', 'a deadline in the past is refused at creation');

  // ----------------------------------------------------------------- bounty
  const bounty = c.expectOk(await actor.createBounty(await bountyInput(1)), 'the owner posts a bounty');
  c.ok(bounty.owner.toText() === owner.getPrincipal().toText(), 'the bounty owner is the caller');
  c.ok('open' in bounty.status, 'a fresh bounty is open');

  // ------------------------------------------------------------ submissions
  actor.setIdentity(anna);
  c.expectErr(await actor.submit(submissionInput(9999n, 1)), 'notFound', 'submitting to an unknown bounty is notFound');
  c.expectErr(await actor.submit(submissionInput(bounty.id, 1, { artifactHash: new Uint8Array(3) })),
    'invalidInput', 'artifactHash must be a 32-byte digest');

  const annaEntry = c.expectOk(await actor.submit(submissionInput(bounty.id, 1)), 'anna submits');
  c.ok(annaEntry.submitter.toText() === anna.getPrincipal().toText(), 'the submitter is the caller');

  // One entry per caller per bounty. This is keyed on the caller, so it is not
  // observable without one.
  c.expectErr(await actor.submit(submissionInput(bounty.id, 2)), 'duplicate',
    'the same caller cannot enter the same bounty twice');

  actor.setIdentity(ben);
  const benEntry = c.expectOk(await actor.submit(submissionInput(bounty.id, 3)),
    'a different caller may enter the same bounty');
  c.ok(benEntry.id !== annaEntry.id, 'the second entry is a separate submission');

  // -------------------------------------------------------------- awarding
  actor.setIdentity(anna);
  c.expectErr(await actor.award(bounty.id, annaEntry.id), 'unauthorized',
    'a submitter cannot award the bounty to themselves');

  actor.setIdentity(owner);
  const second = c.expectOk(await actor.createBounty(await bountyInput(2)), 'the owner posts a second bounty');
  c.expectErr(await actor.award(second.id, annaEntry.id), 'invalidInput',
    'a submission cannot be awarded under a bounty it was not entered in');

  const award = c.expectOk(await actor.award(bounty.id, benEntry.id), 'the owner awards the bounty');
  c.ok(award.winner.toText() === ben.getPrincipal().toText(), 'the award names the submitter, not the caller');
  c.ok(award.reward === bounty.reward, 'the award carries the advertised reward');

  const closed = await actor.getBounty(bounty.id);
  c.ok('awarded' in closed[0].status && closed[0].status.awarded.awardId === award.id,
    'the bounty records which award closed it');

  // A bounty pays once.
  c.expectErr(await actor.award(bounty.id, annaEntry.id), 'conflict', 'an awarded bounty cannot be awarded again');
  c.expectErr(await actor.cancelBounty(bounty.id, 'changed my mind'),
    'conflict', 'an awarded bounty cannot then be cancelled');
  actor.setIdentity(anna);
  c.expectErr(await actor.submit(submissionInput(bounty.id, 4)), 'conflict', 'a closed bounty accepts no more entries');

  // ------------------------------------------------------------ cancelling
  actor.setIdentity(ben);
  c.expectErr(await actor.cancelBounty(second.id, 'not mine'), 'unauthorized', 'only the owner can cancel a bounty');
  actor.setIdentity(owner);
  c.expectErr(await actor.cancelBounty(second.id, ''), 'invalidInput', 'cancelling needs a reason');
  const cancelled = c.expectOk(await actor.cancelBounty(second.id, 'funding fell through'), 'the owner cancels');
  c.ok('cancelled' in cancelled.status, 'the bounty is cancelled');

  // ------------------------------------------------------------- deadline
  // Reachable only here: the interpreter has no clock to move.
  const third = c.expectOk(await actor.createBounty(await bountyInput(3)), 'the owner posts a third bounty');
  actor.setIdentity(anna);
  c.expectOk(await actor.submit(submissionInput(third.id, 5)), 'anna enters before the deadline');

  await pic.setTime((await pic.getTime()) + 2 * HOUR_MS);
  await pic.tick();

  actor.setIdentity(ben);
  c.expectErr(await actor.submit(submissionInput(third.id, 6)), 'deadlinePassed',
    'the bounty refuses entries once its deadline has passed');
  // The deadline closes entry, not settlement: the owner must still be able to
  // award among the entries that arrived in time.
  actor.setIdentity(owner);
  c.expectOk(await actor.award(third.id, 3n), 'the owner can still award after the deadline');

  const before = await actor.stats();
  c.ok(before.bounties === 3n && before.submissions === 3n && before.awards === 2n, 'stats count each entity');

  // ---------------------------------------------------------------- upgrade
  await upgradeCanister({ pic, canisterId: fixture.canisterId, wasm, sender });

  const after = await actor.stats();
  c.ok(JSON.stringify(after, bigintSafe) === JSON.stringify(before, bigintSafe),
    'every counter survives the upgrade unchanged');
  c.ok((await actor.getAward(award.id))[0].winner.toText() === ben.getPrincipal().toText(),
    'an award still names its winner after the upgrade');

  // The one-entry-per-caller index has to survive, or an upgrade would let
  // everyone enter every open bounty a second time.
  const fourth = c.expectOk(await actor.createBounty(await bountyInput(4)), 'a bounty can still be posted');
  actor.setIdentity(anna);
  c.expectOk(await actor.submit(submissionInput(fourth.id, 7)), 'anna enters the new bounty');
  c.expectErr(await actor.submit(submissionInput(fourth.id, 8)), 'duplicate',
    'the submitter index still refuses a second entry after the upgrade');
}
