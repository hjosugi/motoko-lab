#!/usr/bin/env node
// W3C Verifiable Credentials for the creator provenance protocol (#11).
//
// A principal proves control of a key. It does not prove that the key belongs
// to a member of an organization, that someone was authorized to publish on a
// creator's behalf, or that a reviewer looked at a record. Those are claims
// somebody else makes, and a Verifiable Credential is the standard container
// for "somebody else says so, and here is their signature".
//
//   * VC Data Model 2.0 credentials of three types: CreatorMembershipCredential,
//     DelegatedAuthorityCredential, ProvenanceReviewCredential.
//   * Data Integrity proofs with the `eddsa-jcs-2022` cryptosuite (W3C
//     Recommendation, 15 May 2025). JCS is RFC 8785, which `jcs.mjs` already
//     implements, so no JSON-LD processor is needed to sign or verify.
//   * Bitstring Status List v1.0 (W3C Recommendation, 15 May 2025) for
//     revocation and suspension.
//   * An issuer policy: which issuers are trusted for which credential types,
//     with key history, because a did:key cannot rotate — a new key is a new
//     DID — so rotation has to live somewhere, and it lives here.
//   * An optional read-only cross-check against the registry's creator
//     identity and delegations (#7): a credential that says more than the
//     chain does is rejected.
//
// See protocol/VERIFIABLE_CREDENTIALS.md.
//
//   node protocol/tools/vc.mjs verify <credential.json> --policy policy.json
//        [--status-list url=file.json ...] [--json]

import { createHash, sign, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { gunzipSync, gzipSync } from 'node:zlib';

import { canonicalizeValue, parse as parseJson } from './jcs.mjs';
import { multibaseBase58, multibaseBase64url, multibaseDecode, resolveDidKey } from './multikey.mjs';
import { isValid as isPrincipal } from './principal.mjs';

export const VC_CONTEXT = 'https://www.w3.org/ns/credentials/v2';
export const CRYPTOSUITE = 'eddsa-jcs-2022';
export const REPORT_FORMAT = 'vc-verification/1';

export const TYPES = Object.freeze({
  membership: 'CreatorMembershipCredential',
  delegation: 'DelegatedAuthorityCredential',
  review: 'ProvenanceReviewCredential',
});

export class VcError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VcError';
  }
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest();

// XML Schema dateTimeStamp: a date-time that must carry a time zone. Data
// Integrity requires it for `created`, and VC 2.0 for `validFrom`/`validUntil`.
const DATE_TIME_STAMP = /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function timestamp(value, field) {
  if (typeof value !== 'string' || !DATE_TIME_STAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new VcError(`${field} is not an XML Schema dateTimeStamp`);
  }
  return new Date(value);
}

// ------------------------------------------------ Data Integrity: eddsa-jcs-2022

/**
 * The `hashData` of eddsa-jcs-2022 §3.3.4: SHA-256 of the canonical proof
 * configuration, then SHA-256 of the canonical document — in that order.
 */
export function hashData(unsecuredDocument, proofConfig) {
  const transformed = canonicalizeValue(unsecuredDocument);
  const canonicalConfig = canonicalizeValue(proofConfig);
  return Buffer.concat([sha256(canonicalConfig), sha256(transformed)]);
}

/**
 * Adds an eddsa-jcs-2022 DataIntegrityProof. `created` is required rather
 * than defaulted to "now": the proof covers it, and a caller who wants
 * reproducible output needs to be the one choosing it.
 */
export function signCredential(unsecured, { privateKey, verificationMethod, created, proofPurpose = 'assertionMethod' }) {
  if ('proof' in unsecured) throw new VcError('the document already carries a proof; this suite signs unsecured documents');
  timestamp(created, 'created');
  const options = { type: 'DataIntegrityProof', cryptosuite: CRYPTOSUITE, created, verificationMethod, proofPurpose };
  if (unsecured['@context'] !== undefined) options['@context'] = unsecured['@context'];
  const proofValue = multibaseBase58(sign(null, hashData(unsecured, options), privateKey));
  return { ...unsecured, proof: { ...options, proofValue } };
}

/**
 * Verifies an eddsa-jcs-2022 proof (§3.3.2). Returns
 * `{ verified, errors, proof }`; never throws for a bad credential.
 *
 * `resolveKey(verificationMethod)` returns `{ controller, publicKey }`. The
 * default resolves did:key, which needs no network.
 */
