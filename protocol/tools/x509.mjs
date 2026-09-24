// X.509 for the C2PA bridge: issuing test signing certificates, and checking a
// signer's chain against a trust list.
//
// C2PA signs with an X.509 certificate, and a verifier refuses a self-signed
// one, so even a test signer needs a CA. Node can parse and verify
// certificates (`X509Certificate`) but cannot issue them, and pulling in an
// ASN.1 library to write perhaps forty lines of DER would put a dependency on
// the path CI runs offline. `issue` writes exactly the profile C2PA asks a
// claim-signing certificate to have: v3, a serial, an Ed25519 key,
// basicConstraints, keyUsage and extendedKeyUsage, and key identifiers.
//
// These certificates are for tests and for the published example. A real
// credential is signed with a certificate from a CA on the C2PA trust list;
// nothing here makes a certificate trusted, only well-formed.

import { createHash, createPrivateKey, createPublicKey, sign, X509Certificate } from 'node:crypto';

export class X509Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'X509Error';
  }
}

// ----------------------------------------------------------------------- DER

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, ...contents) => {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const sequence = (...items) => tlv(0x30, ...items);
const set = (...items) => tlv(0x31, ...items);
const explicit = (n, item) => tlv(0xa0 | n, item);

function oid(dotted) {
  const arcs = dotted.split('.').map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const base128 = [];
    let n = arc;
    do {
      base128.unshift(n & 0x7f);
      n = Math.floor(n / 128);
    } while (n > 0);
    for (let i = 0; i < base128.length - 1; i++) base128[i] |= 0x80;
    out.push(...base128);
  }
  return tlv(0x06, Buffer.from(out));
}

function integer(bytes) {
  // Unsigned big-endian magnitude: strip leading zeros, then keep the sign bit clear.
  let value = Buffer.from(bytes);
  while (value.length > 1 && value[0] === 0 && !(value[1] & 0x80)) value = value.subarray(1);
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return tlv(0x02, value);
}

const utf8String = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
const printableString = (text) => tlv(0x13, Buffer.from(text, 'ascii'));
const octetString = (bytes) => tlv(0x04, bytes);
const bitString = (bytes, unusedBits = 0) => tlv(0x03, Buffer.from([unusedBits]), bytes);
const boolean = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));

