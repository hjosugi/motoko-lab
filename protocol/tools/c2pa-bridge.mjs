#!/usr/bin/env node
// The bridge between a C2PA content credential and a registry record.
//
// A credential and a record answer different questions. The credential says
// "this signer vouches for these bytes", and is checked against the signer's
// certificate. The record says "this principal committed to this artifact at
// this time, and has (or has not) withdrawn it", and is checked against the
// subnet's certificate. Neither is the source of truth for the other, so the
// verifier checks both and reports them separately, and only then combines
// them into a verdict. See protocol/C2PA_BRIDGE.md.
//
//   node protocol/tools/c2pa-bridge.mjs verify <asset.png> [--bundle record.json]
//        [--trust-anchors ca.pem] [--manifest manifest.json] [--json]
//   node protocol/tools/c2pa-bridge.mjs inspect <asset.png>
//   node protocol/tools/c2pa-bridge.mjs example [--out-dir dir]
//
// Exit codes: 0 verified (with or without warnings), 1 usage error,
// 2 invalid, 3 revoked, 4 unlinked, 5 unverifiable, 6 no credential.

import { createHash, X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { canonicalizeValue, parse as parseJson } from './jcs.mjs';
import { ACTIONS_LABEL, signPng, stripManifest, validatePng } from './c2pa.mjs';
import { decode as decodePrincipal, encode as encodePrincipal } from './principal.mjs';
import { recordDigest, recordPath } from '../../apps/01_creator_proof_registry/test/record-digest.mjs';

/// Entity-specific assertion label. C2PA requires custom labels to start with
/// a reverse domain name the entity controls; this project's is its GitHub
/// Pages domain, hjosugi.github.io. `.v2` would follow a breaking change.
export const ICP_PROOF_LABEL = 'io.github.hjosugi.icp-proof';

/// Where a creator's provenance manifest declares which C2PA signing keys may
/// issue credentials for its records: the record -> credential direction.
export const MANIFEST_EXTENSION = 'io.github.hjosugi.c2pa';

export const REPORT_FORMAT = 'c2pa-icp-verification/1';
export const BUNDLE_FORMAT = 'icp-certified-record/1';

const IPTC = 'http://cv.iptc.org/newscodes/digitalsourcetype/';
/// IPTC digital source types that disclose generative AI in the content.
const AI_SOURCE_TYPES = new Set(['trainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia', 'algorithmicMedia', 'compositeSynthetic'].map((t) => IPTC + t));

/// The source type a record's AI disclosure implies, where it implies exactly
/// one. `none` and `other` do not: a human-made record could be a photograph
/// (`digitalCapture`) or a drawing (`digitalArt`), and the registry does not say.
export const DEFAULT_SOURCE_TYPE = Object.freeze({
  generate: `${IPTC}trainedAlgorithmicMedia`,
  transform: `${IPTC}compositeWithTrainedAlgorithmicMedia`,
  assist: `${IPTC}compositeWithTrainedAlgorithmicMedia`,
});

export const EXIT = Object.freeze({
  verified: 0,
  'verified-with-warnings': 0,
  invalid: 2,
  revoked: 3,
  unlinked: 4,
  unverifiable: 5,
  'no-credential': 6,
});

export const NOT_AUTHORSHIP = 'Registration evidence is not legal authorship proof.';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));

// -------------------------------------------------------- record encoding

const modeOf = (mode) => {
  const [key] = Object.keys(mode);
  return key === 'other' ? { other: mode.other } : key;
};

/**
 * A record as the registry's Candid interface returns it, in plain JSON:
 * naturals as decimal strings, blobs as hex, the owner as principal text,
 * `opt` as value-or-null. This is the form an offline bundle stores.
 */
