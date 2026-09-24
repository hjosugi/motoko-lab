// Merkle tree v1 (`icp-merkle:v1`): the tree rules behind a batch anchored in
// `apps/02_merkle_anchor`.
//
// The anchor stores a root and a leaf count. Until this module existed nothing
// said how that root was built, so a root was verifiable only by whoever built
// it, with whatever rules they happened to use. The rules are now fixed:
//
//   leaf value  = 32OCTET                                   ; a SHA-256 digest
//   leaf hash   = SHA-256( %x00 || "icp-merkle:v1" || leaf value )
//   node hash   = SHA-256( %x01 || left || right )
//   tree shape  = RFC 9162 section 2.1.1: the left subtree of n leaves holds
//                 k leaves, k the largest power of two smaller than n
//
// Put differently: an RFC 9162 Merkle Tree Hash with SHA-256, whose entries are
// `"icp-merkle:v1" || leaf value`. Inclusion proofs are RFC 9162 audit paths,
// so this module is also checked against the transparency-dev/merkle probes
// that Certificate Transparency implementations are tested with.
//
// Why each rule, and the rules for multiproofs, are in protocol/MERKLE_V1.md.
// The short version:
//
// * %x00 / %x01 separate leaves from interior nodes, so an interior node can
//   never be presented as a leaf (the second-preimage attack on unprefixed
//   trees). Their preimages also differ in length: 46 bytes versus 65.
// * The domain string versions the leaf encoding. A v2 tree hashes every leaf
//   differently, so no v1 root can be reinterpreted under v2 rules.
// * Odd nodes are never duplicated. Bitcoin's "duplicate the last node" rule
//   makes [a, b, c] and [a, b, c, c] share a root (CVE-2012-2459). Under the
//   RFC 9162 split the right subtree is simply smaller.
// * Pairs are ordered by position, never sorted. A proof therefore binds the
//   leaf's index and the tree size, and for a given (index, size) there is
//   exactly one valid proof length and one valid proof.

import { createHash } from "node:crypto";

export class MerkleError extends Error {
  constructor(message) {
    super(message);
    this.name = "MerkleError";
  }
}

export const TREE_VERSION = "icp-merkle:v1";
export const HASH_ALGORITHM = "sha256";
export const LEAF_DOMAIN = TREE_VERSION;
export const LEAF_PREFIX = 0x00;
export const NODE_PREFIX = 0x01;
export const DIGEST_BYTES = 32;
export const SHAPE = "rfc9162";
/** The anchor's `leafCount` cap. A proof in a tree this size has 20 hashes. */
export const MAX_LEAF_COUNT = 1_000_000;
/** How many leaves one multiproof may prove on-chain. See MERKLE_V1.md. */
export const MAX_MULTIPROOF_LEAVES = 256;

const LEAF_DOMAIN_BYTES = Buffer.from(LEAF_DOMAIN, "ascii");
const LEAF_TAG = Buffer.from([LEAF_PREFIX]);
const NODE_TAG = Buffer.from([NODE_PREFIX]);

/** What the canister's `merkleSpec()` returns, field for field. */
export function spec() {
  return {
    treeVersion: TREE_VERSION,
    hashAlgorithm: HASH_ALGORITHM,
    leafDomain: LEAF_DOMAIN,
    leafPrefix: LEAF_PREFIX,
    nodePrefix: NODE_PREFIX,
    digestSize: DIGEST_BYTES,
    shape: SHAPE,
    maxLeafCount: MAX_LEAF_COUNT,
    maxMultiproofLeaves: MAX_MULTIPROOF_LEAVES,
  };
}

const sha256 = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

function bytes(field, value, exact = DIGEST_BYTES) {
  let buffer;
  if (typeof value === "string") {
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) {
      throw new MerkleError(`${field} must be hexadecimal with an even number of characters`);
    }
    buffer = Buffer.from(value, "hex");
  } else if (value instanceof Uint8Array) {
    buffer = Buffer.from(value);
  } else {
    throw new MerkleError(`${field} must be bytes or a hexadecimal string`);
  }
  if (buffer.length !== exact) {
    throw new MerkleError(`${field} must be exactly ${exact} bytes, got ${buffer.length}`);
  }
  return buffer;
}

