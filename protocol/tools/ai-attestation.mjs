#!/usr/bin/env node
// AI tool and model attestations (#39).
//
// A provenance manifest's `ai` block is the creator's own account of how AI
// was used. That is useful, and it is weak: whoever wrote the manifest chose
// what it says. An attestation is the same statement made by someone else —
// the tool that generated the output, or an organization that reviewed the
// evidence — and signed, so a verifier can weigh it by who made it.
//
// Attestations are Verifiable Credentials (vc.mjs), so issuing, eddsa-jcs-2022
// proofs, the issuer policy, key rotation, compromised keys and status-list
// revocation are all the ones #11 already tests. This module adds what is
// specific to AI evidence:
//
//   * AIGenerationAttestation — signed by a provider service or a local tool:
//     which model (id *and* resolved version), which role, which output, and a
//     sealed commitment to the prompt rather than the prompt;
//   * AIUsageReviewCredential — an organization's review of that evidence;
//   * evaluateAiEvidence — the evidence level for one artifact:
//     `none` < `self-asserted` < `tool-signed` < `organization-reviewed`,
//     with every attestation bound to the artifact so none can be replayed for
//     another one.
//
// See protocol/AI_ATTESTATION.md.

import { createHash, randomBytes } from 'node:crypto';
import process from 'node:process';

import { canonicalizeValue } from './jcs.mjs';
import { signCredential, VC_CONTEXT, VcError, verifyCredential } from './vc.mjs';

export const ATTESTATION_TYPE = 'AIGenerationAttestation';
export const REVIEW_TYPE = 'AIUsageReviewCredential';
export const LEVELS = Object.freeze(['none', 'self-asserted', 'tool-signed', 'organization-reviewed']);
export const ROLES = Object.freeze(['generate', 'transform', 'assist']);
export const PROMPT_SCHEME = 'icp-ai-prompt:v1';
export const REPORT_FORMAT = 'ai-evidence/1';

const HEX64 = /^[0-9a-f]{64}$/;

// --------------------------------------------------------------- sealed prompt

/**
 * A commitment to a prompt that reveals nothing about it.
 *
 *     SHA-256(UTF8("icp-ai-prompt:v1") || 0x00 || salt || 0x00 || UTF8(prompt))
 *
 * A plain SHA-256 of a prompt is not private: prompts are short, predictable
 * text, and anyone can hash candidates until one matches. The salt (at least
 * 16 random bytes, kept by the creator) makes guessing useless; disclosing
 * salt and prompt to an auditor lets them check the commitment, and nobody
 * else learns anything. Same shape as the registry's commitment
 * (protocol/COMMITMENT_V1.md): domain, separators, fixed order.
 */
export function sealPrompt(prompt, salt = randomBytes(32)) {
  if (!(salt instanceof Uint8Array) || salt.length < 16 || salt.length > 64) {
    throw new VcError('a prompt salt is 16 to 64 bytes');
  }
  const digest = createHash('sha256')
    .update(Buffer.from(PROMPT_SCHEME, 'utf8'))
    .update(Buffer.from([0]))
    .update(salt)
    .update(Buffer.from([0]))
    .update(Buffer.from(prompt, 'utf8'))
    .digest('hex');
  return { commitment: { scheme: PROMPT_SCHEME, digest }, salt: Buffer.from(salt).toString('hex') };
}

export function openPrompt(commitment, { prompt, salt }) {
  if (commitment?.scheme !== PROMPT_SCHEME) return false;
  return sealPrompt(prompt, Buffer.from(salt, 'hex')).commitment.digest === commitment.digest;
}

// -------------------------------------------------------- metadata hygiene

// C0 and C1 controls, and the bidi overrides and isolates that make text
// render in a different order than it is stored. A model name containing
// "\nverdict: accepted" or U+202E is not a model name; it is an attempt to
// make a report say something the verifier did not.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;

function text(value, field, max, errors) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    errors.push(`${field} must be 1 to ${max} characters`);
  } else if (UNSAFE.test(value)) {
    errors.push(`${field} contains control or bidirectional-override characters`);
  }
}

