// Tests for icp-merkle:v1 (protocol/MERKLE_V1.md).
//
//   node protocol/tools/merkle.test.mjs
//
// Four layers, each catching what the others cannot:
//
// 1. The RFC 9162 core against transparency-dev/merkle, an implementation this
//    kit shares nothing with. If the tree shape or the audit-path walk were
//    subtly off, this is where it would show.
// 2. The two constructions in merkle.mjs against each other: the recursive
//    definition and the bottom-up builder, for every tree size up to 130.
// 3. The published v1 vectors: roots, every audit path, multiproofs, and each
//    rejection with the outcome it is pinned to.
// 4. The generated Motoko rendering is current, so the canister's verifier is
//    tested over exactly these vectors (apps/02_merkle_anchor/test/Merkle.test.mo).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTree,
  hashLeafData,
  inclusionPath,
  leafHash,
  leafPreimage,
  MerkleError,
  multiproof,
  pathLength,
  rootFromInclusionPath,
  rootFromLeafHashes,
  rootFromMultiproof,
  spec,
  verifyInclusionHashes,
  verifyMultiproof,
  verifyProof,
} from "./merkle.mjs";
import { checkGenerated, derivedLeaf } from "./merkle-vectors.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const protocolRoot = resolve(here, "..");
const read = async (relative) => JSON.parse(await readFile(resolve(protocolRoot, relative), "utf8"));

let checks = 0;
const check = (fn) => {
  fn();
  checks += 1;
};
const hex = (bytes) => Buffer.from(bytes).toString("hex");

// -- 1. RFC 9162 core against transparency-dev/merkle -----------------------

const probes = await read("test-vectors/merkle/rfc9162-inclusion.json");
for (const probe of probes.probes) {
  let accepted;
  try {
    accepted = verifyInclusionHashes({
      index: probe.leafIdx,
      treeSize: probe.treeSize,
      leafHash: probe.leafHashHex,
      path: probe.proofHex,
      root: probe.rootHex,
    });
  } catch (error) {
    if (!(error instanceof MerkleError)) throw error;
    accepted = false;
  }
  check(() => assert.equal(accepted, !probe.wantErr, `transparency-dev probe ${probe.file}`));
}

// The root hashes from transparency-dev/merkle testonly/constants.go
// (RootHashes), for the first n of its eight reference leaf inputs.
const CT_LEAVES = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"];
const CT_ROOTS = [
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];
const ctHashes = CT_LEAVES.map((value) => hashLeafData(Buffer.from(value, "hex")));
for (let n = 1; n <= 8; n++) {
  check(() => assert.equal(hex(rootFromLeafHashes(ctHashes.slice(0, n))), CT_ROOTS[n - 1], `RFC 6962 root of ${n}`));
}

// -- 2. The definition and the builder agree --------------------------------

for (let n = 1; n <= 130; n++) {
  const leaves = Array.from({ length: n }, (_, i) => derivedLeaf(i));
  const tree = buildTree(leaves);
  const hashes = leaves.map((leaf) => leafHash(leaf));
  check(() => assert.ok(tree.root.equals(rootFromLeafHashes(hashes)), `builder root equals MTH for ${n}`));
  for (let i = 0; i < n; i++) {
    const path = tree.prove(i).path;
    // Every audit path of every tree up to 130 leaves: from the builder and
    // from the recursive definition, of the length (index, size) fixes, and
    // reconstructing the root.
    assert.deepEqual(path.map(hex), inclusionPath(hashes, i).map(hex), `builder path ${i} of ${n}`);
    assert.equal(path.length, pathLength(i, n), `path length ${i} of ${n}`);
    assert.ok(rootFromInclusionPath({ index: i, treeSize: n, leafHash: hashes[i], path }).equals(tree.root));
  }
  checks += 1;
}