export function verifyProof(secured, { resolveKey = resolveDidKey, expectedPurpose = 'assertionMethod' } = {}) {
  const errors = [];
  const fail = (message) => {
    errors.push(message);
    return { verified: false, errors, proof: secured?.proof ?? null };
  };
  const proof = secured?.proof;
  if (!proof) return fail('the credential carries no proof');
  if (Array.isArray(proof)) return fail('proof sets and chains are not supported; exactly one proof is expected');
  if (proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== CRYPTOSUITE) {
    return fail(`unsupported proof ${proof.type}/${proof.cryptosuite}`);
  }
  if (proof.proofPurpose !== expectedPurpose) return fail(`proof purpose is ${proof.proofPurpose}, expected ${expectedPurpose}`);
  let signature;
  try {
    timestamp(proof.created, 'proof.created');
    if (proof.proofValue?.[0] !== 'z') throw new VcError('proofValue is not base58-btc multibase');
    signature = multibaseDecode(proof.proofValue);
    if (signature.length !== 64) throw new VcError('an Ed25519 proofValue is 64 bytes');
  } catch (error) {
    return fail(error.message);
  }
  // §3.3.2 step 3: a proof that names a context must name a prefix of the
  // document's, in order, or the proof configuration describes a different
  // vocabulary than the one the document is read in.
  if (proof['@context'] !== undefined) {
    const documentContext = [].concat(secured['@context'] ?? []);
    const proofContext = [].concat(proof['@context']);
    if (!proofContext.every((item, i) => JSON.stringify(item) === JSON.stringify(documentContext[i]))) {
      return fail('the proof @context does not match the document @context');
    }
  }
  let key;
  try {
    key = resolveKey(proof.verificationMethod);
  } catch (error) {
    return fail(`verification method does not resolve: ${error.message}`);
  }
  const { proof: _removed, ...unsecured } = secured;
  const { proofValue: _value, ...config } = proof;
  let valid;
  try {
    valid = verify(null, hashData(unsecured, config), key.publicKey, signature);
  } catch (error) {
    return fail(`signature check failed: ${error.message}`);
  }
  if (!valid) return fail('the proof does not verify');
  return { verified: true, errors, proof, controller: key.controller };
}

// ------------------------------------------------ Bitstring Status List v1.0

/// The minimum a status list may carry. Smaller lists shrink the crowd a
/// holder hides in when the list is fetched, which is the privacy property the
/// specification sets this floor to protect.
export const MIN_STATUS_ENTRIES = 131_072;

export function emptyStatusList(entries = MIN_STATUS_ENTRIES) {
  if (entries % 8) throw new VcError('a status list is a whole number of bytes');
  return new Uint8Array(entries / 8);
}

/// Index 0 is the left-most bit: the most significant bit of the first byte.
export function setStatus(bits, index, value = 1) {
  const byte = Math.floor(index / 8);
  const mask = 0x80 >> index % 8;
  if (byte >= bits.length) throw new VcError(`status index ${index} is outside the list`);
  bits[byte] = value ? bits[byte] | mask : bits[byte] & ~mask;
  return bits;
}

export function getStatus(bits, index, statusSize = 1) {
  let value = 0;
  for (let k = 0; k < statusSize; k++) {
    const position = index * statusSize + k;
    const byte = Math.floor(position / 8);
    if (byte >= bits.length) throw new VcError(`status index ${index} is outside the list`);
    value = (value << 1) | ((bits[byte] >> (7 - (position % 8))) & 1);
  }
  return value;
}

export const encodeStatusList = (bits) => multibaseBase64url(gzipSync(Buffer.from(bits)));

export function decodeStatusList(encodedList) {
  if (typeof encodedList !== 'string' || encodedList[0] !== 'u') {
    throw new VcError('encodedList is not base64url multibase');
  }
  // Bounded: a few kilobytes of gzip can expand to gigabytes, and the list
  // comes from the network. 16 MiB is 128 times the minimum list.
  return new Uint8Array(gunzipSync(multibaseDecode(encodedList), { maxOutputLength: 16 * 1024 * 1024 }));
}

export function statusListCredential({ id, issuer, validFrom, validUntil, statusPurpose, bits }) {
  return {
    '@context': [VC_CONTEXT],
    id,
    type: ['VerifiableCredential', 'BitstringStatusListCredential'],
    issuer,
    validFrom,
    ...(validUntil ? { validUntil } : {}),
    credentialSubject: {
      id: `${id}#list`,
      type: 'BitstringStatusList',
      statusPurpose,
      encodedList: encodeStatusList(bits),
    },
  };
}

