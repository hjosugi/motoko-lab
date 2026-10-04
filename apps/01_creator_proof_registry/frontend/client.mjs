// The creator/verifier frontend's logic, without a framework and without a
// build step.
//
// Everything that must be right is here, in a module a browser and Node both
// load: hashing happens locally before anything is sent, the commitment is
// built from the documented v1 layout, the pending reveal survives an
// interrupted flow, and a served record is checked against the digest the
// subnet attested. The HTML in `index.html` is a thin view over this module;
// the tests in `client.test.mjs` run it offline.
//
// Hashing uses Web Crypto, which exists in every browser this targets and in
// Node 18+, so there is no `node:crypto` import to break a browser bundle. The
// one Node-only helper (`hashArtifactFile`, for large files) imports its
// streaming hash lazily and is never called in a browser.

const encoder = new TextEncoder();

const concat = (parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const hexToBytes = (hex) => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error('not a hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const bytesToHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export async function sha256Bytes(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

export async function sha256Hex(bytes) {
  return bytesToHex(await sha256Bytes(bytes));
}

/// The artifact digest, computed from bytes the user chose. Nothing here
/// touches the network: the file never leaves the browser.
export async function hashArtifactBytes(bytes) {
  return sha256Hex(bytes);
}

/// The same digest for a file on disk, streamed so a large artifact does not
/// have to fit in memory. Node-only by construction; the browser uses a
/// `File`/`Blob` and `hashArtifactBytes` on its array buffer, or the streams
/// API, and the two are compared in the tests.
export async function hashArtifactFile(path) {
  const { createHash } = await import('node:crypto');
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/// The manifest digest: SHA-256 over the RFC 8785 canonical JSON, the same
/// value `protocol/tools/provenance-cli.mjs manifest-hash` prints.
export async function manifestHash(manifest, canonicalizeValue) {
  const canonical = canonicalizeValue(manifest);
  return sha256Hex(encoder.encode(canonical));
}

// ---------------------------------------------------------------- commitment

const DOMAIN = 'icp-creator-proof:v1';
const SEPARATOR = new Uint8Array([0]);

/// The commitment preimage of `protocol/COMMITMENT_V1.md`, built here from the
/// documented layout rather than imported: the frontend must be able to
/// compute it with the platform's own crypto, and the tests compare the two
/// implementations so a drift fails.
export function commitmentPreimage({ principal, manifestHash: manifest, salt }) {
  const manifestBytes = hexToBytes(manifest);
  const saltBytes = hexToBytes(salt);
  if (manifestBytes.length !== 32) throw new Error('manifestHash must be 32 bytes');
  if (saltBytes.length < 16 || saltBytes.length > 64) throw new Error('salt must be between 16 and 64 bytes');
  if (principal.length < 8 || principal.length > 63) throw new Error('principal text length is invalid');
  return concat([encoder.encode(DOMAIN), SEPARATOR, encoder.encode(principal), SEPARATOR, manifestBytes, SEPARATOR, saltBytes]);
}

export async function commitmentHex(input) {
  return sha256Hex(commitmentPreimage(input));
}

// --------------------------------------------------------------- record digest

const RECORD_DOMAIN = 'icp-creator-proof:record:v1';
const MODE_TAGS = { none: 0, assist: 1, generate: 2, transform: 3, other: 4 };

const u64 = (value) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
};

const u32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, Number(value), false);
  return out;
};

const short = (bytes) => concat([new Uint8Array([bytes.length]), bytes]);
const text = (value) => {
  const bytes = encoder.encode(value);
  return concat([u32(bytes.length), bytes]);
};
const optionalText = (value) =>
  value.length === 0 ? new Uint8Array([0]) : concat([new Uint8Array([1]), text(value[0])]);

function disclosure(ai) {
  const [mode] = Object.keys(ai.mode);
  const parts = [
    new Uint8Array([ai.assisted ? 1 : 0]),
    new Uint8Array([MODE_TAGS[mode]]),
  ];
  if (mode === 'other') parts.push(text(ai.mode.other));
  parts.push(optionalText(ai.provider), optionalText(ai.model));
  parts.push(ai.promptHash.length === 0
    ? new Uint8Array([0])
    : concat([new Uint8Array([1]), new Uint8Array(ai.promptHash[0])]));
  parts.push(optionalText(ai.humanContribution));
  return concat(parts);
}

