#!/usr/bin/env node
// The C2PA bridge (#10) against a real registry on a real replica.
//
// protocol/tools/c2pa.test.mjs checks every verdict offline, with a stand-in
// for the certificate check. This runs the path end to end: a creator
// registers a PNG with apps/01_creator_proof_registry, a credential naming the
// record is embedded in the PNG, and a verifier checks the credential and the
// *certified* record — online through `getRecordCertified`, and offline from a
// saved bundle whose BLS certificate is verified against the subnet key. Then
// the creator revokes the record and the same credential stops verifying.
//
// Not an application suite, so `run.mjs` does not discover it:
//
//   node tools/pocket-ic/setup.mjs            # once
//   node tools/pocket-ic/c2pa-bridge.test.mjs

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { buildCanister, Checks, repoRoot, salt, withReplica } from './harness.mjs';
import { isInstalled } from './setup.mjs';
import { verifyCertifiedRecord } from './certified-record.mjs';
import { commitmentHex } from '../../protocol/tools/commitment.mjs';
import { canonicalizeValue } from '../../protocol/tools/jcs.mjs';
import { spkiSha256, testPki } from '../../protocol/tools/x509.mjs';
import { stripManifest } from '../../protocol/tools/c2pa.mjs';
import {
  BUNDLE_FORMAT,
  buildExample,
  bundleResolver,
  certify,
  issueCredential,
  MANIFEST_EXTENSION,
  recordToJson,
  verifyAsset,
} from '../../protocol/tools/c2pa-bridge.mjs';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest();

/// What a verifier saves to check a record later without the network.
function bundleFrom({ canisterId, recordId, certified, rootKey }) {
  return {
    format: BUNDLE_FORMAT,
    network: 'local',
    canisterId,
    recordId: String(recordId),
    record: recordToJson(certified.record),
    certificate: hex(certified.certificate),
    witness: hex(certified.witness),
    rootKey: hex(rootKey),
    fetchedAt: new Date().toISOString(),
  };
}

/// An online resolver: a certified query, verified before it is believed.
function onlineResolver({ actor, canisterId, rootKey }) {
  return {
    async resolve({ canisterId: wanted, recordId }) {
      if (wanted !== canisterId) {
        return { status: 'unreachable', source: 'online', error: `no route to canister ${wanted}` };
      }
      const [certified] = await actor.getRecordCertified(BigInt(recordId));
      // Absence is not certified by a query (docs/CERTIFIED_QUERIES.md); a
      // verifier that must prove it would repeat this as an update call.
      if (!certified) return { status: 'not-found', source: 'online' };
      const bundle = bundleFrom({ canisterId, recordId, certified, rootKey });
      return { status: 'found', source: 'online', record: bundle.record, ...(await certify(bundle, verifyCertifiedRecord)) };
    },
  };
}