export function recordToJson(record) {
  const opt = (value) => (value.length ? value[0] : null);
  return {
    id: String(record.id),
    commitmentId: String(record.commitmentId),
    owner: record.owner.toText(),
    artifactHash: hex(record.artifactHash),
    manifestHash: hex(record.manifestHash),
    salt: hex(record.salt),
    title: record.title,
    kind: record.kind,
    mimeType: record.mimeType,
    storageUri: record.storageUri,
    parents: record.parents.map(String),
    ai: {
      assisted: record.ai.assisted,
      mode: modeOf(record.ai.mode),
      provider: opt(record.ai.provider),
      model: opt(record.ai.model),
      promptHash: record.ai.promptHash.length ? hex(record.ai.promptHash[0]) : null,
      humanContribution: opt(record.ai.humanContribution),
    },
    createdAt: String(record.createdAt),
    status: 'revoked' in record.status
      ? { revoked: { at: String(record.status.revoked.at), reason: record.status.revoked.reason } }
      : { active: null },
  };
}

/// The inverse, back to the shape `record-digest.mjs` encodes. The owner is
/// rebuilt from its text with the protocol's own principal decoder, so an
/// offline bundle needs no agent library to recompute the digest.
export function recordFromJson(json) {
  const opt = (value) => (value === null ? [] : [value]);
  const ownerBytes = decodePrincipal(json.owner);
  return {
    id: BigInt(json.id),
    commitmentId: BigInt(json.commitmentId),
    owner: { toUint8Array: () => ownerBytes, toText: () => encodePrincipal(ownerBytes) },
    artifactHash: unhex(json.artifactHash),
    manifestHash: unhex(json.manifestHash),
    salt: unhex(json.salt),
    title: json.title,
    kind: json.kind,
    mimeType: json.mimeType,
    storageUri: json.storageUri,
    parents: json.parents.map(BigInt),
    ai: {
      assisted: json.ai.assisted,
      mode: typeof json.ai.mode === 'string' ? { [json.ai.mode]: null } : json.ai.mode,
      provider: opt(json.ai.provider),
      model: opt(json.ai.model),
      promptHash: json.ai.promptHash === null ? [] : [unhex(json.ai.promptHash)],
      humanContribution: opt(json.ai.humanContribution),
    },
    createdAt: BigInt(json.createdAt),
    status: 'revoked' in json.status
      ? { revoked: { at: BigInt(json.status.revoked.at), reason: json.status.revoked.reason } }
      : { active: null },
  };
}

// ------------------------------------------------------------------ issuing

/**
 * The assertion a credential carries to name its registry record. The hashes
 * are repeated rather than only referenced so the credential can be checked
 * against a record without trusting whoever served either of them.
 */
export function icpProofAssertion({ network, canisterId, record }) {
  return {
    version: 1,
    network,
    canisterId,
    recordId: Number(record.id),
    owner: record.owner,
    artifactHash: unhex(record.artifactHash),
    manifestHash: unhex(record.manifestHash),
    ai: { assisted: record.ai.assisted, mode: typeof record.ai.mode === 'string' ? record.ai.mode : 'other' },
    query: 'getRecordCertified',
  };
}

/**
 * Issues a credential for `png` that references `record` (in `recordToJson`
 * form).
 *
 * Refuses when the PNG is not the artifact the record registered, or the
 * record is revoked: a bridge that would write a credential for any bytes and
 * any record would make every check the verifier runs a check of the bridge's
 * carelessness rather than of the creator's claim.
 *
 * `digitalSourceType` defaults from the record's AI disclosure and may not
 * understate it: a record that says `generate` cannot be credentialed as a
 * digital capture.
 */
