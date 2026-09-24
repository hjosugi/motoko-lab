// Offline tests for AI tool and model attestations (#39).
//
//   node protocol/tools/ai-attestation.test.mjs
//
// The acceptance criteria, in the order the issue lists them: the three
// evidence levels are told apart, an attestation cannot be replayed for
// another artifact, the prompt is never needed publicly, and key rotation and
// revocation hold. Then the test plan: provider unavailable, model alias
// changes, local model, prompt injection into metadata.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAiExample,
  credentialDigest,
  evaluateAiEvidence,
  generationAttestation,
  LEVELS,
  openPrompt,
  PROMPT_SCHEME,
  REPORT_FORMAT,
  sealPrompt,
  signCredential,
  usageReview,
  validateAttestationSubject,
} from './ai-attestation.mjs';
import { VcError, emptyStatusList, setStatus, statusEntry, statusListCredential } from './vc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let checks = 0;
const check = (condition, description) => {
  assert.ok(condition, description);
  checks += 1;
};

const example = await buildAiExample();
const { keys, artifactSha256, manifest, attestation, review, policy } = example;
const at = new Date('2026-09-24T00:00:00Z');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// ------------------------------------------------------------ the example

for (const [name, content] of Object.entries(example.files)) {
  const committed = await readFile(resolve(here, '../examples/ai-attestation', name), 'utf8');
  check(committed === content, `protocol/examples/ai-attestation/${name} is reproducible`);
}

// ------------------------------------------------------ sealed prompts

const disclosure = example.disclosure;
const commitment = attestation.credentialSubject.generation.prompt;
check(commitment.scheme === PROMPT_SCHEME && openPrompt(commitment, disclosure), 'the creator\'s disclosure opens the sealed prompt');
check(!openPrompt(commitment, { ...disclosure, prompt: `${disclosure.prompt} ` }), 'a different prompt does not');
check(!openPrompt(commitment, { ...disclosure, salt: '00'.repeat(32) }), 'nor does the right prompt with the wrong salt');
check(manifest.ai.promptDigest.hex === commitment.digest, 'the manifest commits to the same sealed prompt, not to the prompt');
// Why sealing matters: an unsalted digest of a short prompt falls to a list
// of guesses. The same list against the sealed commitment finds nothing.
const guesses = ['Write a note.', 'Three one-line ideas for a note about keeping provenance honest.', 'Summarize provenance.'];
check(guesses.some((g) => sha256(g) === sha256(disclosure.prompt)), 'a plain SHA-256 of the prompt is found by guessing');
check(!guesses.some((g) => sha256(g) === commitment.digest), 'the sealed commitment is not');
check(!JSON.stringify(example.files['provider-attestation.json']).includes('provenance honest'), 'the attestation never carries the prompt text');
assert.throws(() => sealPrompt('x', new Uint8Array(15)), VcError);
check(true, 'a salt shorter than 16 bytes is refused');

// ------------------------------------------------ the three evidence levels

const lists = (...credentials) => async (url) => credentials.find((c) => c.id === url) ?? null;
const evaluate = (options) => evaluateAiEvidence({ artifactSha256, manifest, policy, at, statusLists: lists(), ...options });
check(LEVELS.join() === 'none,self-asserted,tool-signed,organization-reviewed', 'four levels, weakest first');

let report = await evaluate({});
check(report.format === REPORT_FORMAT && report.level === 'self-asserted', 'a manifest alone is self-asserted');
check(report.warnings.some((w) => w.includes('self-asserted only')), 'and the report says no tool attested it');
report = await evaluate({ manifest: { ...manifest, ai: undefined } });
check(report.level === 'none', 'no disclosure at all is `none`');
report = await evaluate({ attestations: [attestation] });
check(report.level === 'tool-signed' && report.evidence[0].binding === 'artifact' && report.evidence[0].issuerKind === 'provider',
  'a provider attestation bound to the artifact is tool-signed');
report = await evaluate({ attestations: [attestation], reviews: [review] });
check(report.level === 'organization-reviewed' && report.errors.length === 0, 'with the studio\'s review it is organization-reviewed');

