// Offline tests for the C2PA bridge (#10): CBOR, JUMBF, the test PKI, COSE,
// the PNG manifest writer and validator, and the bridge's verdicts.
//
// Dependency-free, so it runs in scripts/run_offline_checks.sh. What needs a
// replica — a real record, a real certificate, a real revocation — is in
// tools/pocket-ic/c2pa-bridge.test.mjs; what needs c2patool is in
// c2pa-crosscheck.mjs.
//
//   node protocol/tools/c2pa.test.mjs

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

import { CborError, decode, encode, Tagged } from './cbor.mjs';
import { CoseError, sign1, verify1 } from './cose.mjs';
import { box, descriptionBox, JumbfError, parseBoxes, parseDescription, UUID } from './jumbf.mjs';
import { C2paError, pngChunk, pngChunks, signPng, stripManifest, validatePng } from './c2pa.mjs';
import { evaluateChain, issue, OID, pem, spkiSha256, testPki, X509Error, ed25519FromSeed, testSeed } from './x509.mjs';
import {
  BUNDLE_FORMAT,
  buildExample,
  bundleResolver,
  EXAMPLE_DIR,
  EXIT,
  ICP_PROOF_LABEL,
  icpProofAssertion,
  issueCredential,
  MANIFEST_EXTENSION,
  recordFromJson,
  recordToJson,
  REPORT_FORMAT,
  verifyAsset,
} from './c2pa-bridge.mjs';
import { recordDigest } from '../../apps/01_creator_proof_registry/test/record-digest.mjs';

let checks = 0;
const check = (condition, description) => {
  assert.ok(condition, description);
  checks += 1;
};
const throwsLike = (fn, type, description) => {
  assert.throws(fn, type, description);
  checks += 1;
};

// ---------------------------------------------------------------------- CBOR

const hex = (bytes) => Buffer.from(bytes).toString('hex');

// Preferred serialization at every width boundary: a signed structure has one
// encoding, and it is the shortest.
const INTEGERS = [
  [0, '00'], [23, '17'], [24, '1818'], [255, '18ff'], [256, '190100'], [65535, '19ffff'],
  [65536, '1a00010000'], [4294967295, '1affffffff'], [4294967296, '1b0000000100000000'],
  [-1, '20'], [-24, '37'], [-25, '3818'], [-256, '38ff'], [-257, '390100'],
];
for (const [value, expected] of INTEGERS) {
  check(hex(encode(value)) === expected, `integer ${value} encodes as ${expected}`);
  check(decode(Buffer.from(expected, 'hex')) === value, `integer ${expected} decodes to ${value}`);
}
const nested = { a: [1, 'x', new Uint8Array([1, 2]), null, true, false], b: new Map([[1, -7], [33, new Uint8Array([9])]]) };
const nestedBytes = encode(nested);
check(hex(encode(decode(nestedBytes))) === hex(nestedBytes), 'a nested value round-trips byte for byte');
check(hex(encode(new Tagged(18, [1]))) === 'd28101', 'a tag encodes before its item');
check(hex(encode({ keep: 1, drop: undefined })) === 'a1646b65657001', 'an undefined member is omitted, not encoded');
throwsLike(() => encode(1.5), CborError, 'a float is refused rather than encoded in some width');
throwsLike(() => decode(Buffer.from('a2616101616102', 'hex')), CborError, 'a duplicate map key is rejected');
throwsLike(() => decode(Buffer.from('0000', 'hex')), CborError, 'trailing bytes are rejected');
throwsLike(() => decode(Buffer.from('5820aa', 'hex')), CborError, 'a truncated byte string is rejected');
throwsLike(() => decode(Buffer.from('62c328', 'hex')), CborError, 'invalid UTF-8 in a text string is rejected');
// Other claim generators may write indefinite lengths and floats; a verifier
// that cannot read them verifies only itself.
assert.deepEqual(decode(Buffer.from('9f0102ff', 'hex')), [1, 2]);
assert.deepEqual(decode(Buffer.from('bf616101ff', 'hex')), { a: 1 });
check(hex(decode(Buffer.from('5f42010241ffff', 'hex'))) === '0102ff', 'indefinite-length arrays, maps and strings decode');
check(decode(Buffer.from('f93c00', 'hex')) === 1 && decode(Buffer.from('fa3fc00000', 'hex')) === 1.5, 'half and single floats decode');
check(Object.getPrototypeOf(decode(encode({ ['__proto__']: 1 }))) === Object.prototype, 'a __proto__ key stays data');