export const statusEntry = ({ listId, index, statusPurpose = 'revocation' }) => ({
  id: `${listId}#${index}`,
  type: 'BitstringStatusListEntry',
  statusPurpose,
  statusListIndex: String(index),
  statusListCredential: listId,
});

// ------------------------------------------------------ credential builders

/// An ICP principal as a credential subject. There is no registered DID
/// method for principals, so this uses a URN rather than inventing one.
export function principalUrn(text) {
  if (!isPrincipal(text)) throw new VcError(`not a principal in canonical textual form: ${text}`);
  return `urn:icp:principal:${text}`;
}

export function principalFromUrn(urn) {
  const match = /^urn:icp:principal:(.+)$/.exec(urn ?? '');
  if (!match || !isPrincipal(match[1])) return null;
  return match[1];
}

const base = ({ id, type, issuer, validFrom, validUntil, credentialStatus, name }) => ({
  '@context': [VC_CONTEXT],
  id,
  type: ['VerifiableCredential', type],
  ...(name ? { name } : {}),
  issuer,
  validFrom,
  ...(validUntil ? { validUntil } : {}),
  ...(credentialStatus ? { credentialStatus } : {}),
});

/**
 * "The creator identity `creatorId` on `canisterId`, whose root key is
 * `member`, is a `role` of `organization`." Personal data is deliberately
 * absent: no name, no e-mail. The organization is named because it is the
 * claim; the member is named only by principal.
 */
export function membershipCredential({ member, organization, role, registry, ...rest }) {
  return {
    ...base({ ...rest, type: TYPES.membership }),
    credentialSubject: {
      id: principalUrn(member),
      memberOf: organization,
      role,
      ...(registry ? { creator: { canisterId: registry.canisterId, creatorId: String(registry.creatorId) } } : {}),
    },
  };
}

/**
 * "`delegate` may register on behalf of creator `creatorId`, within `scope`,
 * under on-chain delegation `delegationId`." The registry is the authority for
 * whether the delegation is still in force; the credential is how it is
 * presented off-chain, and it may not claim more than the chain grants.
 */
export function delegationCredential({ delegate, registry, delegationId, scope, ...rest }) {
  return {
    ...base({ ...rest, type: TYPES.delegation }),
    credentialSubject: {
      id: principalUrn(delegate),
      authorizedBy: {
        canisterId: registry.canisterId,
        creatorId: String(registry.creatorId),
        delegationId: String(delegationId),
      },
      scope: scope === 'all' ? { type: 'all' } : { type: 'collection', collectionId: String(scope.collection) },
    },
  };
}

export const REVIEW_OUTCOMES = Object.freeze(['consistent', 'inconsistent', 'inconclusive']);

/**
 * "The reviewer examined record `recordId` and found its evidence
 * `outcome`." A review is a statement about evidence, not about authorship or
 * legal ownership, and `inconclusive` exists so a reviewer is never forced to
 * pick a side.
 */
export function reviewCredential({ record, outcome, method, ...rest }) {
  if (!REVIEW_OUTCOMES.includes(outcome)) throw new VcError(`unknown review outcome ${outcome}`);
  return {
    ...base({ ...rest, type: TYPES.review }),
    credentialSubject: {
      id: `urn:icp:record:${record.canisterId}:${record.recordId}`,
      artifactHash: record.artifactHash,
      manifestHash: record.manifestHash,
      review: { outcome, method },
    },
  };
}

// ------------------------------------------------------------- verification

const issuerId = (issuer) => (typeof issuer === 'string' ? issuer : issuer?.id);

/**
 * Finds the policy entry and key record for a verification method. Returns
 * `{ entry, key }` or `null`.
 */
function policyKey(policy, verificationMethod) {
  for (const entry of policy?.issuers ?? []) {
    const key = entry.keys.find((k) => k.verificationMethod === verificationMethod);
    if (key) return { entry, key };
  }
  return null;
}

const nanosToDate = (nanos) => new Date(Number(BigInt(nanos) / 1_000_000n));