export function issueCredential({ png, record, network, canisterId, signer, digitalSourceType, title, claimGenerator, deterministic }) {
  const assetHash = createHash('sha256').update(png).digest('hex');
  if (assetHash !== record.artifactHash) {
    throw new Error(`the PNG hashes to ${assetHash}, but record ${record.id} registered ${record.artifactHash}`);
  }
  if (!('active' in record.status)) throw new Error(`record ${record.id} is revoked; refusing to credential it`);
  const mode = typeof record.ai.mode === 'string' ? record.ai.mode : 'other';
  const sourceType = digitalSourceType ?? DEFAULT_SOURCE_TYPE[mode];
  if (!sourceType) {
    throw new Error(`record ${record.id} discloses AI mode "${mode}", which implies no single digitalSourceType; pass one`);
  }
  if (record.ai.assisted && !AI_SOURCE_TYPES.has(sourceType)) {
    throw new Error(`digitalSourceType ${sourceType} understates the record's AI disclosure (${mode})`);
  }
  return signPng({
    png,
    assertions: [
      { label: ACTIONS_LABEL, data: { actions: [{ action: 'c2pa.created', digitalSourceType: sourceType }] } },
      { label: ICP_PROOF_LABEL, data: icpProofAssertion({ network, canisterId, record }) },
    ],
    signer,
    claimGenerator: claimGenerator ?? { name: 'motoko-lab c2pa-bridge', version: '1' },
    title: title ?? record.title,
    ...deterministic,
  });
}

// ---------------------------------------------------------------- resolvers

/**
 * An offline resolver over saved certified records.
 *
 * `verifyCertified` is the certificate check — BLS over the subnet's state
 * tree, then the witness — and is injected because it needs an agent library
 * the offline tools do not carry (`tools/pocket-ic/certificate.mjs`). Without
 * it the bundle is still read, and the report says plainly that its
 * certification was not checked.
 */
export function bundleResolver(bundles, { verifyCertified } = {}) {
  return {
    async resolve({ canisterId, recordId }) {
      const bundle = bundles.find((b) => b.canisterId === canisterId && String(b.recordId) === String(recordId));
      if (!bundle) return { status: 'not-found', source: 'bundle' };
      if (bundle.format !== BUNDLE_FORMAT) return { status: 'unreachable', source: 'bundle', error: `unknown bundle format ${bundle.format}` };
      const certification = await certify(bundle, verifyCertified);
      return { status: 'found', source: 'bundle', record: bundle.record, fetchedAt: bundle.fetchedAt, ...certification };
    },
  };
}

/// Checks a bundle's certificate and that the digest it attests is the digest
/// of the record the bundle carries. Returns `{ certification, error? }`.
export async function certify(bundle, verifyCertified) {
  if (!verifyCertified) return { certification: 'unverified' };
  try {
    const attested = await verifyCertified({
      certificate: unhex(bundle.certificate),
      witness: unhex(bundle.witness),
      canisterId: bundle.canisterId,
      rootKey: unhex(bundle.rootKey),
      path: recordPath(BigInt(bundle.recordId)),
    });
    const local = recordDigest(recordFromJson(bundle.record));
    if (!Buffer.from(attested).equals(Buffer.from(local))) {
      return { certification: 'failed', error: 'the record does not match the digest the certificate attests' };
    }
    return { certification: 'verified' };
  } catch (error) {
    return { certification: 'failed', error: error.message };
  }
}

// ------------------------------------------------------------- verification

function signerDeclaration(manifestText, record) {
  if (manifestText == null) return { state: 'not-checked' };
  const manifest = parseJson(manifestText);
  const digest = createHash('sha256').update(canonicalizeValue(manifest), 'utf8').digest('hex');
  if (digest !== record.manifestHash) return { state: 'manifest-mismatch', digest };
  const signers = manifest.extensions?.[MANIFEST_EXTENSION]?.signers;
  if (!Array.isArray(signers) || !signers.length) return { state: 'not-declared' };
  return { state: 'declared', spki: signers.map((s) => s?.spki?.hex).filter(Boolean) };
}

/**
 * Verifies a PNG's credential and the record it names. `resolver` looks
 * records up (`bundleResolver`, or an online one); `manifestText` is the
 * creator's provenance manifest, when the verifier has it, and is what lets
 * the report say whether the signer is one the creator declared.
 */
