// Pure model of `apps/01_creator_proof_registry` for the state-machine runner.
//
// The model mirrors the state a commitment/record lifecycle test cares about:
// which commitments are open, which records exist, and which of those are
// revoked. `predict` is the entire specification — the executor compares what
// the canister did with what `predict` said it would do — so this file is also
// the written-down answer to the issue's first acceptance criterion:
// **revoked records never reactivate**.
//
// Nothing here touches a replica; the same functions are run during generation
// and during execution.

import { commitmentHex } from '../../../protocol/tools/commitment.mjs';
import { Mismatch, eq, expectErr, expectOk, variantOf } from '../framework.mjs';

const OWNERS = ['alice', 'bob'];

function dig(seed) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 31 + i * 7) & 0xff;
  return bytes;
}

function slt(seed) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 17 + i * 11) & 0xff;
  return bytes;
}

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));

/// The commitment the canister will recompute for this caller and seed. It is
/// built with the verifier's implementation (`protocol/tools/commitment.mjs`),
/// not the canister's, so every accepted reveal is a cross-implementation
/// check as well as a state-machine one.
function commitmentHash(principalText, seed) {
  return commitmentHex({
    principal: principalText,
    manifestHash: hex(dig(seed + 100)),
    salt: hex(slt(seed)),
  });
}

function emptyModel(ctx) {
  return {
    ctx,
    nextCommitmentId: 1n,
    nextRecordId: 1n,
    commitments: {},
    commitmentIdByHash: {},
    commitmentSeedById: {},
    records: {},
    artifactIdByHash: {},
    artifactSeedByHash: {},
    activeRecords: 0n,
    revokedRecords: 0n,
  };
}

const openCommitments = (model, owner) =>
  Object.values(model.commitments).filter((entry) => entry.owner === owner && entry.status === 'open');
const anyCommitments = (model, owner) =>
  Object.values(model.commitments).filter((entry) => entry.owner === owner);
const activeRecords = (model, owner) =>
  Object.values(model.records).filter((entry) => entry.owner === owner && entry.status === 'active');
const revokedRecords = (model, owner) =>
  Object.values(model.records).filter((entry) => entry.owner === owner && entry.status === 'revoked');

const commit = {
  name: 'commit',
  weight: 5,

  generate(model, rng) {
    const owner = rng.pick(OWNERS);
    const roll = rng.int(100);
    // Boundary inputs: a 31-byte digest and an expiry at Nat 1 are both
    // refused before any state exists, so they may be drawn at any time.
    if (roll < 6) return { owner, kind: 'badDigest' };
    if (roll < 12) return { owner, kind: 'pastExpiry' };
    const seeds = Object.values(model.commitmentSeedById);
    if (roll < 20 && seeds.length > 0) {
      // The commitment binds the principal, so a duplicate must replay the
      // *same owner's* seed: the same seed from the other owner is a
      // different hash and a legitimately fresh commitment.
      const entry = rng.pick(seeds);
      return { owner: entry.owner, kind: 'duplicate', seed: entry.seed };
    }
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const seed = rng.int(1 << 28) + 1;
      if (!(commitmentHash(model.ctx.principals[owner], seed) in model.commitmentIdByHash)) {
        return { owner, kind: 'fresh', seed };
      }
    }
    return null;
  },

  predict(model, args) {
    if (args.kind === 'badDigest' || args.kind === 'pastExpiry') {
      return { result: { kind: 'err', variant: 'invalidInput' }, next: model };
    }
    if (args.kind === 'duplicate') {
      return { result: { kind: 'err', variant: 'duplicate' }, next: model };
    }
    const next = structuredClone(model);
    const id = model.nextCommitmentId;
    const hash = commitmentHash(model.ctx.principals[args.owner], args.seed);
    next.commitments[id] = { id, owner: args.owner, status: 'open' };
    next.commitmentIdByHash[hash] = id;
    next.commitmentSeedById[id] = { seed: args.seed, owner: args.owner };
    next.nextCommitmentId = id + 1n;
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `commit(${args.kind})`);
      return prediction.next;
    }
    const created = expectOk(observed, 'commit');
    eq(created.id, model.nextCommitmentId, 'commitment id');
    eq(created.owner.toText(), model.ctx.principals[args.owner], 'commitment owner');
    eq(variantOf(created.status), 'open', 'fresh commitment status');
    return prediction.next;
  },

  run(io, args) {
    const actor = io.actor(args.owner);
    if (args.kind === 'badDigest') {
      return actor.commit({ commitmentHash: new Uint8Array(31), metadataHash: [], expiresAt: [] });
    }
    if (args.kind === 'pastExpiry') {
      return actor.commit({ commitmentHash: unhex(commitmentHash(io.principalText(args.owner), args.seed)), metadataHash: [], expiresAt: [1n] });
    }
    return actor.commit({
      commitmentHash: unhex(commitmentHash(io.principalText(args.owner), args.seed)),
      metadataHash: [],
      expiresAt: [],
    });
  },
};