async function checkRegistry(credential, types, registry, at) {
  const subject = credential.credentialSubject ?? {};
  if (types.includes(TYPES.delegation)) {
    const link = subject.authorizedBy ?? {};
    const delegation = await registry.getDelegation(link.canisterId, BigInt(link.delegationId));
    if (!delegation) return { state: 'inconsistent', error: `delegation ${link.delegationId} does not exist on the registry` };
    const principal = principalFromUrn(subject.id);
    if (delegation.delegate !== principal) return { state: 'inconsistent', error: 'the on-chain delegation names a different delegate' };
    if (String(delegation.creator) !== link.creatorId) return { state: 'inconsistent', error: 'the on-chain delegation belongs to a different creator' };
    const chainScope = 'all' in delegation.scope ? { type: 'all' } : { type: 'collection', collectionId: String(delegation.scope.collection) };
    if (JSON.stringify(chainScope) !== JSON.stringify(subject.scope)) {
      return { state: 'inconsistent', error: 'the credential claims a different scope than the on-chain delegation grants' };
    }
    if ('revoked' in delegation.status) return { state: 'inconsistent', error: `the on-chain delegation was revoked: ${delegation.status.revoked.reason}` };
    const expiresAt = nanosToDate(delegation.expiresAt);
    if (at >= expiresAt) return { state: 'inconsistent', error: 'the on-chain delegation has expired' };
    if (credential.validUntil && new Date(credential.validUntil) > expiresAt) {
      return { state: 'inconsistent', error: 'the credential outlives the on-chain delegation it presents' };
    }
    return { state: 'consistent' };
  }
  if (types.includes(TYPES.membership) && subject.creator) {
    const creator = await registry.getCreator(subject.creator.canisterId, BigInt(subject.creator.creatorId));
    if (!creator) return { state: 'inconsistent', error: `creator ${subject.creator.creatorId} does not exist on the registry` };
    // Membership attaches to the identity through its *current* root. A
    // credential naming a rotated-away key describes who the creator was, and
    // presenting it now would let the old key speak for the identity.
    if (creator.root !== principalFromUrn(subject.id)) {
      return { state: 'inconsistent', error: 'the credential names a key that is not the creator\'s current root' };
    }
    return { state: 'consistent' };
  }
  if (types.includes(TYPES.review)) {
    const match = /^urn:icp:record:([^:]+):(\d+)$/.exec(subject.id ?? '');
    if (!match) return { state: 'inconsistent', error: 'the review subject is not a registry record' };
    const record = await registry.getRecord(match[1], BigInt(match[2]));
    if (!record) return { state: 'inconsistent', error: `record ${match[2]} does not exist on the registry` };
    if (record.artifactHash !== subject.artifactHash || record.manifestHash !== subject.manifestHash) {
      return { state: 'inconsistent', error: 'the reviewed hashes are not the record\'s' };
    }
    if (record.revoked) return { state: 'consistent', warning: 'the reviewed record has since been revoked' };
    return { state: 'consistent' };
  }
  return { state: 'not-checked' };
}

async function checkStatus(credential, { statusLists, verifyList, at }) {
  const entries = [].concat(credential.credentialStatus ?? []);
  if (!entries.length) return { state: 'none' };
  const results = [];
  for (const entry of entries) {
    if (entry.type !== 'BitstringStatusListEntry') return { state: 'unavailable', error: `unsupported status type ${entry.type}` };
    let list;
    try {
      list = await statusLists(entry.statusListCredential);
    } catch (error) {
      return { state: 'unavailable', error: `status list ${entry.statusListCredential} could not be retrieved: ${error.message}` };
    }
    if (!list) return { state: 'unavailable', error: `status list ${entry.statusListCredential} could not be retrieved` };
    // The list is a credential too, and an unsigned or foreign one is worth
    // nothing: anyone could serve an all-zero list for a revoked credential.
    const listProof = verifyList(list);
    if (!listProof.verified) return { state: 'unavailable', error: `status list proof: ${listProof.errors.join('; ')}` };
    if (listProof.controller !== issuerId(credential.issuer) || issuerId(list.issuer) !== issuerId(credential.issuer)) {
      return { state: 'unavailable', error: 'the status list was not issued by the credential\'s issuer' };
    }
    if (list.id !== entry.statusListCredential) return { state: 'unavailable', error: 'the status list is not the one the entry names' };
    if (list.validUntil && at > new Date(list.validUntil)) return { state: 'unavailable', error: 'the status list has expired' };
    const subject = list.credentialSubject ?? {};
    const purposes = [].concat(subject.statusPurpose ?? []);
    if (!purposes.includes(entry.statusPurpose)) {
      return { state: 'unavailable', error: `status purpose mismatch: entry ${entry.statusPurpose}, list ${purposes.join(',')}` };
    }
    let bits;
    try {
      bits = decodeStatusList(subject.encodedList);
    } catch (error) {
      return { state: 'unavailable', error: `encodedList: ${error.message}` };
    }
    const statusSize = entry.statusSize ?? 1;
    if (bits.length * 8 / statusSize < MIN_STATUS_ENTRIES) {
      return { state: 'unavailable', error: 'STATUS_LIST_LENGTH_ERROR: the list is shorter than the privacy minimum' };
    }
    if (!/^\d+$/.test(entry.statusListIndex ?? '')) return { state: 'unavailable', error: 'statusListIndex is not a base-10 integer string' };
    results.push({ purpose: entry.statusPurpose, value: getStatus(bits, Number(entry.statusListIndex), statusSize) });
  }
  if (results.some((r) => r.purpose === 'revocation' && r.value)) return { state: 'revoked' };
  if (results.some((r) => r.purpose === 'suspension' && r.value)) return { state: 'suspended' };
  return { state: 'active' };
}

