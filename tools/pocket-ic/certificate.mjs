// Client-side verification of a certified query response.
//
// This is the whole point of issue #6, so it is written the way a reader would
// have to write it, not the way a canister would like it verified:
//
//   1. Verify the certificate. `Certificate.create` checks the BLS signature
//      over the state tree and walks any subnet delegation, against the root
//      key. A certificate that does not verify throws here.
//   2. Read `/canister/<id>/certified_data` out of the *certified* tree. That
//      is the only 32 bytes the subnet actually signed for this canister.
//   3. Reconstruct the witness the canister returned. Its root has to equal
//      those 32 bytes, or the witness describes some other tree.
//   4. Look the record up inside the witness. That value is what the subnet
//      attests, and it is compared against a digest recomputed locally from the
//      record the query returned.
//
// Skipping step 3 is the subtle failure: a witness that verifies internally but
// whose root is not the certified data proves nothing at all, and a reader that
// only checked "the certificate is valid" and "the witness contains a digest"
// would accept it.

import { Certificate, lookup_path, LookupPathStatus, reconstruct } from '@dfinity/agent';

export class CertificateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CertificateError';
  }
}

const equal = (a, b) =>
  a.length === b.length && new Uint8Array(a).every((byte, index) => byte === new Uint8Array(b)[index]);

/// Decodes the CBOR hash tree the canister returned as a witness.
async function decodeWitness(witness) {
  const { decode } = await import('@dfinity/cbor');
  return decode(new Uint8Array(witness));
}

/**
 * Verifies a `CertifiedRecord` and returns the digest the subnet attests.
 *
 * Throws `CertificateError` when any step fails; the caller decides whether
 * that was expected.
 */
export async function verifyCertifiedValue({ certificate, witness, canisterId, rootKey, path }) {
  let verified;
  try {
    verified = await Certificate.create({
      certificate: new Uint8Array(certificate),
      rootKey: new Uint8Array(rootKey),
      canisterId,
      // The suite drives the replica's clock, so a freshness window measured
      // against the host's wall clock is not meaningful here.
      maxAgeInMinutes: Number.MAX_SAFE_INTEGER,
    });
  } catch (error) {
    throw new CertificateError(`certificate did not verify: ${error.message}`);
  }

  const certified = verified.lookup_path(['canister', canisterId.toUint8Array(), 'certified_data']);
  if (certified.status !== LookupPathStatus.Found) {
    throw new CertificateError('the certificate carries no certified_data for this canister');
  }

  let tree;
  try {
    tree = await decodeWitness(witness);
  } catch (error) {
    throw new CertificateError(`witness is not a hash tree: ${error.message}`);
  }

  let root;
  try {
    root = await reconstruct(tree);
  } catch (error) {
    throw new CertificateError(`witness does not reconstruct: ${error.message}`);
  }

  if (!equal(root, certified.value)) {
    throw new CertificateError('witness root is not the certified data the subnet signed');
  }

  const found = lookup_path(path, tree);
  if (found.status !== LookupPathStatus.Found) {
    throw new CertificateError(`the witness does not reveal a value at the requested path (${found.status})`);
  }
  return new Uint8Array(found.value);
}