/**
 * Structural checks on an attestation's subject, beyond what its proof says.
 * A signature makes the issuer accountable for the bytes; it does not make
 * the bytes well-formed, and a verifier renders them.
 */
export function validateAttestationSubject(subject) {
  const errors = [];
  if (!HEX64.test(subject?.output?.sha256 ?? '')) errors.push('output.sha256 must be 64 lowercase hex characters');
  if (subject?.id !== `urn:sha256:${subject?.output?.sha256}`) errors.push('the subject id must be urn:sha256:<output.sha256>');
  const g = subject?.generation ?? {};
  text(g.provider, 'generation.provider', 100, errors);
  text(g.model?.id, 'generation.model.id', 200, errors);
  // The resolved version is required. "example-model-latest" names a moving
  // target: the same alias meant a different model last month, and evidence
  // that could refer to either is evidence of neither.
  text(g.model?.version, 'generation.model.version', 100, errors);
  if (g.model?.alias !== undefined) text(g.model.alias, 'generation.model.alias', 200, errors);
  if (g.model?.weightsSha256 !== undefined && !HEX64.test(g.model.weightsSha256)) {
    errors.push('generation.model.weightsSha256 must be 64 lowercase hex characters');
  }
  if (!ROLES.includes(g.role)) errors.push(`generation.role must be one of ${ROLES.join(', ')}`);
  if (g.prompt !== undefined) {
    if (g.prompt?.scheme !== PROMPT_SCHEME || !HEX64.test(g.prompt?.digest ?? '')) {
      errors.push(`generation.prompt must be a ${PROMPT_SCHEME} commitment`);
    }
  }
  if (subject?.requestedBy !== undefined && !/^urn:icp:principal:[a-z0-9-]+$/.test(subject.requestedBy)) {
    errors.push('requestedBy must be a urn:icp:principal URN');
  }
  if (typeof g.generatedAt !== 'string' || Number.isNaN(Date.parse(g.generatedAt))) errors.push('generation.generatedAt must be a date-time');
  return errors;
}

// ------------------------------------------------------------------ builders

/**
 * An attestation by the tool that produced `outputSha256`. The prompt is
 * carried only as a sealed commitment; the tool never publishes it.
 */
export function generationAttestation({ id, issuer, validFrom, output, generation, requestedBy, credentialStatus }) {
  const subject = {
    id: `urn:sha256:${output.sha256}`,
    output: { sha256: output.sha256, ...(output.mediaType ? { mediaType: output.mediaType } : {}) },
    generation,
    ...(requestedBy ? { requestedBy } : {}),
  };
  const errors = validateAttestationSubject(subject);
  if (errors.length) throw new VcError(errors.join('; '));
  return {
    '@context': [VC_CONTEXT],
    id,
    type: ['VerifiableCredential', ATTESTATION_TYPE],
    issuer,
    validFrom,
    ...(credentialStatus ? { credentialStatus } : {}),
    credentialSubject: subject,
  };
}

/// Digest of an attestation as issued (proof included), so a review names
/// exactly the credential it looked at and not a later reissue with the same id.
export const credentialDigest = (credential) =>
  createHash('sha256').update(canonicalizeValue(credential), 'utf8').digest('hex');

export function usageReview({ id, issuer, validFrom, artifactSha256, attestation, outcome, method }) {
  if (!['consistent', 'inconsistent', 'inconclusive'].includes(outcome)) throw new VcError(`unknown review outcome ${outcome}`);
  return {
    '@context': [VC_CONTEXT],
    id,
    type: ['VerifiableCredential', REVIEW_TYPE],
    issuer,
    validFrom,
    credentialSubject: {
      id: `urn:sha256:${artifactSha256}`,
      ...(attestation ? { reviewedAttestation: { id: attestation.id, sha256: credentialDigest(attestation) } } : {}),
      review: { outcome, method },
    },
  };
}

export { signCredential };

// --------------------------------------------------------------- evaluation


/**
 * The evidence level for one artifact.
 *
 * `artifactSha256` is the registered artifact; `manifest` is the creator's
 * provenance manifest (parsed), which is what the registry committed to. An
 * attestation counts only if it verifies under `policy`, is issued by a
 * `provider` or `local-tool` entry, and is *bound*: its output is this
 * artifact, or one of the manifest's declared parents (a generated draft the
 * creator then edited). Anything else is a replay and is reported as one.
 */