export async function verifyAsset(png, { resolver, trustAnchors = null, manifestText, at = new Date() } = {}) {
  const errors = [];
  const warnings = [];
  let credential;
  let unsignedSha256;
  try {
    credential = validatePng(png, { trustAnchors, at });
    unsignedSha256 = createHash('sha256').update(stripManifest(png)).digest('hex');
  } catch (error) {
    // A file that is not even a well-formed PNG (a bad CRC, a truncated chunk)
    // is a failed verification with a reason, not a crash.
    credential = { present: true, valid: false, manifest: null, status: [], assertions: new Map(), signer: null };
    unsignedSha256 = createHash('sha256').update(png).digest('hex');
    errors.push(`the asset is not a well-formed PNG: ${error.message}`);
  }
  const report = {
    format: REPORT_FORMAT,
    verifiedAt: at.toISOString(),
    verdict: null,
    asset: { mediaType: 'image/png', unsignedSha256 },
    credential: {
      present: credential.present,
      manifest: credential.manifest,
      claimGenerator: credential.claim?.claim_generator_info?.name ?? null,
      signer: credential.signer,
      valid: credential.valid,
      status: credential.status,
    },
    link: { assertion: 'not-checked', resolution: 'not-checked', certification: 'not-checked' },
    record: { status: 'not-checked' },
    binding: { signer: 'not-checked', disclosure: 'not-checked' },
    errors,
    warnings,
  };
  const finish = (verdict) => {
    report.verdict = verdict ?? (warnings.length ? 'verified-with-warnings' : 'verified');
    warnings.push(NOT_AUTHORSHIP);
    return report;
  };

  if (!credential.present) {
    errors.push('the asset carries no C2PA manifest');
    return finish('no-credential');
  }
  for (const s of credential.status) {
    if (/mismatch|missing|malformed|invalid|unsupported/.test(s.code)) errors.push(`${s.code}: ${s.explanation}`);
  }
  if (!credential.valid) return finish('invalid');
  if (credential.signer.trusted === null) warnings.push('the signer was not checked against a trust list');
  if (credential.signer.trusted === false) warnings.push(`the signer is not trusted: ${credential.signer.reasons.join('; ')}`);

  // ---- the ICP link, read only from a signed, hash-verified assertion
  const proof = credential.assertions.get(ICP_PROOF_LABEL);
  if (!proof?.created) {
    report.link.assertion = 'missing';
    errors.push(`the credential has no signed ${ICP_PROOF_LABEL} assertion`);
    return finish('unlinked');
  }
  const link = proof.value;
  Object.assign(report.link, {
    assertion: 'present',
    network: link.network,
    canisterId: link.canisterId,
    recordId: String(link.recordId),
  });

  // The credential repeats the registered artifact hash. The signed data hash
  // already equals the unsigned asset's hash, so this is the same bytes.
  if (hex(link.artifactHash) !== report.asset.unsignedSha256) {
    errors.push('the credential names an artifact hash that is not this asset');
    return finish('invalid');
  }

  // ---- disclosure: the C2PA side may not understate the registry's
  const actions = credential.assertions.get(ACTIONS_LABEL)?.value?.actions ?? [];
  const sourceType = actions[0]?.digitalSourceType;
  if (link.ai?.assisted && !AI_SOURCE_TYPES.has(sourceType)) {
    report.binding.disclosure = 'understated';
    errors.push(`the credential's digitalSourceType (${sourceType ?? 'none'}) understates the AI disclosure it cites (${link.ai.mode})`);
    return finish('invalid');
  }
  report.binding.disclosure = 'consistent';

  if (!resolver) {
    warnings.push('no registry resolver was given; the record was not checked');
    return finish('unverifiable');
  }
  let resolved;
  try {
    resolved = await resolver.resolve({ canisterId: link.canisterId, recordId: String(link.recordId) });
  } catch (error) {
    resolved = { status: 'unreachable', error: error.message };
  }
  report.link.resolution = resolved.status;
  report.link.source = resolved.source ?? null;
  if (resolved.status === 'not-found') {
    errors.push(`broken link: record ${link.recordId} does not exist on canister ${link.canisterId}`);
    return finish('unlinked');
  }
  if (resolved.status !== 'found') {
    errors.push(`the registry could not be consulted: ${resolved.error ?? resolved.status}`);
    return finish('unverifiable');
  }
  report.link.certification = resolved.certification;
  if (resolved.fetchedAt) report.link.fetchedAt = resolved.fetchedAt;
  if (resolved.certification === 'failed') {
    errors.push(`the registry response failed certification: ${resolved.error}`);
    return finish('unverifiable');
  }
  if (resolved.certification !== 'verified') warnings.push('the registry response was not certified; it is only as good as the transport that served it');
  if (resolved.source === 'bundle' && resolved.fetchedAt) {
    warnings.push(`offline: the record status is as of ${resolved.fetchedAt}; a later revocation is not visible`);
  }

  const record = resolved.record;
  const checks = {
    artifactHashMatch: record.artifactHash === hex(link.artifactHash),
    manifestHashMatch: record.manifestHash === hex(link.manifestHash),
    ownerMatch: record.owner === link.owner,
  };
  report.record = {
    status: 'revoked' in record.status ? 'revoked' : 'active',
    ...('revoked' in record.status ? { revokedAt: record.status.revoked.at, revocationReason: record.status.revoked.reason } : {}),
    ...checks,
  };
  if (!checks.artifactHashMatch) errors.push('the record registered a different artifact than this asset');
  if (!checks.manifestHashMatch) errors.push('the record committed to a different manifest than the credential names');
  if (!checks.ownerMatch) errors.push('the record was registered by a different principal than the credential names');
  if (errors.length) return finish('invalid');

  // ---- signer binding: record -> manifest -> declared signer keys
  const declaration = signerDeclaration(manifestText, record);
  if (declaration.state === 'not-checked') {
    warnings.push('the provenance manifest was not supplied, so the signer could not be matched to the creator');
  } else if (declaration.state === 'manifest-mismatch') {
    report.binding.signer = 'manifest-mismatch';
    errors.push('the supplied manifest is not the one the record committed to');
    return finish('invalid');
  } else if (declaration.state === 'not-declared') {
    report.binding.signer = 'not-declared';
    warnings.push('the creator\'s manifest declares no C2PA signer, so anyone could have issued this credential');
  } else if (declaration.spki.includes(credential.signer.spkiSha256)) {
    report.binding.signer = 'declared';
  } else {
    report.binding.signer = 'undeclared';
    errors.push('the credential was signed by a key the creator\'s manifest does not declare');
    return finish('invalid');
  }

  if (report.record.status === 'revoked') {
    errors.push(`record ${record.id} was revoked at ${record.status.revoked.at}: ${record.status.revoked.reason}`);
    return finish('revoked');
  }
  return finish();
}

