#!/usr/bin/env node
// Generates the icp-merkle:v1 conformance vectors and their Motoko rendering.
//
//   node protocol/tools/merkle-vectors.mjs --write   # regenerate both files
//   node protocol/tools/merkle-vectors.mjs           # fail if either is stale
//
// Two outputs, one source of truth:
//
//   protocol/test-vectors/merkle/vectors.json      what any implementation checks
//   apps/02_merkle_anchor/test/MerkleVectors.mo    the same data as Motoko values
//
// The Motoko file exists because the interpreter cannot read JSON at test time.
// It is generated rather than written by hand so the canister's verifier is run
// over every published vector rather than a hand-picked few, and `--check` (run
// by merkle.test.mjs in the offline checks) is what stops the two drifting.
//
// Leaf values are derived, not random: leaf i is SHA-256("icp-merkle-vector:" i).
// Anyone can regenerate them, and the large tree does not have to be stored.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTree,
  leafHash,
  leafPreimage,
  MerkleError,
  spec,
  verifyMultiproof,
  verifyProof,
} from "./merkle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
export const VECTORS_PATH = resolve(repoRoot, "protocol/test-vectors/merkle/vectors.json");
export const PROBES_PATH = resolve(repoRoot, "protocol/test-vectors/merkle/rfc9162-inclusion.json");
export const MOTOKO_PATH = resolve(repoRoot, "apps/02_merkle_anchor/test/MerkleVectors.mo");

export const LEAF_RULE = 'leaf i = SHA-256(UTF-8("icp-merkle-vector:" || decimal i))';

export function derivedLeaf(i) {
  return createHash("sha256").update(`icp-merkle-vector:${i}`).digest();
}

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const flip = (value, byte = 0) => {
  const copy = Buffer.from(value);
  copy[byte] ^= 0x01;
  return copy;
};

/** Small trees carry every leaf and every proof. */
function smallTree(name, description, leaves) {
  const tree = buildTree(leaves);
  return {
    name,
    description,
    leafCount: leaves.length,
    leavesHex: leaves.map(hex),
    rootHex: hex(tree.root),
    proofs: leaves.map((_, index) => ({ index, pathHex: tree.prove(index).path.map(hex) })),
  };
}

const LARGE_COUNT = 100_000;
const LARGE_INDICES = [0, 1, 65_535, 65_536, 99_998, 99_999];

function largeTree() {
  const tree = buildTree(Array.from({ length: LARGE_COUNT }, (_, i) => derivedLeaf(i)));
  return {
    tree,
    vector: {
      name: "large-100000",
      description: "a large batch; leaves are derived with leafRule rather than listed",
      leafCount: LARGE_COUNT,
      derived: true,
      rootHex: hex(tree.root),
      proofs: LARGE_INDICES.map((index) => ({
        index,
        leafHex: hex(derivedLeaf(index)),
        pathHex: tree.prove(index).path.map(hex),
      })),
    },
  };
}

/**
 * The deepest tree the anchor accepts: 1,000,000 copies of one leaf.
 *
 * Identical leaves make every subtree of a given size hash identically, so the
 * root and any proof take O(log n) hashes to compute instead of 2,000,000. What
 * it cannot test is index binding — in a uniform tree every leaf of a perfect
 * subtree has the same proof — which is what `large-100000` and the small trees
 * are for. What it does test is a 20-hash path and the anchor's size cap.
 */
function uniformTree(count, leaf) {
  const leafHashValue = leafHash(leaf);
  const memo = new Map();
  const mth = (n) => {
    if (n === 1) return leafHashValue;
    if (memo.has(n)) return memo.get(n);
    let k = 1;
    while (k * 2 < n) k *= 2;
    const node = createHash("sha256").update(Buffer.from([1])).update(mth(k)).update(mth(n - k)).digest();
    memo.set(n, node);
    return node;
  };
  const path = (m, n) => {
    if (n === 1) return [];
    let k = 1;
    while (k * 2 < n) k *= 2;
    return m < k ? [...path(m, k), mth(n - k)] : [...path(m - k, n - k), mth(k)];
  };
  return { root: mth(count), path: (index) => path(index, count) };
}

