#!/usr/bin/env node
// The creator/verifier frontend's logic, tested offline.
//
//   node apps/01_creator_proof_registry/frontend/client.test.mjs
//
// The point of these tests is that the browser never has to be trusted with
// the rules: the commitment and record encodings are compared against the
// independent implementations in `protocol/tools/` and `test/`, the hashing
// is proven to make no network call, and the interrupted-reveal state is
// proven to carry no artifact.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { canonicalize, canonicalizeValue } from '../../../protocol/tools/jcs.mjs';
import { commitmentHex as referenceCommitment } from '../../../protocol/tools/commitment.mjs';
import { recordDigest as referenceRecordDigest } from '../test/record-digest.mjs';
import warningInventory from '../../../privacy/warnings.json' with { type: 'json' };
import {
  WARNING_COPY,
  bytesToHex,
  clearPending,
  commitmentHex,
  encodeRecord,
  hashArtifactBytes,
  hashArtifactFile,
  loadPending,
  manifestHash,
  publicationWarnings,
  recordDigest,
  savePending,
  sha256Hex,
  verificationReport,
} from './client.mjs';

let checks = 0;
function ok(condition, description) {
  checks += 1;
  if (!condition) throw new Error(`FAILED: ${description}`);
  console.log(`  ok  ${description}`);
}

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const unhex = (value) => new Uint8Array(Buffer.from(value, 'hex'));

function digest(seed) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 31 + i * 7) & 0xff;
  return bytes;
}

function salt(seed) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 17 + i * 11) & 0xff;
  return bytes;
}

const owner = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1, 2, 3]);

const record = {
  id: 7n,
  commitmentId: 3n,
  owner,
  artifactHash: digest(1),
  manifestHash: digest(2),
  salt: salt(3),
  title: 't',
  kind: 'image',
  mimeType: 'image/png',
  storageUri: 'ipfs://x',
  parents: [1n, 2n],
  ai: {
    assisted: true,
    mode: { other: '研究' },
    provider: ['acme'],
    model: [],
    promptHash: [digest(4)],
    humanContribution: [],
  },
  createdAt: 1234567890n,
  status: { revoked: { at: 999n, reason: 'superseded' } },
};

// ------------------------------------------------------------------ hashing

{
  ok(await sha256Hex(new TextEncoder().encode('abc'))
    === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'SHA-256 matches the published vector');

  const manifest = { z: 1, a: { y: 'é', x: [3, 2, 1] } };
  const expected = createHash('sha256').update(canonicalize(JSON.stringify(manifest))).digest('hex');
  ok(await manifestHash(manifest, canonicalizeValue) === expected,
    'the manifest digest matches the RFC 8785 canonicalizer used by the CLI');
  ok(await manifestHash(manifest, canonicalizeValue) === await manifestHash({ a: { x: [3, 2, 1], y: 'é' }, z: 1 }, canonicalizeValue),
    'key order does not change the manifest digest');
}

// -------------------------------------------------------------- commitment

{
  for (const [principal, seed] of [['rrkah-fqaaa-aaaaa-aaaaq-cai', 1], ['renrk-eyaaa-aaaaa-aaada-cai', 9]]) {
    const manifest = hex(digest(seed + 100));
    const value = hex(salt(seed));
    const reference = referenceCommitment({ principal, manifestHash: manifest, salt: value });
    ok(await commitmentHex({ principal, manifestHash: manifest, salt: value }) === reference,
      `the client commitment matches the protocol implementation (${principal.slice(0, 8)}…)`);
  }
}

// ------------------------------------------------------------- record digest

{
  const referenceOwner = { toUint8Array: () => owner };
  const referenceRecord = { ...record, owner: referenceOwner };
  ok(hex(await recordDigest(record)) === hex(referenceRecordDigest(referenceRecord)),
    'the client record digest matches the test implementation (revoked record)');
  const active = { ...record, status: { active: null }, title: 'active' };
  ok(hex(await recordDigest(active)) === hex(referenceRecordDigest({ ...active, owner: referenceOwner })),
    'the client record digest matches for an active record');
  ok(hex(await recordDigest({ ...record, owner: { toUint8Array: () => owner } })) === hex(await recordDigest(record)),
    'a decoded principal object and its bytes encode the same');
}

// ------------------------------------------------------------ interrupted flow

{
  const memory = new Map();
  const store = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key),
  };
  ok(loadPending(store) === null, 'no pending reveal before a commit');
  const pending = {
    commitmentId: '12',
    commitmentHash: hex(await commitmentHex({ principal: 'rrkah-fqaaa-aaaaa-aaaaq-cai', manifestHash: hex(digest(2)), salt: hex(salt(3)) })),
    manifestHash: hex(digest(2)),
    artifactHash: hex(digest(1)),
    salt: hex(salt(3)),
  };
  savePending(store, pending);
  const stored = loadPending(store);
  ok(JSON.stringify(stored) === JSON.stringify(pending), 'the pending reveal survives a reload');
  ok(!JSON.stringify(stored).includes('artifact') || stored.artifactHash, 'the pending state carries the artifact hash, never the artifact');
  ok(Object.keys(stored).sort().join() === 'artifactHash,commitmentHash,commitmentId,manifestHash,salt',
    'the pending state has exactly the recovery fields');
  clearPending(store);
  ok(loadPending(store) === null, 'clearing the pending reveal removes it');
}

// ------------------------------------------------------------------- offline

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('the hashing path must not touch the network');
  };
  try {
    await sha256Hex(new Uint8Array([1, 2, 3]));
    await manifestHash({ a: 1 }, canonicalizeValue);
    await commitmentHex({ principal: 'rrkah-fqaaa-aaaaa-aaaaq-cai', manifestHash: hex(digest(2)), salt: hex(salt(3)) });
    await recordDigest(record);
    ok(true, 'hashing, canonicalization and both encodings work with fetch disabled');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ------------------------------------------------------------------ large file

{
  const directory = await mkdtemp(join(tmpdir(), 'creator-client-'));
  try {
    const bytes = new Uint8Array(8 * 1024 * 1024 + 123);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7 + 3) & 0xff;
    const path = join(directory, 'artifact.bin');
    await writeFile(path, bytes);
    const streamed = await hashArtifactFile(path);
    ok(streamed === await hashArtifactBytes(bytes), 'the streamed digest of a large file equals the in-memory digest');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------- verification

{
  const attested = await recordDigest(record);
  const report = await verificationReport({ record, attestedDigest: attested });
  ok(report.matches && report.status === 'revoked', 'a matching revoked record verifies and says so');
  ok(report.warnings.some((warning) => warning.includes('revoked')), 'the revoked state is prominent');

  const tampered = { ...record, storageUri: 'ipfs://attacker-controlled' };
  const tamperedReport = await verificationReport({ record: tampered, attestedDigest: attested });
  ok(!tamperedReport.matches, 'a record altered in transit fails verification');
  ok(tamperedReport.summary.includes('altered'), 'the failure says what happened in plain words');
}

// -------------------------------------------------------------- warnings

{
  const inventory = new Map(warningInventory.warnings.map((warning) => [warning.id, warning]));
  for (const [id, copy] of Object.entries(WARNING_COPY)) {
    const source = inventory.get(id);
    ok(source !== undefined && source.copy === copy.copy && source.title === copy.title,
      `the UI copy for ${id} is verbatim from privacy/warnings.json`);
  }
  const shown = publicationWarnings(['irreversible-publication', 'no-personal-data']);
  ok(shown.length === 2 && shown[0].id === 'irreversible-publication', 'the warnings render in the order asked for');
}

console.log(`\ncreator frontend client: ${checks} checks passed`);