// --------------------------------------------------------------------- JUMBF

// The type UUIDs, pinned to the bytes c2patool 0.27.22 writes.
check(hex(UUID.manifestStore) === '6332706100110010800000aa00389b71', 'manifest store UUID (c2pa)');
check(hex(UUID.manifest) === '63326d6100110010800000aa00389b71', 'manifest UUID (c2ma)');
check(hex(UUID.assertionStore) === '6332617300110010800000aa00389b71', 'assertion store UUID (c2as)');
check(hex(UUID.claim) === '6332636c00110010800000aa00389b71', 'claim UUID (c2cl)');
check(hex(UUID.signature) === '6332637300110010800000aa00389b71', 'signature UUID (c2cs)');
check(hex(UUID.cbor) === '63626f7200110010800000aa00389b71', 'CBOR assertion UUID');
const description = parseDescription(descriptionBox({ uuid: UUID.cbor, label: 'x.y', salt: Buffer.alloc(16, 7) }).subarray(8));
check(description.label === 'x.y' && description.toggles === 0x13 && hex(description.salt) === '07'.repeat(16),
  'a salted description box round-trips its label, toggles and salt');
throwsLike(() => parseBoxes(Buffer.from('00000010', 'hex')), JumbfError, 'a truncated box header is rejected');
throwsLike(() => parseBoxes(Buffer.concat([box('abcd', Buffer.alloc(4)).subarray(0, 10)])), JumbfError, 'a box overrunning its container is rejected');
throwsLike(() => descriptionBox({ uuid: UUID.cbor, label: 'a\0b' }), JumbfError, 'a label containing NUL is refused');

// ---------------------------------------------------------------------- X.509

const pki = testPki();
const { X509Certificate } = await import('node:crypto');
const root = new X509Certificate(pki.root);
const signerCert = new X509Certificate(pki.signer);
check(root.ca && root.checkIssued(root) && root.verify(root.publicKey), 'the test root is a self-signed CA');
check(!signerCert.ca && signerCert.checkIssued(root) && signerCert.verify(root.publicKey), 'the signer is issued by the root and is not a CA');
check(signerCert.keyUsage.includes(OID.documentSigning), 'the signer carries the documentSigning EKU');
check(hex(testPki().signer) === hex(pki.signer), 'the test PKI is deterministic');
const at = new Date('2026-09-24T00:00:00Z');
check(evaluateChain([pki.signer], [pki.root], at).trusted === true, 'a chain ending at a trust anchor is trusted');
check(evaluateChain([pki.signer], null, at).trusted === null, 'without a trust list, trust is not evaluated rather than failed');
const other = testPki({ signerLabel: 'other' });
const otherRoot = issue({
  subject: { CN: 'unrelated root' },
  publicKey: ed25519FromSeed(testSeed('unrelated root')).publicKey,
  issuer: { name: { CN: 'unrelated root' }, ...ed25519FromSeed(testSeed('unrelated root')) },
  ca: true, serial: Buffer.from([9]), notBefore: at, notAfter: new Date('2030-01-01T00:00:00Z'),
});
check(evaluateChain([other.signer], [otherRoot], at).trusted === false, 'a chain ending elsewhere is untrusted');
check(evaluateChain([pki.signer], [pki.root], new Date('2040-01-01T00:00:00Z')).profile === false, 'an expired signer fails its profile');
const noEku = issue({
  subject: { CN: 'no eku' }, publicKey: ed25519FromSeed(testSeed('no eku')).publicKey,
  issuer: { name: { CN: 'motoko-lab Test Root CA' }, ...pki.rootKeys }, serial: Buffer.from([7]),
  notBefore: at, notAfter: new Date('2030-01-01T00:00:00Z'), ekus: ['1.3.6.1.5.5.7.3.1'],
});
check(evaluateChain([noEku], [pki.root], at).profile === false, 'a certificate without a claim-signing EKU is not a signing credential');
throwsLike(() => issue({
  subject: { CN: 'self' }, publicKey: pki.signerKeys.publicKey, issuer: { name: { CN: 'self' }, ...pki.signerKeys },
  serial: Buffer.from([1]), notBefore: at, notAfter: at,
}), X509Error, 'a self-signed signing certificate is refused');
check(pem(pki.root).startsWith('-----BEGIN CERTIFICATE-----\n'), 'certificates export as PEM');

