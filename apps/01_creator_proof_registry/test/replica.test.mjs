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
import { DISCLAIMER, DisputeLogError, EXPORT_FORMAT, describe, eventHash, render, verifyExport } from './dispute-log.mjs';

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

  // ---------------------------------------------------- disputes (#8) -----
  // Counterclaims turn on callers, controllers and a clock — the response and
  // appeal windows, the filing rate, the strike window — so this is where they
  // are exercised. `Dispute.test.mo` covers the rules; this covers that the
  // endpoints apply them, that the record is never touched, and that an export
  // verifies against the subnet's signature without trusting the canister.
  const grace = createIdentity('grace');
  const heidi = createIdentity('heidi');
  const ivan = createIdentity('ivan');
  const panel = createIdentity('panel');
  const court = createIdentity('court');
  const asGrace = () => actor.setIdentity(grace);
  const asHeidi = () => actor.setIdentity(heidi);
  const asIvan = () => actor.setIdentity(ivan);
  const asPanel = () => actor.setIdentity(panel);
  const asCourt = () => actor.setIdentity(court);
  const asFrank = () => actor.setIdentity(frank);
  const asDeployer = () => actor.setIdentity(deployer);

  const aliceLatest = (await actor.getByArtifactHash(digest(6)))[0];
  const erinRecord = (await actor.getByArtifactHash(digest(12)))[0];
  const tagOf = (variant) => Object.keys(variant)[0];
  const evidenceAt = (seed, uri) => ({ digest: digest(seed), locator: { uri }, description: `exhibit ${seed}` });
  const sealedAt = (seed, custodian) => ({ digest: digest(seed), locator: { sealed: { custodian } }, description: '' });
  const filing = (recordId, overrides = {}) => ({
    record: recordId,
    ground: { authorship: null },
    statement: 'I made this before it was registered here.',
    counterRecord: [],
    evidence: [],
    ...overrides,
  });

  // Who may speak is the operator's decision, so only a controller registers
  // an authority.
  asGrace();
  c.expectErr(await actor.addDisputeAuthority(panel.getPrincipal(), 'Mediation panel', 'https://panel.example/policy'),
    'unauthorized', 'a non-controller cannot register a dispute authority');
  asDeployer();
  const panelAuthority = c.expectOk(
    await actor.addDisputeAuthority(panel.getPrincipal(), 'Mediation panel', 'https://panel.example/policy'),
    'a controller registers an authority');
  c.expectOk(await actor.addDisputeAuthority(court.getPrincipal(), 'Arbitration court', 'https://court.example/rules'),
    'and a second one');
  c.expectErr(await actor.addDisputeAuthority(panel.getPrincipal(), 'again', 'https://panel.example/policy'),
    'duplicate', 'an authority cannot be registered twice');
  c.ok((await actor.listDisputeAuthorities()).length === 2, 'both authorities are listed with their policies');

  // Grace has a record of her own, which is what "I made it first" points at.
  asGrace();
  const graceCommit = c.expectOk(
    await actor.commit({ commitmentHash: commitmentFor(grace.getPrincipal(), 20), metadataHash: [], expiresAt: [] }),
    'grace commits her own work');
  const graceRecord = c.expectOk(await actor.reveal(revealInput(graceCommit.id, 20)), 'and reveals it');

  // -------------------------------------------------- refused before filing
  asAnonymous();
  c.expectErr(await actor.fileDispute(filing(parented.id)), 'anonymousNotAllowed',
    'an anonymous principal cannot file a counterclaim');
  asGrace();
  c.expectErr(await actor.fileDispute(filing(4242n)), 'notFound', 'a counterclaim needs a record to be about');
  c.expectErr(await actor.fileDispute(filing(record.id)), 'conflict',
    'a revoked record is not disputed: its owner already withdrew it');
  c.expectErr(await actor.fileDispute(filing(parented.id, { counterRecord: [parented.id] })), 'invalidInput',
    'a record cannot be its own counter-record');
  c.expectErr(await actor.fileDispute(filing(parented.id, { statement: '' })), 'invalidInput',
    'a counterclaim needs a statement');
  // The privacy rule: a sealed reference names a custodian, and a URI in that
  // field would publish the pointer the claimant chose to keep private.
  c.expectErr(
    await actor.fileDispute(filing(parented.id, { evidence: [sealedAt(30, 'https://vault.example/case/42')] })),
    'invalidInput', 'sealed evidence cannot smuggle a URI through its custodian field');
  asAlice();
  c.expectErr(await actor.fileDispute(filing(parented.id)), 'conflict',
    'the owner cannot dispute her own record; she can revoke it');

  // ------------------------------------------------------------- filing
  const certifiedBefore = (await actor.getRecordCertified(parented.id))[0];
  const digestBefore = recordDigest(certifiedBefore.record);

  asGrace();
  const graceDispute = c.expectOk(
    await actor.fileDispute(filing(parented.id, {
      ground: { priorCreation: null },
      counterRecord: [graceRecord.id],
      evidence: [evidenceAt(31, 'https://grace.example/sketches.zip'), sealedAt(32, "Grace's counsel")],
    })),
    'grace files a counterclaim with public and sealed evidence');
  c.ok('open' in graceDispute.status && graceDispute.round === 0n, 'a new counterclaim is open, in round 0');
  c.ok(graceDispute.respondBy === graceDispute.filedAt + 14n * DAY, 'the respondent has fourteen days to answer');
  c.ok(graceDispute.counterRecord[0] === graceRecord.id, 'the counter-record is kept as a reference');
  const sealed = graceDispute.evidence[1].evidence.locator;
  c.ok('sealed' in sealed && !('uri' in sealed) && sealed.sealed.custodian === "Grace's counsel",
    'private evidence is on-chain as a digest and a custodian, with no pointer');
  c.expectErr(await actor.fileDispute(filing(parented.id)), 'duplicate',
    'one unresolved counterclaim per claimant and record; more material goes in as evidence');

  // ------------------------------------------------------------- response
  asBob();
  c.expectErr(await actor.respondToDispute(graceDispute.id, { stance: { contest: null }, statement: 'no', evidence: [] }),
    'unauthorized', 'a third party cannot answer for the record');
  asAlice();
  const answered = c.expectOk(
    await actor.respondToDispute(graceDispute.id, {
      stance: { contest: null },
      statement: 'The sketches post-date my commitment.',
      evidence: [evidenceAt(33, 'https://alice.example/timeline.pdf')],
    }),
    'the owner answers');
  c.ok('responded' in answered.status && answered.response[0].by.toText() === alicePrincipal.toText(),
    'the answer is recorded with who gave it');
  c.expectErr(await actor.respondToDispute(graceDispute.id, { stance: { concede: null }, statement: 'x', evidence: [] }),
    'duplicate', 'the respondent answers once');
  asGrace();
  c.expectOk(await actor.addDisputeEvidence(graceDispute.id, [evidenceAt(34, 'https://grace.example/witness.txt')]),
    'the claimant adds evidence while the dispute is unresolved');
  asBob();
  c.expectErr(await actor.addDisputeEvidence(graceDispute.id, [evidenceAt(35, 'https://bob.example')]),
    'unauthorized', 'a stranger cannot add evidence');

  // A record attributed to a creator is answered for by the creator's current
  // root — not by the delegate who signed it, and not by a key rotated away.
  asGrace();
  const againstCreator = c.expectOk(await actor.fileDispute(filing(daveRecord.id)),
    'grace files against a record registered by a delegate');
  asDave();
  c.expectErr(await actor.respondToDispute(againstCreator.id, { stance: { contest: null }, statement: 'x', evidence: [] }),
    'unauthorized', 'the delegate who signed the record does not answer for the identity');
  asCarol();
  c.expectErr(await actor.respondToDispute(againstCreator.id, { stance: { contest: null }, statement: 'x', evidence: [] }),
    'unauthorized', 'nor does a root key that has been rotated away');
  asFrank();
  c.expectOk(
    await actor.respondToDispute(againstCreator.id, { stance: { partial: null }, statement: 'Partly.', evidence: [] }),
    'the current root answers for the creator');

  // ------------------------------------------------------------ due process
  asHeidi();
  const unanswered = c.expectOk(
    await actor.fileDispute(filing(aliceLatest.id, { ground: { aiDisclosure: null } })),
    'heidi files a counterclaim nobody answers');
  asPanel();
  c.expectErr(
    await actor.determineDispute(unanswered.id, { outcome: { upheld: null }, summary: 'x', decision: [] }),
    'conflict', 'nobody determines an unanswered counterclaim inside the response window');
  asBob();
  c.expectErr(
    await actor.determineDispute(graceDispute.id, { outcome: { upheld: null }, summary: 'x', decision: [] }),
    'unauthorized', 'an unregistered principal records no determination');

  // --------------------------------------------------- conflicting authorities
  asPanel();
  const upheld = c.expectOk(
    await actor.determineDispute(graceDispute.id, {
      outcome: { upheld: null },
      summary: 'The earlier sketches were shown.',
      decision: [sealedAt(36, 'panel case office')],
    }),
    'the panel upholds the counterclaim');
  c.ok('determined' in upheld.status, 'the counterclaim is determined');
  c.expectErr(
    await actor.determineDispute(graceDispute.id, { outcome: { rejected: null }, summary: 'changed mind', decision: [] }),
    'duplicate', 'an authority determines a round once');

  // Upheld is a statement by the panel. It does not revoke, edit or re-certify
  // the record: the owner's record is exactly what she committed to.
  const certifiedAfter = (await actor.getRecordCertified(parented.id))[0];
  c.ok('active' in certifiedAfter.record.status, 'an upheld counterclaim does not change the record status');
  c.ok(equalBytes(recordDigest(certifiedAfter.record), digestBefore),
    'the record digest is byte-identical to before the dispute');
  c.ok(equalBytes(await verify(certifiedAfter, parented.id), digestBefore),
    'and the subnet still attests that same digest');

  asCourt();
  c.expectOk(
    await actor.determineDispute(graceDispute.id, { outcome: { rejected: null }, summary: 'Not persuaded.', decision: [] }),
    'a second authority reaches the opposite conclusion');
  const summary = await actor.disputeSummary(parented.id);
  c.ok(summary.total === 1n && summary.determined === 1n && summary.conflicting === 1n && summary.unresolved === 0n,
    'the summary reports one determined counterclaim on which the authorities disagree');

  const conflicted = (await actor.exportDispute(graceDispute.id))[0];
  const conflictReport = describe(conflicted);
  const conflictText = render(conflictReport);
  c.ok(conflictReport.conflicting && conflictReport.technicalStatus === 'active',
    'the verifier reports the disagreement and the unchanged technical status side by side');
  c.ok(conflictText.includes('Mediation panel recorded "upheld"') && conflictText.includes('Arbitration court recorded "rejected"'),
    'each determination is attributed to the authority that made it, under its policy');
  c.ok(conflictText.includes('The registry does not choose between them') && conflictText.includes(DISCLAIMER),
    'the verifier says in words that the registry declares no winner and no legal truth');
  c.ok(!/\b(invalid|fraud|false|proven|guilty|infring)/i.test(conflictText),
    'nothing in the rendering calls the record false or anyone liable');

  // ----------------------------------------------------------------- appeal
  asAlice();
  const appealed = c.expectOk(
    await actor.appealDispute(graceDispute.id, { statement: 'The panel misread the dates.', evidence: [] }),
    'the respondent appeals');
  c.ok('appealed' in appealed.status && appealed.round === 1n, 'an appeal opens round 1');
  c.ok((await actor.disputeSummary(parented.id)).unresolved === 1n, 'an appealed counterclaim is unresolved again');
  c.expectErr(await actor.appealDispute(graceDispute.id, { statement: 'again', evidence: [] }),
    'conflict', 'a round that has not been determined cannot be appealed');

  // A retired authority keeps what it already said and says nothing new.
  asDeployer();
  c.expectOk(await actor.retireDisputeAuthority(court.getPrincipal()), 'a controller retires the court');
  asCourt();
  c.expectErr(
    await actor.determineDispute(graceDispute.id, { outcome: { upheld: null }, summary: 'x', decision: [] }),
    'unauthorized', 'a retired authority records no new determination');
  asDeployer();
  c.expectErr(await actor.addDisputeAuthority(court.getPrincipal(), 'Arbitration court', 'https://court.example/rules'),
    'conflict', 'a retired authority is not quietly reinstated');

  asPanel();
  const reconsidered = c.expectOk(
    await actor.determineDispute(graceDispute.id, { outcome: { rejected: null }, summary: 'On appeal, not shown.', decision: [] }),
    'the panel determines round 1');
  c.ok(reconsidered.determinations.length === 3 && reconsidered.determinations[2].round === 1n,
    'every earlier determination is kept; the new one belongs to round 1');
  c.ok((await actor.disputeSummary(parented.id)).conflicting === 0n,
    'the round-0 disagreement is history, not the current state');
  asAlice();
  c.expectErr(await actor.appealDispute(graceDispute.id, { statement: 'once more', evidence: [] }),
    'conflict', 'each side appeals once');

  // ------------------------------------------------------------ withdrawal
  asFrank();
  c.expectErr(await actor.withdrawDispute(againstCreator.id, 'not mine'), 'unauthorized',
    'only the claimant withdraws');
  asGrace();
  const withdrawn = c.expectOk(await actor.withdrawDispute(againstCreator.id, 'Settled privately.'),
    'the claimant withdraws before any determination');
  c.ok('withdrawn' in withdrawn.status, 'the counterclaim is withdrawn, and stays in the log');
  c.expectErr(await actor.withdrawDispute(graceDispute.id, 'too late'), 'conflict',
    'a determined counterclaim is not withdrawn; the way to stop is not to appeal');

  // ------------------------------------------------------ false report spam
  // Five filings a day per claimant. Withdrawing does not give one back, so
  // file-withdraw cycling is counted like anything else.
  asIvan();
  for (let i = 0; i < 4; i += 1) {
    const spam = c.expectOk(await actor.fileDispute(filing(erinRecord.id, { statement: `spam ${i}` })),
      `ivan files counterclaim ${i + 1} of the day`);
    c.expectOk(await actor.withdrawDispute(spam.id, 'withdrawn'), `and withdraws it (${i + 1})`);
  }
  const fifthFiling = c.expectOk(await actor.fileDispute(filing(daveRecord.id, { statement: 'spam 4' })),
    'the fifth filing of the day is accepted');
  const limited = c.expectErr(await actor.fileDispute(filing(aliceLatest.id, { statement: 'spam 5' })),
    'rateLimited', 'the sixth is refused for volume');
  // `pic.getTime()` is in milliseconds and the canister's clock in
  // nanoseconds, so the bound allows the sub-millisecond part it cannot see.
  const limitedAt = await now();
  c.ok(limited.retryAt > limitedAt && limited.retryAt < limitedAt + DAY + 1_000_000n,
    'and says when the oldest filing leaves the window');

  // Move past the response window: this also lets heidi's unanswered
  // counterclaim be determined without an answer, and the filing window roll.
  await pic.advanceTime(Number(15n * DAY / 1_000_000n));
  await pic.tick();
  asPanel();
  c.expectOk(
    await actor.determineDispute(unanswered.id, { outcome: { dismissed: null }, summary: 'No evidence offered.', decision: [] }),
    'after the response window, silence does not block a determination');

  // Three abusive findings in ninety days suspend filing. `#dismissed` above
  // did not count: a weak claim is not a bad-faith one.
  asIvan();
  const abuse1 = fifthFiling;
  const abuse2 = c.expectOk(await actor.fileDispute(filing(erinRecord.id, { statement: 'spam 6' })),
    'ivan can file again once the day has passed');
  const abuse3 = c.expectOk(await actor.fileDispute(filing(aliceLatest.id, { statement: 'spam 7' })),
    'and again');
  await pic.advanceTime(Number(15n * DAY / 1_000_000n));
  await pic.tick();
  asPanel();
  for (const [index, spam] of [abuse1, abuse2, abuse3].entries()) {
    c.expectOk(
      await actor.determineDispute(spam.id, { outcome: { abusive: null }, summary: 'Filed in bad faith.', decision: [] }),
      `the panel finds filing ${index + 1} abusive`);
  }
  asIvan();
  const suspended = c.expectErr(await actor.fileDispute(filing(graceRecord.id, { statement: 'spam 8' })),
    'rateLimited', 'three abusive findings suspend the claimant');
  c.ok(suspended.retryAt > (await now()) + 60n * DAY,
    'for the strike window, not merely the filing window');
  asHeidi();
  const goodFaith = c.expectOk(await actor.fileDispute(filing(graceRecord.id, { statement: 'A good-faith claim.' })),
    'another claimant is unaffected by the suspension');

  // ---------------------------------------------------- appeal window
  asGrace();
  c.expectErr(await actor.appealDispute(graceDispute.id, { statement: 'late', evidence: [] }),
    'expired', 'an appeal after the thirty-day window is refused');

  // --------------------------------------------------- the portable export
  const bundle = (await actor.exportDispute(graceDispute.id))[0];
  c.ok(bundle.format === EXPORT_FORMAT && bundle.canister.toText() === fixture.canisterId.toText(),
    'the export names its format and the canister it came from');
  c.ok(bundle.authorities.length === 2, 'the export carries the policy of every authority that determined it, retired or not');
  const verifyValue = (args) => verifyCertifiedValue(args);
  const head = await verifyExport(bundle, { rootKey, verifyCertifiedValue: verifyValue });
  c.ok(equalBytes(head, bundle.dispute.head),
    'the export verifies: the chain replays to the certified head and the record to its certified digest');

  // Every event the canister hashed, rehashed by the reader's implementation.
  let rehashed = 0;
  for (let id = 1n; id <= abuse3.id; id += 1n) {
    for (const event of await actor.disputeEvents(id)) {
      if (!equalBytes(eventHash(event), event.hash)) throw new Error(`event ${event.seq} of dispute ${id} disagrees`);
      rehashed += 1;
    }
  }
  c.ok(rehashed >= 25, `the Motoko and JavaScript encodings agree on all ${rehashed} events produced`);

  const tamper = (changes) => ({ ...bundle, ...changes });
  const editedEvents = bundle.events.map((event, index) =>
    index === 1 ? { ...event, action: { responded: { ...event.action.responded, stance: { concede: null } } } } : event);
  await c.expectThrows(() => verifyExport(tamper({ events: editedEvents }), { rootKey, verifyCertifiedValue: verifyValue }),
    DisputeLogError, 'an export with an edited event is rejected');
  await c.expectThrows(
    () => verifyExport(tamper({ events: bundle.events.filter((_, index) => index !== 2) }), { rootKey, verifyCertifiedValue: verifyValue }),
    DisputeLogError, 'an export with a dropped event is rejected');
  await c.expectThrows(
    () => verifyExport(tamper({ dispute: { ...bundle.dispute, status: { open: null } } }), { rootKey, verifyCertifiedValue: verifyValue }),
    DisputeLogError, 'a served dispute that disagrees with its own log is rejected');
  await c.expectThrows(
    () => verifyExport(tamper({ record: { ...bundle.record, title: 'something else' } }), { rootKey, verifyCertifiedValue: verifyValue }),
    DisputeLogError, 'an export pairing the log with an altered record is rejected');

  // A snapshot taken earlier is still a valid document on its own: the
  // certificate it carries attests the head it had then. What it cannot do is
  // pass for the current state. Paired with today's certificate the chain is
  // intact and consistent, the record digest even matches — only the certified
  // head catches it, which is the step a reader must not skip.
  c.ok(equalBytes(await verifyExport(conflicted, { rootKey, verifyCertifiedValue: verifyValue }), conflicted.dispute.head),
    'an export captured before the appeal still verifies on its own terms');
  const stale = await c.expectThrows(
    () => verifyExport(tamper({ dispute: conflicted.dispute, events: conflicted.events }), { rootKey, verifyCertifiedValue: verifyValue }),
    DisputeLogError, 'an old log presented with the current certificate is rejected');
  c.ok(stale.message.includes('certified log head'), 'and it is rejected at the certified head, not earlier');

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

  // Disputes live in stable state beside the records, and their heads in the
  // same certified tree. A lost log would still answer queries — with a head
  // nobody signed — so this verifies the export rather than reading it.
  const exportedAfterUpgrade = (await actor.exportDispute(graceDispute.id))[0];
  c.ok(equalBytes(await verifyExport(exportedAfterUpgrade, { rootKey, verifyCertifiedValue: verifyValue }), head),
    'a dispute exported after the upgrade verifies to the same certified head');
  asIvan();
  c.expectErr(await actor.fileDispute(filing(graceRecord.id, { statement: 'after upgrade' })),
    'rateLimited', 'a suspension survives the upgrade');
  asHeidi();
  const afterUpgradeDispute = c.expectOk(await actor.fileDispute(filing(aliceLatest.id)),
    'a counterclaim can be filed after the upgrade');
  c.ok(afterUpgradeDispute.id === goodFaith.id + 1n, 'dispute ids continue past the upgrade rather than restarting');
}
