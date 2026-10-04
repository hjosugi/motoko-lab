#!/usr/bin/env node
// The export reader's tests: byte vectors, page verification, resumption, and
// a restore against a fake target.
//
//   node tools/export/export.test.mjs
//
// Offline and dependency-free. The live comparison against the canister is the
// replica suite's export section; this pins the bytes and exercises the loop
// around them (interruption, tampering, a target that lies) without a replica.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMMITMENT_KIND,
  FORMAT_V1,
  RECORD_KIND,
  bytesToHex,
  commitmentDigest,
  commitmentRoot,
  hexToBytes,
  pageChecksum,
  recordDigest,
  recordRoot,
  redactRecord,
  verifyPage,
} from './format.mjs';
import { collect, readBundle, restore, verify } from './bundle.mjs';

let checks = 0;
function ok(condition, description) {
  checks += 1;
  if (!condition) throw new Error(`FAILED: ${description}`);
  console.log(`  ok  ${description}`);
}

async function expectThrows(body, includes, description) {
  let thrown = null;
  try {
    await body();
  } catch (error) {
    thrown = error;
  }
  checks += 1;
  if (thrown === null || (includes && !thrown.message.includes(includes))) {
    throw new Error(`FAILED: ${description} -> ${thrown === null ? 'it did not throw' : thrown.message}`);
  }
  console.log(`  ok  ${description}`);
}

const ownerBytes = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
const owner = { _isPrincipal: true, toUint8Array: () => ownerBytes };

const commitment = {
  id: 7n,
  owner,
  commitmentHash: Uint8Array.from(Array(32).fill(0xaa)),
  metadataHash: [Uint8Array.from(Array(32).fill(0xbb))],
  committedAt: 1234567890n,
  expiresAt: [2000000000n],
  status: { revealed: 3n },
};

const proof = {
  id: 7n,
  commitmentId: 3n,
  owner,
  artifactHash: Uint8Array.from(Array(32).fill(0xaa)),
  manifestHash: Uint8Array.from(Array(32).fill(0xbb)),
  salt: Uint8Array.from(Array(16).fill(0xcc)),
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
    promptHash: [Uint8Array.from(Array(32).fill(0xdd))],
    humanContribution: [],
  },
  createdAt: 1234567890n,
  status: { revoked: { at: 999n, reason: 'superseded' } },
};

const includeUris = { includeStorageUris: true };
const redactUris = { includeStorageUris: false };

// ----------------------------------------------------------- byte vectors

// Pinned against `Export.test.mo`, which computes the same values in Motoko
// from the same fixture. A change to either encoding fails here first.
ok(bytesToHex(commitmentDigest(commitment)) === '6385b2fc9f870382eccdf955a3b021db0b07e026cfae887a671b7329f01d4a97',
  'the commitment digest vector is unchanged');
ok(bytesToHex(recordDigest(proof, includeUris)) === 'b1455d91833601f72c0bb045131fffd6c1f02700d89ef940c8800d435ecff2bf',
  'the record digest vector is unchanged');
ok(bytesToHex(recordDigest(proof, redactUris)) === 'fe812ca008a9fc99af2bbbd4d68edacb215b8a856b34f9fb58e1129e56f94e48',
  'redaction changes the record digest');
ok(bytesToHex(commitmentRoot([commitmentDigest(commitment)]))
  === '6eaa34abffcb1fe1e2549e1da942a981046e8e188e00d1c93e3cc6ea91fca520',
  'the commitment root vector is unchanged');
ok(bytesToHex(recordRoot([recordDigest(proof, includeUris)]))
  === '71ec3536bf6d20deb4ae9ef247cf05ede87c7af427c63179d34a035924131aeb',
  'the record root vector is unchanged');
ok(bytesToHex(pageChecksum(COMMITMENT_KIND, includeUris, 0n, 1n, [commitmentDigest(commitment)]))
  === '2315566ec9dd23240ed3e50f9ed2626300dc786dbe915dca3c4519ba3b03152c',
  'the page checksum vector is unchanged');
ok(redactRecord(proof, redactUris).storageUri === '' && proof.storageUri === 'ipfs://x',
  'redaction replaces the pointer without touching the input');

// --------------------------------------------------------------- fixtures