const reveal = {
  name: 'reveal',
  weight: 6,

  generate(model, rng) {
    const owner = rng.pick(OWNERS);
    const mine = openCommitments(model, owner);
    const others = Object.values(model.commitments)
      .filter((entry) => entry.owner !== owner && entry.status === 'open');
    const nonOpenMine = anyCommitments(model, owner).filter((entry) => entry.status !== 'open');
    const roll = rng.int(100);

    // Someone else's open commitment: refused for ownership before any content
    // is looked at.
    if (roll < 12 && others.length > 0) {
      const target = rng.pick(others);
      return { caller: owner, kind: 'unauthorized', commitmentId: target.id, seed: model.commitmentSeedById[target.id].seed };
    }
    if (mine.length > 0) {
      const target = rng.pick(mine);
      const seed = model.commitmentSeedById[target.id].seed;
      if (roll < 30 && nonOpenMine.length > 0) {
        const stale = rng.pick(nonOpenMine);
        return { caller: owner, kind: 'conflict', commitmentId: stale.id, seed: model.commitmentSeedById[stale.id].seed };
      }
      if (roll < 42) {
        return { caller: owner, kind: 'wrongSalt', commitmentId: target.id, seed };
      }
      if (roll < 54 && Object.keys(model.artifactSeedByHash).length > 0) {
        const artifactSeed = rng.pick(Object.values(model.artifactSeedByHash));
        return { caller: owner, kind: 'duplicateArtifact', commitmentId: target.id, seed, artifactSeed };
      }
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const artifactSeed = rng.int(1 << 28) + 1;
        if (hex(dig(artifactSeed)) in model.artifactIdByHash) continue;
        // The unknown parent is drawn from the same fresh-artifact pool as the
        // valid reveal: the parent check runs after the duplicate-artifact
        // check, so a reused hash would be refused for the wrong reason.
        if (roll < 64) {
          return { caller: owner, kind: 'unknownParent', commitmentId: target.id, seed, artifactSeed };
        }
        const parents = [];
        if (rng.chance(0.15)) {
          const candidates = Object.values(model.records).filter((entry) => entry.status === 'active');
          if (candidates.length > 0) parents.push(rng.pick(candidates).id);
        }
        return { caller: owner, kind: 'valid', commitmentId: target.id, seed, artifactSeed, parents };
      }
      return null;
    }
    if (nonOpenMine.length > 0) {
      const stale = rng.pick(nonOpenMine);
      return { caller: owner, kind: 'conflict', commitmentId: stale.id, seed: model.commitmentSeedById[stale.id].seed };
    }
    return null;
  },

  predict(model, args) {
    const commitment = model.commitments[args.commitmentId];
    if (!commitment) {
      return { result: { kind: 'err', variant: 'notFound' }, next: model };
    }
    if (commitment.owner !== args.caller) {
      return { result: { kind: 'err', variant: 'unauthorized' }, next: model };
    }
    if (commitment.status !== 'open') {
      return { result: { kind: 'err', variant: 'conflict' }, next: model };
    }
    switch (args.kind) {
      case 'wrongSalt':
        return { result: { kind: 'err', variant: 'invalidInput' }, next: model };
      case 'conflict':
        return { result: { kind: 'err', variant: 'conflict' }, next: model };
      case 'unknownParent':
        return { result: { kind: 'err', variant: 'invalidInput' }, next: model };
      case 'duplicateArtifact':
        return { result: { kind: 'err', variant: 'duplicate' }, next: model };
      default: {
        const next = structuredClone(model);
        const id = model.nextRecordId;
        const hash = hex(dig(args.artifactSeed));
        next.records[id] = {
          id,
          owner: args.caller,
          status: 'active',
          artifactHash: hash,
        };
        next.artifactIdByHash[hash] = id;
        next.artifactSeedByHash[hash] = args.artifactSeed;
        next.activeRecords += 1n;
        next.commitments[commitment.id] = { ...commitment, status: 'revealed', recordId: id };
        next.nextRecordId = id + 1n;
        return { result: { kind: 'ok' }, next, artifactHash: hash };
      }
    }
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `reveal(${args.kind})`);
      return prediction.next;
    }
    const record = expectOk(observed, 'reveal');
    eq(record.id, model.nextRecordId, 'record id');
    eq(record.owner.toText(), model.ctx.principals[args.caller], 'record owner');
    eq(variantOf(record.status), 'active', 'fresh record status');
    eq(hex(record.artifactHash), prediction.artifactHash, 'record artifact hash');
    eq(record.commitmentId, args.commitmentId, 'record commitment id');
    return prediction.next;
  },

  run(io, args) {
    const input = {
      commitmentId: args.commitmentId,
      artifactHash: dig(args.artifactSeed ?? 0),
      manifestHash: dig(args.seed + 100),
      salt: slt(args.seed),
      title: `artifact ${args.artifactSeed ?? 0}`,
      kind: 'image',
      mimeType: 'image/png',
      storageUri: `ipfs://cid-${args.artifactSeed ?? 0}`,
      parents: args.parents ?? [],
      ai: { assisted: false, mode: { none: null }, provider: [], model: [], promptHash: [], humanContribution: [] },
      algorithm: [],
      collection: [],
    };
    if (args.kind === 'wrongSalt') input.salt = slt((args.seed ?? 0) + 999);
    if (args.kind === 'unknownParent') input.parents = [9999n];
    if (args.kind === 'duplicateArtifact') input.artifactHash = dig(args.artifactSeed);
    if (args.kind === 'valid') input.artifactHash = dig(args.artifactSeed);
    if (args.kind === 'conflict' || args.kind === 'unauthorized') {
      // The content does not matter: the status or the owner refuses first.
      input.artifactHash = dig((args.artifactSeed ?? 0) + 1);
    }
    const actor = io.actor(args.caller);
    return actor.reveal(input);
  },
};

