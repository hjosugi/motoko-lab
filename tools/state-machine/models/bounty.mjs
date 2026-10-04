// Pure model of `apps/04_bounty_board` for the state-machine runner.
//
// The board's lifecycle is short but sharp: a bounty is open until it is
// awarded or cancelled, `(bounty, caller)` admits one submission, and the
// deadline closes entries without closing settlement. The issue's acceptance
// criterion is **a closed bounty cannot be re-awarded**; `observe` sweeps the
// awards to prove at most one exists per bounty and that the bounty it names
// is still closed afterwards.
//
// The bounty's ledger is never registered here, so no escrow exists and
// `escrowReady` is trivially true: this models the board's own state machine,
// not the ledger integration (which the replica suite in apps/04 covers).

import { Mismatch, eq, expectErr, expectOk, variantOf } from '../framework.mjs';

const SUBMITTERS = ['anna', 'ben', 'carol'];
const HOUR_NS = 3_600_000_000_000n;
/// Deadlines are an hour and a minute out, not an hour: the replica clock is
/// nanosecond-resolution while `pic.getTime()` and `advanceTime` are
/// millisecond-resolution, so a deadline the generator can hit *exactly* is a
/// coin toss between "now" and "now + a few microseconds". Advances are whole
/// minutes, so an offset that is not a multiple of any advance sum keeps every
/// comparison away from the boundary.
const DEADLINE_OFFSET_NS = HOUR_NS + 60_000_000_000n;

function dig(seed) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 41 + i * 3) & 0xff;
  return bytes;
}

function emptyModel(ctx) {
  return {
    ctx,
    nextBountyId: 1n,
    nextSubmissionId: 1n,
    nextAwardId: 1n,
    bounties: {},
    submissions: {},
    awards: {},
    submitterIndex: {},
    elapsedNs: 0n,
  };
}

const nowNs = (model) => model.ctx.baseNs + model.elapsedNs;
const submissionKey = (bountyId, submitter) => `${bountyId}:${submitter}`;

const createBounty = {
  name: 'createBounty',
  weight: 3,

  generate(model, rng) {
    const roll = rng.int(100);
    const seed = Number(model.nextBountyId);
    if (roll < 5) return { reward: 0n, deadlineOffsetNs: HOUR_NS, kind: 'zeroReward', seed };
    if (roll < 10) return { reward: 1n, deadlineOffsetNs: -HOUR_NS, kind: 'pastDeadline', seed };
    return {
      reward: rng.pick([1n, 500n, 10n ** 18n]),
      deadlineOffsetNs: DEADLINE_OFFSET_NS,
      kind: 'create',
      seed,
    };
  },

  predict(model, args) {
    if (args.kind === 'zeroReward' || args.kind === 'pastDeadline') {
      return { result: { kind: 'err', variant: 'invalidInput' }, next: model };
    }
    const next = structuredClone(model);
    const id = model.nextBountyId;
    next.bounties[id] = {
      id,
      owner: 'owner',
      reward: args.reward,
      deadline: nowNs(model) + args.deadlineOffsetNs,
      status: 'open',
    };
    next.nextBountyId = id + 1n;
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `createBounty(${args.kind})`);
      return prediction.next;
    }
    const bounty = expectOk(observed, 'createBounty');
    eq(bounty.id, model.nextBountyId, 'bounty id');
    eq(bounty.owner.toText(), model.ctx.principals.owner, 'bounty owner');
    eq(bounty.reward, args.reward, 'bounty reward');
    eq(variantOf(bounty.status), 'open', 'fresh bounty status');
    return prediction.next;
  },

  async run(io, args) {
    return io.actor('owner').createBounty({
      title: `bounty ${args.seed}`,
      descriptionHash: dig(args.seed),
      descriptionUri: `ipfs://brief-${args.seed}`,
      criteriaHash: dig(args.seed + 60),
      reward: args.reward,
      ledger: io.principal('ledger'),
      deadline: (await io.nowNs()) + args.deadlineOffsetNs,
    });
  },
};