/// A human-readable rendering of a report, for the CLI.
export function renderReport(report) {
  const lines = [`verdict: ${report.verdict}`];
  const c = report.credential;
  if (c.present) {
    lines.push(`credential: ${c.valid ? 'valid' : 'INVALID'} (${c.manifest})`);
    if (c.signer) lines.push(`  signer: ${c.signer.subject} [${c.signer.algorithm}] trusted=${c.signer.trusted}`);
  } else {
    lines.push('credential: none');
  }
  const l = report.link;
  if (l.assertion === 'present') {
    lines.push(`registry: ${l.network} canister ${l.canisterId} record ${l.recordId} -> ${l.resolution} (certification: ${l.certification}${l.source ? `, ${l.source}` : ''})`);
    if (report.record.status !== 'not-checked') lines.push(`  record: ${report.record.status}${report.record.revocationReason ? ` (${report.record.revocationReason})` : ''}`);
  }
  lines.push(`binding: signer ${report.binding.signer}, disclosure ${report.binding.disclosure}`);
  for (const e of report.errors) lines.push(`error: ${e}`);
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}

// ------------------------------------------------------------------- example

const here = dirname(fileURLToPath(import.meta.url));
export const EXAMPLE_DIR = resolve(here, '../examples/c2pa');

/**
 * Rebuilds the published example: a PNG with a credential referencing a
 * record, and the record's offline bundle. Deterministic — fixed image, fixed
 * test keys, fixed ids and salts — so the suite can assert the committed files
 * are exactly what this produces.
 */