// ----------------------------------------------------------------------- COSE

const claimBytes = encode({ claim: 'bytes' });
const ed = sign1({ payload: claimBytes, privateKey: pki.signerKeys.privateKey, chain: [pki.signer] });
check(verify1(ed, claimBytes).valid === true, 'an Ed25519 COSE_Sign1 verifies over its detached payload');
check(verify1(ed, encode({ claim: 'other' })).valid === false, 'it does not verify over a different payload');
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ecCert = issue({
  subject: { CN: 'es256 signer' }, publicKey: ec.publicKey,
  issuer: { name: { C: 'JP', O: 'motoko-lab test PKI', OU: 'FOR TESTING ONLY', CN: 'motoko-lab Test Root CA' }, ...pki.rootKeys },
  serial: Buffer.from([5]), notBefore: at, notAfter: new Date('2030-01-01T00:00:00Z'),
});
const es = sign1({ payload: claimBytes, privateKey: ec.privateKey, chain: [ecCert], alg: -7 });
check(verify1(es, claimBytes).valid && verify1(es, claimBytes).algName === 'ES256', 'an ES256 COSE_Sign1 verifies');
const esTampered = decode(es);
esTampered.value[0] = encode(new Map([[1, -7], [33, new Uint8Array(pki.signer)]]));
check(verify1(encode(esTampered), claimBytes).valid === false, 'swapping the chain in the protected header breaks the signature');
const attached = decode(ed);
attached.value[2] = claimBytes;
throwsLike(() => verify1(encode(attached), claimBytes), CoseError, 'an attached payload is refused for a claim signature');

// -------------------------------------------------------------- C2PA on PNG

const example = await buildExample();
const png = example.files['gradient.png'];
const signer = { privateKey: pki.signerKeys.privateKey, chain: [pki.signer] };
const signed = signPng({
  png,
  assertions: [{ label: 'org.example.note', data: { note: 'hello' } }, { label: 'org.example.gathered', data: { g: 1 }, created: false }],
  signer,
  claimGenerator: { name: 'test', version: '1' },
  title: 'gradient.png',
});
const valid = validatePng(signed.png, { trustAnchors: [pki.root], at });
check(valid.valid, 'a manifest written here validates here');
check(valid.status.some((s) => s.code === 'signingCredential.trusted'), 'the signer is trusted against the test root');
check(valid.assertions.get('org.example.note').created && !valid.assertions.get('org.example.gathered').created,
  'created and gathered assertions are told apart');
check(hex(stripManifest(signed.png)) === hex(png), 'stripping the manifest store gives back the original file exactly');
check(signed.dataHash === createHash('sha256').update(png).digest('hex'), 'the hard binding is the hash of the unsigned file');
throwsLike(() => signPng({ png: signed.png, assertions: [], signer, claimGenerator: { name: 't' }, title: 't' }), C2paError,
  'a PNG that already has a manifest store is refused');
check(!validatePng(png).present, 'an unsigned PNG has no credential');

// Rewrites one chunk's data and fixes its CRC, the way an editor would: a
// tampering that also broke the CRC would be caught for the wrong reason.
function replaceChunk(file, type, edit) {
  const out = [file.subarray(0, 8)];
  for (const chunk of pngChunks(file)) {
    out.push(chunk.type === type ? pngChunk(type, edit(Buffer.from(chunk.data))) : file.subarray(chunk.start, chunk.end));
  }
  return Buffer.concat(out);
}
const codes = (result) => result.status.map((s) => s.code);
let report0;

const repainted = replaceChunk(signed.png, 'IDAT', (data) => {
  const raw = inflateSync(data);
  raw[10] ^= 0xff;
  return deflateSync(raw, { level: 9 });
});
const repaintedResult = validatePng(repainted, { at });
check(!repaintedResult.valid && codes(repaintedResult).includes('assertion.dataHash.mismatch'), 'a changed pixel fails the hard binding');