const submit = {
  name: 'submit',
  weight: 5,

  generate(model, rng) {
    const submitter = rng.pick(SUBMITTERS);
    const bounties = Object.values(model.bounties);
    const roll = rng.int(100);
    if (roll < 10 || bounties.length === 0) {
      return { submitter, bountyId: 9999n, seed: 1, kind: 'unknownBounty' };
    }
    const bounty = rng.pick(bounties);
    if (bounty.status !== 'open') return { submitter, bountyId: bounty.id, seed: 1, kind: 'closed' };
    if (nowNs(model) > bounty.deadline) return { submitter, bountyId: bounty.id, seed: 1, kind: 'late' };
    if (submissionKey(bounty.id, submitter) in model.submitterIndex) {
      return { submitter, bountyId: bounty.id, seed: 1, kind: 'duplicate' };
    }
    return { submitter, bountyId: bounty.id, seed: rng.int(1 << 28) + 1, kind: 'entry' };
  },

  predict(model, args) {
    const bounty = model.bounties[args.bountyId];
    if (!bounty) return { result: { kind: 'err', variant: 'notFound' }, next: model };
    if (bounty.status !== 'open') return { result: { kind: 'err', variant: 'conflict' }, next: model };
    if (nowNs(model) > bounty.deadline) return { result: { kind: 'err', variant: 'deadlinePassed' }, next: model };
    if (submissionKey(args.bountyId, args.submitter) in model.submitterIndex) {
      return { result: { kind: 'err', variant: 'duplicate' }, next: model };
    }
    const next = structuredClone(model);
    const id = model.nextSubmissionId;
    next.submissions[id] = { id, bountyId: args.bountyId, submitter: args.submitter };
    next.submitterIndex[submissionKey(args.bountyId, args.submitter)] = id;
    next.nextSubmissionId = id + 1n;
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `submit(${args.kind})`);
      return prediction.next;
    }
    const entry = expectOk(observed, 'submit');
    eq(entry.id, model.nextSubmissionId, 'submission id');
    eq(entry.bountyId, args.bountyId, 'submission bounty');
    eq(entry.submitter.toText(), model.ctx.principals[args.submitter], 'submission submitter');
    return prediction.next;
  },

  run(io, args) {
    return io.actor(args.submitter).submit({
      bountyId: args.bountyId,
      artifactHash: dig(args.seed),
      proofCanister: io.principal('proof-canister'),
      proofRecordId: BigInt(args.seed),
      evidenceUri: `ipfs://evidence-${args.seed}`,
      note: '',
    });
  },
};

const award = {
  name: 'award',
  weight: 4,

  generate(model, rng) {
    const bounties = Object.values(model.bounties);
    const roll = rng.int(100);
    if (roll < 8 || bounties.length === 0) {
      return { caller: 'owner', bountyId: 9999n, submissionId: 9999n, kind: 'unknownBounty' };
    }
    const bounty = rng.pick(bounties);
    const mine = Object.values(model.submissions).filter((entry) => entry.bountyId === bounty.id);
    if (roll < 18) return { caller: 'anna', bountyId: bounty.id, submissionId: (mine[0] ?? { id: 9999n }).id, kind: 'notOwner' };
    if (bounty.status !== 'open') {
      return { caller: 'owner', bountyId: bounty.id, submissionId: (mine[0] ?? { id: 9999n }).id, kind: 'closed' };
    }
    if (mine.length === 0) return { caller: 'owner', bountyId: bounty.id, submissionId: 9999n, kind: 'unknownSubmission' };
    const foreign = Object.values(model.submissions).filter((entry) => entry.bountyId !== bounty.id);
    if (foreign.length > 0 && rng.int(100) < 20) {
      return { caller: 'owner', bountyId: bounty.id, submissionId: rng.pick(foreign).id, kind: 'foreignSubmission' };
    }
    return { caller: 'owner', bountyId: bounty.id, submissionId: rng.pick(mine).id, kind: 'award' };
  },

  predict(model, args) {
    const bounty = model.bounties[args.bountyId];
    if (!bounty) return { result: { kind: 'err', variant: 'notFound' }, next: model };
    if (bounty.owner !== args.caller) return { result: { kind: 'err', variant: 'unauthorized' }, next: model };
    if (bounty.status !== 'open') return { result: { kind: 'err', variant: 'conflict' }, next: model };
    const entry = model.submissions[args.submissionId];
    if (!entry) return { result: { kind: 'err', variant: 'notFound' }, next: model };
    if (entry.bountyId !== args.bountyId) return { result: { kind: 'err', variant: 'invalidInput' }, next: model };
    const next = structuredClone(model);
    const id = model.nextAwardId;
    next.awards[id] = { id, bountyId: args.bountyId, submissionId: args.submissionId };
    next.bounties[args.bountyId] = { ...bounty, status: 'awarded', awardId: id };
    next.nextAwardId = id + 1n;
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `award(${args.kind})`);
      return prediction.next;
    }
    const awardValue = expectOk(observed, 'award');
    eq(awardValue.id, model.nextAwardId, 'award id');
    eq(awardValue.bountyId, args.bountyId, 'award bounty');
    eq(awardValue.submissionId, args.submissionId, 'award submission');
    return prediction.next;
  },

  run(io, args) {
    return io.actor(args.caller).award(args.bountyId, args.submissionId);
  },
};

