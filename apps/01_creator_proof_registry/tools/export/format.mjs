// The portable export format of `backend/src/Export.mo`, in JavaScript.
//
// This is the reader's side of #19. The canister hands out pages; nothing about
// a page is believed until this module has recomputed its checksum from the
// entries and, at the end, the roots over every entry digest. The encoding has
// to exist on both sides of the trust boundary for that to mean anything, and
// the replica suite is where the two implementations are compared live.
//
// Same discipline as `test/record-digest.mjs` and `protocol/COMMITMENT_V1.md`:
// a versioned domain separator, fixed-width big-endian integers, a length
// prefix on every variable-length field, a present-flag on every optional, and
// a tag byte on every variant.

import { createHash } from 'node:crypto';

import { recordDigest as rawRecordDigest, short, text, u32, u64 } from '../../test/record-digest.mjs';

export const FORMAT_V1 = 'icp-creator-proof:export:v1';
export const COMMITMENT_DOMAIN = 'icp-creator-proof:export-commitment:v1';
export const COMMITMENT_ROOT_DOMAIN = 'icp-creator-proof:export-commitments-root:v1';
export const RECORD_ROOT_DOMAIN = 'icp-creator-proof:export-records-root:v1';
export const PAGE_DOMAIN = 'icp-creator-proof:export-page:v1';

export const COMMITMENT_KIND = 1;
export const RECORD_KIND = 2;
export const PAGE_MAX = 100;

const sha256 = (parts) => new Uint8Array(createHash('sha256').update(Buffer.concat(parts)).digest());
const domain = (value) => Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);

const optionalBlob = (value) =>
  value.length === 0 ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), Buffer.from(value[0])]);

const optionalNat = (value) =>
  value.length === 0 ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), u64(value[0])]);

const statusEncoding = (status) => {
  if ('open' in status) return Buffer.from([0]);
  if ('revealed' in status) return Buffer.concat([Buffer.from([1]), u64(status.revealed)]);
  return Buffer.concat([Buffer.from([2]), u64(status.cancelled)]);
};

/// The commitment's canonical digest; mirrors `Export.commitmentDigest`.
export function commitmentDigest(commitment) {
  return sha256([
    domain(COMMITMENT_DOMAIN),
    u64(commitment.id),
    short(commitment.owner.toUint8Array()),
    Buffer.from(commitment.commitmentHash),
    optionalBlob(commitment.metadataHash),
    u64(commitment.committedAt),
    optionalNat(commitment.expiresAt),
    statusEncoding(commitment.status),
  ]);
}

/// A record under the export policy. Redaction happens before hashing, so a
/// redacted export's roots describe exactly what was handed out.
export function redactRecord(record, policy) {
  if (policy.includeStorageUris) return record;
  return { ...record, storageUri: '' };
}

export function recordDigest(record, policy) {
  return rawRecordDigest(redactRecord(record, policy));
}

function root(domainName, digests) {
  return sha256([
    domain(domainName),
    u64(digests.length),
    ...digests.map((digest) => Buffer.from(digest)),
  ]);
}

export function commitmentRoot(digests) {
  return root(COMMITMENT_ROOT_DOMAIN, digests);
}

export function recordRoot(digests) {
  return root(RECORD_ROOT_DOMAIN, digests);
}

/// The page checksum; mirrors `Export.pageChecksum`. `next` is a bigint or
/// null. The policy flag is folded in so a page fetched under one policy
/// cannot be replayed as another.
export function pageChecksum(kind, policy, start, next, digests) {
  return sha256([
    domain(PAGE_DOMAIN),
    Buffer.from([kind]),
    Buffer.from([policy.includeStorageUris ? 1 : 0]),
    u64(start),
    u32(digests.length),
    ...digests.map((digest) => Buffer.from(digest)),
    next === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), u64(next)]),
  ]);
}

/// Recomputes a page's checksum from its own entries. Returns the entry
/// digests so a caller can accumulate them into the roots without re-encoding.
export function verifyPage(page, policy) {
  if (page.kind !== COMMITMENT_KIND && page.kind !== RECORD_KIND) {
    throw new Error(`unknown page kind ${page.kind}`);
  }
  const digests = page.entries.map((entry) =>
    page.kind === COMMITMENT_KIND ? commitmentDigest(entry) : recordDigest(entry, policy));
  const expected = pageChecksum(page.kind, policy, page.start, page.next.length === 0 ? null : page.next[0], digests);
  if (Buffer.compare(Buffer.from(page.checksum), Buffer.from(expected)) !== 0) {
    throw new Error(`page at ${page.start} does not match its checksum`);
  }
  return digests;
}

export const bytesToHex = (bytes) => Buffer.from(bytes).toString('hex');
export const hexToBytes = (hex) => new Uint8Array(Buffer.from(hex, 'hex'));
