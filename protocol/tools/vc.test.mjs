// Offline tests for the Verifiable Credential integration (#11).
//
//   node protocol/tools/vc.test.mjs
//
// The W3C Recommendation's own eddsa-jcs-2022 vector is reproduced step by
// step — canonical forms, both hashes, the signature — which is the only check
// here that does not compare this implementation with itself. Everything after
// it is verdicts: every rejection is asserted with its reason code, because a
// test that only checked "not accepted" would pass for the wrong reason.

import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalizeValue, JcsError, parse as parseJson } from './jcs.mjs';
import {
  base58btcDecode,
  base58btcEncode,
  MultikeyError,
  privateKeyFromMultibase,
  publicKeyFromMultibase,
  publicKeyMultibase,
  resolveDidKey,
  secretKeyMultibase,
} from './multikey.mjs';
import {
  decodeStatusList,
  emptyStatusList,
  encodeStatusList,
  EXIT,
  getStatus,
  hashData,
  membershipCredential,
  MIN_STATUS_ENTRIES,
  principalUrn,
  REPORT_FORMAT,
  reviewCredential,
  setStatus,
  signCredential,
  statusEntry,
  statusListCredential,
  VcError,
  verifyCredential,
  verifyProof,
} from './vc.mjs';
import {
  buildExamples,
  CANISTER,
  DELEGATE,
  json,
  MEMBER,
  MEMBER_STATUS_INDEX,
  REVOKED_STATUS_INDEX,
  STATUS_LIST,
  VC_EXAMPLE_DIR,
} from './vc-example.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let checks = 0;
const check = (condition, description) => {
  assert.ok(condition, description);
  checks += 1;
};
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const sha256hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// ------------------------------------------------ W3C eddsa-jcs-2022 vector

const w3c = JSON.parse(await readFile(resolve(here, '../test-vectors/vc/eddsa-jcs-2022.json'), 'utf8'));
const w3cSecret = privateKeyFromMultibase(w3c.keyPair.secretKeyMultibase);
const w3cPublic = publicKeyFromMultibase(w3c.keyPair.publicKeyMultibase);
check(publicKeyMultibase(w3cPublic) === w3c.keyPair.publicKeyMultibase, 'W3C: the Multikey public key round-trips');
check(secretKeyMultibase(w3cSecret) === w3c.keyPair.secretKeyMultibase, 'W3C: the Multikey secret key round-trips');
check(publicKeyMultibase(createPublicKey(w3cSecret)) === w3c.keyPair.publicKeyMultibase, 'W3C: the secret key derives the published public key');
check(canonicalizeValue(w3c.unsecuredDocument) === w3c.canonicalDocument, 'W3C: the canonical document is byte-identical');
check(sha256hex(w3c.canonicalDocument) === w3c.canonicalDocumentHash, 'W3C: the document hash matches');
check(canonicalizeValue(w3c.proofOptions) === w3c.canonicalProofConfig, 'W3C: the canonical proof configuration is byte-identical');
check(sha256hex(w3c.canonicalProofConfig) === w3c.canonicalProofConfigHash, 'W3C: the proof configuration hash matches');
check(hex(hashData(w3c.unsecuredDocument, w3c.proofOptions)) === w3c.combinedHash, 'W3C: hashData is config hash then document hash');
const w3cSigned = signCredential(w3c.unsecuredDocument, {
  privateKey: w3cSecret,
  verificationMethod: w3c.proofOptions.verificationMethod,
  created: w3c.proofOptions.created,
});
check(hex(base58btcDecode(w3cSigned.proof.proofValue.slice(1))) === w3c.signature, 'W3C: the signature is byte-identical');
check(w3cSigned.proof.proofValue === w3c.proofValue, 'W3C: the proofValue is byte-identical');
check(JSON.stringify(w3cSigned.proof['@context']) === JSON.stringify(w3c.proofOptions['@context']), 'W3C: the proof carries the document @context');
check(verifyProof(w3cSigned).verified, 'W3C: the signed credential verifies');

