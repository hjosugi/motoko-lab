// A minimal C2PA manifest writer and validator for PNG.
//
// Scope, stated exactly (protocol/C2PA_BRIDGE.md has the long form):
//
//   * One asset format: PNG, with the manifest store in a `caBX` chunk placed
//     directly after `IHDR`.
//   * One manifest per store, a standard manifest with a v2 claim
//     (`c2pa.claim.v2`), CBOR assertions, a `c2pa.hash.data` hard binding and a
//     COSE_Sign1 claim signature with the chain in `x5chain`.
//   * Not implemented: ingredients and update manifests, redaction, JSON-LD
//     assertions, remote manifests, RFC 3161 timestamps, OCSP, BMFF and every
//     other container. A store with more than one manifest is read (the active
//     manifest is the last one) but only the active manifest is validated.
//
// Everything written here is read back by c2patool 0.27.22 as a valid
// manifest, and everything c2patool writes into a PNG is validated here:
// protocol/tools/c2pa-crosscheck.mjs checks both directions.

import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';

import { decode, encode } from './cbor.mjs';
import { sign1, verify1 } from './cose.mjs';
import { box, child, parseBoxes, parseSuperbox, superbox, UUID } from './jumbf.mjs';
import { evaluateChain, spkiSha256 } from './x509.mjs';

export class C2paError extends Error {
  constructor(message) {
    super(message);
    this.name = 'C2paError';
  }
}

export const MANIFEST_CHUNK = 'caBX';
export const CLAIM_LABEL = 'c2pa.claim.v2';
export const HASH_DATA_LABEL = 'c2pa.hash.data';
export const ACTIONS_LABEL = 'c2pa.actions.v2';

const sha256 = (...parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

// ----------------------------------------------------------------------- PNG

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, crc]);
}

/// Every chunk with its byte range. A bad CRC is an error: a verifier that
/// skipped corrupt chunks could be steered into reading a different store.
export function pngChunks(bytes) {
  const data = Buffer.from(bytes);
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new C2paError('not a PNG file');
  const chunks = [];
  let offset = 8;
  while (offset < data.length) {
    if (offset + 12 > data.length) throw new C2paError('truncated PNG chunk');
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > data.length) throw new C2paError(`PNG chunk ${type} overruns the file`);
    const expected = data.readUInt32BE(end - 4);
    if (crc32(data.subarray(offset + 4, end - 4)) !== expected) throw new C2paError(`PNG chunk ${type} has a bad CRC`);
    chunks.push({ type, start: offset, end, data: data.subarray(offset + 8, end - 4) });
    offset = end;
    if (type === 'IEND') break;
  }
  if (chunks[0]?.type !== 'IHDR') throw new C2paError('PNG does not start with IHDR');
  if (offset !== data.length) throw new C2paError('bytes after IEND');
  return chunks;
}

// ------------------------------------------------------------------- writing

const assertionUrl = (label) => `self#jumbf=c2pa.assertions/${label}`;

function assertionBox(label, data, salt) {
  return superbox({ uuid: UUID.cbor, label, salt }, [box('cbor', encode(data))]);
}

/**
 * Embeds a signed manifest in `png` and returns the new file.
 *
 * `assertions` are `{ label, data, created = true }`; the data-hash hard
 * binding is added here, since only this function knows where the store will
 * sit. `created` assertions are attributed to the signer, `gathered` ones are
 * not (C2PA 2.x claim v2). `instanceId`, `manifestId` and `salts` exist so the
 * published example can be rebuilt byte for byte; leave them out otherwise.
 */
