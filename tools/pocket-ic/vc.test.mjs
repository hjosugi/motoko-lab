#!/usr/bin/env node
// Verifiable Credentials (#11) checked against the registry's creator
// identity (#7) on a real replica.
//
// protocol/tools/vc.test.mjs covers every verdict with a stand-in registry.
// This runs the cross-check against app 01 itself: a credential presenting an
// on-chain delegation is accepted while the chain agrees and rejected the
// moment it does not — revoked, expired, or a membership naming a key the
// creator has since rotated away. The credential never changes; the chain
// does, and the verdict follows the chain.
//
//   node tools/pocket-ic/setup.mjs     # once
//   node tools/pocket-ic/vc.test.mjs

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { buildCanister, Checks, repoRoot, salt, withReplica } from './harness.mjs';
import { isInstalled } from './setup.mjs';
import { commitmentHex } from '../../protocol/tools/commitment.mjs';
import { didKey, didKeyVerificationMethod } from '../../protocol/tools/multikey.mjs';
import { delegationCredential, membershipCredential, reviewCredential, signCredential, verifyCredential } from '../../protocol/tools/vc.mjs';
import { ed25519FromSeed, testSeed } from '../../protocol/tools/x509.mjs';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const NANOS_PER_MS = 1_000_000n;
const DAY_MS = 86_400_000;

/// The read-only registry adapter `verifyCredential` consults: queries only,
/// principals as text, and nothing it answers is taken from the credential.
function registryAdapter(actor, canisterId) {
  const here = (id) => id === canisterId;
  return {
    async getDelegation(id, delegationId) {
      if (!here(id)) return null;
      const [delegation] = await actor.getDelegation(delegationId);
      return delegation ? { ...delegation, delegate: delegation.delegate.toText() } : null;
    },
    async getCreator(id, creatorId) {
      if (!here(id)) return null;
      const [creator] = await actor.getCreator(creatorId);
      return creator ? { root: creator.root.toText() } : null;
    },
    async getRecord(id, recordId) {
      if (!here(id)) return null;
      const [record] = await actor.getRecord(recordId);
      return record
        ? { artifactHash: hex(record.artifactHash), manifestHash: hex(record.manifestHash), revoked: 'revoked' in record.status }
        : null;
    },
  };
}

function issuerKey(label) {
  const keys = ed25519FromSeed(testSeed(label));
  return { ...keys, did: didKey(keys.publicKey), verificationMethod: didKeyVerificationMethod(keys.publicKey) };
}

