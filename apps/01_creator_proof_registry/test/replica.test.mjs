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

import { bigintSafe, buildCanister, digest, equalBytes, salt, upgradeCanister } from '../../../tools/pocket-ic/harness.mjs';
import { CertificateError, verifyCertifiedValue } from '../../../tools/pocket-ic/certificate.mjs';
import { commitmentHex } from '../../../protocol/tools/commitment.mjs';
import { recordDigest, recordPath } from './record-digest.mjs';

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
    // No collection: the caller holds no creator identity. The identity suite
    // below is where scoped registration is exercised.
    collection: [],
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

  const counted = await actor.stats();
  c.ok(counted.records === 2n && counted.activeRecords === 1n && counted.revokedRecords === 1n,
    'stats count active and revoked separately');
  c.ok((await actor.listRecords(0n, 100n)).length === 2, 'listRecords returns both records');

  // ------------------------------------------------- certified queries (#6)
  // A query response is unsigned, so anything between the canister and the
  // reader can change it. None of this is observable in the interpreter: there
  // is no subnet, no signature, and no certified data.
  // The subnet's own public key, which is what a reader would have obtained
  // from the NNS and pinned. Verification has to be against a key the reader
  // already trusts; taking it from the response would verify nothing.
  const subnetId = await pic.getCanisterSubnetId(fixture.canisterId);
  const rootKey = await pic.getPubKey(subnetId);
  const verify = async (certified, id) =>
    verifyCertifiedValue({
      certificate: certified.certificate,
      witness: certified.witness,
      canisterId: fixture.canisterId,
      rootKey,
      path: recordPath(id),
    });

  const certifiedActive = (await actor.getRecordCertified(parented.id))[0];
  c.ok(certifiedActive !== undefined, 'a record can be fetched with its certificate');
  const attested = await verify(certifiedActive, parented.id);
  c.ok(equalBytes(attested, recordDigest(certifiedActive.record)),
    'the subnet attests the digest of the record it returned');

  // Every field is covered, so altering any one of them is detectable. This is
  // the substitution the certification exists to stop: a record that still
  // looks valid but points somewhere else.
  const tampered = { ...certifiedActive.record, storageUri: 'ipfs://attacker-controlled' };
  c.ok(!equalBytes(attested, recordDigest(tampered)),
    'a record with a rewritten storageUri no longer matches the attested digest');
  c.ok(!equalBytes(attested, recordDigest({ ...certifiedActive.record, title: 'something else' })),
    'a record with a rewritten title no longer matches the attested digest');

  // A witness that verifies internally but is not rooted in the certified data
  // proves nothing, and is what a reader who skipped that comparison would
  // accept.
  const corrupted = Uint8Array.from(certifiedActive.witness);
  corrupted[corrupted.length - 1] ^= 0xff;
  await c.expectThrows(
    () => verify({ ...certifiedActive, witness: corrupted }, parented.id),
    CertificateError,
    'a corrupted witness is rejected',
  );

  // A stale witness. Certified data only changes when the tree does, so this
  // needs a mutation between the two reads — otherwise both certificates carry
  // the same root and pairing them is perfectly legitimate.
  const staleWitness = certifiedActive.witness;
  const fifth = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(alicePrincipal, 6), metadataHash: [], expiresAt: [] }),
    'alice commits again, to move the certified tree');
  c.expectOk(await actor.reveal(revealInput(fifth.id, 6)), 'and reveals it, which re-certifies the root');

  const fresh = (await actor.getRecordCertified(parented.id))[0];
  c.ok(!equalBytes(fresh.witness, staleWitness), 'the witness changed when the tree did');
  await c.expectThrows(
    () => verify({ certificate: fresh.certificate, witness: staleWitness }, parented.id),
    CertificateError,
    'a witness from before the last mutation is rejected against the current certificate',
  );
  c.ok(equalBytes(await verify(fresh, parented.id), recordDigest(fresh.record)),
    'the current witness still attests the unchanged record');

  c.ok((await actor.getRecordCertified(4242n)).length === 0, 'an unknown record has no certificate');

  // Revocation has to be certified too. An intermediary that could keep
  // serving a withdrawn record as active would make revocation cosmetic.
  const certifiedRevoked = (await actor.getRecordCertified(record.id))[0];
  c.ok('revoked' in certifiedRevoked.record.status, 'the revoked record is fetched as revoked');
  const revokedAttested = await verify(certifiedRevoked, record.id);
  c.ok(equalBytes(revokedAttested, recordDigest(certifiedRevoked.record)),
    'the subnet attests the revoked status, not only the record identity');
  c.ok(!equalBytes(revokedAttested, recordDigest({ ...certifiedRevoked.record, status: { active: null } })),
    'presenting the revoked record as active no longer matches the attested digest');

  // --------------------------------------------- creator identity (#7) ----
  // Rotation, scoped delegation and recovery all turn on a clock and a caller,
  // so none of it is reachable from the interpreter. `Identity.test.mo` covers
  // the rules; this covers that `reveal` consults them.
  const carol = createIdentity('carol');
  const dave = createIdentity('dave');
  const erin = createIdentity('erin');
  const frank = createIdentity('frank');
  const asCarol = () => actor.setIdentity(carol);
  const asDave = () => actor.setIdentity(dave);
  const asErin = () => actor.setIdentity(erin);

  const NANOS = 1_000_000_000n;
  const DAY = 86_400n * NANOS;
  const now = async () => BigInt(await pic.getTime()) * 1_000_000n;

  asCarol();
  const creator = c.expectOk(await actor.registerCreator(), 'carol claims a creator identity');
  c.ok(creator.root.toText() === carol.getPrincipal().toText(), 'the caller becomes the root key');
  c.ok(creator.keys.length === 1 && creator.keys[0].retiredAt.length === 0,
    'the identity starts with one live key');
  c.expectErr(await actor.registerCreator(), 'duplicate', 'a principal cannot claim two identities');

  const collection = c.expectOk(await actor.createCollection('spring campaign'), 'carol creates a collection');
  const other = c.expectOk(await actor.createCollection('archive'), 'and a second one');

  // A delegate scoped to one collection, expiring inside the year cap.
  const deadline = (await now()) + 30n * DAY;
  const scoped = c.expectOk(
    await actor.createDelegation(dave.getPrincipal(), { collection: collection.id }, deadline),
    'carol delegates to dave, scoped to one collection');

  c.expectErr(
    await actor.createDelegation(erin.getPrincipal(), { all: null }, (await now()) + 400n * DAY),
    'invalidInput', 'a delegation cannot outlive the maximum lifetime');
  c.expectErr(
    await actor.createDelegation(erin.getPrincipal(), { all: null }, (await now()) - DAY),
    'invalidInput', 'a delegation cannot expire in the past');
  asDave();
  c.expectErr(
    await actor.createDelegation(erin.getPrincipal(), { all: null }, deadline),
    'unauthorized', 'a delegate cannot issue further delegations');

  // Dave registers inside his scope. The record's owner is dave — he signed it
  // — while the attribution names carol.
  const daveCommit = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(dave.getPrincipal(), 10), metadataHash: [], expiresAt: [] }),
    'dave commits');
  const daveRecord = c.expectOk(
    await actor.reveal(revealInput(daveCommit.id, 10, { collection: [collection.id] })),
    'dave reveals inside his scope');
  c.ok(daveRecord.owner.toText() === dave.getPrincipal().toText(), 'the record records the key that signed it');
  const daveAttribution = (await actor.attribution(daveRecord.id))[0];
  c.ok(daveAttribution.creator === creator.id, 'the record is attributed to carol, not to dave');
  c.ok(daveAttribution.signer.toText() === dave.getPrincipal().toText(),
    'the signer is kept apart from the creator');
  c.ok('delegated' in daveAttribution.authority && daveAttribution.authority.delegated === scoped.id,
    'the attribution names the delegation that authorized it');

  // Out of scope. A delegate that could register into a collection it was not
  // given would make the scope advisory.
  const outOfScope = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(dave.getPrincipal(), 11), metadataHash: [], expiresAt: [] }),
    'dave commits again');
  c.expectErr(await actor.reveal(revealInput(outOfScope.id, 11, { collection: [other.id] })),
    'unauthorized', 'a collection-scoped delegate cannot register into another collection');
  c.expectErr(await actor.reveal(revealInput(outOfScope.id, 11)),
    'unauthorized', 'nor outside any collection: no collection is not every collection');

  // Organization member removal. Revoking has to stop new records without
  // touching the ones already registered.
  asCarol();
  c.expectOk(await actor.revokeDelegation(scoped.id, 'left the organization'), 'carol revokes the delegation');
  asDave();
  c.expectErr(await actor.reveal(revealInput(outOfScope.id, 11, { collection: [collection.id] })),
    'unauthorized', 'a revoked delegate cannot create new records');
  c.ok((await actor.getRecord(daveRecord.id))[0] !== undefined,
    'the record dave already registered is untouched');
  c.ok((await actor.attribution(daveRecord.id))[0].creator === creator.id,
    'and is still attributed to carol');

  // Expiry, reached by moving the replica clock rather than by waiting.
  asCarol();
  const shortLived = c.expectOk(
    await actor.createDelegation(erin.getPrincipal(), { all: null }, (await now()) + 2n * DAY),
    'carol delegates to erin, unscoped');
  asErin();
  const erinCommit = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(erin.getPrincipal(), 12), metadataHash: [], expiresAt: [] }),
    'erin commits while her delegation is live');
  c.expectOk(await actor.reveal(revealInput(erinCommit.id, 12)), 'erin reveals while her delegation is live');

  await pic.advanceTime(Number(3n * DAY / 1_000_000n));
  await pic.tick();
  c.ok('active' in (await actor.getDelegation(shortLived.id))[0].status,
    'an expired delegation is still marked active: expiry is a deadline, not a status change');

  const afterExpiry = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(erin.getPrincipal(), 13), metadataHash: [], expiresAt: [] }),
    'erin commits after her delegation expired');
  c.expectErr(await actor.reveal(revealInput(afterExpiry.id, 13)),
    'unauthorized', 'an expired delegation authorizes nothing');

  // Rotation. The identity survives; the retired key does not.
  asCarol();
  const rotated = c.expectOk(await actor.rotateKey(bob.getPrincipal(), 'scheduled rotation'), 'carol rotates to a new key');
  c.ok(rotated.id === creator.id, 'the creator id survives the rotation');
  c.ok(rotated.keys.length === 2, 'the retired key is kept in the history');
  c.ok(rotated.keys[0].retiredAt.length === 1 && rotated.keys[1].retiredAt.length === 0,
    'exactly one key is live after a rotation');
  c.ok((await actor.attribution(daveRecord.id))[0].signer.toText() === dave.getPrincipal().toText(),
    'a record registered before the rotation still names the key that signed it');

  const retiredCommit = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(carol.getPrincipal(), 14), metadataHash: [], expiresAt: [] }),
    'the retired key can still commit');
  c.expectErr(await actor.reveal(revealInput(retiredCommit.id, 14)),
    'unauthorized', 'but a rotated-away key cannot register anything new');

  // Concurrent rotations: the second one has nothing to rotate, because the
  // first already moved the identity out from under it.
  c.expectErr(await actor.rotateKey(erin.getPrincipal(), 'racing rotation'),
    'unauthorized', 'a second rotation from the retired key is refused');

  // Recovery. Declared in advance by the root, delayed, and cancellable.
  asBob();
  c.expectErr(await actor.declareRecovery(bob.getPrincipal(), 30n * DAY),
    'conflict', 'the guardian cannot be the key it would recover');
  c.expectErr(await actor.declareRecovery(erin.getPrincipal(), DAY),
    'invalidInput', 'a recovery delay below the minimum is refused');
  c.expectOk(await actor.declareRecovery(erin.getPrincipal(), 30n * DAY), 'the root declares a recovery policy');

  asDave();
  c.expectErr(await actor.beginRecovery(creator.id, dave.getPrincipal()),
    'unauthorized', 'only the declared guardian can begin a recovery');

  asErin();
  const recovery = c.expectOk(await actor.beginRecovery(creator.id, frank.getPrincipal()),
    'the guardian begins a recovery');
  c.ok('pending' in recovery.status, 'the recovery is pending, not applied');
  c.ok(recovery.effectiveAt > (await now()), 'and does not take effect immediately');
  c.expectErr(await actor.confirmRecovery(creator.id), 'conflict',
    'a recovery cannot complete before its delay elapses');

  // The delay exists so the current root can notice and stop it. That is what
  // makes a recovery something other than a silent transfer of identity.
  asBob();
  c.expectOk(await actor.cancelRecovery(creator.id), 'the root cancels the recovery it did not ask for');
  c.ok((await actor.getCreator(creator.id))[0].root.toText() === bob.getPrincipal().toText(),
    'the identity did not move');

  asErin();
  c.expectOk(await actor.beginRecovery(creator.id, frank.getPrincipal()), 'the guardian tries again');
  await pic.advanceTime(Number(31n * DAY / 1_000_000n));
  await pic.tick();
  const recovered = c.expectOk(await actor.confirmRecovery(creator.id), 'and completes it after the delay');
  c.ok(recovered.root.toText() === frank.getPrincipal().toText(), 'the identity moved to the proposed key');
  c.ok(recovered.keys.length === 3, 'the recovered-from key is retired into the history');
  c.ok((await actor.attribution(daveRecord.id))[0].creator === creator.id,
    'records registered before the recovery are still attributable');

  // ---------------------------------------------------------------- upgrade
  // The claim in docs/UPGRADE_PLAN.md that state survives is not observable in
  // the interpreter at all.
  // Snapshotted here rather than earlier, so the comparison spans the upgrade
  // and nothing else.
  const before = await actor.stats();
  // Relative rather than a literal: the identity section above allocates
  // commitments too, and an absolute id would have to be rewritten every time
  // a test is inserted, which is how an assertion stops meaning anything.
  const lastCommitmentId = before.commitments;
  await upgradeCanister({ pic, canisterId: fixture.canisterId, wasm, sender });

  const after = await actor.stats();
  c.ok(JSON.stringify(after, bigintSafe) === JSON.stringify(before, bigintSafe),
    'every counter survives the upgrade unchanged');

  const survivor = await actor.getRecord(record.id);
  c.ok(survivor.length === 1 && 'revoked' in survivor[0].status,
    'a revoked record is still revoked after the upgrade');
  c.ok((await actor.getByArtifactHash(digest(1))).length === 1,
    'the artifact hash index survives the upgrade');

  // The hash tree lives in stable state and `Ops` is rebuilt on upgrade. If the
  // tree were lost, `getRecordCertified` would still answer — with a witness
  // rooted in an empty tree — so this has to compare against the certificate,
  // not merely check that a witness came back.
  const afterUpgradeCertified = (await actor.getRecordCertified(record.id))[0];
  c.ok(equalBytes(await verify(afterUpgradeCertified, record.id), recordDigest(afterUpgradeCertified.record)),
    'a record certified before the upgrade still verifies after it');

  // Ids must keep counting up. Reuse after an upgrade would let a new record
  // take a retired id, which is exactly what a provenance registry cannot do.
  asAlice();
  const afterUpgrade = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(alicePrincipal, 5), metadataHash: [], expiresAt: [] }),
    'a commit still works after the upgrade');
  c.ok(afterUpgrade.id === lastCommitmentId + 1n,
    'commitment ids continue past the upgrade rather than restarting');

  // The commitment check runs on the same code after an upgrade, against a
  // commitment stored before it.
  const revealedAfterUpgrade = c.expectOk(await actor.reveal(revealInput(afterUpgrade.id, 5)),
    'a reveal still verifies against its commitment after the upgrade');
  c.ok(revealedAfterUpgrade.commitmentId === afterUpgrade.id, 'the post-upgrade record points at its commitment');
}
