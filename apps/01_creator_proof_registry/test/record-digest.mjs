// The record encoding of `backend/src/RecordDigest.mo`, in JavaScript.
//
// This is what a reader actually has to do: take the record a query returned,
// re-encode it, hash it, and compare against what the certificate attests. A
// verifier that trusted the canister to tell it the digest would be verifying
// nothing, so the encoding has to exist twice — once on each side of the trust
// boundary — and the replica suite is where the two are compared.
//
// The layout is `docs/CERTIFIED_QUERIES.md`. Same discipline as the commitment
// in `protocol/COMMITMENT_V1.md`: a versioned domain separator, fixed-width
// integers, and a length prefix on every variable-length field.

import { createHash } from 'node:crypto';

const DOMAIN = 'icp-creator-proof:record:v1';

const MODE_TAGS = { none: 0, assist: 1, generate: 2, transform: 3, other: 4 };

const u64 = (value) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
};

const u32 = (value) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(Number(value));
  return out;
};

/// A length prefix of one byte, for fields the canister caps below 256.
const short = (bytes) => Buffer.concat([Buffer.from([bytes.length]), Buffer.from(bytes)]);

const text = (value) => {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
};

/// A present-flag rather than a zero length, so `null` and `""` cannot encode
/// to the same bytes.
const optionalText = (value) =>
  value.length === 0 ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), text(value[0])]);

function disclosure(ai) {
  const parts = [Buffer.from([ai.assisted ? 1 : 0])];
  const [mode] = Object.keys(ai.mode);
  parts.push(Buffer.from([MODE_TAGS[mode]]));
  if (mode === 'other') parts.push(text(ai.mode.other));
  parts.push(optionalText(ai.provider));
  parts.push(optionalText(ai.model));
  parts.push(
    ai.promptHash.length === 0
      ? Buffer.from([0])
      : Buffer.concat([Buffer.from([1]), Buffer.from(ai.promptHash[0])]),
  );
  parts.push(optionalText(ai.humanContribution));
  return Buffer.concat(parts);
}

export function encodeRecord(record) {
  const parts = [
    Buffer.from(DOMAIN, 'utf8'),
    Buffer.from([0]),
    u64(record.id),
    u64(record.commitmentId),
    // `Principal.toBlob` on the canister side: the raw principal, not its text.
    short(record.owner.toUint8Array()),
    Buffer.from(record.artifactHash),
    Buffer.from(record.manifestHash),
    short(record.salt),
    text(record.title),
    text(record.kind),
    text(record.mimeType),
    text(record.storageUri),
    u32(record.parents.length),
    ...record.parents.map(u64),
    disclosure(record.ai),
    u64(record.createdAt),
  ];

  if ('revoked' in record.status) {
    parts.push(Buffer.from([1]), u64(record.status.revoked.at), text(record.status.revoked.reason));
  } else {
    parts.push(Buffer.from([0]));
  }

  return Buffer.concat(parts);
}

export function recordDigest(record) {
  return new Uint8Array(createHash('sha256').update(encodeRecord(record)).digest());
}

/// The tree key a record's digest lives under: `["record", id as u64 BE]`.
export const recordPath = (id) => [Buffer.from('record', 'utf8'), u64(id)];