/**
 * Verifies a credential against a policy and returns a report whose verdict
 * is one of `accepted`, `accepted-with-warnings`, `unknown-issuer`,
 * `rejected`.
 *
 * `unknown-issuer` is not a kind of success. The signature being valid says
 * that whoever holds the key signed this; it says nothing about whether that
 * someone has any authority to, and a verifier that rendered "valid signature,
 * unknown issuer" as green would be the false success the issue warns about.
 *
 * `statusLists(url)` returns a status list credential (or throws); `registry`
 * is the optional read-only adapter over the creator registry.
 */
export async function verifyCredential(credential, { policy, statusLists = async () => null, registry, at = new Date() } = {}) {
  const errors = [];
  const warnings = [];
  const reasons = [];
  const types = [].concat(credential?.type ?? []);
  const report = {
    format: REPORT_FORMAT,
    verifiedAt: at.toISOString(),
    verdict: null,
    credential: { id: credential?.id ?? null, types, issuer: issuerId(credential?.issuer) ?? null },
    checks: { proof: 'not-checked', issuer: 'not-checked', validity: 'not-checked', status: 'not-checked', registry: 'not-checked' },
    reasons,
    errors,
    warnings,
  };
  const reject = (reason, message) => {
    reasons.push(reason);
    errors.push(message);
  };
  const finish = () => {
    if (reasons.length) report.verdict = 'rejected';
    else if (report.checks.issuer === 'unknown') report.verdict = 'unknown-issuer';
    else report.verdict = warnings.length ? 'accepted-with-warnings' : 'accepted';
    return report;
  };

  // ---- shape (VC Data Model 2.0 §4)
  const context = [].concat(credential?.['@context'] ?? []);
  if (context[0] !== VC_CONTEXT) reject('malformed', `the first @context must be ${VC_CONTEXT}`);
  if (!types.includes('VerifiableCredential')) reject('malformed', 'type must include VerifiableCredential');
  if (!issuerId(credential?.issuer)) reject('malformed', 'the credential has no issuer');
  if (!credential?.credentialSubject) reject('malformed', 'the credential has no credentialSubject');
  if (reasons.length) return finish();

  // ---- proof
  const proof = verifyProof(credential);
  report.checks.proof = proof.verified ? 'verified' : 'failed';
  if (!proof.verified) {
    reject('invalid-proof', proof.errors.join('; '));
    return finish();
  }
  if (proof.controller !== issuerId(credential.issuer)) {
    report.checks.issuer = 'mismatch';
    reject('issuer-mismatch', 'the proof was made by a key the issuer does not control');
    return finish();
  }

  // ---- validity period
  try {
    const validFrom = credential.validFrom ? timestamp(credential.validFrom, 'validFrom') : null;
    const validUntil = credential.validUntil ? timestamp(credential.validUntil, 'validUntil') : null;
    if (validFrom && at < validFrom) {
      report.checks.validity = 'not-yet-valid';
      reject('not-yet-valid', `the credential is not valid until ${credential.validFrom}`);
    } else if (validUntil && at > validUntil) {
      report.checks.validity = 'expired';
      reject('expired', `the credential expired at ${credential.validUntil}`);
    } else {
      report.checks.validity = 'current';
    }
  } catch (error) {
    reject('malformed', error.message);
  }

  // ---- issuer policy
  const found = policyKey(policy, credential.proof.verificationMethod);
  if (!found) {
    report.checks.issuer = 'unknown';
    warnings.push(`issuer ${issuerId(credential.issuer)} is not in the policy: the signature is valid, and says nothing about the issuer's authority`);
  } else {
    const { entry, key } = found;
    const created = new Date(credential.proof.created);
    const allowedTypes = entry.types ?? [];
    if (!types.some((t) => allowedTypes.includes(t))) {
      report.checks.issuer = 'not-authorized';
      reject('issuer-not-authorized', `${entry.name} is trusted, but not to issue ${types.filter((t) => t !== 'VerifiableCredential').join(', ')}`);
    } else if (key.status === 'compromised') {
      // Anything signed by a compromised key is suspect, including what it
      // claims to have signed before the compromise: `created` is written by
      // the signer, and a thief can backdate it.
      report.checks.issuer = 'compromised-key';
      reject('compromised-issuer-key', `${entry.name}'s key was reported compromised`);
    } else if (key.activeFrom && created < new Date(key.activeFrom)) {
      report.checks.issuer = 'retired-key';
      reject('retired-issuer-key', `the proof predates the key's activation (${key.activeFrom})`);
    } else if (key.retiredAt && created >= new Date(key.retiredAt)) {
      report.checks.issuer = 'retired-key';
      reject('retired-issuer-key', `${entry.name} retired this key at ${key.retiredAt}`);
    } else {
      report.checks.issuer = 'trusted';
      if (key.retiredAt) warnings.push(`signed with a key ${entry.name} has since retired (${key.retiredAt}); valid because it was signed before`);
    }
  }

  // ---- status
  const status = await checkStatus(credential, {
    statusLists,
    verifyList: (list) => verifyProof(list),
    at,
  });
  report.checks.status = status.state;
  if (status.state === 'revoked') reject('revoked', 'the issuer has revoked this credential');
  else if (status.state === 'suspended') reject('suspended', 'the issuer has suspended this credential');
  else if (status.state === 'unavailable') {
    // Fail closed by default: a verifier that accepted when the status list
    // could not be fetched would accept every revoked credential during an
    // outage, and an attacker can cause outages.
    if ((policy?.statusFailure ?? 'reject') === 'reject') reject('status-unavailable', status.error);
    else warnings.push(`status not checked: ${status.error}`);
  } else if (status.state === 'none' && found?.entry.requireStatus) {
    reject('status-required', `${found.entry.name} credentials must carry a status entry`);
  }

  // ---- registry
  if (registry) {
    try {
      const result = await checkRegistry(credential, types, registry, at);
      report.checks.registry = result.state;
      if (result.state === 'inconsistent') reject('registry-mismatch', result.error);
      if (result.warning) warnings.push(result.warning);
    } catch (error) {
      report.checks.registry = 'unavailable';
      warnings.push(`the registry could not be consulted: ${error.message}`);
    }
  } else if (types.includes(TYPES.delegation)) {
    warnings.push('the registry was not consulted, so the on-chain delegation was not checked');
  }
  return finish();
}