const tampered = structuredClone(w3cSigned);
tampered.credentialSubject.alumniOf = 'Another School';
check(!verifyProof(tampered).verified, 'a changed subject fails the proof');
const backdated = structuredClone(w3cSigned);
backdated.proof.created = '2020-01-01T00:00:00Z';
check(!verifyProof(backdated).verified, 'a changed `created` fails the proof: the configuration is signed too');
const recontexted = structuredClone(w3cSigned);
recontexted['@context'] = ['https://www.w3.org/ns/credentials/v2', 'https://example.org/other'];
check(verifyProof(recontexted).errors[0].includes('@context'), 'a proof @context that is not a prefix of the document\'s is refused');
const repurposed = structuredClone(w3cSigned);
repurposed.proof.proofPurpose = 'authentication';
check(verifyProof(repurposed).errors[0].includes('purpose'), 'a proof made for another purpose is refused');
const hexProof = structuredClone(w3cSigned);
hexProof.proof.proofValue = `f${w3c.signature}`;
check(!verifyProof(hexProof).verified, 'a proofValue that is not base58-btc is refused');
check(!verifyProof({ ...w3cSigned, proof: [w3cSigned.proof] }).verified, 'proof sets are refused rather than half-checked');
assert.throws(() => resolveDidKey(`did:key:${w3c.keyPair.publicKeyMultibase}#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`), MultikeyError);
check(true, 'a did:key whose fragment names another key does not resolve');
assert.throws(() => signCredential(w3cSigned, { privateKey: w3cSecret, verificationMethod: 'x', created: '2026-01-01T00:00:00Z' }), VcError);
check(true, 'signing an already-secured document is refused');
assert.throws(() => signCredential(w3c.unsecuredDocument, { privateKey: w3cSecret, verificationMethod: 'x', created: '2026-01-01' }), VcError);
check(true, 'a `created` without a time zone is refused');

// ------------------------------------------------------------- base58, lists

check(base58btcEncode(Buffer.from('Hello World!')) === '2NEpo7TZRRrLZSi2U', 'base58-btc encodes the canonical example');
check(base58btcEncode(Buffer.from([0, 0, 1])) === '112' && hex(base58btcDecode('112')) === '000001', 'leading zero bytes survive as leading 1s');
assert.throws(() => base58btcDecode('0OIl'), MultikeyError);
check(true, 'characters outside the base58 alphabet are refused');

const bits = emptyStatusList();
check(bits.length * 8 === MIN_STATUS_ENTRIES, 'an empty list has the privacy minimum of 131072 entries');
setStatus(bits, 0);
setStatus(bits, 7);
setStatus(bits, 8);
check(bits[0] === 0x81 && bits[1] === 0x80, 'index 0 is the most significant bit of the first byte');
check(getStatus(bits, 0) === 1 && getStatus(bits, 1) === 0 && getStatus(bits, 8) === 1, 'bits read back where they were written');
check(getStatus(bits, 0, 2) === 2 && getStatus(bits, 3, 2) === 1, 'multi-bit status values read left to right');
setStatus(bits, 7, 0);
check(getStatus(bits, 7) === 0, 'a bit can be cleared');
check(hex(decodeStatusList(encodeStatusList(bits))) === hex(bits), 'a list round-trips through gzip and base64url');
const { gzipSync } = await import('node:zlib');
assert.throws(() => decodeStatusList(`u${gzipSync(Buffer.alloc(32 * 1024 * 1024)).toString('base64url')}`));
check(true, 'a list that inflates past 16 MiB is refused rather than inflated');

// ----------------------------------------------------------------- examples

const example = buildExamples();
const { keys } = example;
for (const name of ['membership', 'delegation', 'review', 'policy']) {
  const committed = await readFile(resolve(VC_EXAMPLE_DIR, `${name}.json`), 'utf8');
  check(committed === json(example[name]), `protocol/examples/vc/${name}.json is reproducible`);
}
const statusList = parseJson(await readFile(resolve(VC_EXAMPLE_DIR, 'status-list.json'), 'utf8'));
const listBits = decodeStatusList(statusList.credentialSubject.encodedList);
check(getStatus(listBits, REVOKED_STATUS_INDEX) === 1 && getStatus(listBits, MEMBER_STATUS_INDEX) === 0,
  'the committed status list revokes exactly the index it says');
check(listBits.reduce((n, byte) => n + byte.toString(2).split('1').length - 1, 0) === 1, 'and nothing else');
check(verifyProof(statusList).verified, 'the committed status list is signed');

// ----------------------------------------------------------------- verdicts

const at = new Date('2026-09-24T00:00:00Z');
const schema = JSON.parse(await readFile(resolve(here, '../schemas/vc-verification-report.schema.json'), 'utf8'));
const verdicts = schema.properties.verdict.enum;
check(verdicts.every((v) => v in EXIT) && Object.keys(EXIT).every((v) => verdicts.includes(v)), 'every verdict has an exit code, and only those');
const reasonCodes = schema.properties.reasons.items.enum;