export async function buildExample() {
  const { testPki, pem, spkiSha256 } = await import('./x509.mjs');
  const { pngChunk } = await import('./c2pa.mjs');
  // A 16x16 gradient in a *stored* (uncompressed) zlib stream. Compressed
  // output is not portable: zlib and zlib-ng, which different Node releases
  // link, produce different bytes for the same input at the same level, and
  // the example has to be byte-identical wherever the suite runs.
  const width = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(width, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * width);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = x * 16;
      raw[o + 1] = y * 16;
      raw[o + 2] = 0x80;
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', storedZlib(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);

  const pki = testPki();
  const manifest = {
    version: '0.1',
    canonicalization: 'RFC8785',
    artifact: {
      name: 'gradient.png',
      mediaType: 'image/png',
      sizeBytes: png.length,
      digest: { algorithm: 'sha256', hex: createHash('sha256').update(png).digest('hex') },
      storageUri: 'https://hjosugi.github.io/motoko-lab/examples/gradient.png',
      normalization: { binary: true, textEncoding: null, unicode: null, lineEndings: null },
    },
    creator: { principal: '2vxsx-fae', displayName: 'Example Creator', organization: null, credentialUris: [] },
    process: {
      declaredCreatedAt: '2026-09-24T00:00:00Z',
      tools: [{ name: 'Example image model', version: '2026-09', role: 'Generated the image', attestationUri: null }],
      humanStatement: 'I wrote the prompt and selected this output.',
      sealedEvidenceUri: null,
      environmentDigest: null,
    },
    ai: {
      assisted: true,
      mode: 'generate',
      systems: [{ provider: 'Example AI Provider', model: 'Example Image Model', version: '2026-09', role: 'Generated the image' }],
      promptDigest: null,
      humanContribution: 'Prompt authorship and selection.',
      attestationUris: [],
    },
    derivation: { parents: [], notes: null },
    license: {
      termsUri: 'https://example.org/licenses/creator-proof-example-v1',
      termsDigest: { algorithm: 'sha256', hex: '177685de465408927f1b2f65e6cca29f319f6684fd375c9808b02871c39a693d' },
      spdxId: null,
    },
    extensions: {
      [MANIFEST_EXTENSION]: {
        signers: [{ spki: { algorithm: 'sha256', hex: spkiSha256(pki.signerKeys.publicKey) } }],
      },
    },
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestHash = createHash('sha256').update(canonicalizeValue(manifest), 'utf8').digest('hex');
  // `2vxsx-fae` is the anonymous principal, which the canister refuses to
  // register; it is used here precisely so the example cannot be mistaken for
  // a real registration. The replica test registers a real one.
  const record = {
    id: '1',
    commitmentId: '1',
    owner: '2vxsx-fae',
    artifactHash: manifest.artifact.digest.hex,
    manifestHash,
    salt: '000102030405060708090a0b0c0d0e0f',
    title: 'gradient.png',
    kind: 'image',
    mimeType: 'image/png',
    storageUri: manifest.artifact.storageUri,
    parents: [],
    ai: { assisted: true, mode: 'generate', provider: 'Example AI Provider', model: 'Example Image Model', promptHash: null, humanContribution: 'Prompt authorship and selection.' },
    createdAt: '1790208000000000000',
    status: { active: null },
  };
  const canisterId = 'rrkah-fqaaa-aaaaa-aaaaq-cai';
  const signed = issueCredential({
    png,
    record,
    network: 'example',
    canisterId,
    signer: { privateKey: pki.signerKeys.privateKey, chain: [pki.signer] },
    claimGenerator: { name: 'motoko-lab c2pa-bridge', version: '1' },
    deterministic: {
      instanceId: '00000000-0000-4000-8000-000000000001',
      manifestId: '00000000-0000-4000-8000-000000000002',
      salts: {
        'c2pa.actions.v2': Buffer.alloc(16, 1),
        [ICP_PROOF_LABEL]: Buffer.alloc(16, 2),
        'c2pa.hash.data': Buffer.alloc(16, 3),
      },
    },
  });
  // An uncertified bundle: the example has no subnet to sign it. The replica
  // test writes certified ones from a real canister.
  const bundle = {
    format: BUNDLE_FORMAT,
    network: 'example',
    canisterId,
    recordId: record.id,
    record,
    certificate: '',
    witness: '',
    rootKey: '',
    fetchedAt: '2026-09-24T00:00:00.000Z',
  };
  return {
    files: {
      'gradient.png': png,
      'gradient.c2pa.png': signed.png,
      'manifest.json': Buffer.from(manifestText),
      'record-bundle.json': Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`),
      'test-root-ca.pem': Buffer.from(pem(pki.root)),
    },
    record,
    canisterId,
    manifestText,
  };
}

/// RFC 1950 zlib around one RFC 1951 stored block: deterministic by definition.
function storedZlib(raw) {
  if (raw.length > 0xffff) throw new Error('a single stored block holds at most 65535 bytes');
  let a = 1;
  let b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  const header = Buffer.from([0x78, 0x01, 0x01, raw.length & 0xff, raw.length >> 8, ~raw.length & 0xff, (~raw.length >> 8) & 0xff]);
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((b << 16) | a) >>> 0, 0);
  return Buffer.concat([header, raw, adler]);
}

// ----------------------------------------------------------------------- CLI

function options(args) {
  const positional = [];
  const named = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') named.json = true;
    else if (args[i].startsWith('--')) named[args[i].slice(2)] = args[++i];
    else positional.push(args[i]);
  }
  return { positional, named };
}

function pemCertificates(text) {
  return [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((m) =>
    new X509Certificate(Buffer.from(m[1].replace(/\s+/g, ''), 'base64')).raw,
  );
}

/// The certificate verifier, when the agent library is installed (it is, once
/// `node tools/pocket-ic/setup.mjs` has run). Without it bundles are read but
/// reported as uncertified.
async function optionalCertificateVerifier() {
  try {
    const { verifyCertifiedRecord } = await import('../../tools/pocket-ic/certified-record.mjs');
    return verifyCertifiedRecord;
  } catch {
    return undefined;
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { positional, named } = options(rest);
  if (command === 'inspect') {
    if (positional.length !== 1) throw new Error('usage: inspect <asset.png>');
    const result = validatePng(await readFile(positional[0]));
    console.log(JSON.stringify({ ...result, assertions: Object.fromEntries(result.assertions) }, (k, v) => (v instanceof Uint8Array ? hex(v) : v), 2));
    return 0;
  }
  if (command === 'verify') {
    if (positional.length !== 1) throw new Error('usage: verify <asset.png> [--bundle record.json] [--trust-anchors ca.pem] [--manifest manifest.json] [--json]');
    const bundles = named.bundle ? [parseJson(await readFile(named.bundle, 'utf8'))] : [];
    const verifyCertified = await optionalCertificateVerifier();
    const report = await verifyAsset(await readFile(positional[0]), {
      resolver: bundles.length ? bundleResolver(bundles, { verifyCertified: bundles[0].certificate ? verifyCertified : undefined }) : undefined,
      trustAnchors: named['trust-anchors'] ? pemCertificates(await readFile(named['trust-anchors'], 'utf8')) : null,
      manifestText: named.manifest ? await readFile(named.manifest, 'utf8') : undefined,
    });
    console.log(named.json ? JSON.stringify(report, null, 2) : renderReport(report));
    return EXIT[report.verdict];
  }
  if (command === 'example') {
    const outDir = named['out-dir'] ?? EXAMPLE_DIR;
    const { files } = await buildExample();
    for (const [name, bytes] of Object.entries(files)) await writeFile(resolve(outDir, name), bytes);
    console.log(outDir);
    return 0;
  }
  throw new Error('commands: verify, inspect, example');
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