// Multiproofs over pseudo-random index sets, deterministic so a failure
// reproduces. Each must round-trip, and must contain exactly the union of the
// sibling hashes the individual audit paths need, minus those the other proven
// leaves make computable: never more hashes than the single paths combined.
let seed = 0x2545f491;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};
for (let n = 1; n <= 40; n++) {
  const hashes = Array.from({ length: n }, (_, i) => leafHash(derivedLeaf(i)));
  const root = rootFromLeafHashes(hashes);
  for (let trial = 0; trial < 6; trial++) {
    const indices = [...new Set(Array.from({ length: 1 + Math.floor(random() * n) }, () => Math.floor(random() * n)))]
      .sort((a, b) => a - b);
    const proof = multiproof(hashes, indices);
    const leaves = indices.map((index) => ({ index, leafHash: hashes[index] }));
    assert.ok(rootFromMultiproof({ treeSize: n, leaves, proof }).equals(root), `multiproof ${indices} of ${n}`);
    const separate = indices.reduce((sum, index) => sum + pathLength(index, n), 0);
    assert.ok(proof.length <= separate, `multiproof ${indices} of ${n} is no larger than separate proofs`);
    if (indices.length === 1) {
      const single = new Set(inclusionPath(hashes, indices[0]).map(hex));
      assert.deepEqual(new Set(proof.map(hex)), single, `one-leaf multiproof equals the audit path set, ${n}`);
    }
  }
  checks += 1;
}

// -- 3. The published vectors -----------------------------------------------

const vectors = await read("test-vectors/merkle/vectors.json");
check(() => assert.deepEqual(vectors.spec, spec()));

const example = vectors.leafPreimageExample;
check(() => assert.equal(hex(leafPreimage(Buffer.from(example.leafHex, "hex"))), example.preimageHex));
check(() => assert.equal(example.preimageBytes, 46, "a leaf preimage is 1 + 13 + 32 bytes"));
check(() => assert.equal(hex(leafHash(Buffer.from(example.leafHex, "hex"))), example.leafHashHex));

const trees = new Map(vectors.trees.map((tree) => [tree.name, tree]));
for (const tree of vectors.trees) {
  if (tree.leavesHex) {
    check(() => assert.equal(hex(buildTree(tree.leavesHex).root), tree.rootHex, `root ${tree.name}`));
  }
  for (const proof of tree.proofs) {
    const leaf = proof.leafHex ?? tree.leavesHex[proof.index];
    if (tree.derived) {
      check(() => assert.equal(leaf, hex(derivedLeaf(proof.index)), `derived leaf ${tree.name}#${proof.index}`));
    }
    check(() =>
      assert.ok(
        verifyProof({ root: tree.rootHex, leafCount: tree.leafCount, index: proof.index, leaf, path: proof.pathHex }),
        `proof ${tree.name}#${proof.index}`,
      ),
    );
  }
}

// What the odd-node rule is for: under "duplicate the last node" [a, b, c] and
// [a, b, c, c] share a root, and a proof of the phantom fourth leaf verifies.
check(() => assert.notEqual(trees.get("size-3").rootHex, trees.get("last-leaf-repeated").rootHex));
// Duplicate values are allowed, and a proof proves "this value at this
// position". Positions 0 and 1 hold the same value under the same sibling, so
// their paths coincide and each proves both — which is true of both. Position
// 2 sits elsewhere in the shape and has its own path. Uniqueness of values is a
// property of the leaf list, which only the batch manifest can show.
{
  const dup = trees.get("duplicate-leaves");
  check(() => assert.deepEqual(dup.proofs[0].pathHex, dup.proofs[1].pathHex));
  check(() => assert.notDeepEqual(dup.proofs[0].pathHex, dup.proofs[2].pathHex));
  check(() =>
    assert.ok(verifyProof({ root: dup.rootHex, leafCount: 3, index: 1, leaf: dup.leavesHex[0], path: dup.proofs[0].pathHex })),
  );
  check(() =>
    assert.throws(
      () => verifyProof({ root: dup.rootHex, leafCount: 3, index: 2, leaf: dup.leavesHex[0], path: dup.proofs[0].pathHex }),
      MerkleError,
      "position 0's path is the wrong length for position 2",
    ),
  );
}
check(() => assert.equal(trees.get("uniform-1000000").proofs[0].pathHex.length, 20, "the deepest path is 20 hashes"));