/// A source serving the given entries in bounded pages, with real checksums.
function makeSource({ commitments = [], records = [], policy = includeUris, failOn = null, log = [] }) {
  const source = {
    exportSummary() {
      return {
        format: FORMAT_V1,
        canister: { toText: () => 'aaaaa-aa' },
        policy,
        commitments: BigInt(commitments.length),
        records: BigInt(records.length),
        activeRecords: BigInt(records.filter((record) => 'active' in record.status).length),
        revokedRecords: BigInt(records.filter((record) => 'revoked' in record.status).length),
        commitmentRoot: commitmentRoot(commitments.map((entry) => commitmentDigest(entry))),
        recordRoot: recordRoot(records.map((record) => recordDigest(record, policy))),
      };
    },
  };
  const serve = (name, kind, entries, start, limit, digests) => {
    if (failOn && failOn.name === name && failOn.start === start) {
      throw new Error('connection dropped');
    }
    const slice = entries.slice(Number(start), Number(start) + Number(limit));
    const next = BigInt(Number(start) + slice.length) >= BigInt(entries.length)
      ? []
      : [BigInt(Number(start) + slice.length)];
    const page = { kind, start, next, entries: slice };
    page.checksum = pageChecksum(kind, policy, start, next.length === 0 ? null : next[0], digests(slice));
    log.push(`${name}:${start}`);
    return page;
  };
  source.exportCommitments = (start, limit) => serve(
    'commitments', COMMITMENT_KIND, commitments, start, limit, (slice) => slice.map(commitmentDigest));
  source.exportRecords = (start, limit) => serve(
    'records', RECORD_KIND, records, start, limit, (slice) => slice.map((record) => recordDigest(record, policy)));
  return source;
}

function manyCommitments(count) {
  return Array.from({ length: count }, (_, index) => ({
    ...commitment,
    id: BigInt(index + 1),
    commitmentHash: Uint8Array.from(Array(32).fill((index * 7 + 3) & 0xff)),
    committedAt: BigInt(1000 + index),
    status: index % 3 === 0 ? { open: null } : { revealed: BigInt(index + 1) },
  }));
}

function manyRecords(count) {
  return Array.from({ length: count }, (_, index) => ({
    ...proof,
    id: BigInt(index + 1),
    commitmentId: BigInt(index + 1),
    artifactHash: Uint8Array.from(Array(32).fill((index * 11 + 5) & 0xff)),
    status: index % 4 === 0
      ? { revoked: { at: BigInt(index), reason: 'superseded' } }
      : { active: null },
  }));
}

// --------------------------------------------------------------- collect

