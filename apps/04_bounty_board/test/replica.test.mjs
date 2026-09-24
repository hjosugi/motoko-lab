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

  await escrow({ pic, appDir, actor, fixture, wasm, sender, deployer, owner, anna, ben, createIdentity,
    bountyInput, submissionInput, nowNs, c });
}

// ------------------------------------------------------------------ escrow

async function escrow({ pic, appDir, actor, fixture, wasm, sender, deployer, owner, anna, ben, createIdentity,
  bountyInput, submissionInput, nowNs, c }) {
  const mock = await buildCanister({
    appDir,
    name: 'bounty_mock_ledger',
    main: 'test/fixtures/MockLedger.mo',
    did: 'test/fixtures/mock_ledger.did',
  });
  const { idlFactory: ledgerIdl } = await import(mock.idl);
  const ledgerFixture = await pic.setupCanister({ idlFactory: ledgerIdl, wasm: mock.wasm, sender });
  const ledger = ledgerFixture.actor;
  const ledgerId = ledgerFixture.canisterId;
  const board = fixture.canisterId;
  const platformOwner = createIdentity('platform');
  const account = (identity) => ({ owner: identity.getPrincipal(), subaccount: [] });
  const balance = async (who) => ledger.icrc1_balance_of(who.owner ? who : account(who));
  const REWARD = 1_000_000n;
  const CUT = 25_000n; // 250 bps
  let fee = 10_000n;
  let minted = 0n;
  const mint = async (who, amount) => { minted += amount; await ledger.mint(account(who), amount); };

  const escrowAccount = (e) => ({ owner: board, subaccount: [e.subaccount] });
  /// The books, recomputed here from the op log rather than asked for.
  const books = (e) => e.ops.reduce((sum, op) => {
    if (!('done' in op.status)) return sum;
    return 'fund' in op.kind ? sum + op.amount : sum - op.amount - op.fee;
  }, 0n);
  const getEscrow = async (id) => (await actor.getEscrow(id))[0];
  const stateOf = async (id) => Object.keys((await getEscrow(id)).state)[0];
  const approve = async (identity, amount, expiresAt = []) => {
    ledger.setIdentity(identity);
    const result = await ledger.icrc2_approve({
      from_subaccount: [], spender: { owner: board, subaccount: [] }, amount, expected_allowance: [],
      expires_at: expiresAt, fee: [], memo: [], created_at_time: [],
    });
    if (!('Ok' in result)) throw new Error(`approve failed: ${JSON.stringify(result, bigintSafe)}`);
  };
  const escrowedBounty = async (seed) => {
    actor.setIdentity(owner);
    return c.expectOk(await actor.createBounty(await bountyInput(seed, {
      ledger: ledgerId, reward: REWARD, deadline: (await nowNs()) + 72n * HOUR_NS,
    })), `an escrowed bounty (${seed})`);
  };

  // ------------------------------------------------------------ operator
  actor.setIdentity(owner);
  c.expectErr(await actor.registerLedger(ledgerId), 'unauthorized', 'only a controller registers a ledger');
  c.expectErr(await actor.setPlatform(account(platformOwner), 250n), 'unauthorized', 'only a controller sets the platform cut');
  actor.setIdentity(deployer);
  c.expectOk(await actor.registerLedger(ledgerId), 'the controller registers the ledger');
  c.expectErr(await actor.setPlatform(account(platformOwner), 2_001n), 'invalidInput', 'the cut is capped at 20%');
  c.expectOk(await actor.setPlatform(account(platformOwner), 250n), 'the controller sets a 2.5% platform cut');

  // ------------------------------------------------ no award without escrow
  const first = await escrowedBounty(40);
  let e = await getEscrow(first.id);
  c.ok('awaitingFunds' in e.state && e.reward === REWARD && e.platformFee === CUT && e.fee === fee
    && e.deposit === REWARD + fee + CUT + fee,
    'the terms are fixed at posting: deposit = reward + cut + one fee per payout');
  c.ok(e.subaccount.length === 32, 'the bounty has its own 32-byte escrow subaccount');
  actor.setIdentity(anna);
  c.expectErr(await actor.submit(submissionInput(first.id, 40)), 'conflict', 'no entries before the reward is in escrow');
  actor.setIdentity(owner);
  c.expectErr(await actor.award(first.id, 1n), 'conflict', 'and no award');
  actor.setIdentity(anna);
  c.expectErr(await actor.fundEscrow(first.id), 'unauthorized', 'only the owner funds the escrow');

  // ------------------------------------------------------ funding refusals
  actor.setIdentity(owner);
  c.expectErr(await actor.fundEscrow(first.id), 'refused', 'funding without an approval is refused by the ledger');

  await mint(owner, 20_000n);
  await approve(owner, e.deposit + fee);
  actor.setIdentity(owner);
  let result = await actor.fundEscrow(first.id);
  c.expectErr(result, 'refused', 'insufficient funds');
  c.ok(result.err.refused.startsWith('insufficient funds'), 'insufficient funds: the reason says so');

  await mint(owner, 10_000_000n);
  // Allowance expires: approved for an hour, used after two.
  await approve(owner, e.deposit + fee, [BigInt(await pic.getTime() + HOUR_MS) * 1_000_000n]);
  await pic.advanceTime(2 * HOUR_MS);
  await pic.tick();
  actor.setIdentity(owner);
  result = await actor.fundEscrow(first.id);
  c.expectErr(result, 'refused', 'an expired approval');
  c.ok(result.err.refused.includes('allowance'), 'is refused as an insufficient allowance');
  c.ok('awaitingFunds' in (await getEscrow(first.id)).state, 'every refusal leaves the escrow unfunded');

  // Fee changes before funding: the terms are redone and the owner re-approves.
  await approve(owner, e.deposit + fee);
  await ledger.setFee(20_000n);
  actor.setIdentity(owner);
  result = await actor.fundEscrow(first.id);
  c.expectErr(result, 'feeChanged', 'a fee change before funding');
  fee = 20_000n;
  e = await getEscrow(first.id);
  c.ok(e.fee === fee && e.deposit === REWARD + fee + CUT + fee && result.err.feeChanged.approval === e.deposit + fee,
    'recomputes the deposit and the approval at the new fee');
  await approve(owner, e.deposit + fee);
  const ownerBefore = await balance(owner);
  actor.setIdentity(owner);
  e = c.expectOk(await actor.fundEscrow(first.id), 'the owner funds at the new terms');
  c.ok('funded' in e.state, 'the escrow is funded');
  c.ok(await balance(escrowAccount(e)) === e.deposit && await balance(owner) === ownerBefore - e.deposit - fee,
    'the deposit is in the escrow subaccount; the owner paid it plus the pull fee');
  c.ok(e.ops.filter((op) => 'failed' in op.status).length === 4 && e.ops.filter((op) => 'done' in op.status).length === 1,
    'the op log keeps the four refused pulls and the one that executed');

  // ---------------------------------------------------------------- award
  actor.setIdentity(anna);
  const annaEntry = c.expectOk(await actor.submit(submissionInput(first.id, 41)), 'anna enters once funded');
  actor.setIdentity(owner);
  c.expectOk(await actor.award(first.id, annaEntry.id), 'the owner awards anna');
  e = await getEscrow(first.id);
  c.ok('released' in e.state, 'the escrow is released');
  c.ok(await balance(anna) === REWARD, 'anna received exactly the reward');
  c.ok(await balance(platformOwner) === CUT, 'the platform received exactly its cut');
  c.ok(await balance(escrowAccount(e)) === 0n && books(e) === 0n, 'the escrow is empty, on the ledger and in the books');
  c.ok(c.expectOk(await actor.settleEscrow(first.id), 'settling a released escrow again').ops.length === e.ops.length
    && await balance(anna) === REWARD, 'settlement is idempotent: nothing moves');

  // ------------------------------------ the ledger answered, the reply was lost
  const second = await escrowedBounty(42);
  e = await getEscrow(second.id);
  c.ok(e.fee === fee, 'a bounty posted after the fee change is priced at the new fee');
  await approve(owner, e.deposit + fee);
  const beforeDrop = await balance(owner);
  await ledger.dropNextReply();
  actor.setIdentity(owner);
  c.expectErr(await actor.fundEscrow(second.id), 'ledgerUnavailable', 'the pull executes but its reply is lost');
  e = await getEscrow(second.id);
  c.ok('awaitingFunds' in e.state && 'pending' in e.ops[0].status && await balance(escrowAccount(e)) === e.deposit,
    'the books say pending; the money has in fact moved');
  actor.setIdentity(anna);
  e = c.expectOk(await actor.settleEscrow(second.id), 'anyone may settle: the identical retry');
  c.ok('funded' in e.state && e.ops.length === 1 && 'done' in e.ops[0].status,
    'is deduplicated by the ledger into the original block: funded, one pull');
  c.ok(await balance(owner) === beforeDrop - e.deposit - fee, 'the owner was charged once');

  actor.setIdentity(ben);
  const benEntry = c.expectOk(await actor.submit(submissionInput(second.id, 43)), 'ben enters');
  // Now the winner's payout loses its reply.
  await ledger.dropNextReply();
  actor.setIdentity(owner);
  c.expectOk(await actor.award(second.id, benEntry.id), 'the award stands even though the payout reply was lost');
  e = await getEscrow(second.id);
  c.ok('releasing' in e.state && await balance(ben) === REWARD, 'ben has been paid; the books do not know yet');
  e = c.expectOk(await actor.settleEscrow(second.id), 'settling after the lost payout reply');
  c.ok('released' in e.state && await balance(ben) === REWARD, 'finishes the release and pays ben exactly once');
  c.ok(await balance(escrowAccount(e)) === books(e), 'the books match the ledger');

  // ------------------------------------------------ the ledger is unreachable
  const third = await escrowedBounty(44);
  e = await getEscrow(third.id);
  await approve(owner, e.deposit + fee);
  actor.setIdentity(owner);
  c.expectOk(await actor.fundEscrow(third.id), 'funded');
  const carol = createIdentity('carol');
  actor.setIdentity(carol);
  const carolEntry = c.expectOk(await actor.submit(submissionInput(third.id, 45)), 'carol enters');
  await ledger.setAvailable(false);
  actor.setIdentity(owner);
  c.expectOk(await actor.award(third.id, carolEntry.id), 'the award is recorded while the ledger is down');
  e = await getEscrow(third.id);
  c.ok('releasing' in e.state && await balance(carol) === 0n, 'nothing has moved');
  c.expectErr(await actor.settleEscrow(third.id), 'ledgerUnavailable', 'settling while the ledger is down');
  await ledger.setAvailable(true);
  e = c.expectOk(await actor.settleEscrow(third.id), 'settling once it is back');
  c.ok('released' in e.state && await balance(carol) === REWARD, 'pays carol the reward');

  // ----------------------------------------------------- fee change at payout
  const fourth = await escrowedBounty(46);
  e = await getEscrow(fourth.id);
  await approve(owner, e.deposit + fee);
  actor.setIdentity(owner);
  c.expectOk(await actor.fundEscrow(fourth.id), 'funded at fee 20,000');
  const dave = createIdentity('dave');
  actor.setIdentity(dave);
  const daveEntry = c.expectOk(await actor.submit(submissionInput(fourth.id, 47)), 'dave enters');
  await ledger.setFee(30_000n);
  const platformBefore = await balance(platformOwner);
  actor.setIdentity(owner);
  c.expectOk(await actor.award(fourth.id, daveEntry.id), 'awarded after the fee rose to 30,000');
  e = await getEscrow(fourth.id);
  c.ok('released' in e.state && await balance(dave) === REWARD, 'the winner is still paid in full');
  const platformGot = (await balance(platformOwner)) - platformBefore;
  c.ok(platformGot === CUT - 2n * (30_000n - 20_000n), 'the platform absorbs both extra fees');
  c.ok(await balance(escrowAccount(e)) === books(e) && books(e) === 0n, 'and the escrow still balances to zero');
  fee = 30_000n;
  c.ok((await actor.getLedger(ledgerId))[0].fee === fee, 'and the board now prices new bounties at the fee it learned');

  // ------------------------------------------------------------------ refund
  const fifth = await escrowedBounty(48);
  e = await getEscrow(fifth.id);
  await approve(owner, e.deposit + fee);
  actor.setIdentity(owner);
  c.expectOk(await actor.fundEscrow(fifth.id), 'funded');
  const beforeRefund = await balance(owner);
  c.expectOk(await actor.cancelBounty(fifth.id, 'project cancelled'), 'the owner cancels a funded bounty');
  e = await getEscrow(fifth.id);
  c.ok('refunded' in e.state && await balance(owner) === beforeRefund + e.deposit - fee,
    'everything comes back to the owner, less the refund fee');
  c.ok(await balance(escrowAccount(e)) === 0n && books(e) === 0n, 'the escrow is empty');
  c.expectOk(await actor.settleEscrow(fifth.id), 'settling a refunded escrow again');
  c.ok(await balance(owner) === beforeRefund + e.deposit - fee, 'refunds once');

  // A cancellation while the pull's outcome is unknown: the money did move, so
  // it has to come back, not be forgotten because the books said "unfunded".
  const sixth = await escrowedBounty(49);
  e = await getEscrow(sixth.id);
  await approve(owner, e.deposit + fee);
  const beforeLost = await balance(owner);
  await ledger.dropNextReply();
  actor.setIdentity(owner);
  c.expectErr(await actor.fundEscrow(sixth.id), 'ledgerUnavailable', 'a pull whose reply is lost');
  c.expectOk(await actor.cancelBounty(sixth.id, 'changed my mind'), 'then the owner cancels');
  e = await getEscrow(sixth.id);
  c.ok('refunded' in e.state && await balance(owner) === beforeLost - 2n * fee,
    'the pull is resolved, then refunded: the owner is out only the two fees');

  // An unfunded bounty simply closes.
  const seventh = await escrowedBounty(50);
  actor.setIdentity(owner);
  c.expectOk(await actor.cancelBounty(seventh.id, 'never funded'), 'cancelling an unfunded escrowed bounty');
  c.ok(await stateOf(seventh.id) === 'closedUnfunded', 'closes it with nothing to refund');

  // ----------------------------------- after the deduplication window closes
  const eighth = await escrowedBounty(51);
  e = await getEscrow(eighth.id);
  await approve(owner, e.deposit + fee);
  await ledger.dropNextReply();
  actor.setIdentity(owner);
  c.expectErr(await actor.fundEscrow(eighth.id), 'ledgerUnavailable', 'another pull whose reply is lost');
  await pic.advanceTime(25 * HOUR_MS);
  await pic.tick();
  e = c.expectOk(await actor.settleEscrow(eighth.id), 'settled 25 hours later, past the dedup window');
  c.ok('funded' in e.state && 'done' in e.ops[0].status && e.ops[0].status.done.block.length === 0,
    'the ledger says TooOld, and the escrow balance establishes the pull happened (no block to cite)');

  // --------------------------------------------------------- accounting
  // Every token is accounted for: what was minted is now in some account or
  // was burned as a fee, and every escrow holds exactly what its books say.
  let checked = 0;
  for (const id of [first.id, second.id, third.id, fourth.id, fifth.id, sixth.id, seventh.id, eighth.id]) {
    const x = await getEscrow(id);
    if (await balance(escrowAccount(x)) !== books(x)) throw new Error(`escrow ${id} does not balance`);
    checked += 1;
  }
  c.ok(checked === 8, 'all eight escrows hold exactly what their books say');
  c.ok(await ledger.totalSupply() < minted, 'fees were burned, nothing was created');

  // ---------------------------------------------------------------- upgrade
  await upgradeCanister({ pic, canisterId: board, wasm, sender });
  e = await getEscrow(first.id);
  c.ok('released' in e.state && e.ops.length > 0, 'escrows and their op logs survive the upgrade');
  c.ok((await actor.getLedger(ledgerId)).length === 1 && (await actor.getPlatform())[0].feeBps === 250n,
    'so do the ledger allowlist and the platform terms');
  actor.setIdentity(owner);
  c.expectOk(await actor.settleEscrow(first.id), 'settling after the upgrade');
  c.ok(await balance(anna) === REWARD, 'moves nothing that already moved');
}
