// Multibase, Multikey and did:key for Ed25519, as the W3C Data Integrity
// specifications use them.
//
// A Multikey public key is `z` (multibase: base58-btc) followed by the
// base58-btc encoding of the multicodec header `0xed 0x01` and the 32-byte
// Ed25519 public key; the secret key uses header `0x80 0x26` and the 32-byte
// seed. A `did:key` DID is `did:key:` plus that same public key string, and its
// only verification method is `<did>#<the same string>` — which is why a
// did:key needs no network to resolve, and why it cannot be rotated: a new key
// is a new DID. Rotation is therefore expressed in the verifier's issuer
// policy (vc.mjs), the same way #7 expresses it in the registry: as history.

import { createPrivateKey, createPublicKey } from 'node:crypto';

export class MultikeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MultikeyError';
  }
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58btcEncode(bytes) {
  const data = Buffer.from(bytes);
  let n = BigInt(`0x${data.toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of data) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function base58btcDecode(text) {
  let n = 0n;
  for (const c of text) {
    const digit = INDEX.get(c);
    if (digit === undefined) throw new MultikeyError(`invalid base58-btc character ${JSON.stringify(c)}`);
    n = n * 58n + digit;
  }
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  return new Uint8Array(Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]));
}

/// Multibase decode for the two encodings the VC specifications use:
/// `z` base58-btc (keys, proof values) and `u` base64url without padding
/// (Bitstring Status List). Anything else is refused rather than guessed.
export function multibaseDecode(text) {
  if (typeof text !== 'string' || !text.length) throw new MultikeyError('empty multibase value');
  const body = text.slice(1);
  if (text[0] === 'z') return base58btcDecode(body);
  if (text[0] === 'u') {
    if (!/^[A-Za-z0-9_-]*$/.test(body)) throw new MultikeyError('invalid base64url multibase value');
    return new Uint8Array(Buffer.from(body, 'base64url'));
  }
  throw new MultikeyError(`unsupported multibase prefix ${JSON.stringify(text[0])}`);
}

export const multibaseBase58 = (bytes) => `z${base58btcEncode(bytes)}`;
export const multibaseBase64url = (bytes) => `u${Buffer.from(bytes).toString('base64url')}`;

const ED25519_PUB = [0xed, 0x01];
const ED25519_PRIV = [0x80, 0x26];

function withHeader(header, raw) {
  return multibaseBase58(Buffer.concat([Buffer.from(header), Buffer.from(raw)]));
}

function withoutHeader(header, text, length) {
  const bytes = multibaseDecode(text);
  if (text[0] !== 'z') throw new MultikeyError('a Multikey is base58-btc encoded');
  if (bytes[0] !== header[0] || bytes[1] !== header[1]) throw new MultikeyError('not an Ed25519 Multikey');
  if (bytes.length !== length + 2) throw new MultikeyError(`an Ed25519 Multikey carries ${length} bytes`);
  return bytes.subarray(2);
}

const rawPublic = (publicKey) => publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

export function publicKeyMultibase(publicKey) {
  return withHeader(ED25519_PUB, rawPublic(publicKey));
}

export function secretKeyMultibase(privateKey) {
  // PKCS#8 for Ed25519 ends with the 32-byte seed.
  return withHeader(ED25519_PRIV, privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32));
}

export function publicKeyFromMultibase(text) {
  const raw = withoutHeader(ED25519_PUB, text, 32);
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  });
}

export function privateKeyFromMultibase(text) {
  const seed = withoutHeader(ED25519_PRIV, text, 32);
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
}

export const didKey = (publicKey) => `did:key:${publicKeyMultibase(publicKey)}`;
export const didKeyVerificationMethod = (publicKey) => {
  const multibase = publicKeyMultibase(publicKey);
  return `did:key:${multibase}#${multibase}`;
};

/**
 * Resolves a did:key verification method URL to its public key. Only the
 * canonical form is accepted — the fragment must repeat the method-specific
 * id — because a URL whose fragment named a different key would let one DID
 * appear to authorize another's signature.
 */
export function resolveDidKey(verificationMethod) {
  const match = /^did:key:(z[1-9A-HJ-NP-Za-km-z]+)#(z[1-9A-HJ-NP-Za-km-z]+)$/.exec(verificationMethod);
  if (!match) throw new MultikeyError(`not a did:key verification method: ${verificationMethod}`);
  if (match[1] !== match[2]) throw new MultikeyError('the did:key fragment does not match its DID');
  return { controller: `did:key:${match[1]}`, publicKey: publicKeyFromMultibase(match[1]) };
}