async function suite({ pic, createIdentity, checks: c, wasm, idl }) {
  const { idlFactory } = await import(idl);
  const deployer = createIdentity('deployer');
  const fixture = await pic.setupCanister({ idlFactory, wasm, sender: deployer.getPrincipal() });
  const actor = fixture.actor;
  const canisterId = fixture.canisterId.toText();
  const rootKey = await pic.getPubKey(await pic.getCanisterSubnetId(fixture.canisterId));

  // ------------------------------------------------ the creator registers
  const alice = createIdentity('alice');
  actor.setIdentity(alice);
  const pki = testPki();
  const example = await buildExample();
  const png = example.files['gradient.png'];

  // The creator's manifest, declaring in advance which C2PA key will issue
  // credentials for this record. Its digest is what the record commits to.
  const manifest = JSON.parse(example.manifestText);
  manifest.creator.principal = alice.getPrincipal().toText();
  manifest.extensions[MANIFEST_EXTENSION].signers = [{ spki: { algorithm: 'sha256', hex: spkiSha256(pki.signerKeys.publicKey) } }];
  const manifestText = JSON.stringify(manifest);
  const manifestHash = createHash('sha256').update(canonicalizeValue(manifest), 'utf8').digest();
  const recordSalt = salt(10);

  const commitment = c.expectOk(await actor.commit({
    commitmentHash: Buffer.from(commitmentHex({
      principal: alice.getPrincipal().toText(),
      manifestHash: hex(manifestHash),
      salt: hex(recordSalt),
    }), 'hex'),
    metadataHash: [],
    expiresAt: [],
  }), 'alice commits to the manifest');
  const registered = c.expectOk(await actor.reveal({
    commitmentId: commitment.id,
    artifactHash: sha256(png),
    manifestHash,
    salt: recordSalt,
    title: 'gradient.png',
    kind: 'image',
    mimeType: 'image/png',
    storageUri: manifest.artifact.storageUri,
    parents: [],
    ai: {
      assisted: true,
      mode: { generate: null },
      provider: ['Example AI Provider'],
      model: ['Example Image Model'],
      promptHash: [],
      humanContribution: ['Prompt authorship and selection.'],
    },
    algorithm: [],
    collection: [],
  }), 'alice reveals the PNG as a record');

  // --------------------------------------------- the credential is issued
  const [certified] = await actor.getRecordCertified(registered.id);
  const record = recordToJson(certified.record);
  const signer = { privateKey: pki.signerKeys.privateKey, chain: [pki.signer] };
  const credential = issueCredential({ png, record, network: 'local', canisterId, signer });
  c.ok(credential.dataHash === record.artifactHash, 'the credential binds exactly the bytes the record registered');

  const online = onlineResolver({ actor, canisterId, rootKey });
  const verify = (asset, resolver, extra = {}) =>
    verifyAsset(asset, { resolver, trustAnchors: [pki.root], manifestText, ...extra });

  let report = await verify(credential.png, online);
  c.ok(report.verdict === 'verified', `online, certified, trusted, declared: verified (${report.verdict}: ${report.errors.concat(report.warnings.slice(0, -1)).join('; ')})`);
  c.ok(report.link.certification === 'verified' && report.link.source === 'online', 'the record was read through a verified certificate');
  c.ok(report.binding.signer === 'declared', 'the signer is the one alice declared in her committed manifest');

  // ------------------------------------------------ offline verification
  const saved = bundleFrom({ canisterId, recordId: registered.id, certified, rootKey });
  const offline = (bundles) => bundleResolver(bundles, { verifyCertified: verifyCertifiedRecord });
  report = await verify(credential.png, offline([saved]));
  c.ok(report.verdict === 'verified-with-warnings' && report.link.certification === 'verified',
    'offline, the saved certificate verifies against the subnet key');
  c.ok(report.warnings.length === 2 && report.warnings[0].startsWith('offline:'), 'and the only warning is that the status is as of the save');

  const rewritten = { ...saved, record: { ...saved.record, storageUri: 'https://attacker.example/gradient.png' } };
  report = await verify(credential.png, offline([rewritten]));
  c.ok(report.verdict === 'unverifiable' && report.link.certification === 'failed',
    'a bundle with a rewritten record fails certification');
  const wrongKey = { ...saved, rootKey: hex(Buffer.from(rootKey).map((b, i) => (i === 40 ? b ^ 1 : b))) };
  report = await verify(credential.png, offline([wrongKey]));
  c.ok(report.verdict === 'unverifiable' && report.errors.some((e) => e.includes('certificate did not verify')),
    'a certificate checked against the wrong root key does not verify');

  // --------------------------------------------------- broken references
  const dangling = issueCredential({ png, record: { ...record, id: '999' }, network: 'local', canisterId, signer });
  report = await verify(dangling.png, online);
  c.ok(report.verdict === 'unlinked' && report.errors.some((e) => e.startsWith('broken link: record 999')),
    'a credential naming a record the registry does not have is reported as a broken link');
  const elsewhere = issueCredential({ png, record, network: 'local', canisterId: 'aaaaa-aa', signer });
  report = await verify(elsewhere.png, online);
  c.ok(report.verdict === 'unverifiable' && report.link.resolution === 'unreachable',
    'a credential naming a canister the verifier cannot reach is unverifiable, not verified');

  const stripped = stripManifest(credential.png);
  report = await verify(stripped, online);
  c.ok(report.verdict === 'no-credential', 'a stripped copy has no credential');
  const [byHash] = await actor.getByArtifactHash(sha256(stripped));
  c.ok(byHash?.id === registered.id, 'but its bytes still resolve to the record: the record -> asset direction needs no credential');

  const edited = Buffer.from(credential.png);
  edited[edited.length - 20] ^= 1; // inside IDAT, so the chunk CRC catches it first
  report = await verify(edited, online);
  c.ok(report.verdict === 'invalid' && report.errors[0].includes('bad CRC'), 'a corrupted asset is invalid, with the reason');

  // ---------------------------------------------------------- revocation
  c.expectOk(await actor.revokeRecord(registered.id, 'withdrawn by the creator'), 'alice revokes the record');
  report = await verify(credential.png, online);
  c.ok(report.verdict === 'revoked' && report.record.revocationReason === 'withdrawn by the creator',
    'online, the unchanged credential now reports the certified revocation');
  c.ok(report.credential.valid, 'while still reporting the credential itself as intact');

  report = await verify(credential.png, offline([saved]));
  c.ok(report.verdict === 'verified-with-warnings' && report.warnings[0].startsWith('offline:'),
    'a bundle saved before the revocation still says active, and says when it was saved');
  const [afterRevocation] = await actor.getRecordCertified(registered.id);
  report = await verify(credential.png, offline([bundleFrom({ canisterId, recordId: registered.id, certified: afterRevocation, rootKey })]));
  c.ok(report.verdict === 'revoked' && report.link.certification === 'verified', 'a bundle saved after it carries the certified revocation');
  const replayed = { ...bundleFrom({ canisterId, recordId: registered.id, certified: afterRevocation, rootKey }), record: saved.record };
  report = await verify(credential.png, offline([replayed]));
  c.ok(report.verdict === 'unverifiable', 'presenting the old active record with the new certificate fails certification');

  try {
    issueCredential({ png, record: recordToJson(afterRevocation.record), network: 'local', canisterId, signer });
    c.ok(false, 'the bridge refuses to credential a revoked record');
  } catch {
    c.ok(true, 'the bridge refuses to credential a revoked record');
  }
}

async function main() {
  if (!(await isInstalled())) {
    console.error('pocket-ic is not installed. Run: node tools/pocket-ic/setup.mjs');
    return 127;
  }
  console.log('== c2pa bridge on a replica ==');
  const checks = new Checks('c2pa-bridge');
  try {
    // Compiled before the replica starts, not inside it: the pocket-ic server
    // shuts itself down after a minute without requests, and on a loaded
    // machine compiling app 01 takes longer than that.
    const { wasm, idl } = await buildCanister({
      appDir: resolve(repoRoot, 'apps/01_creator_proof_registry'),
      name: 'creator_proof_registry_c2pa',
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