const cancelCommitment = {
  name: 'cancelCommitment',
  weight: 2,

  generate(model, rng) {
    const caller = rng.pick(OWNERS);
    const all = anyCommitments(model, caller);
    if (all.length === 0) return null;
    if (rng.int(100) < 8) return { caller, commitmentId: 4242n, kind: 'unknown' };
    const open = all.filter((entry) => entry.status === 'open');
    const closed = all.filter((entry) => entry.status !== 'open');
    if (open.length > 0 && (closed.length === 0 || rng.int(100) < 75)) {
      return { caller, commitmentId: rng.pick(open).id, kind: 'open' };
    }
    return { caller, commitmentId: rng.pick(closed).id, kind: 'closed' };
  },

  predict(model, args) {
    if (args.kind === 'unknown') return { result: { kind: 'err', variant: 'notFound' }, next: model };
    if (!model.commitments[args.commitmentId]) return { result: { kind: 'err', variant: 'notFound' }, next: model };
    if (model.commitments[args.commitmentId].status !== 'open') {
      return { result: { kind: 'err', variant: 'conflict' }, next: model };
    }
    const next = structuredClone(model);
    next.commitments[args.commitmentId] = { ...next.commitments[args.commitmentId], status: 'cancelled' };
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `cancelCommitment(${args.kind})`);
      return prediction.next;
    }
    const cancelled = expectOk(observed, 'cancelCommitment');
    eq(cancelled.id, args.commitmentId, 'cancelled commitment id');
    eq(variantOf(cancelled.status), 'cancelled', 'cancelled status');
    return prediction.next;
  },

  run(io, args) {
    return io.actor(args.caller).cancelCommitment(args.commitmentId);
  },
};

