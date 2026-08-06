// Replica suite for the creator proof registry.
//
// `test/Validation.test.mo` and `test/Commitment.test.mo` cover the pure
// predicates and the commitment layout in the interpreter. This covers what the
// interpreter cannot reach: a real `caller` (including the anonymous
// principal), the commit-reveal state machine across separate messages,
// duplicate suppression through the hash indexes, and state surviving an
// upgrade.
//
// Since #3 the canister recomputes the commitment, so a commitment here has to
// be a real one. It is built with `protocol/tools/commitment.mjs` — the
// verifier's implementation, not the canister's — which makes every `reveal`
// below a cross-implementation check as well as a state-machine one. If the
// Motoko and JavaScript layouts ever diverged, `alice reveals` would stop
// working and say so.
//
//   node tools/pocket-ic/run.mjs 01

import { bigintSafe, buildCanister, digest, salt, upgradeCanister } from '../../../tools/pocket-ic/harness.mjs';
import { commitmentHex } from '../../../protocol/tools/commitment.mjs';

export const name = '01_creator_proof_registry';

const NO_AI = {
  assisted: false,
  mode: { none: null },
  provider: [],
  model: [],
  promptHash: [],
  humanContribution: [],
};

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));

/// The commitment the canister will recompute for this caller and this reveal.
function commitmentFor(principal, seed) {
  return unhex(commitmentHex({
    principal: principal.toText(),
    manifestHash: hex(digest(seed + 100)),
    salt: hex(salt(seed)),
  }));
}

function revealInput(commitmentId, seed, overrides = {}) {
  return {
    commitmentId,
    artifactHash: digest(seed),
    manifestHash: digest(seed + 100),
    salt: salt(seed),
    title: `artifact ${seed}`,
    kind: 'image',
    mimeType: 'image/png',
    storageUri: `ipfs://cid-${seed}`,
    parents: [],
    ai: NO_AI,
    // `null` selects v1, the only layout there is. Present so the suite encodes
    // the field a client written after #3 would send.
    algorithm: [],
    ...overrides,
  };
}