const cancelBounty = {
  name: 'cancelBounty',
  weight: 2,

  generate(model, rng) {
    const bounties = Object.values(model.bounties);
    const roll = rng.int(100);
    if (roll < 8 || bounties.length === 0) {
      return { caller: 'owner', bountyId: 9999n, reason: 'changed my mind', kind: 'unknown' };
    }
    const bounty = rng.pick(bounties);
    if (roll < 18) return { caller: 'ben', bountyId: bounty.id, reason: 'not mine', kind: 'notOwner' };
    if (bounty.status !== 'open') return { caller: 'owner', bountyId: bounty.id, reason: 'too late', kind: 'closed' };
    return { caller: 'owner', bountyId: bounty.id, reason: 'changed my mind', kind: 'cancel' };
  },

  predict(model, args) {
    if (args.kind === 'unknown') return { result: { kind: 'err', variant: 'notFound' }, next: model };
    const bounty = model.bounties[args.bountyId];
    if (!bounty) return { result: { kind: 'err', variant: 'notFound' }, next: model };
    if (bounty.owner !== args.caller) return { result: { kind: 'err', variant: 'unauthorized' }, next: model };
    if (bounty.status !== 'open') return { result: { kind: 'err', variant: 'conflict' }, next: model };
    const next = structuredClone(model);
    next.bounties[args.bountyId] = { ...bounty, status: 'cancelled' };
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `cancelBounty(${args.kind})`);
      return prediction.next;
    }
    const bounty = expectOk(observed, 'cancelBounty');
    eq(bounty.id, args.bountyId, 'cancelled bounty id');
    eq(variantOf(bounty.status), 'cancelled', 'cancelled status');
    return prediction.next;
  },

  run(io, args) {
    return io.actor(args.caller).cancelBounty(args.bountyId, args.reason);
  },
};

export default {
  name: 'bounty',
  appDir: 'apps/04_bounty_board',
  canister: {
    name: 'bounty_board',
    main: 'backend/src/main.mo',
    did: 'backend/candid/backend.did',
  },
  identities: ['owner', 'anna', 'ben', 'carol', 'ledger', 'proof-canister'],
  advanceChoices: [30 * 60 * 1000, 2 * 60 * 60 * 1000],
  advanceWeight: 3,
  upgradeWeight: 1,
  commands: { createBounty, submit, award, cancelBounty },

  generationContext() {
    return {
      principals: {
        owner: 'owner-principal',
        anna: 'anna-principal',
        ben: 'ben-principal',
        carol: 'carol-principal',
        ledger: 'ryjl3-tyaaa-aaaaa-aaaba-cai',
        'proof-canister': 'aaaaa-aa',
      },
      canisterId: 'aaaaa-aa',
      baseNs: 0n,
    };
  },

  init(ctx) {
    return emptyModel(ctx);
  },

  afterAdvance(model, ms) {
    const next = structuredClone(model);
    next.elapsedNs += BigInt(ms) * 1_000_000n;
    return next;
  },

  async observe(io, model, { full }) {
    const canister = io.canister();
    const stats = await canister.stats();
    eq(stats.bounties, BigInt(Object.keys(model.bounties).length), 'stats.bounties');
    eq(stats.submissions, BigInt(Object.keys(model.submissions).length), 'stats.submissions');
    eq(stats.awards, BigInt(Object.keys(model.awards).length), 'stats.awards');
    if (!full) return;

    // **A closed bounty cannot be re-awarded.** Swept from the canister:
    // at most one award per bounty, every award names a bounty the canister
    // also reports as awarded, and a cancelled bounty has no award at all.
    const awardsByBounty = new Map();
    for (const awardValue of Object.values(model.awards)) {
      const [found] = await canister.getAward(awardValue.id);
      if (!found) throw new Mismatch(`award ${awardValue.id} is missing from the canister`);
      eq(found.bountyId, awardValue.bountyId, `award ${awardValue.id} bounty`);
      const count = (awardsByBounty.get(awardValue.bountyId.toString()) ?? 0) + 1;
      awardsByBounty.set(awardValue.bountyId.toString(), count);
      if (count > 1) throw new Mismatch(`bounty ${awardValue.bountyId} was awarded ${count} times`);
    }
    for (const bounty of Object.values(model.bounties)) {
      const [found] = await canister.getBounty(bounty.id);
      if (!found) throw new Mismatch(`bounty ${bounty.id} is missing from the canister`);
      eq(variantOf(found.status), bounty.status, `bounty ${bounty.id} status`);
      if (bounty.status === 'awarded') {
        eq(found.status.awarded.awardId, bounty.awardId, `bounty ${bounty.id} award id`);
      }
    }
  },
};