const editStore = (edit) => replaceChunk(signed.png, 'caBX', (data) => {
  const out = Buffer.from(data);
  edit(out);
  return out;
});
const noteAt = (data) => data.indexOf(Buffer.from('hello'));
const assertionEdited = validatePng(editStore((d) => { d[noteAt(d)] = 0x48; }), { at });
check(!assertionEdited.valid && codes(assertionEdited).includes('assertion.hashedURI.mismatch'), 'an edited assertion fails its hashed URI');
check(!assertionEdited.assertions.has('org.example.note'), 'and its content is not returned to the caller');
const claimEdited = validatePng(editStore((d) => {
  const i = d.indexOf(Buffer.from('gradient.png'));
  d[i] = 0x47;
}), { at });
check(!claimEdited.valid && codes(claimEdited).includes('claimSignature.mismatch'), 'an edited claim fails its signature');

// Inserting a chunk ahead of the store moves it, so the signed exclusion no
// longer covers exactly the store. Accepting that would let an exclusion be
// pointed at pixel data.
const chunks = pngChunks(signed.png);
const shifted = Buffer.concat([
  signed.png.subarray(0, chunks[0].end),
  pngChunk('tEXt', Buffer.from('Comment\0inserted')),
  signed.png.subarray(chunks[0].end),
]);
const shiftedResult = validatePng(shifted, { at });
check(!shiftedResult.valid && codes(shiftedResult).includes('assertion.dataHash.mismatch'), 'a moved manifest store fails the hard binding');
const badCrc = Buffer.from(signed.png);
badCrc[chunks[0].end - 1] ^= 1;
throwsLike(() => validatePng(badCrc), C2paError, 'a chunk with a bad CRC is an error, not skipped');
report0 = await verifyAsset(badCrc, { at });
check(report0.verdict === 'invalid' && report0.errors[0].includes('bad CRC'), 'and the bridge reports it as invalid rather than crashing');
const twoStores = Buffer.concat([signed.png.subarray(0, chunks[1].end), signed.png.subarray(chunks[1].start)]);
check(codes(validatePng(twoStores)).includes('claim.malformed'), 'two manifest store chunks are malformed');

// ------------------------------------------------------------ the example

// The committed example is exactly what the code produces. If it drifted, the
// published credential would be evidence for a different implementation.
for (const [name, bytes] of Object.entries(example.files)) {
  const committed = await readFile(resolve(EXAMPLE_DIR, name));
  check(committed.equals(bytes), `protocol/examples/c2pa/${name} is reproducible`);
}
const exampleSigned = example.files['gradient.c2pa.png'];
const bundleJson = JSON.parse(example.files['record-bundle.json']);
const anchors = [pki.root];

// ----------------------------------------------------------- record codecs

const roundTrip = recordToJson(recordFromJson(bundleJson.record));
assert.deepEqual(roundTrip, bundleJson.record);
check(true, 'a record survives JSON -> Candid form -> JSON unchanged');
const revokedJson = { ...bundleJson.record, status: { revoked: { at: '1790300000000000000', reason: 'withdrawn' } } };
check(hex(recordDigest(recordFromJson(revokedJson))) !== hex(recordDigest(recordFromJson(bundleJson.record))),
  'the revoked status is part of the digest a bundle is checked against');

// ---------------------------------------------------------------- verdicts

const schema = JSON.parse(await readFile(resolve(EXAMPLE_DIR, '../../schemas/c2pa-verification-report.schema.json'), 'utf8'));
const verdicts = schema.properties.verdict.enum;
check(verdicts.every((v) => v in EXIT) && Object.keys(EXIT).every((v) => verdicts.includes(v)), 'every verdict has an exit code, and only those');

function conforms(report) {
  for (const key of schema.required) assert.ok(key in report, `report has ${key}`);
  assert.equal(report.format, REPORT_FORMAT);
  assert.ok(verdicts.includes(report.verdict));
  assert.ok(report.warnings.includes('Registration evidence is not legal authorship proof.'));
  return true;
}