{
  const directory = await mkdtemp(join(tmpdir(), 'export-test-'));
  try {
    const commitments = manyCommitments(7);
    const records = manyRecords(5);
    const source = makeSource({ commitments, records });
    const bundle = await collect({ source, policy: includeUris, directory, sourceInfo: {
      canister: 'aaaaa-aa', moduleHash: '00', candidHash: '00', schema: FORMAT_V1,
    }, pageLimit: 3 });
    ok(bundle.entries.commitments.length === 7 && bundle.entries.records.length === 5,
      'collect fetches every entry in bounded pages');
    ok(bundle.bundle.pages.commitments.length === 3 && bundle.bundle.pages.records.length === 2,
      'the bundle records one file per page');
    ok(bundle.bundle.summary.records === '5', 'the summary travels with the bundle');
    const verified = await verify(directory);
    ok(bytesToHex(verified.digests.records[0]) === bytesToHex(recordDigest(records[0], includeUris)),
      'verification recomputes the same digests the source did');

    // Resume: the first run dies on the second records page; a second run with
    // a healthy source must start at the page that failed, not from zero.
    const interrupted = await mkdtemp(join(tmpdir(), 'export-test-'));
    const log = [];
    const broken = makeSource({ commitments, records, failOn: { name: 'records', start: 3n }, log });
    await expectThrows(
      () => collect({ source: broken, policy: includeUris, directory: interrupted, sourceInfo: {
        canister: 'aaaaa-aa', moduleHash: '00', candidHash: '00', schema: FORMAT_V1,
      }, pageLimit: 3 }),
      'connection dropped',
      'an interrupted export throws instead of writing an incomplete bundle',
    );
    const partial = await readBundle(interrupted);
    ok(partial.state.commitments === null && partial.state.records === '3',
      'the interrupted bundle remembers where it stopped');
    const resumed = await collect({ source: makeSource({ commitments, records, log }), policy: includeUris,
      directory: interrupted, sourceInfo: {
        canister: 'aaaaa-aa', moduleHash: '00', candidHash: '00', schema: FORMAT_V1,
      }, pageLimit: 3 });
    ok(resumed.entries.records.length === 5, 'the resumed export completes');
    ok(log.filter((line) => line === 'commitments:0').length === 1,
      'the resume does not re-fetch the commitments it already verified');

    // A corrupted page on disk is caught by verification, not trusted.
    const pagePath = join(directory, bundle.bundle.pages.records[0].file);
    const page = JSON.parse(await readFile(pagePath, 'utf-8'));
    page.entries[0].title = 'tampered';
    await writeFile(pagePath, JSON.stringify(page), 'utf-8');
    await expectThrows(() => verify(directory), 'checksum', 'a page edited on disk fails verification');

    await rm(interrupted, { recursive: true, force: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------- restore

/// A fake fresh canister: it accumulates the pages and computes the same roots
/// the reader does, so `restore` can require the summaries to agree.
function makeTarget({ lie = false } = {}) {
  const state = { commitments: [], records: [], open: false, policy: null };
  return {
    state,
    async restoreBegin(summary) {
      if (state.open) return { err: { conflict: 'a restore is already open' } };
      if (state.commitments.length > 0 || state.records.length > 0) {
        return { err: { conflict: 'not empty' } };
      }
      state.open = true;
      state.policy = summary.policy;
      return { ok: summary };
    },
    async restoreCommitments(entries) {
      state.commitments.push(...entries);
      return { ok: BigInt(state.commitments.length) };
    },
    async restoreRecords(entries) {
      state.records.push(...entries);
      return { ok: BigInt(state.records.length) };
    },
    async restoreFinish() {
      state.open = false;
      const summary = {
        format: FORMAT_V1,
        canister: 'aaaaa-aa',
        policy: state.policy,
        commitments: BigInt(state.commitments.length),
        records: BigInt(state.records.length),
        activeRecords: BigInt(state.records.filter((record) => 'active' in record.status).length),
        revokedRecords: BigInt(state.records.filter((record) => 'revoked' in record.status).length),
        commitmentRoot: commitmentRoot(state.commitments.map(commitmentDigest)),
        recordRoot: recordRoot(state.records.map((record) => recordDigest(record, state.policy))),
      };
      if (lie) summary.recordRoot = hexToBytes('00'.repeat(32));
      return { ok: summary };
    },
  };
}

{
  const directory = await mkdtemp(join(tmpdir(), 'export-test-'));
  try {
    const commitments = manyCommitments(4);
    const records = manyRecords(3);
    await collect({ source: makeSource({ commitments, records }), policy: includeUris, directory, sourceInfo: {
      canister: 'aaaaa-aa', moduleHash: '00', candidHash: '00', schema: FORMAT_V1,
    }, pageLimit: 2 });
    const target = makeTarget();
    const summary = await restore({ directory, target, targetCanister: 'aaaaa-aa', chunk: 2 });
    ok(target.state.commitments.length === 4 && target.state.records.length === 3,
      'restore imports every entry');
    ok(summary.records === 3n, 'restoreFinish returns the restored summary');

    const lying = makeTarget({ lie: true });
    await expectThrows(
      () => restore({ directory, target: lying, targetCanister: 'aaaaa-aa', chunk: 2 }),
      'recordRoot',
      'a target whose summary disagrees with the export is rejected',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ page guard

{
  const page = {
    kind: RECORD_KIND,
    start: 0n,
    next: [1n],
    checksum: new Uint8Array(32),
    entries: [proof],
  };
  await expectThrows(() => verifyPage(page, includeUris), 'checksum', 'a page with a forged checksum is refused');
  const good = {
    ...page,
    checksum: pageChecksum(RECORD_KIND, includeUris, 0n, 1n, [recordDigest(proof, includeUris)]),
  };
  ok(verifyPage(good, includeUris).length === 1, 'a page with a real checksum verifies');
  await expectThrows(
    () => verifyPage(good, redactUris),
    'checksum',
    'a page verified under the other policy is refused',
  );
}

console.log(`\nexport format and tooling: ${checks} checks passed`);