export function signPng({ png, assertions, signer, claimGenerator, title, instanceId, manifestId, salts }) {
  const chunks = pngChunks(png);
  if (chunks.some((chunk) => chunk.type === MANIFEST_CHUNK)) {
    throw new C2paError('the PNG already carries a manifest store; ingredients/update manifests are not implemented');
  }
  const original = Buffer.from(png);
  const insertAt = chunks[0].end; // directly after IHDR
  // The store is excluded from the hard binding, and inserting it is the only
  // change, so the bytes the binding covers are exactly the original file.
  const dataHash = sha256(original);
  const manifestLabel = `urn:c2pa:${manifestId ?? randomUUID()}`;
  const iid = `xmp:iid:${instanceId ?? randomUUID()}`;
  const saltFor = (label) => (salts ? salts[label] : randomBytes(16));

  const build = (exclusionLength) => {
    const hashData = {
      exclusions: [{ start: insertAt, length: exclusionLength }],
      name: 'jumbf manifest',
      alg: 'sha256',
      hash: new Uint8Array(dataHash),
      pad: new Uint8Array(0),
    };
    const all = [...assertions, { label: HASH_DATA_LABEL, data: hashData, created: true }];
    const boxes = all.map((assertion) => ({
      ...assertion,
      box: assertionBox(assertion.label, assertion.data, saltFor(assertion.label)),
    }));
    const hashed = (entry) => ({ url: assertionUrl(entry.label), hash: new Uint8Array(sha256(entry.box.subarray(8))) });
    // The hard binding first among created assertions, as c2patool orders it.
    const created = [...boxes.filter((b) => b.label === HASH_DATA_LABEL), ...boxes.filter((b) => b.created !== false && b.label !== HASH_DATA_LABEL)];
    const gathered = boxes.filter((b) => b.created === false);
    const claim = encode({
      instanceID: iid,
      claim_generator_info: claimGenerator,
      signature: `self#jumbf=/c2pa/${manifestLabel}/c2pa.signature`,
      created_assertions: created.map(hashed),
      gathered_assertions: gathered.length ? gathered.map(hashed) : undefined,
      'dc:title': title,
      alg: 'sha256',
    });
    const signature = sign1({ payload: claim, privateKey: signer.privateKey, chain: signer.chain, alg: signer.alg ?? -8 });
    const store = superbox({ uuid: UUID.manifestStore, label: 'c2pa' }, [
      superbox({ uuid: UUID.manifest, label: manifestLabel }, [
        superbox({ uuid: UUID.assertionStore, label: 'c2pa.assertions' }, boxes.map((b) => b.box)),
        superbox({ uuid: UUID.claim, label: CLAIM_LABEL }, [box('cbor', claim)]),
        superbox({ uuid: UUID.signature, label: 'c2pa.signature' }, [box('cbor', signature)]),
      ]),
    ]);
    return store;
  };

  // The exclusion length is inside the store it measures. Its CBOR width can
  // only grow with the value, so this reaches a fixed point in a few rounds.
  let length = 0;
  let store;
  for (let round = 0; round < 8; round++) {
    store = build(length);
    const needed = store.length + 12;
    if (needed === length) break;
    length = needed;
  }
  if (store.length + 12 !== length) throw new C2paError('manifest size did not converge');

  const signed = Buffer.concat([original.subarray(0, insertAt), pngChunk(MANIFEST_CHUNK, store), original.subarray(insertAt)]);
  return { png: signed, manifestLabel, dataHash: dataHash.toString('hex') };
}