const bundle = (record = bundleJson.record, extra = {}) => ({ ...bundleJson, record, ...extra });
const verify = (asset, { bundles = [bundle()], manifestText = example.manifestText, trust = anchors, verifyCertified } = {}) =>
  verifyAsset(asset, { resolver: bundleResolver(bundles, { verifyCertified }), trustAnchors: trust, manifestText, at });

let report = await verify(exampleSigned);
check(conforms(report) && report.verdict === 'verified-with-warnings', 'the example verifies offline, with warnings');
check(report.binding.signer === 'declared' && report.binding.disclosure === 'consistent', 'its signer is the one the creator declared');
check(report.record.status === 'active' && report.link.certification === 'unverified', 'the record is active, and the uncertified bundle is said to be uncertified');
check(report.warnings.some((w) => w.startsWith('offline: the record status is as of')), 'an offline verdict says when the status was observed');

// A certificate verifier that attests the bundled record's digest stands in
// for the BLS check here; the replica test runs the real one.
const attest = (record) => async () => recordDigest(recordFromJson(record));
report = await verify(exampleSigned, { bundles: [bundle(undefined, { certificate: '00' })], verifyCertified: attest(bundleJson.record) });
check(report.link.certification === 'verified' && !report.warnings.some((w) => w.includes('not certified')),
  'a certified bundle carries no certification warning');
report = await verify(exampleSigned, { bundles: [bundle(undefined, { certificate: '00' })], verifyCertified: attest(revokedJson) });
check(report.verdict === 'unverifiable' && report.link.certification === 'failed',
  'a bundle whose record differs from what the certificate attests is unverifiable');
report = await verify(exampleSigned, { verifyCertified: async () => { throw new Error('bad signature'); } });
check(report.verdict === 'unverifiable' && report.errors.some((e) => e.includes('bad signature')), 'a certificate that does not verify is unverifiable');

report = await verify(exampleSigned, { bundles: [bundle(revokedJson)] });
check(conforms(report) && report.verdict === 'revoked', 'credential valid, record revoked: revoked');
check(report.record.revocationReason === 'withdrawn' && report.credential.valid, 'the reason is reported and the credential is still reported valid');

report = await verify(exampleSigned, { bundles: [bundle(undefined, { recordId: '2' })] });
check(conforms(report) && report.verdict === 'unlinked' && report.errors.some((e) => e.startsWith('broken link')),
  'a record the registry does not have is a broken link');
report = await verifyAsset(exampleSigned, { trustAnchors: anchors, at });
check(report.verdict === 'unverifiable', 'with no registry to ask, the result is unverifiable, not verified');
report = await verifyAsset(exampleSigned, { resolver: { resolve: async () => { throw new Error('ECONNREFUSED'); } }, trustAnchors: anchors, at });
check(report.verdict === 'unverifiable' && report.link.resolution === 'unreachable', 'an unreachable registry is unverifiable, not a broken link');

report = await verify(repaintedFrom(exampleSigned));
check(conforms(report) && report.verdict === 'invalid', 'a modified asset is invalid');
report = await verify(stripManifest(exampleSigned));
check(conforms(report) && report.verdict === 'no-credential', 'a stripped asset has no credential');

report = await verify(exampleSigned, { bundles: [bundle({ ...bundleJson.record, artifactHash: '00'.repeat(32) })] });
check(report.verdict === 'invalid' && report.record.artifactHashMatch === false, 'a record for a different artifact is a contradiction');
report = await verify(exampleSigned, { manifestText: example.manifestText.replace('Example Creator', 'Someone Else') });
check(report.verdict === 'invalid' && report.binding.signer === 'manifest-mismatch', 'a manifest the record did not commit to is refused');

report = await verify(exampleSigned, { trust: null });
check(report.verdict === 'verified-with-warnings' && report.warnings.some((w) => w.includes('trust list')), 'no trust list is a warning');
report = await verify(exampleSigned, { trust: [otherRoot] });
check(report.warnings.some((w) => w.startsWith('the signer is not trusted')), 'an untrusted signer is a warning');