export async function suite({ appDir, pic, createIdentity, checks: c }) {
  const { wasm, idl } = await buildCanister({
    appDir,
    name: 'creator_proof_registry',
    main: 'backend/src/main.mo',
    did: 'backend/candid/backend.did',
  });
  const { idlFactory } = await import(idl);

  // Install under a named controller rather than the default sender. `icp
  // deploy` makes the *currently selected* identity the controller, and an
  // upgrade from anyone else is rejected with `CanisterInvalidController` —
  // the same trap recorded in apps/06_distributed_llm/docs/MEASUREMENTS.md.
  // Naming it here means the upgrade below tests the upgrade, not the default.
  const deployer = createIdentity('deployer');
  const sender = deployer.getPrincipal();
  const fixture = await pic.setupCanister({ idlFactory, wasm, sender });
  const actor = fixture.actor;

  const alice = createIdentity('alice');
  const bob = createIdentity('bob');
  const asAlice = () => actor.setIdentity(alice);
  const asBob = () => actor.setIdentity(bob);
  const asAnonymous = () => actor.setPrincipal(null);

  // -------------------------------------------------------- anonymous caller
  // `moc -r` has no caller at all, so this is the first place the guard runs.
  asAnonymous();
  c.expectErr(await actor.commit({ commitmentHash: digest(1), metadataHash: [], expiresAt: [] }),
    'anonymousNotAllowed', 'commit refuses the anonymous principal');
  c.expectErr(await actor.reveal(revealInput(1n, 1)),
    'anonymousNotAllowed', 'reveal refuses the anonymous principal');

  // -------------------------------------------------------------- validation
  asAlice();
  c.expectErr(await actor.commit({ commitmentHash: new Uint8Array(31), metadataHash: [], expiresAt: [] }),
    'invalidInput', 'commit rejects a 31-byte digest');
  c.expectErr(await actor.commit({ commitmentHash: digest(1), metadataHash: [], expiresAt: [1n] }),
    'invalidInput', 'commit rejects an expiry in the past');

  // ----------------------------------------------------- the published spec
  // A verifier rebuilds the preimage from what the canister advertises, so the
  // two implementations have to agree about what they advertise before any of
  // the digests below can mean anything.
  const spec = await actor.commitmentSpec();
  c.ok(spec.version === 'v1' && 'sha256V1' in spec.algorithm, 'the canister advertises the v1 layout');
  c.ok(spec.domain === 'icp-creator-proof:v1', 'the advertised domain is the v1 domain');
  c.ok(spec.digestSize === 32n && spec.minSaltSize === 16n && spec.maxSaltSize === 64n,
    'the advertised sizes match the frozen specification');
  c.ok(spec.minPrincipalTextSize === 8n && spec.maxPrincipalTextSize === 63n,
    'the advertised principal bounds match the textual form');

  // ------------------------------------------------------ commit and reveal
  const alicePrincipal = alice.getPrincipal();
  const first = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(alicePrincipal, 1), metadataHash: [], expiresAt: [] }),
    'alice commits');
  c.ok(first.id === 1n, 'first commitment gets id 1');
  c.ok(first.owner.toText() === alicePrincipal.toText(), 'commitment owner is the caller, not the installer');
  c.ok('open' in first.status, 'a fresh commitment is open');

  c.expectErr(
    await actor.commit({ commitmentHash: commitmentFor(alicePrincipal, 1), metadataHash: [], expiresAt: [] }),
    'duplicate', 'the same commitmentHash cannot be committed twice');

  // Authorization is per record, not per canister: bob is a valid caller and
  // still cannot touch alice's commitment.
  asBob();
  c.expectErr(await actor.reveal(revealInput(first.id, 1)), 'unauthorized', 'bob cannot reveal alice\'s commitment');
  c.expectErr(await actor.cancelCommitment(first.id), 'unauthorized', 'bob cannot cancel alice\'s commitment');

  // ------------------------------------------------ the commitment binds (#3)
  // Before #3 the canister stored the commitment and the revealed values side
  // by side and never compared them, so all three of these succeeded and the
  // registry recorded a proof nobody could verify. The interpreter cannot test
  // this at all: the preimage contains the caller.
  asAlice();
  c.expectErr(await actor.reveal(revealInput(first.id, 1, { salt: salt(99) })),
    'invalidInput', 'a reveal with the wrong salt does not match the commitment');
  c.expectErr(await actor.reveal(revealInput(first.id, 1, { manifestHash: digest(999) })),
    'invalidInput', 'a reveal with the wrong manifest hash does not match the commitment');

  // The principal binding, which is the case that is not the obvious one.
  // Calling from bob's identity proves nothing — ownership refuses first — so
  // what exercises it is alice revealing a commitment whose preimage names
  // somebody else. Ownership passes, the digest does not.
  const foreign = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(bob.getPrincipal(), 1), metadataHash: [], expiresAt: [] }),
    'alice commits a hash whose preimage names bob');
  c.expectErr(await actor.reveal(revealInput(foreign.id, 1)),
    'invalidInput', 'alice cannot reveal a commitment computed for a different principal');
  c.expectOk(await actor.cancelCommitment(foreign.id), 'the unusable commitment can still be cancelled');

  const record = c.expectOk(await actor.reveal(revealInput(first.id, 1)), 'alice reveals');
  c.ok(record.commitmentId === first.id, 'the record points back at its commitment');

  const afterReveal = await actor.getCommitment(first.id);
  c.ok('revealed' in afterReveal[0].status && afterReveal[0].status.revealed === record.id,
    'revealing moves the commitment to #revealed with the record id');

  c.expectErr(await actor.cancelCommitment(first.id), 'conflict', 'a revealed commitment can no longer be cancelled');

  // ------------------------------------------------- duplicate artifact hash
  // The reveal has to match its own commitment first, so the duplicate is
  // introduced by overriding only the artifact hash: same creator, same
  // manifest and salt as commitment two, an artifact that already has a record.
  const second = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(alicePrincipal, 2), metadataHash: [], expiresAt: [] }),
    'alice commits a second time');
  c.expectErr(await actor.reveal(revealInput(second.id, 2, { artifactHash: digest(1) })),
    'duplicate', 'the same artifactHash cannot be revealed twice');

  // ------------------------------------------------------------- derivation
  const parented = c.expectOk(await actor.reveal(revealInput(second.id, 2, { parents: [record.id] })),
    'a record may declare an existing parent');
  c.ok(parented.parents.length === 1 && parented.parents[0] === record.id, 'the parent is recorded');

  const third = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(alicePrincipal, 3), metadataHash: [], expiresAt: [] }),
    'alice commits a third time');
  c.expectErr(await actor.reveal(revealInput(third.id, 3, { parents: [999n] })),
    'invalidInput', 'a record cannot declare a parent that does not exist');

  // ------------------------------------------------------------ cancellation
  c.expectOk(await actor.cancelCommitment(third.id), 'an open commitment can be cancelled');
  c.expectErr(await actor.cancelCommitment(third.id), 'conflict', 'cancelling twice conflicts');
  c.expectErr(await actor.cancelCommitment(4242n), 'notFound', 'cancelling an unknown commitment is notFound');

  // ------------------------------------------------------------- revocation
  asBob();
  c.expectErr(await actor.revokeRecord(record.id, 'not mine'), 'unauthorized', 'bob cannot revoke alice\'s record');
  asAlice();
  c.expectErr(await actor.revokeRecord(record.id, ''), 'invalidInput', 'revocation needs a reason');
  const revoked = c.expectOk(await actor.revokeRecord(record.id, 'superseded'), 'alice revokes her record');
  c.ok('revoked' in revoked.status && revoked.status.revoked.reason === 'superseded', 'the reason is stored');
  c.expectErr(await actor.revokeRecord(record.id, 'again'), 'conflict', 'revoking twice conflicts');

  // A revoked record cannot be a parent — the derivation graph must not grow
  // from something withdrawn.
  const fourth = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(alicePrincipal, 4), metadataHash: [], expiresAt: [] }),
    'alice commits a fourth time');
  c.expectErr(await actor.reveal(revealInput(fourth.id, 4, { parents: [record.id] })),
    'invalidInput', 'a revoked record cannot be a parent');

  // ------------------------------------------------------------- read paths
  const found = await actor.getByArtifactHash(digest(1));
  c.ok(found.length === 1 && found[0].id === record.id, 'a record is findable by artifact hash');
  c.ok((await actor.getByArtifactHash(digest(200))).length === 0, 'an unknown artifact hash finds nothing');

  const before = await actor.stats();
  c.ok(before.records === 2n && before.activeRecords === 1n && before.revokedRecords === 1n,
    'stats count active and revoked separately');
  c.ok((await actor.listRecords(0n, 100n)).length === 2, 'listRecords returns both records');

  // ---------------------------------------------------------------- upgrade
  // The claim in docs/UPGRADE_PLAN.md that state survives is not observable in
  // the interpreter at all.
  await upgradeCanister({ pic, canisterId: fixture.canisterId, wasm, sender });

  const after = await actor.stats();
  c.ok(JSON.stringify(after, bigintSafe) === JSON.stringify(before, bigintSafe),
    'every counter survives the upgrade unchanged');

  const survivor = await actor.getRecord(record.id);
  c.ok(survivor.length === 1 && 'revoked' in survivor[0].status,
    'a revoked record is still revoked after the upgrade');
  c.ok((await actor.getByArtifactHash(digest(1))).length === 1,
    'the artifact hash index survives the upgrade');

  // Ids must keep counting up. Reuse after an upgrade would let a new record
  // take a retired id, which is exactly what a provenance registry cannot do.
  asAlice();
  const afterUpgrade = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(alicePrincipal, 5), metadataHash: [], expiresAt: [] }),
    'a commit still works after the upgrade');
  c.ok(afterUpgrade.id === 6n, 'commitment ids continue past the upgrade rather than restarting');

  // The commitment check runs on the same code after an upgrade, against a
  // commitment stored before it.
  const revealedAfterUpgrade = c.expectOk(await actor.reveal(revealInput(afterUpgrade.id, 5)),
    'a reveal still verifies against its commitment after the upgrade');
  c.ok(revealedAfterUpgrade.commitmentId === afterUpgrade.id, 'the post-upgrade record points at its commitment');
}