// ----------------------------------------------------------------------- CLI

function options(args) {
  const positional = [];
  const named = { 'status-list': [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') named.json = true;
    else if (args[i] === '--status-list') named['status-list'].push(args[++i]);
    else if (args[i].startsWith('--')) named[args[i].slice(2)] = args[++i];
    else positional.push(args[i]);
  }
  return { positional, named };
}

export const EXIT = Object.freeze({ accepted: 0, 'accepted-with-warnings': 0, 'unknown-issuer': 2, rejected: 3 });

async function main(argv) {
  const [command, ...rest] = argv;
  const { positional, named } = options(rest);
  if (command !== 'verify' || positional.length !== 1) {
    throw new Error('usage: verify <credential.json> --policy policy.json [--status-list url=file.json ...] [--json]');
  }
  const credential = parseJson(await readFile(positional[0], 'utf8'));
  const policy = named.policy ? parseJson(await readFile(named.policy, 'utf8')) : { issuers: [] };
  const lists = new Map();
  for (const mapping of named['status-list']) {
    const [url, file] = mapping.split(/=(.*)/s);
    lists.set(url, parseJson(await readFile(file, 'utf8')));
  }
  const report = await verifyCredential(credential, { policy, statusLists: async (url) => lists.get(url) ?? null });
  if (named.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`verdict: ${report.verdict}`);
    for (const [name, value] of Object.entries(report.checks)) console.log(`  ${name}: ${value}`);
    for (const e of report.errors) console.log(`error: ${e}`);
    for (const w of report.warnings) console.log(`warning: ${w}`);
  }
  return EXIT[report.verdict];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