function conforms(report) {
  for (const key of schema.required) assert.ok(key in report, `report has ${key}`);
  assert.equal(report.format, REPORT_FORMAT);
  assert.ok(verdicts.includes(report.verdict));
  for (const reason of report.reasons) assert.ok(reasonCodes.includes(reason), `reason ${reason} is in the schema`);
  return true;
}

const lists = (...credentials) => async (url) => credentials.find((c) => c.id === url) ?? null;
const run = (credential, extra = {}) =>
  verifyCredential(credential, { policy: example.policy, statusLists: lists(statusList), at, ...extra });
const rejectedFor = (report, reason) => conforms(report) && report.verdict === 'rejected' && report.reasons.includes(reason);
const studio = (options, created = '2026-04-01T00:00:00Z', key = keys.studio2026) =>
  signCredential(membershipCredential({
    id: 'urn:uuid:test',
    issuer: key.did,
    validFrom: '2026-01-01T00:00:00Z',
    member: MEMBER,
    organization: { name: 'Example Studio' },
    role: 'member',
    credentialStatus: statusEntry({ listId: STATUS_LIST, index: MEMBER_STATUS_INDEX }),
    ...options,
  }), { privateKey: key.privateKey, verificationMethod: key.verificationMethod, created });
const signList = (listBitsValue, { purpose = 'revocation', key = keys.studio2026, id = STATUS_LIST } = {}) =>
  signCredential(statusListCredential({ id, issuer: key.did, validFrom: '2026-01-01T00:00:00Z', statusPurpose: purpose, bits: listBitsValue }),
    { privateKey: key.privateKey, verificationMethod: key.verificationMethod, created: '2026-04-01T00:00:00Z' });

let report = await run(example.membership);
check(conforms(report) && report.verdict === 'accepted', 'the example membership credential is accepted');
check(report.checks.status === 'active' && report.checks.issuer === 'trusted', 'with its status and issuer checked');

// Expired / revoked, the issue's first two acceptance criteria.
report = await run(example.membership, { at: new Date('2027-05-01T00:00:00Z') });
check(rejectedFor(report, 'expired') && report.checks.validity === 'expired', 'an expired credential is rejected');
report = await run(example.membership, { at: new Date('2026-03-01T00:00:00Z') });
check(rejectedFor(report, 'not-yet-valid'), 'a credential before its validFrom is rejected');
const revokedList = signList(setStatus(emptyStatusList(), MEMBER_STATUS_INDEX));
report = await run(example.membership, { statusLists: lists(revokedList) });
check(rejectedFor(report, 'revoked') && report.checks.status === 'revoked', 'a revoked credential is rejected');
const suspensionList = signList(setStatus(emptyStatusList(), 5), { purpose: 'suspension', id: 'https://studio.example/status/suspension' });
const suspendable = studio({
  credentialStatus: [
    statusEntry({ listId: STATUS_LIST, index: MEMBER_STATUS_INDEX }),
    statusEntry({ listId: 'https://studio.example/status/suspension', index: 5, statusPurpose: 'suspension' }),
  ],
});
report = await run(suspendable, { statusLists: lists(statusList, suspensionList) });
check(rejectedFor(report, 'suspended'), 'a suspended credential is rejected, and says suspended rather than revoked');

// Unknown issuer: a warning, never a success.
const strangerCredential = studio({ issuer: keys.stranger.did }, '2026-04-01T00:00:00Z', keys.stranger);
report = await run(strangerCredential, { statusLists: lists(signList(emptyStatusList(), { key: keys.stranger })) });
check(conforms(report) && report.verdict === 'unknown-issuer', 'a valid signature from an unknown issuer is `unknown-issuer`');
check(report.checks.proof === 'verified' && report.warnings.some((w) => w.includes('not in the policy')), 'the proof is reported valid and the warning says why that is not enough');
check(EXIT['unknown-issuer'] !== 0, 'and the CLI does not exit 0 for it');
report = await run(strangerCredential, { statusLists: lists(signList(setStatus(emptyStatusList(), MEMBER_STATUS_INDEX), { key: keys.stranger })) });
check(rejectedFor(report, 'revoked'), 'an unknown issuer\'s revoked credential is rejected, not merely unknown');