function size(field, value, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new MerkleError(`${field} must be an integer in ${min}..${max}, got ${value}`);
  }
  return value;
}

// ------------------------------------------------------------ the RFC 9162 core
//
// Everything in this section is generic over leaf *hashes*. It is what the
// transparency-dev probes exercise, and it knows nothing about the domain.

/** RFC 9162 section 2.1.1: the leaf hash of arbitrary entry bytes. */
export function hashLeafData(data) {
  return sha256(LEAF_TAG, Buffer.from(data));
}

export function hashChildren(left, right) {
  return sha256(NODE_TAG, bytes("left child", left), bytes("right child", right));
}

/** The largest power of two strictly smaller than `n`, for n >= 2. */
export function splitPoint(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** RFC 9162 MTH(D[n]) over leaf hashes. */
export function rootFromLeafHashes(leafHashes) {
  if (leafHashes.length === 0) {
    throw new MerkleError("a tree must have at least one leaf");
  }
  const level = leafHashes.map((hash, index) => bytes(`leaf hash ${index}`, hash));
  const mth = (lo, hi) => {
    if (hi - lo === 1) return level[lo];
    const mid = lo + splitPoint(hi - lo);
    return hashChildren(mth(lo, mid), mth(mid, hi));
  };
  return mth(0, level.length);
}

/**
 * The number of hashes in the audit path of `index` in a tree of `size`.
 *
 * Fixed by (index, size) alone, which is what lets a verifier refuse a proof of
 * the wrong length before hashing anything. `inner` counts the levels where the
 * path of `index` and the path of the last leaf `size - 1` are still in
 * different subtrees; `border` counts the right-edge levels above them where the
 * leaf's subtree has a left sibling.
 */
export function pathLength(index, treeSize) {
  size("tree size", treeSize, { min: 1, max: Number.MAX_SAFE_INTEGER });
  size("leaf index", index, { min: 0, max: treeSize - 1 });
  // BigInt, because `^` on a JavaScript number truncates to 32 bits.
  const inner = bitLength(BigInt(index) ^ BigInt(treeSize - 1));
  const border = popCount(BigInt(index) >> BigInt(inner));
  return inner + border;
}

function bitLength(n) {
  let bits = 0;
  for (; n > 0n; n >>= 1n) bits += 1;
  return bits;
}

function popCount(n) {
  let count = 0;
  for (; n > 0n; n >>= 1n) count += Number(n & 1n);
  return count;
}

/** RFC 9162 section 2.1.3.1: PATH(m, D[n]), bottom-up. */
export function inclusionPath(leafHashes, index) {
  size("leaf index", index, { min: 0, max: leafHashes.length - 1 });
  const hashes = leafHashes.map((hash, i) => bytes(`leaf hash ${i}`, hash));
  const mth = (lo, hi) => {
    if (hi - lo === 1) return hashes[lo];
    const mid = lo + splitPoint(hi - lo);
    return hashChildren(mth(lo, mid), mth(mid, hi));
  };
  const path = (m, lo, hi) => {
    if (hi - lo === 1) return [];
    const mid = lo + splitPoint(hi - lo);
    return m < mid
      ? [...path(m, lo, mid), mth(mid, hi)]
      : [...path(m, mid, hi), mth(lo, mid)];
  };
  return path(index, 0, hashes.length);
}

/**
 * RFC 9162 section 2.1.3.2: the root an audit path reconstructs.
 *
 * Throws `MerkleError` for input that cannot be a proof at all — a wrong-sized
 * hash, an index outside the tree, or a path whose length is not the one
 * (index, size) requires. A well-formed proof that simply belongs to another
 * tree returns that other tree's root, and the caller compares.
 */
export function rootFromInclusionPath({ index, treeSize, leafHash, path }) {
  size("tree size", treeSize, { min: 1, max: Number.MAX_SAFE_INTEGER });
  size("leaf index", index, { min: 0, max: treeSize - 1 });
  let hash = bytes("leaf hash", leafHash);
  const siblings = path.map((sibling, i) => bytes(`path[${i}]`, sibling));
  const expected = pathLength(index, treeSize);
  if (siblings.length !== expected) {
    throw new MerkleError(
      `a proof for leaf ${index} of ${treeSize} has exactly ${expected} hashes, got ${siblings.length}`,
    );
  }

  let fn = index;
  let sn = treeSize - 1;
  for (const sibling of siblings) {
    if (sn === 0) throw new MerkleError("the proof continues past the root");
    if (fn % 2 === 1 || fn === sn) {
      hash = hashChildren(sibling, hash);
      // Climb past the levels where this node is the right edge and has no
      // sibling: its hash is carried up unchanged.
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      hash = hashChildren(hash, sibling);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  // `pathLength` already guarantees this; kept because it is the termination
  // condition RFC 9162 states, and a verifier that skipped the length check
  // would rely on it.
  if (sn !== 0) throw new MerkleError("the proof ended below the root");
  return hash;
}

export function verifyInclusionHashes({ index, treeSize, leafHash, path, root }) {
  const expected = bytes("root", root);
  return rootFromInclusionPath({ index, treeSize, leafHash, path }).equals(expected);
}

// ---------------------------------------------------------------- multiproofs
//
// One proof for several leaves of the same tree. The format is the set of
// subtree hashes a verifier cannot compute from the leaves it was given, in the
// order a left-to-right, depth-first walk of the RFC 9162 shape needs them. For
// a given tree size and set of indices both the count and the order are fixed,
// so there is exactly one valid multiproof, as there is one valid audit path.

function checkIndices(indices, treeSize) {
  if (indices.length === 0) throw new MerkleError("a multiproof must prove at least one leaf");
  if (indices.length > MAX_MULTIPROOF_LEAVES) {
    throw new MerkleError(`a multiproof proves at most ${MAX_MULTIPROOF_LEAVES} leaves, got ${indices.length}`);
  }
  indices.forEach((index, i) => {
    size(`leaf index ${i}`, index, { min: 0, max: treeSize - 1 });
    if (i > 0 && index <= indices[i - 1]) {
      throw new MerkleError("multiproof leaf indices must be strictly increasing");
    }
  });
}

/** Builds the multiproof for `indices` (strictly increasing) from all leaf hashes. */
export function multiproof(leafHashes, indices) {
  const hashes = leafHashes.map((hash, i) => bytes(`leaf hash ${i}`, hash));
  checkIndices(indices, hashes.length);
  const proof = [];
  const mth = (lo, hi) => {
    if (hi - lo === 1) return hashes[lo];
    const mid = lo + splitPoint(hi - lo);
    return hashChildren(mth(lo, mid), mth(mid, hi));
  };
  const walk = (lo, hi, from, to) => {
    if (from === to) {
      proof.push(mth(lo, hi));
      return;
    }
    if (hi - lo === 1) return;
    const mid = lo + splitPoint(hi - lo);
    let split = from;
    while (split < to && indices[split] < mid) split += 1;
    walk(lo, mid, from, split);
    walk(mid, hi, split, to);
  };
  walk(0, hashes.length, 0, indices.length);
  return proof;
}

/**
 * The root a multiproof reconstructs. `leaves` is `[{ index, leafHash }]` in
 * strictly increasing index order; `proof` is consumed exactly — a hash left
 * over is as much an error as one missing, because a proof with room for extra
 * data is a proof with more than one valid encoding.
 */
export function rootFromMultiproof({ treeSize, leaves, proof }) {
  size("tree size", treeSize, { min: 1, max: Number.MAX_SAFE_INTEGER });
  const indices = leaves.map((leaf) => leaf.index);
  checkIndices(indices, treeSize);
  const leafHashes = leaves.map((leaf, i) => bytes(`leaf hash ${i}`, leaf.leafHash));
  const siblings = proof.map((hash, i) => bytes(`proof[${i}]`, hash));
  let next = 0;

  const walk = (lo, hi, from, to) => {
    if (from === to) {
      if (next >= siblings.length) throw new MerkleError("the multiproof has too few hashes");
      return siblings[next++];
    }
    if (hi - lo === 1) return leafHashes[from];
    const mid = lo + splitPoint(hi - lo);
    let split = from;
    while (split < to && indices[split] < mid) split += 1;
    const left = walk(lo, mid, from, split);
    const right = walk(mid, hi, split, to);
    return hashChildren(left, right);
  };

  const root = walk(0, treeSize, 0, indices.length);
  if (next !== siblings.length) throw new MerkleError("the multiproof has unused hashes");
  return root;
}

// ------------------------------------------------------------- the v1 profile
//
// The kit-specific layer: leaves are 32-byte digests, hashed under the domain.

/** SHA-256(0x00 || "icp-merkle:v1" || digest). */
export function leafHash(digest) {
  return hashLeafData(Buffer.concat([LEAF_DOMAIN_BYTES, bytes("leaf", digest)]));
}

/** The exact 46 bytes a leaf hash is taken over. Exposed for the vectors. */
export function leafPreimage(digest) {
  return Buffer.concat([LEAF_TAG, LEAF_DOMAIN_BYTES, bytes("leaf", digest)]);
}

function checkLeaves(leaves) {
  if (leaves.length === 0) throw new MerkleError("a tree must have at least one leaf");
  if (leaves.length > MAX_LEAF_COUNT) {
    throw new MerkleError(`a tree holds at most ${MAX_LEAF_COUNT} leaves, got ${leaves.length}`);
  }
  return leaves.map((leaf, i) => leafHash(bytes(`leaf ${i}`, leaf)));
}

/**
 * A v1 tree over 32-byte leaf digests, with everything a builder needs.
 *
 * Built bottom-up, one level at a time, pairing neighbours and carrying a lone
 * last node up unchanged. That produces exactly the RFC 9162 shape — the
 * recursive split above is the definition, this is the O(n) construction, and
 * the test suite asserts the two agree for every size from 1 to 130 — and it
 * keeps every level, so a proof is read off in O(log n) instead of rehashing
 * the siblings' subtrees for each leaf.
 */
export function buildTree(leaves) {
  const values = leaves.map((leaf, i) => bytes(`leaf ${i}`, leaf));
  const hashes = checkLeaves(values);
  const levels = [hashes];
  while (levels[levels.length - 1].length > 1) {
    const below = levels[levels.length - 1];
    const above = [];
    for (let i = 0; i < below.length; i += 2) {
      above.push(i + 1 < below.length ? hashChildren(below[i], below[i + 1]) : below[i]);
    }
    levels.push(above);
  }
  const path = (index) => {
    size("leaf index", index, { min: 0, max: hashes.length - 1 });
    const siblings = [];
    let position = index;
    for (const level of levels.slice(0, -1)) {
      const sibling = position ^ 1;
      // No sibling means this node is the carried-up right edge: it contributes
      // nothing at this level, exactly as the RFC 9162 verifier expects.
      if (sibling < level.length) siblings.push(level[sibling]);
      position >>= 1;
    }
    return siblings;
  };
  return {
    treeVersion: TREE_VERSION,
    leafCount: hashes.length,
    root: levels[levels.length - 1][0],
    leafHashes: hashes,
    prove: (index) => ({ index, leaf: values[index], path: path(index) }),
    proveMany: (indices) => ({
      leaves: indices.map((index) => ({ index, leaf: values[index] })),
      proof: multiproof(hashes, indices),
    }),
  };
}

export function root(leaves) {
  return rootFromLeafHashes(checkLeaves(leaves));
}

/** Verifies a v1 inclusion proof for a 32-byte leaf digest. */
export function verifyProof({ root: expected, leafCount, index, leaf, path }) {
  size("leaf count", leafCount, { min: 1, max: MAX_LEAF_COUNT });
  const want = bytes("root", expected);
  return rootFromInclusionPath({ index, treeSize: leafCount, leafHash: leafHash(leaf), path }).equals(want);
}

/** Verifies a v1 multiproof; `leaves` is `[{ index, leaf }]`. */
export function verifyMultiproof({ root: expected, leafCount, leaves, proof }) {
  size("leaf count", leafCount, { min: 1, max: MAX_LEAF_COUNT });
  const want = bytes("root", expected);
  const hashed = leaves.map(({ index, leaf }) => ({ index, leafHash: leafHash(leaf) }));
  return rootFromMultiproof({ treeSize: leafCount, leaves: hashed, proof }).equals(want);
}