// A review names the attestation it read by digest, so a reissued or altered
// attestation under the same id is not the one reviewed.
const reissued = signCredential({ ...stripProof(attestation), validFrom: '2026-07-20T00:05:00Z' }, signing(keys.provider2026, '2026-07-20T00:05:00Z'));
check(reissued.id === attestation.id && credentialDigest(reissued) !== credentialDigest(attestation), 'a reissue keeps the id and changes the digest');
report = await evaluate({ attestations: [reissued], reviews: [review] });
check(report.level !== 'organization-reviewed' && report.errors.some((e) => e.includes('byte-for-byte')), 'a review does not carry over to a reissued attestation');
const providerReview = signCredential(usageReview({
  id: 'urn:uuid:review-by-provider', issuer: keys.provider2026.did, validFrom: '2026-07-21T00:00:00Z',
  artifactSha256, attestation, outcome: 'consistent', method: 'self-review',
}), signing(keys.provider2026, '2026-07-21T00:00:00Z'));
report = await evaluate({ attestations: [attestation], reviews: [providerReview] });
check(report.level === 'tool-signed' && report.warnings.some((w) => w.includes('not an accepted review by an organization')),
  'a provider cannot review its own attestation into organization-reviewed');
const doubtful = signCredential(usageReview({
  id: 'urn:uuid:review-inconclusive', issuer: keys.studio.did, validFrom: '2026-07-21T00:00:00Z',
  artifactSha256, attestation, outcome: 'inconclusive', method: 'could not open the prompt',
}), signing(keys.studio, '2026-07-21T00:00:00Z'));
report = await evaluate({ attestations: [attestation], reviews: [doubtful] });
check(report.level === 'tool-signed' && report.warnings.some((w) => w.includes('inconclusive')), 'an inconclusive review does not raise the level');

// ------------------------------------------------------------------ replay

const other = sha256('another artifact');
const forOther = attest({ output: other });
report = await evaluate({ attestations: [forOther] });
check(report.level === 'self-asserted' && report.evidence[0].binding === 'replayed' && report.errors[0].includes('a replay'),
  'an attestation for another artifact is reported as a replay and counts for nothing');
report = await evaluate({ attestations: [attestation, forOther] });
check(report.level === 'self-asserted', 'presenting a replay alongside a valid attestation is itself disqualifying');
const reviewOfOther = signCredential(usageReview({
  id: 'urn:uuid:review-other', issuer: keys.studio.did, validFrom: '2026-07-21T00:00:00Z', artifactSha256: other, outcome: 'consistent', method: 'x',
}), signing(keys.studio, '2026-07-21T00:00:00Z'));
report = await evaluate({ attestations: [attestation], reviews: [reviewOfOther] });
check(report.evidence[1].binding === 'replayed', 'a review of another artifact is a replay too');

// An edited draft: the tool attests the raw output, the creator registers the
// edit and declares the draft as its source parent.
const draft = sha256('the raw model output before the creator edited it');
const withParent = structuredClone(manifest);
withParent.derivation.parents = [{ relationship: 'source', recordUri: null, artifactDigest: { algorithm: 'sha256', hex: draft } }];
report = await evaluate({ manifest: withParent, attestations: [attest({ output: draft })] });
check(report.level === 'tool-signed' && report.evidence[0].binding === 'parent', 'an attested draft the manifest declares as a parent is bound');

// ------------------------------------------------ consistency with the manifest

const undisclosed = structuredClone(manifest);
undisclosed.ai = { ...undisclosed.ai, assisted: false, mode: 'none', systems: [], promptDigest: null };
report = await evaluate({ manifest: undisclosed, attestations: [attestation] });
check(report.errors.some((e) => e.includes('understated')) && report.level === 'self-asserted',
  'a tool attesting AI use the manifest does not disclose is an understatement, not an upgrade');
