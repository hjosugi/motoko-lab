// COSE_Sign1 (RFC 9052) with a detached payload: the C2PA claim signature.
//
// The signature box of a C2PA manifest holds `COSE_Sign1_Tagged` (tag 18)
// whose payload is `nil`; the payload is the claim's CBOR bytes, found next to
// it in the manifest. What gets signed is the RFC 9052 section 4.4
// `Sig_structure`:
//
//     ["Signature1", protected header bytes, external_aad = h'', claim bytes]
//
// C2PA 2.x requires the signer's certificate chain in the *protected* header
// (label 33, `x5chain`), so the chain is covered by the signature it
// identifies and cannot be swapped for another one that happens to verify.

import { sign, verify, X509Certificate } from 'node:crypto';

import { CborError, decode, encode, Tagged } from './cbor.mjs';

export class CoseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CoseError';
  }
}

export const HEADER = Object.freeze({ alg: 1, x5chain: 33 });

/// COSE algorithm identifiers C2PA permits, with how node:crypto runs them.
/// ECDSA signatures in COSE are the fixed-width `r || s`, not DER.
const ALGORITHMS = new Map([
  [-8, { name: 'Ed25519', digest: null, options: {} }],
  [-7, { name: 'ES256', digest: 'sha256', options: { dsaEncoding: 'ieee-p1363' } }],
  [-35, { name: 'ES384', digest: 'sha384', options: { dsaEncoding: 'ieee-p1363' } }],
  [-36, { name: 'ES512', digest: 'sha512', options: { dsaEncoding: 'ieee-p1363' } }],
  [-37, { name: 'PS256', digest: 'sha256', options: { padding: 6, saltLength: 32 } }],
  [-38, { name: 'PS384', digest: 'sha384', options: { padding: 6, saltLength: 48 } }],
  [-39, { name: 'PS512', digest: 'sha512', options: { padding: 6, saltLength: 64 } }],
]);

export const algorithmName = (id) => ALGORITHMS.get(id)?.name ?? `unsupported(${id})`;

function sigStructure(protectedBytes, payload) {
  return encode(['Signature1', new Uint8Array(protectedBytes), new Uint8Array(0), new Uint8Array(payload)]);
}

/**
 * Signs `payload` detached. `chain` is DER certificates, leaf first; a single
 * certificate is encoded as a bare `bstr`, since RFC 9360 only allows the
 * array form for two or more.
 */
export function sign1({ payload, privateKey, chain, alg = -8 }) {
  const algorithm = ALGORITHMS.get(alg);
  if (!algorithm) throw new CoseError(`unsupported COSE algorithm ${alg}`);
  const certs = chain.map((der) => new Uint8Array(der));
  const protectedBytes = encode(new Map([
    [HEADER.alg, alg],
    [HEADER.x5chain, certs.length === 1 ? certs[0] : certs],
  ]));
  const signature = sign(algorithm.digest, sigStructure(protectedBytes, payload), { key: privateKey, ...algorithm.options });
  return encode(new Tagged(18, [new Uint8Array(protectedBytes), new Map(), null, new Uint8Array(signature)]));
}

/**
 * Parses a `COSE_Sign1_Tagged` and verifies it over the detached `payload`
 * against the leaf certificate it carries.
 *
 * Returns `{ alg, algName, chain, valid }`; malformed input throws `CoseError`.
 * `valid` only says the signature matches the leaf's key. Whether that key
 * belongs to anyone worth believing is the trust decision in `x509.mjs`.
 */
export function verify1(bytes, payload) {
  let item;
  try {
    item = decode(bytes);
  } catch (error) {
    if (error instanceof CborError) throw new CoseError(`signature is not CBOR: ${error.message}`);
    throw error;
  }
  if (!(item instanceof Tagged) || item.tag !== 18) throw new CoseError('not a COSE_Sign1_Tagged item');
  const [protectedBytes, , embeddedPayload, signature] = item.value;
  if (!(protectedBytes instanceof Uint8Array) || !(signature instanceof Uint8Array)) {
    throw new CoseError('malformed COSE_Sign1 structure');
  }
  if (embeddedPayload !== null) throw new CoseError('a C2PA claim signature must have a detached payload');

  const header = protectedBytes.length ? decode(protectedBytes) : new Map();
  const get = (label) => (header instanceof Map ? header.get(label) : undefined);
  const alg = get(HEADER.alg);
  const x5chain = get(HEADER.x5chain);
  if (x5chain === undefined) throw new CoseError('x5chain is missing from the protected header');
  const chain = (Array.isArray(x5chain) ? x5chain : [x5chain]).map((der) => Buffer.from(der));
  const algorithm = ALGORITHMS.get(alg);
  if (!algorithm) return { alg, algName: algorithmName(alg), chain, valid: false, unsupported: true };

  let leaf;
  try {
    leaf = new X509Certificate(chain[0]);
  } catch (error) {
    throw new CoseError(`signing certificate does not parse: ${error.message}`);
  }
  let valid;
  try {
    valid = verify(algorithm.digest, sigStructure(protectedBytes, payload), { key: leaf.publicKey, ...algorithm.options }, signature);
  } catch {
    valid = false;
  }
  return { alg, algName: algorithm.name, chain, valid };
}