/// The record encoding of `backend/src/RecordDigest.mo`. The verifier needs
/// its own copy: comparing a served record against the attested digest only
/// means something when the reader, not the canister, computed the digest.
export function encodeRecord(record) {
  const parts = [
    encoder.encode(RECORD_DOMAIN),
    new Uint8Array([0]),
    u64(record.id),
    u64(record.commitmentId),
    short(record.owner?.toUint8Array ? record.owner.toUint8Array() : new Uint8Array(record.owner)),
    new Uint8Array(record.artifactHash),
    new Uint8Array(record.manifestHash),
    short(new Uint8Array(record.salt)),
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
    parts.push(new Uint8Array([1]), u64(record.status.revoked.at), text(record.status.revoked.reason));
  } else {
    parts.push(new Uint8Array([0]));
  }
  return concat(parts);
}

export async function recordDigest(record) {
  return sha256Bytes(encodeRecord(record));
}

// ------------------------------------------------------------ pending reveal

/// A commit can be followed by a reveal in a later session; the browser may be
/// closed in between. What is stored is the commitment id, the salt, the
/// manifest hash and the artifact digest — never the artifact, never a
/// private pointer. `store` is anything with getItem/setItem/removeItem, so
/// localStorage in the browser and a Map in the tests.
export function savePending(store, pending) {
  store.setItem('creator.pendingReveal', JSON.stringify(pending));
}

export function loadPending(store) {
  const textValue = store.getItem('creator.pendingReveal');
  return textValue === null ? null : JSON.parse(textValue);
}

export function clearPending(store) {
  store.removeItem('creator.pendingReveal');
}

// ------------------------------------------------------------ verification

/// The verifier's job: take the record a gateway served and the digest the
/// subnet attested, recompute the digest locally, and say plainly what the
/// reader is looking at. A mismatch is the gateway-tampering case; a revoked
/// record is prominent rather than hidden; nothing here turns evidence into a
/// legal conclusion.
export async function verificationReport({ record, attestedDigest }) {
  const computed = await recordDigest(record);
  const matches = computed.length === attestedDigest.length
    && computed.every((byte, index) => byte === attestedDigest[index]);
  const status = 'revoked' in record.status ? 'revoked' : 'active';
  return {
    matches,
    status,
    warnings: [
      ...(matches ? [] : ['the served record does not match the attested digest; do not trust it']),
      ...(status === 'revoked' ? ['this record was revoked by its owner; the history stays'] : []),
    ],
    summary: matches
      ? `The subnet attests this record (${status}).`
      : 'The record you were served was altered in transit or by the gateway.',
  };
}

// ---------------------------------------------------------------- warnings

/// The publication warnings, verbatim from `privacy/warnings.json` (the test
/// compares the two). The UI must show the applicable ones before an
/// irreversible write, and must not soften the wording.
export const WARNING_COPY = {
  'irreversible-publication': {
    title: 'Publication is irreversible',
    copy: 'This will be written to an immutable public canister. It cannot be edited or deleted, only superseded by a new record or withdrawn by revocation.',
  },
  'no-personal-data': {
    title: 'No personal data',
    copy: 'Do not enter names, email addresses, IP addresses, or private source. On-chain free text is permanent and public.',
  },
  'private-evidence-off-chain': {
    title: 'Private evidence stays off-chain',
    copy: 'Keep private evidence in your own storage; only a digest and a custodian label go on-chain.',
  },
};

export function publicationWarnings(ids) {
  return ids.map((id) => {
    const warning = WARNING_COPY[id];
    if (!warning) throw new Error(`unknown warning ${id}`);
    return { id, ...warning };
  });
}

/// The fields a creator is about to publish, and what each one means. Shown
/// next to the form, not in a legal page nobody opens.
export const FIELD_NOTES = {
  title: 'Public and permanent. It can describe the work, not identify a person.',
  kind: 'Public and permanent.',
  mimeType: 'Public and permanent.',
  storageUri: 'Public and permanent pointer to the artifact. Leave it out or use a redacted export for private work.',
  manifest: 'Canonical JSON hashed locally; only the hash is sent.',
  artifact: 'Hashed locally; the file never leaves this device.',
  salt: 'Random, 16–64 bytes. Keep it with the pending reveal: without it the commitment cannot be opened.',
};