const otherPrompt = structuredClone(manifest);
otherPrompt.ai.promptDigest = { algorithm: 'sha256', hex: sealPrompt('another prompt', Buffer.alloc(32, 9)).commitment.digest };
report = await evaluate({ manifest: otherPrompt, attestations: [attestation] });
check(report.errors.some((e) => e.includes('sealed prompt')), 'a prompt commitment that differs from the manifest\'s is an error');
report = await evaluate({ attestations: [attest({ requestedBy: 'urn:icp:principal:2vxsx-fae' })] });
check(report.warnings.some((w) => w.includes('another principal')), 'an attestation issued to someone else is flagged');
report = await evaluate({ attestations: [attest({ model: { id: 'other-model', version: '1' } })] });
check(report.warnings.some((w) => w.includes('does not list other-model')), 'a model the manifest does not list is flagged');

// ------------------------------------------------ key rotation and revocation

report = await evaluate({ attestations: [attest({ key: keys.provider2025, created: '2026-05-01T00:00:00Z' })] });
check(report.level === 'tool-signed' && report.warnings.some((w) => w.includes('since retired')), 'signed before the provider rotated: valid, with a warning');
report = await evaluate({ attestations: [attest({ key: keys.provider2025, created: '2026-07-01T00:00:00Z' })] });
check(report.level === 'self-asserted' && report.evidence[0].reasons.includes('retired-issuer-key'), 'signed with the old key after rotation: rejected');
const compromised = structuredClone(policy);
compromised.issuers[0].keys[0].status = 'compromised';
report = await evaluate({ policy: compromised, attestations: [attest({ key: keys.provider2025, created: '2026-05-01T00:00:00Z' })] });
check(report.evidence[0].reasons.includes('compromised-issuer-key'), 'a compromised provider key is rejected whatever date it claims');

const LIST = 'https://provider.example/status/1';
const revocable = attest({ credentialStatus: statusEntry({ listId: LIST, index: 42 }) });
const list = (bits) => signCredential(statusListCredential({ id: LIST, issuer: keys.provider2026.did, validFrom: '2026-01-01T00:00:00Z', statusPurpose: 'revocation', bits }),
  signing(keys.provider2026, '2026-07-01T00:00:00Z'));
report = await evaluate({ attestations: [revocable], statusLists: lists(list(emptyStatusList())) });
check(report.level === 'tool-signed', 'an attestation whose status is active counts');
report = await evaluate({ attestations: [revocable], statusLists: lists(list(setStatus(emptyStatusList(), 42))) });
check(report.level === 'self-asserted' && report.evidence[0].reasons.includes('revoked'), 'a revoked attestation does not');

// ------------------------------------------------------------- test plan

// Provider unavailable. At generation time there is no attestation, and the
// level says so. At verification time the attestation still verifies offline;
// only its status list needs the provider, and that fails closed by default.
report = await evaluate({ attestations: [] });
check(report.level === 'self-asserted', 'provider unavailable at generation: the evidence stays self-asserted');
report = await evaluate({ attestations: [attestation] });
check(report.level === 'tool-signed', 'provider unavailable at verification: an attestation without status verifies offline');
report = await evaluate({ attestations: [revocable], statusLists: async () => { throw new Error('ECONNREFUSED'); } });
check(report.evidence[0].reasons.includes('status-unavailable') && report.level === 'self-asserted', 'its status list unreachable: fails closed');
report = await evaluate({ attestations: [revocable], statusLists: async () => { throw new Error('ECONNREFUSED'); }, policy: { ...policy, statusFailure: 'warn' } });
check(report.level === 'tool-signed' && report.warnings.some((w) => w.includes('status not checked')), 'unless the policy says warn, and then the report says so');

// Model alias changes: the alias is kept for the record, the version decides.
report = await evaluate({ attestations: [attestation] });
check(report.warnings.some((w) => w.includes('requested as "example-text-model-latest", resolved to 2026-07-01')), 'an alias is reported with what it resolved to');
const unresolved = structuredClone(attestation.credentialSubject);
delete unresolved.generation.model.version;
check(validateAttestationSubject(unresolved).some((e) => e.includes('model.version')), 'an attestation naming only an alias is malformed');
assert.throws(() => generationAttestation({ ...inputs(), generation: { ...inputs().generation, model: { id: 'example-text-model-latest' } } }), VcError);
check(true, 'and the builder refuses to write one');