/// The PNG with its manifest store removed: the bytes a hard binding covers,
/// and the bytes an asset registered before it was signed hashes to.
export function stripManifest(png) {
  const data = Buffer.from(png);
  const parts = [data.subarray(0, 8)];
  for (const chunk of pngChunks(data)) {
    if (chunk.type !== MANIFEST_CHUNK) parts.push(data.subarray(chunk.start, chunk.end));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- validation

function contentOf(node) {
  const content = node.children.find((c) => c.type !== 'jumb');
  if (!content) return { type: null, value: null };
  if (content.type === 'cbor') return { type: 'cbor', value: decode(content.payload) };
  if (content.type === 'json') return { type: 'json', value: JSON.parse(Buffer.from(content.payload).toString('utf8')) };
  return { type: content.type, value: content.payload };
}

/// Resolves a hashed-URI `url` to an assertion node of `manifest`. Relative
/// (`self#jumbf=c2pa.assertions/x`) and absolute (`self#jumbf=/c2pa/<m>/c2pa.assertions/x`)
/// forms are both used in the wild; an absolute URL naming another manifest is
/// not followed, because that manifest is not the one being validated.
function resolveAssertion(url, manifest, assertionStore) {
  const match = /^self#jumbf=(.*)$/.exec(url);
  if (!match) return null;
  let path = match[1];
  const absolute = `/c2pa/${manifest.description.label}/`;
  if (path.startsWith('/')) {
    if (!path.startsWith(absolute)) return null;
    path = path.slice(absolute.length);
  }
  const [store, label, ...rest] = path.split('/');
  if (store !== 'c2pa.assertions' || !label || rest.length) return null;
  return child(assertionStore, label) ?? null;
}

const status = (code, explanation, url) => ({ code, ...(url ? { url } : {}), explanation });

/**
 * Reads and validates the manifest store of a PNG.
 *
 * Only assertions the claim references *and* whose hashes match are returned
 * in `assertions`: an assertion that sits in the store without being signed is
 * something anyone could have added, and reading it would let them speak with
 * the signer's voice.
 *
 * `trustAnchors` is a list of DER certificates. Without one, `trusted` is
 * `null` — the signer's identity was not evaluated, which is not the same as
 * it being bad or good.
 */
export function validatePng(png, { trustAnchors = null, at = new Date() } = {}) {
  const chunks = pngChunks(png);
  const stores = chunks.filter((chunk) => chunk.type === MANIFEST_CHUNK);
  const result = {
    present: stores.length > 0,
    valid: false,
    manifest: null,
    status: [],
    assertions: new Map(),
    signer: null,
    dataHash: null,
  };
  if (!stores.length) return result;
  if (stores.length > 1) {
    result.status.push(status('claim.malformed', 'more than one manifest store chunk'));
    return result;
  }

  let manifest;
  try {
    const [top] = parseBoxes(stores[0].data);
    if (top?.type !== 'jumb') throw new C2paError('the manifest store is not a JUMBF superbox');
    const storeNode = parseSuperbox(top.payload);
    if (!storeNode.description.uuid.equals(UUID.manifestStore)) throw new C2paError('not a C2PA manifest store');
    const manifests = storeNode.children.filter((c) => c.type === 'jumb' && c.description.uuid.equals(UUID.manifest));
    manifest = manifests[manifests.length - 1];
    if (!manifest) throw new C2paError('the manifest store holds no manifest');
  } catch (error) {
    result.status.push(status('claim.malformed', error.message));
    return result;
  }
  result.manifest = manifest.description.label;

  const claimNode = child(manifest, CLAIM_LABEL) ?? child(manifest, 'c2pa.claim');
  const signatureNode = child(manifest, 'c2pa.signature');
  const assertionStore = child(manifest, 'c2pa.assertions');
  if (!claimNode) {
    result.status.push(status('claim.missing', 'the active manifest has no claim'));
    return result;
  }
  if (!signatureNode || !assertionStore) {
    result.status.push(status('claimSignature.missing', 'the active manifest has no claim signature'));
    return result;
  }
  const claimBytes = claimNode.children.find((c) => c.type === 'cbor')?.payload;
  let claim;
  try {
    claim = decode(claimBytes);
  } catch (error) {
    result.status.push(status('claim.malformed', `claim is not CBOR: ${error.message}`));
    return result;
  }
  result.claim = claim;

  // ---- signature
  let signatureValid = false;
  const expectedSignatureUrl = `self#jumbf=/c2pa/${manifest.description.label}/c2pa.signature`;
  if (claim.signature !== expectedSignatureUrl && claim.signature !== 'self#jumbf=c2pa.signature') {
    result.status.push(status('claimSignature.missing', `claim references ${claim.signature}, not this manifest's signature`));
  } else {
    try {
      const cose = verify1(signatureNode.children.find((c) => c.type === 'cbor').payload, claimBytes);
      signatureValid = cose.valid;
      const leaf = new X509Certificate(cose.chain[0]);
      const chain = evaluateChain(cose.chain, trustAnchors, at);
      result.signer = {
        subject: leaf.subject.replace(/\n/g, ', '),
        issuer: leaf.issuer.replace(/\n/g, ', '),
        serialNumber: leaf.serialNumber,
        algorithm: cose.algName,
        spkiSha256: spkiSha256(leaf.publicKey),
        trusted: chain.trusted,
        profile: chain.profile,
        reasons: chain.reasons,
      };
      result.status.push(signatureValid
        ? status('claimSignature.validated', `claim signature verified (${cose.algName})`)
        : status('claimSignature.mismatch', 'the claim signature does not verify against the signing certificate'));
      if (!chain.profile) {
        result.status.push(status('signingCredential.invalid', chain.reasons.join('; ')));
      } else if (chain.trusted === true) {
        result.status.push(status('signingCredential.trusted', 'the signer chains to a configured trust anchor'));
      } else if (chain.trusted === false) {
        result.status.push(status('signingCredential.untrusted', chain.reasons.join('; ')));
      }
    } catch (error) {
      result.status.push(status('claimSignature.mismatch', error.message));
    }
  }

  // ---- assertions referenced by the claim
  let assertionsValid = true;
  const references = [...(claim.created_assertions ?? claim.assertions ?? []), ...(claim.gathered_assertions ?? [])];
  const createdUrls = new Set((claim.created_assertions ?? claim.assertions ?? []).map((ref) => ref.url));
  for (const ref of references) {
    const node = resolveAssertion(ref.url, manifest, assertionStore);
    if (!node) {
      assertionsValid = false;
      result.status.push(status('assertion.missing', 'the claim references an assertion that is not in the store', ref.url));
      continue;
    }
    const alg = ref.alg ?? claim.alg ?? 'sha256';
    if (alg !== 'sha256') {
      assertionsValid = false;
      result.status.push(status('algorithm.unsupported', `hash algorithm ${alg} is not implemented`, ref.url));
      continue;
    }
    if (!Buffer.from(ref.hash ?? []).equals(sha256(node.payload))) {
      assertionsValid = false;
      result.status.push(status('assertion.hashedURI.mismatch', 'assertion bytes do not match the hash the claim signed', ref.url));
      continue;
    }
    result.status.push(status('assertion.hashedURI.match', 'assertion hash matches', ref.url));
    try {
      const content = contentOf(node);
      result.assertions.set(node.description.label, { ...content, created: createdUrls.has(ref.url) });
    } catch (error) {
      assertionsValid = false;
      result.status.push(status('assertion.cbor.invalid', error.message, ref.url));
    }
  }

  // ---- hard binding
  let bindingValid = false;
  const binding = result.assertions.get(HASH_DATA_LABEL);
  if (!binding?.created) {
    result.status.push(status('claim.hardBindings.missing', 'no c2pa.hash.data among the created assertions'));
  } else {
    const hashData = binding.value;
    const store = stores[0];
    const exclusions = hashData.exclusions ?? [];
    // The exclusions must remove the manifest store and nothing else. Anything
    // more would leave part of the image outside the signature: excluding IDAT
    // would let every pixel change under a valid credential.
    const exact = exclusions.length === 1 && exclusions[0].start === store.start && exclusions[0].length === store.end - store.start;
    const data = Buffer.from(png);
    const computed = sha256(data.subarray(0, store.start), data.subarray(store.end));
    result.dataHash = {
      computed: computed.toString('hex'),
      declared: Buffer.from(hashData.hash ?? []).toString('hex'),
      exclusions,
    };
    if (!exact) {
      result.status.push(status('assertion.dataHash.mismatch', 'the exclusions do not cover exactly the manifest store'));
    } else if (hashData.alg && hashData.alg !== 'sha256') {
      result.status.push(status('algorithm.unsupported', `data hash algorithm ${hashData.alg} is not implemented`));
    } else if (!computed.equals(Buffer.from(hashData.hash ?? []))) {
      result.status.push(status('assertion.dataHash.mismatch', 'the asset bytes do not match the signed hash: the asset was modified'));
    } else {
      bindingValid = true;
      result.status.push(status('assertion.dataHash.match', 'the asset bytes match the signed hash'));
    }
  }

  result.valid = signatureValid && assertionsValid && bindingValid && result.signer?.profile === true;
  return result;
}
