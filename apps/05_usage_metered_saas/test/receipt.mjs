// The signed usage receipt of `backend/src/Receipt.mo`, in JavaScript: the
// signer's side and the auditor's side of issue #15.
//
// A reporter signs where the usage is observed — a gateway, a device, a batch
// job — with nothing but `node:crypto`, and an auditor re-verifies exported
// billing the same way. Written from `docs/RECEIPTS.md`, not from the Motoko
// source, so the replica suite doubles as a cross-implementation check: every
// receipt the canister accepts was encoded and signed here.

import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

const DOMAIN = 'icp-usage-receipt:v1';

/// The P-256 group order. ECDSA signatures come in pairs, (r, s) and
/// (r, n - s), and the canister accepts only the low one: `s < floor(n / 2)`,
/// the bound `mo:ecdsa` uses.
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF = P256_ORDER / 2n;

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

const short = (bytes) => Buffer.concat([Buffer.from([bytes.length]), Buffer.from(bytes)]);

const text = (value) => {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
};

/// The bytes that get signed. Principals are raw bytes, not their text.
export function encodeReceipt(receipt) {
  return Buffer.concat([
    Buffer.from(DOMAIN, 'utf8'),
    Buffer.from([0]),
    short(receipt.canister.toUint8Array()),
    short(receipt.reporter.toUint8Array()),
    u64(receipt.keyId),
    short(receipt.tenant.toUint8Array()),
    u64(receipt.units),
    text(receipt.category),
    text(receipt.idempotencyKey),
    u64(receipt.observedAt),
  ]);
}

const toBig = (bytes) => BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
const toBytes32 = (value) => Buffer.from(value.toString(16).padStart(64, '0'), 'hex');

/// Forces `s` into the lower half of the group order. Node, like most
/// libraries, returns whichever `s` the arithmetic produced.
export function lowS(signature) {
  const raw = Buffer.from(signature);
  const s = toBig(raw.subarray(32));
  if (s < P256_HALF) return raw;
  return Buffer.concat([raw.subarray(0, 32), toBytes32(P256_ORDER - s)]);
}

/// The other signature of the same pair. Valid ECDSA, refused by the canister.
export function highS(signature) {
  const raw = Buffer.from(signature);
  const s = toBig(raw.subarray(32));
  return Buffer.concat([raw.subarray(0, 32), toBytes32(P256_ORDER - s)]);
}

/// A reporter signing key. `publicKey` is the 65-byte uncompressed SEC1 point
/// the canister registers.
export function generateSigner() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return {
    publicKey: new Uint8Array(point),
    sign: (receipt) => ({
      receipt,
      signature: new Uint8Array(
        lowS(sign('sha256', encodeReceipt(receipt), { key: privateKey, dsaEncoding: 'ieee-p1363' })),
      ),
    }),
  };
}

/// What an auditor runs over `exportUsageAudit`: the receipt verifies under
/// the exported key, and the event says what the receipt says.
export function verifyAuditEntry(entry) {
  if (entry.receipt.length === 0) return { signed: false, valid: null };
  const signed = entry.receipt[0];
  const point = Buffer.from(entry.publicKey[0]);
  const key = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  const signatureValid = verify(
    'sha256',
    encodeReceipt(signed.receipt),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signed.signature),
  );
  const event = entry.event;
  const matches =
    event.tenant.toText() === signed.receipt.tenant.toText() &&
    BigInt(event.units) === BigInt(signed.receipt.units) &&
    event.category === signed.receipt.category &&
    event.idempotencyKey === signed.receipt.idempotencyKey &&
    event.recordedBy.toText() === signed.receipt.reporter.toText();
  return { signed: true, valid: signatureValid && matches };
}