export async function evaluateAiEvidence({ artifactSha256, manifest, attestations = [], reviews = [], policy, statusLists, at = new Date() }) {
  const errors = [];
  const warnings = [];
  const details = [];
  const declared = manifest?.ai ?? null;
  let level = declared ? 'self-asserted' : 'none';
  const parents = new Set((manifest?.derivation?.parents ?? []).map((p) => p.artifactDigest?.hex));
  const boundDigests = new Set([artifactSha256, ...parents]);
  const kindOf = (report) => report.policyEntry?.kind ?? null;
  const accepted = (report) => report.verdict === 'accepted' || report.verdict === 'accepted-with-warnings';

  if (declared) {
    // The manifest's own statement is evidence too, just the weakest kind.
    if (declared.assisted === false && declared.mode !== 'none') errors.push('the manifest says assisted: false with an AI mode');
  }

  const valid = [];
  for (const attestation of attestations) {
    const report = await verifyCredential(attestation, { policy, statusLists, at });
    const entry = { id: attestation.id ?? null, type: ATTESTATION_TYPE, verdict: report.verdict, reasons: report.reasons, issuerKind: kindOf(report), binding: 'not-checked' };
    details.push(entry);
    if (![].concat(attestation.type ?? []).includes(ATTESTATION_TYPE)) {
      entry.binding = 'wrong-type';
      errors.push(`${attestation.id}: not an ${ATTESTATION_TYPE}`);
      continue;
    }
    const shape = validateAttestationSubject(attestation.credentialSubject);
    if (shape.length) {
      entry.binding = 'malformed';
      errors.push(`${attestation.id}: ${shape.join('; ')}`);
      continue;
    }
    const subject = attestation.credentialSubject;
    if (!boundDigests.has(subject.output.sha256)) {
      entry.binding = 'replayed';
      errors.push(`${attestation.id}: attests output ${subject.output.sha256}, which is neither this artifact nor a declared parent — a replay`);
      continue;
    }
    entry.binding = subject.output.sha256 === artifactSha256 ? 'artifact' : 'parent';
    if (report.verdict === 'unknown-issuer') {
      warnings.push(`${attestation.id}: signed by an issuer the policy does not know; it adds nothing beyond self-assertion`);
      continue;
    }
    if (!accepted(report)) {
      errors.push(`${attestation.id}: ${report.errors.join('; ')}`);
      continue;
    }
    if (!['provider', 'local-tool'].includes(kindOf(report))) {
      warnings.push(`${attestation.id}: issued by a ${kindOf(report) ?? 'non-tool'} issuer, which cannot attest to generation`);
      continue;
    }
    for (const w of report.warnings) warnings.push(`${attestation.id}: ${w}`);
    valid.push({ attestation, report });

    // ---- consistency with the manifest the creator committed to
    const g = subject.generation;
    if (!declared || !declared.assisted || declared.mode === 'none') {
      errors.push(`${attestation.id}: a tool attests AI ${g.role}, but the manifest discloses no AI use — the disclosure is understated`);
    } else {
      const listed = (declared.systems ?? []).some((s) => s.model === g.model.id && (s.version ?? null) === g.model.version);
      if (!listed) warnings.push(`${attestation.id}: the manifest does not list ${g.model.id} ${g.model.version}`);
      const promptDigest = declared.promptDigest?.hex;
      if (g.prompt && promptDigest && promptDigest !== g.prompt.digest) {
        errors.push(`${attestation.id}: the sealed prompt commitment differs from the manifest's`);
      }
    }
    if (g.model.alias) warnings.push(`${attestation.id}: requested as "${g.model.alias}", resolved to ${g.model.version}`);
    if (subject.requestedBy && manifest?.creator?.principal && subject.requestedBy !== `urn:icp:principal:${manifest.creator.principal}`) {
      warnings.push(`${attestation.id}: the tool issued this to another principal than the manifest's creator`);
    }
    if (kindOf(report) === 'local-tool') {
      warnings.push(`${attestation.id}: a local tool's key proves the tool ran where that key lives, not who ran it`);
    }
  }
  if (valid.length && !errors.length) level = 'tool-signed';
  if (!valid.length && declared?.assisted) {
    warnings.push('AI use is self-asserted only: no tool or provider attested it');
  }

  // ---- organization review
  for (const review of reviews) {
    const report = await verifyCredential(review, { policy, statusLists, at });
    const entry = { id: review.id ?? null, type: REVIEW_TYPE, verdict: report.verdict, reasons: report.reasons, issuerKind: kindOf(report), binding: 'not-checked' };
    details.push(entry);
    const subject = review.credentialSubject ?? {};
    if (subject.id !== `urn:sha256:${artifactSha256}`) {
      entry.binding = 'replayed';
      errors.push(`${review.id}: reviews another artifact`);
      continue;
    }
    entry.binding = 'artifact';
    if (!accepted(report) || kindOf(report) !== 'organization') {
      warnings.push(`${review.id}: not an accepted review by an organization in the policy (${report.verdict})`);
      continue;
    }
    const named = subject.reviewedAttestation;
    if (named && !valid.some(({ attestation }) => attestation.id === named.id && credentialDigest(attestation) === named.sha256)) {
      errors.push(`${review.id}: reviews an attestation that is not among the valid ones presented, or not byte-for-byte the same`);
      continue;
    }
    if (subject.review?.outcome !== 'consistent') {
      warnings.push(`${review.id}: the reviewer found the evidence ${subject.review?.outcome}`);
      continue;
    }
    if (level === 'tool-signed' || (level === 'self-asserted' && !named)) level = 'organization-reviewed';
  }

  return {
    format: REPORT_FORMAT,
    verifiedAt: at.toISOString(),
    artifact: artifactSha256,
    level: errors.length ? (declared ? 'self-asserted' : 'none') : level,
    declared: declared ? { assisted: declared.assisted, mode: declared.mode } : null,
    evidence: details,
    errors,
    warnings,
  };
}