function time(date) {
  // RFC 5280 4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050.
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${iso}Z`, 'ascii'));
}

const NAME_OIDS = { C: '2.5.4.6', O: '2.5.4.10', OU: '2.5.4.11', CN: '2.5.4.3' };

function name(attributes) {
  return sequence(
    ...Object.entries(attributes).map(([key, value]) =>
      set(sequence(oid(NAME_OIDS[key]), key === 'C' ? printableString(value) : utf8String(value))),
    ),
  );
}

// ------------------------------------------------------------ profile + keys

export const OID = Object.freeze({
  ed25519: '1.3.101.112',
  emailProtection: '1.3.6.1.5.5.7.3.4',
  documentSigning: '1.3.6.1.5.5.7.3.36',
  c2paClaimSigning: '1.3.6.1.4.1.62558.2.1',
});

/// The extended key usages a C2PA claim-signing certificate may carry. A
/// certificate with none of them is not a signing credential for this purpose.
export const CLAIM_SIGNING_EKUS = Object.freeze([OID.c2paClaimSigning, OID.documentSigning, OID.emailProtection]);

/**
 * An Ed25519 key pair from a 32-byte seed. Deterministic on purpose: the
 * published example credential is rebuilt byte for byte by the test suite,
 * which is only possible if its key is too. The seeds used in this repository
 * are derived from public strings and are test keys, not secrets.
 */
export function ed25519FromSeed(seed) {
  if (seed.length !== 32) throw new X509Error('an Ed25519 seed is 32 bytes');
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

export const testSeed = (label) => createHash('sha256').update(`motoko-lab test key, not a secret: ${label}`).digest();

/// SHA-256 of the DER SubjectPublicKeyInfo: how a manifest names a signer's key
/// independently of any one certificate issued for it.
export const spkiSha256 = (publicKey) =>
  createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

const keyIdentifier = (publicKey) => {
  // RFC 5280 4.2.1.2 method 1: SHA-1 of the subjectPublicKey BIT STRING contents.
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha1').update(spki.subarray(spki.length - 32)).digest();
};

function extension(id, critical, value) {
  return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

/**
 * Issues a certificate. `issuer` is `{ name, privateKey, publicKey }` of the
 * signing CA; a root passes its own name and keys. `ca` selects the CA profile
 * (keyCertSign) rather than the claim-signing one (digitalSignature + EKU).
 */
export function issue({ subject, publicKey, issuer, ca = false, serial, notBefore, notAfter, ekus = [OID.documentSigning] }) {
  const selfSigned = issuer.publicKey.export({ type: 'spki', format: 'der' })
    .equals(publicKey.export({ type: 'spki', format: 'der' }));
  if (selfSigned && !ca) throw new X509Error('only a CA certificate may be self-signed');
  const extensions = [
    extension('2.5.29.19', true, ca ? sequence(boolean(true)) : sequence()),
    // keyUsage: bit 0 digitalSignature for a signer; bits 5, 6 keyCertSign and
    // cRLSign for a CA. A BIT STRING names its unused trailing bits.
    extension('2.5.29.15', true, ca ? bitString(Buffer.from([0x06]), 1) : bitString(Buffer.from([0x80]), 7)),
    extension('2.5.29.14', false, octetString(keyIdentifier(publicKey))),
    extension('2.5.29.35', false, sequence(tlv(0x80, keyIdentifier(issuer.publicKey)))),
  ];
  if (!ca) extensions.push(extension('2.5.29.37', false, sequence(...ekus.map(oid))));

  const algorithm = sequence(oid(OID.ed25519));
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name(issuer.name),
    sequence(time(notBefore), time(notAfter)),
    name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, sequence(...extensions)),
  );
  return sequence(tbs, algorithm, bitString(sign(null, tbs, issuer.privateKey)));
}

/**
 * The fixed test PKI the example credential and the suite use: a root CA and a
 * claim-signing certificate it issued, both Ed25519 from public seeds, valid
 * 2026-01-01 through 2035-12-31.
 */
export function testPki({ signerLabel = 'c2pa signer', ekus } = {}) {
  const rootKeys = ed25519FromSeed(testSeed('c2pa root ca'));
  const signerKeys = ed25519FromSeed(testSeed(signerLabel));
  const notBefore = new Date('2026-01-01T00:00:00Z');
  const notAfter = new Date('2035-12-31T23:59:59Z');
  const rootName = { C: 'JP', O: 'motoko-lab test PKI', OU: 'FOR TESTING ONLY', CN: 'motoko-lab Test Root CA' };
  const root = issue({
    subject: rootName,
    publicKey: rootKeys.publicKey,
    issuer: { name: rootName, ...rootKeys },
    ca: true,
    serial: Buffer.from([1]),
    notBefore,
    notAfter,
  });
  const signer = issue({
    subject: { C: 'JP', O: 'motoko-lab test PKI', OU: 'FOR TESTING ONLY', CN: `motoko-lab ${signerLabel}` },
    publicKey: signerKeys.publicKey,
    issuer: { name: rootName, ...rootKeys },
    serial: createHash('sha256').update(signerLabel).digest().subarray(0, 16),
    notBefore,
    notAfter,
    ekus,
  });
  return { root, rootKeys, signer, signerKeys };
}

// ---------------------------------------------------------------- validation

/**
 * Checks a signer chain (leaf first, as COSE `x5chain` carries it) against a
 * list of trust anchors at time `at`.
 *
 * Returns `{ trusted, reasons }`. `trusted` is `null` when no trust list was
 * supplied: that is "not evaluated", which a report must not render as either
 * success or failure. The leaf's profile is checked whether or not a trust
 * list is given, because a certificate that could never be a claim-signing
 * credential is wrong regardless of who issued it.
 */
export function evaluateChain(chainDer, anchorsDer, at) {
  const reasons = [];
  let chain;
  try {
    chain = chainDer.map((der) => new X509Certificate(Buffer.from(der)));
  } catch (error) {
    return { trusted: false, profile: false, reasons: [`certificate does not parse: ${error.message}`] };
  }
  const [leaf] = chain;
  let profile = true;
  if (leaf.ca) {
    profile = false;
    reasons.push('the signing certificate is a CA certificate');
  }
  // Node's `keyUsage` is the *extended* key usage list. The basic keyUsage
  // bits (digitalSignature) are not exposed, so they are issued correctly here
  // and checked by c2patool in protocol/tools/c2pa-crosscheck.mjs.
  const ekus = leaf.keyUsage ?? [];
  if (!ekus.some((usage) => CLAIM_SIGNING_EKUS.includes(usage))) {
    profile = false;
    reasons.push('the signing certificate has no C2PA claim-signing extended key usage');
  }
  if (leaf.checkIssued(leaf) && leaf.verify(leaf.publicKey)) {
    profile = false;
    reasons.push('the signing certificate is self-signed');
  }
  for (const cert of chain) {
    if (at < new Date(cert.validFrom) || at > new Date(cert.validTo)) {
      profile = false;
      reasons.push(`certificate "${cert.subject.replace(/\n/g, ', ')}" is outside its validity period`);
    }
  }
  for (let i = 0; i + 1 < chain.length; i++) {
    if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) {
      profile = false;
      reasons.push(`x5chain entry ${i} is not issued by entry ${i + 1}`);
    }
  }

  if (!anchorsDer) return { trusted: null, profile, reasons };

  const anchors = anchorsDer.map((der) => new X509Certificate(Buffer.from(der)));
  const top = chain[chain.length - 1];
  const anchored = anchors.some(
    (anchor) => anchor.fingerprint256 === top.fingerprint256 || (top.checkIssued(anchor) && top.verify(anchor.publicKey)),
  );
  if (!anchored) reasons.push('the chain does not end at a trust anchor');
  return { trusted: anchored && profile, profile, reasons };
}

export const pem = (der) =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