// Credential laundering: someone else signs a credential that points at the
// creator's record. The hashes all match — it is the same asset — so only the
// signer declaration in the committed manifest can tell.
const mallory = testPki({ signerLabel: 'mallory' });
const laundered = issueCredential({
  png, record: bundleJson.record, network: 'example', canisterId: bundleJson.canisterId,
  signer: { privateKey: mallory.signerKeys.privateKey, chain: [mallory.signer] },
});
report = await verify(laundered.png);
check(report.verdict === 'invalid' && report.binding.signer === 'undeclared', 'a credential from a signer the creator did not declare is invalid');
const manifestWithout = JSON.parse(example.manifestText);
delete manifestWithout.extensions[MANIFEST_EXTENSION];
const { canonicalizeValue } = await import('./jcs.mjs');
const withoutHash = createHash('sha256').update(canonicalizeValue(manifestWithout), 'utf8').digest('hex');
report = await verify(laundered.png, {
  bundles: [bundle({ ...bundleJson.record, manifestHash: withoutHash })],
  manifestText: JSON.stringify(manifestWithout),
});
// The laundered credential names the original manifest hash, so with a record
// that committed to a different manifest it is a contradiction first.
check(report.verdict === 'invalid' && report.record.manifestHashMatch === false, 'a credential naming another manifest than the record is invalid');
const undeclaredRecord = { ...bundleJson.record, manifestHash: withoutHash };
const undeclared = issueCredential({ png, record: undeclaredRecord, network: 'example', canisterId: bundleJson.canisterId, signer });
report = await verify(undeclared.png, { bundles: [bundle(undeclaredRecord)], manifestText: JSON.stringify(manifestWithout) });
check(report.verdict === 'verified-with-warnings' && report.binding.signer === 'not-declared', 'a manifest declaring no signer is a warning, not a pass');
report = await verify(exampleSigned, { manifestText: null });
check(report.binding.signer === 'not-checked' && report.warnings.some((w) => w.includes('manifest was not supplied')), 'without the manifest, the signer binding is not checked');

// Disclosure: the credential may not say less about AI than the record does.
throwsLike(() => issueCredential({
  png, record: bundleJson.record, network: 'example', canisterId: bundleJson.canisterId, signer,
  digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture',
}), Error, 'the bridge refuses to understate a record\'s AI disclosure');
const understated = signPng({
  png,
  assertions: [
    { label: 'c2pa.actions.v2', data: { actions: [{ action: 'c2pa.created', digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture' }] } },
    { label: ICP_PROOF_LABEL, data: icpProofAssertion({ network: 'example', canisterId: bundleJson.canisterId, record: bundleJson.record }) },
  ],
  signer, claimGenerator: { name: 'hand-rolled' }, title: 't',
});
report = await verify(understated.png);
check(report.verdict === 'invalid' && report.binding.disclosure === 'understated', 'a credential understating AI use is invalid');

// The ICP link is only read from a signed assertion the signer made. A
// gathered one is not attributed to the signer, so it cannot link anything.
const gathered = signPng({
  png,
  assertions: [
    { label: 'c2pa.actions.v2', data: { actions: [{ action: 'c2pa.created', digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia' }] } },
    { label: ICP_PROOF_LABEL, data: icpProofAssertion({ network: 'example', canisterId: bundleJson.canisterId, record: bundleJson.record }), created: false },
  ],
  signer, claimGenerator: { name: 'hand-rolled' }, title: 't',
});
report = await verify(gathered.png);
check(report.verdict === 'unlinked' && report.link.assertion === 'missing', 'a gathered ICP assertion does not link the credential');

throwsLike(() => issueCredential({ png: repaintedFrom(png, false), record: bundleJson.record, network: 'x', canisterId: 'x', signer }), Error,
  'the bridge refuses to credential bytes the record did not register');
throwsLike(() => issueCredential({ png, record: revokedJson, network: 'x', canisterId: 'x', signer }), Error,
  'the bridge refuses to credential a revoked record');
check(bundleJson.format === BUNDLE_FORMAT, 'the example bundle names its format');

function repaintedFrom(file, hasStore = true) {
  void hasStore;
  return replaceChunk(file, 'IDAT', (data) => {
    const raw = inflateSync(data);
    raw[20] ^= 0x55;
    return deflateSync(raw, { level: 9 });
  });
}

console.log(`c2pa bridge: ${checks} checks passed`);