// ------------------------------------------------------------------- example

/**
 * The published example (protocol/examples/ai-attestation/): a creator's
 * manifest for an AI-assisted note, a provider's attestation of the draft, a
 * studio's review of that attestation, and the policy that trusts them.
 * Deterministic — keys from public seeds, fixed ids, dates and salt — so the
 * suite rebuilds every file byte for byte.
 */
export async function buildAiExample() {
  const { didKey, didKeyVerificationMethod } = await import('./multikey.mjs');
  const { ed25519FromSeed, testSeed } = await import('./x509.mjs');
  const { readFile } = await import('node:fs/promises');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  const key = (label) => {
    const keys = ed25519FromSeed(testSeed(label));
    return { ...keys, did: didKey(keys.publicKey), verificationMethod: didKeyVerificationMethod(keys.publicKey) };
  };
  const keys = {
    provider2025: key('ai example provider 2025'),
    provider2026: key('ai example provider 2026'),
    workstation: key('ai example studio workstation'),
    studio: key('ai example studio review'),
  };

  const note = await readFile(resolve(root, 'artifacts/ai-assisted-note.txt'));
  const artifactSha256 = createHash('sha256').update(note).digest('hex');
  // What the creator keeps private and would disclose only to an auditor.
  const disclosure = {
    prompt: 'Three one-line ideas for a note about keeping provenance honest.',
    salt: '6d6f746f6b6f2d6c616220657861706c652073616c74202d206e6f7420612073',
  };
  const sealed = sealPrompt(disclosure.prompt, Buffer.from(disclosure.salt, 'hex'));

  const manifest = JSON.parse(await readFile(resolve(root, 'examples/ai-assisted.json'), 'utf8'));
  manifest.ai.systems = [{ provider: 'Example AI Provider', model: 'example-text-model', version: '2026-07-01', role: 'Generated draft ideas' }];
  manifest.ai.promptDigest = { algorithm: 'sha256', hex: sealed.commitment.digest };
  manifest.ai.attestationUris = ['urn:uuid:9b1f2c3d-0000-4000-8000-000000000001'];

  const attestation = signCredential(generationAttestation({
    id: 'urn:uuid:9b1f2c3d-0000-4000-8000-000000000001',
    issuer: keys.provider2026.did,
    validFrom: '2026-07-20T00:04:00Z',
    output: { sha256: artifactSha256, mediaType: 'text/plain' },
    generation: {
      provider: 'Example AI Provider',
      model: { id: 'example-text-model', version: '2026-07-01', alias: 'example-text-model-latest' },
      role: 'assist',
      prompt: sealed.commitment,
      generatedAt: '2026-07-20T00:04:00Z',
    },
    requestedBy: `urn:icp:principal:${manifest.creator.principal}`,
  }), { privateKey: keys.provider2026.privateKey, verificationMethod: keys.provider2026.verificationMethod, created: '2026-07-20T00:04:00Z' });

  const review = signCredential(usageReview({
    id: 'urn:uuid:9b1f2c3d-0000-4000-8000-000000000002',
    issuer: keys.studio.did,
    validFrom: '2026-07-21T00:00:00Z',
    artifactSha256,
    attestation,
    outcome: 'consistent',
    method: 'Checked the attestation against the manifest and opened the sealed prompt with the creator\'s disclosure.',
  }), { privateKey: keys.studio.privateKey, verificationMethod: keys.studio.verificationMethod, created: '2026-07-21T00:00:00Z' });

  const policy = {
    statusFailure: 'reject',
    issuers: [
      {
        name: 'Example AI Provider',
        kind: 'provider',
        types: [ATTESTATION_TYPE],
        keys: [
          { verificationMethod: keys.provider2025.verificationMethod, activeFrom: '2025-01-01T00:00:00Z', retiredAt: '2026-06-01T00:00:00Z', status: 'superseded' },
          { verificationMethod: keys.provider2026.verificationMethod, activeFrom: '2026-06-01T00:00:00Z', retiredAt: null, status: 'active' },
        ],
      },
      {
        name: 'Example Studio workstation 7',
        kind: 'local-tool',
        types: [ATTESTATION_TYPE],
        keys: [{ verificationMethod: keys.workstation.verificationMethod, activeFrom: '2026-01-01T00:00:00Z', retiredAt: null, status: 'active' }],
      },
      {
        name: 'Example Studio',
        kind: 'organization',
        types: [REVIEW_TYPE],
        keys: [{ verificationMethod: keys.studio.verificationMethod, activeFrom: '2026-01-01T00:00:00Z', retiredAt: null, status: 'active' }],
      },
    ],
  };
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    keys,
    artifactSha256,
    manifest,
    attestation,
    review,
    policy,
    disclosure,
    files: {
      'manifest.json': json(manifest),
      'provider-attestation.json': json(attestation),
      'studio-review.json': json(review),
      'policy.json': json(policy),
      'sealed-prompt-disclosure.json': json(disclosure),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFile, readFile } = await import('node:fs/promises');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { parse } = await import('./jcs.mjs');
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../examples/ai-attestation');
  const [command, ...args] = process.argv.slice(2);
  if (command === 'example') {
    const { files } = await buildAiExample();
    for (const [name, content] of Object.entries(files)) await writeFile(resolve(dir, name), content);
    console.log(dir);
  } else if (command === 'evaluate') {
    // evaluate <artifact-sha256> <manifest.json> <policy.json> [attestation.json ...] [--review review.json ...]
    const [artifactSha256, manifestPath, policyPath, ...rest] = args;
    const reviewAt = rest.indexOf('--review');
    const attestationPaths = reviewAt < 0 ? rest : rest.slice(0, reviewAt);
    const reviewPaths = reviewAt < 0 ? [] : rest.slice(reviewAt + 1);
    const load = async (path) => parse(await readFile(path, 'utf8'));
    const report = await evaluateAiEvidence({
      artifactSha256,
      manifest: await load(manifestPath),
      policy: await load(policyPath),
      attestations: await Promise.all(attestationPaths.map(load)),
      reviews: await Promise.all(reviewPaths.map(load)),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.errors.length ? 2 : 0;
  } else {
    console.error('commands: example, evaluate <artifact-sha256> <manifest.json> <policy.json> [attestation.json ...] [--review review.json ...]');
    process.exitCode = 1;
  }
}