const MAX_COUNT = 1_000_000;
const MAX_INDICES = [0, 524_287, 524_288, 999_999];

export function buildVectors() {
  const L = (i) => derivedLeaf(i);
  const trees = [];
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17]) {
    trees.push(smallTree(`size-${n}`, `${n} distinct leaves`, Array.from({ length: n }, (_, i) => L(i))));
  }
  trees.push(smallTree(
    "duplicate-leaves",
    "the same leaf value three times: every position is provable; positions 0 and 1 share a path because they share a value and a sibling",
    [L(0), L(0), L(0)],
  ));
  trees.push(smallTree(
    "last-leaf-repeated",
    "size-3 with its last leaf repeated; under a duplicate-the-odd-node rule this would share size-3's root (CVE-2012-2459), here it does not",
    [L(0), L(1), L(2), L(2)],
  ));

  const large = largeTree();
  trees.push(large.vector);

  const uniformLeaf = L(0);
  const uniform = uniformTree(MAX_COUNT, uniformLeaf);
  trees.push({
    name: "uniform-1000000",
    description: "the anchor's maximum leafCount, every leaf identical; exercises a 20-hash path, not index binding",
    leafCount: MAX_COUNT,
    uniformLeafHex: hex(uniformLeaf),
    rootHex: hex(uniform.root),
    proofs: MAX_INDICES.map((index) => ({ index, leafHex: hex(uniformLeaf), pathHex: uniform.path(index).map(hex) })),
  });

  const byName = new Map(trees.map((tree) => [tree.name, tree]));
  const leavesOf = (name) => byName.get(name).leavesHex.map((value) => Buffer.from(value, "hex"));

  const multiproofs = [];
  const addMulti = (name, description, treeName, indices) => {
    const tree = treeName === "large-100000" ? large.tree : buildTree(leavesOf(treeName));
    const proof = tree.proveMany(indices);
    multiproofs.push({
      name,
      description,
      tree: treeName,
      leafCount: tree.leafCount,
      rootHex: hex(tree.root),
      leaves: proof.leaves.map(({ index, leaf }) => ({ index, leafHex: hex(leaf) })),
      proofHex: proof.proof.map(hex),
    });
  };
  addMulti("single-leaf", "one leaf: the same hashes as its audit path, in walk order", "size-17", [5]);
  addMulti("first-and-last", "the two ends of an unbalanced tree", "size-17", [0, 16]);
  addMulti("adjacent-run", "three neighbours share most of their paths", "size-17", [3, 4, 5]);
  addMulti("scattered", "leaves in different subtrees", "size-17", [1, 2, 9, 16]);
  addMulti("every-leaf", "every leaf of a perfect tree: nothing left to prove, the proof is empty", "size-8", [0, 1, 2, 3, 4, 5, 6, 7]);
  addMulti("duplicate-values", "two positions holding the same value", "duplicate-leaves", [0, 2]);
  addMulti("large-spread", "three leaves of the large tree", "large-100000", [0, 50_000, 99_999]);

  // -------------------------------------------------------------- rejections
  //
  // Each one is a valid proof with exactly one thing changed. `error` pins the
  // message a malformed proof is refused with; `included: false` marks a proof
  // that is well formed but reconstructs some other root.
  const reject = [];
  const size7 = buildTree(leavesOf("size-7"));
  const good = size7.prove(2);
  const inclusion = (name, description, change) => {
    const input = {
      leafCount: size7.leafCount,
      root: size7.root,
      index: good.index,
      leaf: good.leaf,
      path: [...good.path],
      ...change,
    };
    let outcome;
    try {
      outcome = verifyProof(input) ? { included: true } : { included: false };
    } catch (error) {
      if (!(error instanceof MerkleError)) throw error;
      outcome = { error: error.message };
    }
    if (outcome.included) throw new Error(`reject vector ${name} verifies`);
    reject.push({
      name,
      description,
      kind: "inclusion",
      leafCount: input.leafCount,
      rootHex: hex(input.root),
      index: input.index,
      leafHex: hex(input.leaf),
      pathHex: input.path.map(hex),
      ...outcome,
    });
  };
  inclusion("corrupted-leaf", "one bit of the leaf value flipped", { leaf: flip(good.leaf) });
  inclusion("corrupted-path", "one bit of a path hash flipped", { path: good.path.map((h, i) => (i === 1 ? flip(h) : h)) });
  inclusion("corrupted-root", "one bit of the anchored root flipped", { root: flip(size7.root, 31) });
  inclusion("wrong-index", "the proof for leaf 2 presented as leaf 3", { index: 3 });
  // Not leafCount 8: an audit path does not authenticate the tree size, and
  // leaf 2's path is the same in every tree of 5 to 8 leaves, so against the
  // same root it verifies for all four. MERKLE_V1.md explains why that is
  // harmless here — the size is the anchored one, never the caller's — and
  // merkle.test.mjs asserts it, so the document is not merely claiming it.
  inclusion("wrong-size", "the right proof against a tree two levels deeper", { leafCount: 9 });
  inclusion("reordered-path", "the path hashes swapped", { path: [...good.path].reverse() });
  inclusion("path-too-long", "an extra hash appended", { path: [...good.path, good.path[0]] });
  inclusion("path-too-short", "the last hash dropped", { path: good.path.slice(0, -1) });
  inclusion("short-path-hash", "a 31-byte path hash", { path: good.path.map((h, i) => (i === 0 ? h.subarray(0, 31) : h)) });
  inclusion("index-outside-tree", "leaf index equal to the leaf count", { index: 7, path: [] });
  inclusion("leaf-hash-as-leaf", "the leaf hash presented as the leaf value", { leaf: leafHash(good.leaf) });
  // The second-preimage attack on unprefixed trees: take an interior node and
  // claim it is a leaf one level up. The node is a real node of this tree and
  // its sibling path is real, but the path length is wrong for the tree size.
  const size4 = buildTree(leavesOf("size-4"));
  {
    const interior = size4.prove(0).path;
    const node01 = createHash("sha256").update(Buffer.from([1])).update(size4.leafHashes[0]).update(size4.leafHashes[1]).digest();
    let outcome;
    try {
      outcome = verifyProof({ leafCount: 4, root: size4.root, index: 0, leaf: node01, path: [interior[1]] })
        ? { included: true }
        : { included: false };
    } catch (error) {
      outcome = { error: error.message };
    }
    if (outcome.included) throw new Error("interior-node-as-leaf verifies");
    reject.push({
      name: "interior-node-as-leaf",
      description: "an interior node of size-4 presented as leaf 0 with its real sibling",
      kind: "inclusion",
      leafCount: 4,
      rootHex: hex(size4.root),
      index: 0,
      leafHex: hex(node01),
      pathHex: [hex(interior[1])],
      ...outcome,
    });
  }

  const size17 = buildTree(leavesOf("size-17"));
  const goodMulti = size17.proveMany([1, 2, 9, 16]);
  const multi = (name, description, change) => {
    const input = {
      leafCount: size17.leafCount,
      root: size17.root,
      leaves: goodMulti.leaves.map((leaf) => ({ ...leaf })),
      proof: [...goodMulti.proof],
      ...change,
    };
    let outcome;
    try {
      outcome = verifyMultiproof(input) ? { included: true } : { included: false };
    } catch (error) {
      if (!(error instanceof MerkleError)) throw error;
      outcome = { error: error.message };
    }
    if (outcome.included) throw new Error(`reject vector ${name} verifies`);
    reject.push({
      name,
      description,
      kind: "multiproof",
      leafCount: input.leafCount,
      rootHex: hex(input.root),
      leaves: input.leaves.map(({ index, leaf }) => ({ index, leafHex: hex(leaf) })),
      proofHex: input.proof.map(hex),
      ...outcome,
    });
  };
  const leaves = goodMulti.leaves;
  multi("multi-corrupted-leaf", "one proven leaf value changed", {
    leaves: leaves.map((leaf, i) => (i === 2 ? { ...leaf, leaf: flip(leaf.leaf) } : leaf)),
  });
  multi("multi-corrupted-proof", "one proof hash changed", { proof: goodMulti.proof.map((h, i) => (i === 0 ? flip(h) : h)) });
  multi("multi-missing-hash", "the last proof hash dropped", { proof: goodMulti.proof.slice(0, -1) });
  multi("multi-extra-hash", "a hash appended", { proof: [...goodMulti.proof, goodMulti.proof[0]] });
  multi("multi-unsorted", "leaves out of index order", { leaves: [leaves[1], leaves[0], leaves[2], leaves[3]] });
  multi("multi-duplicate-index", "the same leaf twice", { leaves: [leaves[0], leaves[0], leaves[2], leaves[3]] });
  multi("multi-empty", "no leaves at all", { leaves: [], proof: [] });
  multi("multi-outside-tree", "an index equal to the leaf count", {
    leaves: [...leaves.slice(0, 3), { index: 17, leaf: leaves[3].leaf }],
  });
  multi("multi-shifted-index", "the right leaves claimed one position to the right", {
    leaves: leaves.map((leaf) => ({ ...leaf, index: leaf.index === 16 ? 16 : leaf.index + 1 })),
  });

  return {
    description:
      "Conformance vectors for icp-merkle:v1, the tree rules behind apps/02_merkle_anchor. The specification is protocol/MERKLE_V1.md. `trees` pin roots and every audit path; `multiproofs` pin the multiproof encoding; `reject` pins which inputs are refused and how. Generated by protocol/tools/merkle-vectors.mjs.",
    spec: spec(),
    leafRule: LEAF_RULE,
    leafPreimageExample: {
      leafHex: hex(L(0)),
      preimageHex: hex(leafPreimage(L(0))),
      preimageBytes: leafPreimage(L(0)).length,
      leafHashHex: hex(leafHash(L(0))),
    },
    trees,
    multiproofs,
    reject,
  };
}