const revokeRecord = {
  name: 'revokeRecord',
  weight: 3,

  generate(model, rng) {
    const caller = rng.pick(OWNERS);
    const active = activeRecords(model, caller);
    const revoked = revokedRecords(model, caller);
    const roll = rng.int(100);
    if (roll < 5) return { caller, recordId: 1n, kind: 'emptyReason' };
    if (roll < 8) return { caller, recordId: 4242n, kind: 'unknown' };
    if (roll < 14) {
      const foreign = Object.values(model.records).filter((entry) => entry.owner !== caller && entry.status === 'active');
      if (foreign.length > 0) return { caller, recordId: rng.pick(foreign).id, kind: 'notOwner' };
    }
    if (active.length > 0 && (revoked.length === 0 || rng.int(100) < 70)) {
      return { caller, recordId: rng.pick(active).id, kind: 'revoke' };
    }
    if (revoked.length > 0) return { caller, recordId: rng.pick(revoked).id, kind: 'alreadyRevoked' };
    return null;
  },

  predict(model, args) {
    if (args.kind === 'emptyReason') return { result: { kind: 'err', variant: 'invalidInput' }, next: model };
    const record = model.records[args.recordId];
    if (!record) return { result: { kind: 'err', variant: 'notFound' }, next: model };
    if (record.owner !== args.caller) return { result: { kind: 'err', variant: 'unauthorized' }, next: model };
    if (record.status === 'revoked') return { result: { kind: 'err', variant: 'conflict' }, next: model };
    const next = structuredClone(model);
    next.records[args.recordId] = { ...record, status: 'revoked' };
    next.activeRecords -= 1n;
    next.revokedRecords += 1n;
    return { result: { kind: 'ok' }, next };
  },

  check(model, args, prediction, observed) {
    if (prediction.result.kind === 'err') {
      expectErr(observed, prediction.result.variant, `revokeRecord(${args.kind})`);
      return prediction.next;
    }
    const revoked = expectOk(observed, 'revokeRecord');
    eq(revoked.id, args.recordId, 'revoked record id');
    eq(variantOf(revoked.status), 'revoked', 'revoked status');
    return prediction.next;
  },

  run(io, args) {
    const reason = args.kind === 'emptyReason' ? '' : 'superseded';
    return io.actor(args.caller).revokeRecord(args.recordId, reason);
  },
};

export default {
  name: 'registry',
  appDir: 'apps/01_creator_proof_registry',
  canister: {
    name: 'creator_proof_registry',
    main: 'backend/src/main.mo',
    did: 'backend/candid/backend.did',
  },
  identities: [...OWNERS],
  advanceChoices: [],
  upgradeWeight: 1,
  commands: { commit, reveal, cancelCommitment, revokeRecord },

  generationContext() {
    return {
      principals: {
        // Real, checksum-valid principal texts: `commitmentHex` parses the
        // textual form, and a placeholder would be rejected before any
        // simulation ran. The replica run replaces these with the identities'
        // own principals.
        alice: 'rrkah-fqaaa-aaaaa-aaaaq-cai',
        bob: 'renrk-eyaaa-aaaaa-aaada-cai',
      },
      canisterId: 'aaaaa-aa',
      baseNs: 0n,
    };
  },

  init(ctx) {
    return emptyModel(ctx);
  },

  async observe(io, model, { full }) {
    const canister = io.canister();
    const stats = await canister.stats();
    eq(stats.commitments, BigInt(Object.keys(model.commitments).length), 'stats.commitments');
    eq(stats.records, BigInt(Object.keys(model.records).length), 'stats.records');
    eq(stats.activeRecords, model.activeRecords, 'stats.activeRecords');
    eq(stats.revokedRecords, model.revokedRecords, 'stats.revokedRecords');
    if (!full) return;

    // The acceptance criterion, swept over everything rather than only the
    // entity a step touched: a revoked record is revoked on the canister too,
    // and no canister query can hand it back as active.
    for (const record of Object.values(model.records)) {
      const [found] = await canister.getRecord(record.id);
      if (!found) throw new Mismatch(`record ${record.id} is missing from the canister`);
      eq(variantOf(found.status), record.status, `record ${record.id} status`);
      const [byHash] = await canister.getByArtifactHash(found.artifactHash);
      if (!byHash || byHash.id !== record.id) {
        throw new Mismatch(`artifact hash of record ${record.id} does not index back to it`);
      }
    }
    for (const commitment of Object.values(model.commitments)) {
      const [found] = await canister.getCommitment(commitment.id);
      if (!found) throw new Mismatch(`commitment ${commitment.id} is missing from the canister`);
      eq(variantOf(found.status), commitment.status, `commitment ${commitment.id} status`);
      if (commitment.status === 'revealed') {
        eq(found.status.revealed, commitment.recordId, `commitment ${commitment.id} revealed record id`);
      }
    }
  },
};