// Issuer authority is per type.
const boardMembership = studio({ issuer: keys.board.did }, '2026-04-01T00:00:00Z', keys.board);
report = await run(boardMembership, { statusLists: lists(signList(emptyStatusList(), { key: keys.board })) });
check(rejectedFor(report, 'issuer-not-authorized'), 'a trusted issuer outside its credential types is rejected');
const impostor = signCredential(membershipCredential({
  id: 'urn:uuid:test', issuer: keys.studio2026.did, validFrom: '2026-01-01T00:00:00Z', member: MEMBER,
  organization: { name: 'Example Studio' }, role: 'member',
}), { privateKey: keys.stranger.privateKey, verificationMethod: keys.stranger.verificationMethod, created: '2026-04-01T00:00:00Z' });
report = await run(impostor);
check(rejectedFor(report, 'issuer-mismatch'), 'naming a trusted issuer while signing with another key is rejected');

// Issuer rotation.
const beforeRotation = studio({ issuer: keys.studio2025.did }, '2026-02-01T00:00:00Z', keys.studio2025);
const oldList = signList(emptyStatusList(), { key: keys.studio2025 });
report = await run(beforeRotation, { statusLists: lists(oldList) });
check(conforms(report) && report.verdict === 'accepted-with-warnings' && report.warnings.some((w) => w.includes('since retired')),
  'a credential signed before its key was superseded stays valid, with a warning');
const afterRotation = studio({ issuer: keys.studio2025.did }, '2026-04-01T00:00:00Z', keys.studio2025);
report = await run(afterRotation, { statusLists: lists(oldList) });
check(rejectedFor(report, 'retired-issuer-key'), 'a credential signed with a superseded key after it was superseded is rejected');
const compromisedPolicy = structuredClone(example.policy);
compromisedPolicy.issuers[0].keys[0].status = 'compromised';
report = await run(beforeRotation, { statusLists: lists(oldList), policy: compromisedPolicy });
check(rejectedFor(report, 'compromised-issuer-key'), 'a compromised key invalidates even what it claims to have signed earlier');

// Status failures.
report = await run(example.membership, { statusLists: lists() });
check(rejectedFor(report, 'status-unavailable'), 'an unreachable status list fails closed');
report = await run(example.membership, { statusLists: async () => { throw new Error('ETIMEDOUT'); } });
check(rejectedFor(report, 'status-unavailable') && report.errors[0].includes('ETIMEDOUT'), 'including when fetching it throws');
report = await run(example.membership, { statusLists: lists(), policy: { ...example.policy, statusFailure: 'warn' } });
check(conforms(report) && report.verdict === 'accepted-with-warnings', 'a policy may choose to fail open, and the report says so');
report = await run(example.membership, { statusLists: lists(signList(emptyStatusList(), { key: keys.stranger })) });
check(rejectedFor(report, 'status-unavailable') && report.errors[0].includes('not issued by'), 'a status list from someone else counts for nothing');
report = await run(example.membership, { statusLists: lists(signList(emptyStatusList(1024))) });
check(rejectedFor(report, 'status-unavailable') && report.errors[0].includes('LENGTH'), 'a list below the privacy minimum is refused');
report = await run(example.membership, { statusLists: lists(signList(emptyStatusList(), { purpose: 'suspension' })) });
check(rejectedFor(report, 'status-unavailable') && report.errors[0].includes('purpose'), 'a list for another status purpose is refused');
const forgedList = structuredClone(statusList);
forgedList.credentialSubject.encodedList = encodeStatusList(emptyStatusList());
report = await run(example.membership, { statusLists: lists(forgedList) });
check(rejectedFor(report, 'status-unavailable'), 'a status list whose bits were swapped fails its own proof');
const statusless = studio({ credentialStatus: undefined });
report = await run(statusless);
check(rejectedFor(report, 'status-required'), 'an issuer whose policy requires status cannot issue without it');

// Shape and integrity.
const edited = structuredClone(example.membership);
edited.credentialSubject.role = 'admin';
report = await run(edited);
check(rejectedFor(report, 'invalid-proof'), 'an edited credential is rejected');
report = await run({ ...example.membership, '@context': ['https://www.w3.org/2018/credentials/v1'] });
check(rejectedFor(report, 'malformed'), 'a VC 1.1 context is not VC 2.0');
assert.throws(() => parseJson('{"issuer":"a","issuer":"b"}'), JcsError);
check(true, 'a credential with a duplicate member is refused before verification');
assert.throws(() => principalUrn('not-a-principal'), VcError);
check(true, 'a subject principal must be in canonical textual form');
assert.throws(() => reviewCredential({ record: {}, outcome: 'approved', method: 'x', id: 'x', issuer: 'x', validFrom: 'x' }), VcError);
check(true, 'a review outcome outside consistent / inconsistent / inconclusive is refused');