async function suite({ pic, createIdentity, checks: c, wasm, idl }) {
  const { idlFactory } = await import(idl);
  const deployer = createIdentity('deployer');
  const fixture = await pic.setupCanister({ idlFactory, wasm, sender: deployer.getPrincipal() });
  const actor = fixture.actor;
  const canisterId = fixture.canisterId.toText();
  const registry = registryAdapter(actor, canisterId);

  const alice = createIdentity('alice');
  const bob = createIdentity('bob');
  const aliceNext = createIdentity('alice-next');
  const aliceKey = issuerKey('vc replica creator alice');
  const studioKey = issuerKey('vc replica studio');
  const boardKey = issuerKey('vc replica review board');
  const policy = {
    issuers: [
      { name: 'alice', types: ['DelegatedAuthorityCredential'], keys: [{ verificationMethod: aliceKey.verificationMethod, activeFrom: '2020-01-01T00:00:00Z', retiredAt: null, status: 'active' }] },
      { name: 'Studio', types: ['CreatorMembershipCredential'], keys: [{ verificationMethod: studioKey.verificationMethod, activeFrom: '2020-01-01T00:00:00Z', retiredAt: null, status: 'active' }] },
      { name: 'Board', types: ['ProvenanceReviewCredential'], keys: [{ verificationMethod: boardKey.verificationMethod, activeFrom: '2020-01-01T00:00:00Z', retiredAt: null, status: 'active' }] },
    ],
  };
  // The verifier's clock is the replica's: validity windows and on-chain
  // expiries have to be read against the same time.
  const now = async () => new Date(Math.floor(await pic.getTime()));
  const iso = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const verify = async (credential) => verifyCredential(credential, { policy, registry, at: await now() });
  const sign = (credential, key, created) =>
    signCredential(credential, { privateKey: key.privateKey, verificationMethod: key.verificationMethod, created: iso(created) });

  // ------------------------------------------------ delegation, on-chain
  actor.setIdentity(alice);
  const creator = c.expectOk(await actor.registerCreator(), 'alice registers a creator identity');
  const collection = c.expectOk(await actor.createCollection('portfolio'), 'alice creates a collection');
  let t = await now();
  const expiresAt = BigInt(t.getTime() + 30 * DAY_MS) * NANOS_PER_MS;
  const delegation = c.expectOk(
    await actor.createDelegation(bob.getPrincipal(), { collection: collection.id }, expiresAt),
    'alice delegates the collection to bob for 30 days');

  const presentDelegation = (validUntil) => sign(delegationCredential({
    id: `urn:uuid:replica-delegation-${delegation.id}-${validUntil.getTime()}`,
    issuer: aliceKey.did,
    validFrom: iso(t),
    validUntil: iso(validUntil),
    delegate: bob.getPrincipal().toText(),
    registry: { canisterId, creatorId: creator.id },
    delegationId: delegation.id,
    scope: { collection: collection.id },
  }), aliceKey, t);

  const credential = presentDelegation(new Date(t.getTime() + 29 * DAY_MS));
  let report = await verify(credential);
  c.ok(report.verdict === 'accepted' && report.checks.registry === 'consistent',
    `a delegation credential the chain agrees with is accepted (${report.verdict}: ${report.errors.join('; ')})`);

  const overreaching = presentDelegation(new Date(t.getTime() + 60 * DAY_MS));
  report = await verify(overreaching);
  c.ok(report.verdict === 'rejected' && report.errors.some((e) => e.includes('outlives')),
    'a credential that outlives the on-chain delegation is rejected');

  c.expectOk(await actor.revokeDelegation(delegation.id, 'bob left the project'), 'alice revokes the delegation on-chain');
  report = await verify(credential);
  c.ok(report.verdict === 'rejected' && report.reasons.includes('registry-mismatch') && report.errors.some((e) => e.includes('bob left the project')),
    'the unchanged credential is now rejected: the chain revoked it, no status list needed');

  // Expiry on-chain: a short delegation, then the replica clock moves past it.
  t = await now();
  const shortExpiry = BigInt(t.getTime() + 2 * DAY_MS) * NANOS_PER_MS;
  const short = c.expectOk(
    await actor.createDelegation(bob.getPrincipal(), { collection: collection.id }, shortExpiry),
    'alice delegates again, for two days');
  const shortCredential = sign(delegationCredential({
    id: 'urn:uuid:replica-delegation-short',
    issuer: aliceKey.did,
    validFrom: iso(t),
    delegate: bob.getPrincipal().toText(),
    registry: { canisterId, creatorId: creator.id },
    delegationId: short.id,
    scope: { collection: collection.id },
  }), aliceKey, t);
  report = await verify(shortCredential);
  c.ok(report.verdict === 'accepted', 'the short delegation is accepted while it lasts');
  await pic.advanceTime(3 * DAY_MS);
  await pic.tick();
  report = await verify(shortCredential);
  c.ok(report.verdict === 'rejected' && report.errors.some((e) => e.includes('expired')),
    'after the replica clock passes the on-chain expiry, the credential is rejected even though it names no validUntil');

  // ------------------------------------------- membership and key rotation
  t = await now();
  const membership = sign(membershipCredential({
    id: 'urn:uuid:replica-membership',
    issuer: studioKey.did,
    validFrom: iso(t),
    member: alice.getPrincipal().toText(),
    organization: { name: 'Studio' },
    role: 'member',
    registry: { canisterId, creatorId: creator.id },
  }), studioKey, t);
  report = await verify(membership);
  c.ok(report.verdict === 'accepted' && report.checks.registry === 'consistent', 'membership naming the creator\'s current root is accepted');
  c.expectOk(await actor.rotateKey(aliceNext.getPrincipal(), 'scheduled rotation'), 'alice rotates her root key');
  report = await verify(membership);
  c.ok(report.verdict === 'rejected' && report.errors.some((e) => e.includes('current root')),
    'the same membership credential is now stale: it names a key that no longer speaks for the identity');
  const renewed = sign(membershipCredential({
    id: 'urn:uuid:replica-membership-renewed',
    issuer: studioKey.did,
    validFrom: iso(t),
    member: aliceNext.getPrincipal().toText(),
    organization: { name: 'Studio' },
    role: 'member',
    registry: { canisterId, creatorId: creator.id },
  }), studioKey, t);
  report = await verify(renewed);
  c.ok(report.verdict === 'accepted', 'a membership reissued to the new root is accepted');

  // ----------------------------------------------------- review of a record
  actor.setIdentity(aliceNext);
  const manifestHash = createHash('sha256').update('replica review manifest').digest();
  const artifactHash = createHash('sha256').update('replica review artifact').digest();
  const recordSalt = salt(3);
  const commitment = c.expectOk(await actor.commit({
    commitmentHash: Buffer.from(commitmentHex({ principal: aliceNext.getPrincipal().toText(), manifestHash: hex(manifestHash), salt: hex(recordSalt) }), 'hex'),
    metadataHash: [],
    expiresAt: [],
  }), 'alice (new key) commits');
  const record = c.expectOk(await actor.reveal({
    commitmentId: commitment.id, artifactHash, manifestHash, salt: recordSalt,
    title: 'reviewed', kind: 'text', mimeType: 'text/plain', storageUri: 'ipfs://reviewed', parents: [],
    ai: { assisted: false, mode: { none: null }, provider: [], model: [], promptHash: [], humanContribution: [] },
    algorithm: [], collection: [],
  }), 'and reveals a record');
  t = await now();
  const review = (hashes) => sign(reviewCredential({
    id: 'urn:uuid:replica-review',
    issuer: boardKey.did,
    validFrom: iso(t),
    record: { canisterId, recordId: record.id, ...hashes },
    outcome: 'consistent',
    method: 'Recomputed the commitment from the revealed values.',
  }), boardKey, t);
  report = await verify(review({ artifactHash: hex(artifactHash), manifestHash: hex(manifestHash) }));
  c.ok(report.verdict === 'accepted' && report.checks.registry === 'consistent', 'a review of the record\'s actual evidence is accepted');
  report = await verify(review({ artifactHash: hex(artifactHash), manifestHash: '00'.repeat(32) }));
  c.ok(report.verdict === 'rejected' && report.reasons.includes('registry-mismatch'), 'a review naming other evidence is rejected');
  c.expectOk(await actor.revokeRecord(record.id, 'superseded'), 'the record is revoked');
  report = await verify(review({ artifactHash: hex(artifactHash), manifestHash: hex(manifestHash) }));
  c.ok(report.verdict === 'accepted-with-warnings' && report.warnings.some((w) => w.includes('since been revoked')),
    'the review stands as a statement about what was reviewed, and warns that the record was withdrawn');
}

async function main() {
  if (!(await isInstalled())) {
    console.error('pocket-ic is not installed. Run: node tools/pocket-ic/setup.mjs');
    return 127;
  }
  console.log('== verifiable credentials against the registry ==');
  const checks = new Checks('vc');
  try {
    // Compiled before the replica starts: pocket-ic stops itself after a
    // minute without requests, which a loaded machine can spend compiling.
    const { wasm, idl } = await buildCanister({
      appDir: resolve(repoRoot, 'apps/01_creator_proof_registry'),
      name: 'creator_proof_registry_vc',
      main: 'backend/src/main.mo',
      did: 'backend/candid/backend.did',
    });
    await withReplica(({ pic, createIdentity }) => suite({ pic, createIdentity, checks, wasm, idl }));
  } catch (error) {
    console.error(`   after ${checks.count} checks: ${error.message}`);
    return 1;
  }
  console.log(`   ${checks.count} checks passed`);
  return 0;
}

process.exit(await main());