// Local model: a key on the creator's side of the trust boundary.
const local = attest({
  key: keys.workstation,
  provider: 'local',
  model: { id: 'open-weights-7b', version: 'q4_k_m', weightsSha256: sha256('weights file') },
});
const localManifest = structuredClone(manifest);
localManifest.ai.systems.push({ provider: 'local', model: 'open-weights-7b', version: 'q4_k_m', role: 'draft' });
report = await evaluate({ manifest: localManifest, attestations: [local] });
check(report.level === 'tool-signed' && report.evidence[0].issuerKind === 'local-tool', 'a registered local tool\'s attestation is tool-signed');
check(report.warnings.some((w) => w.includes('proves the tool ran where that key lives')), 'with the warning that it does not prove who ran it');
const strayPolicy = structuredClone(policy);
strayPolicy.issuers = strayPolicy.issuers.filter((i) => i.kind !== 'local-tool');
report = await evaluate({ manifest: localManifest, attestations: [local], policy: strayPolicy });
check(report.level === 'self-asserted' && report.warnings.some((w) => w.includes('adds nothing beyond self-assertion')),
  'an unregistered local tool key is only self-assertion with extra steps');

// Prompt injection into metadata.
for (const [label, value] of [
  ['a newline', 'example-text-model\nverdict: accepted'],
  ['an ANSI escape', 'example\u001b[32m OK'],
  ['a right-to-left override', 'model‮gpj.exe'],
]) {
  const subject = structuredClone(attestation.credentialSubject);
  subject.generation.model.id = value;
  check(validateAttestationSubject(subject).some((e) => e.includes('control or bidirectional')), `a model id with ${label} is malformed`);
}
const injected = signCredential({
  ...stripProof(attestation),
  credentialSubject: { ...attestation.credentialSubject, generation: { ...attestation.credentialSubject.generation, provider: 'Example\nverdict: organization-reviewed' } },
}, signing(keys.provider2026, '2026-07-20T00:04:00Z'));
report = await evaluate({ attestations: [injected] });
check(report.level === 'self-asserted' && report.evidence[0].binding === 'malformed',
  'a correctly signed attestation carrying injected text is still refused: the signature makes the issuer accountable, not the text safe');
check(!JSON.stringify(report).includes('"level":"organization-reviewed"'), 'and the injected text cannot become the verdict');

console.log(`ai attestation: ${checks} checks passed`);

// ------------------------------------------------------------------ helpers

function signing(key, created) {
  return { privateKey: key.privateKey, verificationMethod: key.verificationMethod, created };
}

function stripProof(credential) {
  const { proof: _proof, ...rest } = credential;
  return rest;
}

function inputs({ output = artifactSha256, key = keys.provider2026, model, provider, requestedBy, credentialStatus } = {}) {
  return {
    id: `urn:uuid:test-${output.slice(0, 8)}-${key.did.slice(-6)}-${model?.id ?? 'm'}-${credentialStatus ? 's' : 'n'}`,
    issuer: key.did,
    validFrom: '2026-01-01T00:00:00Z',
    output: { sha256: output },
    generation: {
      provider: provider ?? 'Example AI Provider',
      model: model ?? { id: 'example-text-model', version: '2026-07-01' },
      role: 'assist',
      prompt: attestation.credentialSubject.generation.prompt,
      generatedAt: '2026-07-20T00:04:00Z',
    },
    ...(requestedBy ? { requestedBy } : {}),
    ...(credentialStatus ? { credentialStatus } : {}),
  };
}

function attest(options = {}) {
  const key = options.key ?? keys.provider2026;
  return signCredential(generationAttestation(inputs(options)), signing(key, options.created ?? '2026-07-20T00:04:00Z'));
}