// ------------------------------------------------------------------ Motoko

const mo = (value) =>
  `"${Buffer.from(value, "hex").toString("hex").replace(/(..)/g, "\\$1").toUpperCase()}"`;
const moList = (values, indent) =>
  values.length === 0 ? "[]" : `[\n${values.map((v) => `${indent}  ${mo(v)}`).join(",\n")}\n${indent}]`;
const moText = (text) => JSON.stringify(text);

export function renderMotoko(vectors, probes) {
  const lines = [];
  const push = (line = "") => lines.push(line);
  push("// GENERATED by protocol/tools/merkle-vectors.mjs from");
  push("// protocol/test-vectors/merkle/vectors.json and rfc9162-inclusion.json.");
  push("// Do not edit: run `node protocol/tools/merkle-vectors.mjs --write`.");
  push("module {");
  push("  public type Tree = { name : Text; leafCount : Nat; leaves : [Blob]; root : Blob };");
  push("  public type Proof = { name : Text; leafCount : Nat; root : Blob; index : Nat; leaf : Blob; path : [Blob] };");
  push("  public type Multi = { name : Text; leafCount : Nat; root : Blob; leaves : [(Nat, Blob)]; proof : [Blob] };");
  push("  /// `#malformed`: refused as input. `#notIncluded`: well formed, other root.");
  push("  public type Expect = { #malformed; #notIncluded };");
  push("  public type Probe = { file : Text; index : Nat; size : Nat; leafHash : Blob; path : [Blob]; root : Blob; wantErr : Bool };");
  push();

  push("  /// Trees small enough to list every leaf; the test rebuilds their roots.");
  push("  public let trees : [Tree] = [");
  for (const tree of vectors.trees.filter((t) => t.leavesHex)) {
    push(`    { name = ${moText(tree.name)}; leafCount = ${tree.leafCount}; root = ${mo(tree.rootHex)};`);
    push(`      leaves = ${moList(tree.leavesHex, "      ")} },`);
  }
  push("  ];");
  push();

  push("  /// Every published audit path, for every tree.");
  push("  public let proofs : [Proof] = [");
  for (const tree of vectors.trees) {
    for (const proof of tree.proofs) {
      const leaf = proof.leafHex ?? tree.leavesHex[proof.index];
      push(`    { name = ${moText(`${tree.name}#${proof.index}`)}; leafCount = ${tree.leafCount}; root = ${mo(tree.rootHex)}; index = ${proof.index};`);
      push(`      leaf = ${mo(leaf)};`);
      push(`      path = ${moList(proof.pathHex, "      ")} },`);
    }
  }
  push("  ];");
  push();

  push("  public let multiproofs : [Multi] = [");
  for (const m of vectors.multiproofs) {
    push(`    { name = ${moText(m.name)}; leafCount = ${m.leafCount}; root = ${mo(m.rootHex)};`);
    push(`      leaves = [${m.leaves.map((l) => `(${l.index}, ${mo(l.leafHex)})`).join(", ")}];`);
    push(`      proof = ${moList(m.proofHex, "      ")} },`);
  }
  push("  ];");
  push();

  const expect = (r) => ("error" in r ? "#malformed" : "#notIncluded");
  push("  public let rejectedProofs : [(Proof, Expect)] = [");
  for (const r of vectors.reject.filter((r) => r.kind === "inclusion")) {
    push(`    ({ name = ${moText(r.name)}; leafCount = ${r.leafCount}; root = ${mo(r.rootHex)}; index = ${r.index};`);
    push(`       leaf = ${mo(r.leafHex)};`);
    push(`       path = ${moList(r.pathHex, "       ")} }, ${expect(r)}),`);
  }
  push("  ];");
  push();

  push("  public let rejectedMultiproofs : [(Multi, Expect)] = [");
  for (const r of vectors.reject.filter((r) => r.kind === "multiproof")) {
    push(`    ({ name = ${moText(r.name)}; leafCount = ${r.leafCount}; root = ${mo(r.rootHex)};`);
    push(`       leaves = [${r.leaves.map((l) => `(${l.index}, ${mo(l.leafHex)})`).join(", ")}];`);
    push(`       proof = ${moList(r.proofHex, "       ")} }, ${expect(r)}),`);
  }
  push("  ];");
  push();

  push("  /// transparency-dev/merkle inclusion probes, over raw leaf hashes.");
  push("  public let probes : [Probe] = [");
  for (const p of probes.probes) {
    push(`    { file = ${moText(p.file)}; index = ${p.leafIdx}; size = ${p.treeSize}; wantErr = ${p.wantErr};`);
    push(`      leafHash = ${mo(p.leafHashHex)}; root = ${mo(p.rootHex)};`);
    push(`      path = ${moList(p.proofHex, "      ")} },`);
  }
  push("  ];");
  push("};");
  return lines.join("\n") + "\n";
}

export async function render() {
  const vectors = buildVectors();
  const probes = JSON.parse(await readFile(PROBES_PATH, "utf8"));
  return {
    json: JSON.stringify(vectors, null, 2) + "\n",
    motoko: renderMotoko(vectors, probes),
  };
}

/** Throws when either committed file differs from what the generator produces. */
export async function checkGenerated() {
  const { json, motoko } = await render();
  const stale = [];
  if ((await readFile(VECTORS_PATH, "utf8")) !== json) stale.push(VECTORS_PATH);
  if ((await readFile(MOTOKO_PATH, "utf8")) !== motoko) stale.push(MOTOKO_PATH);
  if (stale.length) {
    throw new Error(`stale generated vectors: ${stale.join(", ")}; run node protocol/tools/merkle-vectors.mjs --write`);
  }
}

async function main(argv) {
  if (argv.includes("--write")) {
    const { json, motoko } = await render();
    await writeFile(VECTORS_PATH, json);
    await writeFile(MOTOKO_PATH, motoko);
    console.log(`wrote ${VECTORS_PATH}\nwrote ${MOTOKO_PATH}`);
    return;
  }
  await checkGenerated();
  console.log("merkle vectors are up to date");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