for (const vector of vectors.multiproofs) {
  check(() =>
    assert.ok(
      verifyMultiproof({
        root: vector.rootHex,
        leafCount: vector.leafCount,
        leaves: vector.leaves.map(({ index, leafHex }) => ({ index, leaf: leafHex })),
        proof: vector.proofHex,
      }),
      `multiproof ${vector.name}`,
    ),
  );
}

for (const vector of vectors.reject) {
  const run = () =>
    vector.kind === "inclusion"
      ? verifyProof({
          root: vector.rootHex,
          leafCount: vector.leafCount,
          index: vector.index,
          leaf: vector.leafHex,
          path: vector.pathHex,
        })
      : verifyMultiproof({
          root: vector.rootHex,
          leafCount: vector.leafCount,
          leaves: vector.leaves.map(({ index, leafHex }) => ({ index, leaf: leafHex })),
          proof: vector.proofHex,
        });
  if ("error" in vector) {
    check(() =>
      assert.throws(run, (error) => error instanceof MerkleError && error.message === vector.error, `reject ${vector.name}`),
    );
  } else {
    check(() => assert.equal(run(), false, `reject ${vector.name}`));
  }
}

// An audit path does not authenticate the tree size (MERKLE_V1.md, "What a
// proof does not prove"). Leaf 2's path is the same in every tree of 5 to 8
// leaves, so against size-7's root it verifies for all four sizes. The anchor
// is safe because it supplies the size itself; this pins that the property is
// real, so the document is describing the code and not guessing.
{
  const size7 = trees.get("size-7");
  const proof = size7.proofs[2];
  for (const leafCount of [5, 6, 7, 8]) {
    check(() =>
      assert.ok(verifyProof({ root: size7.rootHex, leafCount, index: 2, leaf: size7.leavesHex[2], path: proof.pathHex })),
    );
  }
}

// -- 4. The CLI and the generated Motoko data --------------------------------

{
  const dir = await mkdtemp(join(tmpdir(), "merkle-cli-"));
  try {
    const size7 = trees.get("size-7");
    const leavesFile = join(dir, "leaves.txt");
    await writeFile(leavesFile, `${size7.leavesHex.join("\n")}\n`);
    const cli = (...args) =>
      execFileSync(process.execPath, [resolve(here, "provenance-cli.mjs"), ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      }).toString();
    const summary = JSON.parse(cli("merkle-root", leavesFile));
    check(() => assert.equal(summary.root, size7.rootHex));
    const proofFile = join(dir, "proof.json");
    await writeFile(proofFile, cli("merkle-prove", leavesFile, "--index", "2"));
    const verdict = JSON.parse(cli("merkle-verify", proofFile, "--root", size7.rootHex, "--leaf-count", "7"));
    check(() => assert.equal(verdict.included, true));
    await writeFile(proofFile, cli("merkle-prove", leavesFile, "--indices", "0,3,6"));
    check(() =>
      assert.equal(JSON.parse(cli("merkle-verify", proofFile, "--root", size7.rootHex, "--leaf-count", "7")).included, true),
    );
    // Against another tree's root the verdict is false and the exit code 2.
    check(() =>
      assert.throws(
        () => cli("merkle-verify", proofFile, "--root", trees.get("size-8").rootHex, "--leaf-count", "7"),
        (error) => error.status === 2,
      ),
    );
    // Without an anchored root the verifier refuses to guess one.
    check(() => assert.throws(() => cli("merkle-verify", proofFile), (error) => error.status === 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await checkGenerated();
checks += 1;

console.log(
  `ok: ${checks} merkle checks — ${probes.probes.length} transparency-dev probes, ` +
    `${vectors.trees.length} trees, ${vectors.multiproofs.length} multiproofs, ${vectors.reject.length} rejections`,
);