// --------------------------------------------------- registry cross-checks

const NANOS = 1_000_000n;
const delegationOnChain = (overrides = {}) => ({
  id: 1n,
  creator: 1n,
  delegate: DELEGATE,
  scope: { collection: 1n },
  expiresAt: BigInt(Date.parse('2026-12-01T00:00:00Z')) * NANOS,
  status: { active: null },
  ...overrides,
});
const registry = ({ delegation = delegationOnChain(), creator = { root: MEMBER }, record } = {}) => ({
  getDelegation: async (canisterId, id) => (canisterId === CANISTER && id === 1n ? delegation : null),
  getCreator: async (canisterId, id) => (canisterId === CANISTER && id === 1n ? creator : null),
  getRecord: async (canisterId, id) => (canisterId === CANISTER && id === 1n ? record : null),
});

report = await run(example.delegation, { registry: registry() });
check(conforms(report) && report.verdict === 'accepted' && report.checks.registry === 'consistent', 'a delegation credential matching the chain is accepted');
report = await run(example.delegation, { registry: registry({ delegation: delegationOnChain({ status: { revoked: { at: 1n, reason: 'offboarded' } } }) }) });
check(rejectedFor(report, 'registry-mismatch') && report.errors[0].includes('offboarded'), 'a delegation revoked on-chain rejects the credential, with no status list involved');
report = await run(example.delegation, { registry: registry({ delegation: delegationOnChain({ expiresAt: BigInt(Date.parse('2026-09-01T00:00:00Z')) * NANOS }) }) });
check(rejectedFor(report, 'registry-mismatch'), 'a delegation expired on-chain rejects the credential');
report = await run(example.delegation, { registry: registry({ delegation: delegationOnChain({ expiresAt: BigInt(Date.parse('2026-10-01T00:00:00Z')) * NANOS }) }) });
check(rejectedFor(report, 'registry-mismatch') && report.errors[0].includes('outlives'), 'a credential that outlives its on-chain delegation is rejected');
report = await run(example.delegation, { registry: registry({ delegation: delegationOnChain({ scope: { all: null } }) }) });
check(rejectedFor(report, 'registry-mismatch') && report.errors[0].includes('scope'), 'a credential claiming a different scope than the chain grants is rejected');
report = await run(example.delegation, { registry: registry({ delegation: delegationOnChain({ delegate: MEMBER }) }) });
check(rejectedFor(report, 'registry-mismatch'), 'a credential for a different delegate is rejected');
report = await run(example.delegation, { registry: { getDelegation: async () => { throw new Error('replica down'); } } });
check(conforms(report) && report.verdict === 'accepted-with-warnings' && report.checks.registry === 'unavailable', 'an unreachable registry is a warning');
report = await run(example.delegation);
check(report.verdict === 'accepted-with-warnings' && report.warnings.some((w) => w.includes('on-chain delegation was not checked')), 'no registry at all is a warning for a delegation');

const withRegistry = example.membership;
report = await run(withRegistry, { registry: registry() });
check(report.verdict === 'accepted' && report.checks.registry === 'consistent', 'a membership credential for the creator\'s current root is consistent');
report = await run(withRegistry, { registry: registry({ creator: { root: DELEGATE } }) });
check(rejectedFor(report, 'registry-mismatch') && report.errors[0].includes('current root'), 'after the creator rotates its key, membership naming the old key is stale');

const recordOnChain = { artifactHash: example.review.credentialSubject.artifactHash, manifestHash: example.review.credentialSubject.manifestHash, revoked: false };
report = await run(example.review, { registry: registry({ record: recordOnChain }) });
check(report.verdict === 'accepted' && report.checks.registry === 'consistent', 'a review of a record whose hashes match is consistent');
report = await run(example.review, { registry: registry({ record: { ...recordOnChain, revoked: true } }) });
check(report.verdict === 'accepted-with-warnings' && report.warnings.some((w) => w.includes('since been revoked')), 'a review of a since-revoked record stands, with a warning');
report = await run(example.review, { registry: registry({ record: { ...recordOnChain, manifestHash: '00'.repeat(32) } }) });
check(rejectedFor(report, 'registry-mismatch'), 'a review of different evidence than the record holds is rejected');

console.log(`verifiable credentials: ${checks} checks passed`);
