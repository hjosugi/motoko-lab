#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { CANONICALIZATION_ID, canonicalizeValue, parse as parseJson } from "./jcs.mjs";
import { commitmentHex, verify } from "./commitment.mjs";
import { buildTree, TREE_VERSION, verifyMultiproof, verifyProof } from "./merkle.mjs";

function fail(message) {
  console.error(`error: ${message}`);
  process.exitCode = 1;
}

export { CANONICALIZATION_ID };

/**
 * RFC 8785 canonical JSON text for an already-parsed value.
 *
 * Prefer `canonicalizeText` where the JSON text is still available: the checks
 * that need the text — duplicate member names above all — cannot be made once
 * `JSON.parse` has collapsed them.
 */
export function canonicalize(value) {
  return canonicalizeValue(value);
}

export function canonicalizeText(text) {
  return canonicalizeValue(parseJson(text));
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// The layout, its validation and its error messages live in commitment.mjs,
// which is what the conformance vectors are written against.
export { commitmentHex };

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`invalid option sequence near ${key ?? "end"}`);
    }
    result[key.slice(2)] = value;
  }
  return result;
}

// Deliberately not `JSON.parse`. Every manifest read here is on its way to a
// digest, and the strict scanner is the only place a duplicate member name or a
// lone surrogate can still be seen.
async function readJson(path) {
  return parseJson(await readFile(path, "utf8"));
}

/** One 64-hex leaf digest per line; blank lines are ignored. */
async function readLeaves(path) {
  return (await readFile(path, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function integer(flag, value) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error(`${flag} must be a non-negative integer`);
  return Number(value);
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === "canonicalize") {
    if (args.length !== 1) throw new Error("usage: canonicalize <manifest.json>");
    console.log(canonicalize(await readJson(args[0])));
    return;
  }
  if (command === "manifest-hash") {
    if (args.length !== 1) throw new Error("usage: manifest-hash <manifest.json>");
    console.log(sha256Hex(Buffer.from(canonicalize(await readJson(args[0])), "utf8")));
    return;
  }
  if (command === "artifact-hash") {
    if (args.length !== 1) throw new Error("usage: artifact-hash <file>");
    console.log(sha256Hex(await readFile(args[0])));
    return;
  }
  if (command === "commitment") {
    const opts = options(args);
    console.log(commitmentHex({
      principal: opts.principal ?? "",
      manifestHash: opts["manifest-hash"] ?? "",
      salt: opts.salt ?? "",
    }));
    return;
  }
  if (command === "verify-commitment") {
    const opts = options(args);
    const result = verify({
      principal: opts.principal ?? "",
      manifestHash: opts["manifest-hash"] ?? "",
      salt: opts.salt ?? "",
      commitment: opts.commitment ?? "",
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 2;
    return;
  }
  if (command === "bundle") {
    const opts = options(args);
    const manifestPath = opts.manifest;
    const artifactPath = opts.artifact;
    const outputPath = opts.out;
    if (!manifestPath || !artifactPath || !outputPath) {
      throw new Error("usage: bundle --manifest file --artifact file --principal text --salt hex --out file");
    }
    const manifest = await readJson(manifestPath);
    const manifestHash = sha256Hex(Buffer.from(canonicalize(manifest), "utf8"));
    const artifactHash = sha256Hex(await readFile(artifactPath));
    const commitment = commitmentHex({ principal: opts.principal ?? "", manifestHash, salt: opts.salt ?? "" });
    const bundle = {
      version: "0.1",
      generatedAt: new Date().toISOString(),
      canonicalization: CANONICALIZATION_ID,
      // `commitmentHex` above already rejected anything that is not a
      // principal in canonical form, so this is the same text it hashed.
      principal: (opts.principal ?? "").trim(),
      artifactHash,
      manifestHash,
      saltHex: (opts.salt ?? "").toLowerCase(),
      commitment,
      manifest,
      warnings: ["Registration evidence is not legal authorship proof."],
    };
    await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    console.log(outputPath);
    return;
  }
  if (command === "merkle-root" || command === "merkle-prove") {
    const [leavesPath, ...rest] = args;
    if (!leavesPath) {
      throw new Error(`usage: ${command} <leaves.txt>${command === "merkle-prove" ? " --index n | --indices a,b,c" : ""}`);
    }
    const tree = buildTree(await readLeaves(leavesPath));
    const summary = { treeVersion: TREE_VERSION, leafCount: tree.leafCount, root: tree.root.toString("hex") };
    if (command === "merkle-root") {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    const opts = options(rest);
    if (opts.index !== undefined) {
      const proof = tree.prove(integer("--index", opts.index));
      console.log(JSON.stringify({
        ...summary,
        index: proof.index,
        leaf: proof.leaf.toString("hex"),
        path: proof.path.map((hash) => hash.toString("hex")),
      }, null, 2));
      return;
    }
    if (opts.indices !== undefined) {
      const proof = tree.proveMany(opts.indices.split(",").map((value) => integer("--indices", value)));
      console.log(JSON.stringify({
        ...summary,
        leaves: proof.leaves.map(({ index, leaf }) => ({ index, leaf: leaf.toString("hex") })),
        proof: proof.proof.map((hash) => hash.toString("hex")),
      }, null, 2));
      return;
    }
    throw new Error("usage: merkle-prove <leaves.txt> --index n | --indices a,b,c");
  }
  if (command === "merkle-verify") {
    const [proofPath, ...rest] = args;
    const opts = options(rest);
    // The root and the leaf count in a proof file are the prover's claims. A
    // proof checked against the root it brought with it proves nothing, so the
    // verifier has to say where the real ones came from: the anchored batch.
    if (!proofPath || opts.root === undefined || opts["leaf-count"] === undefined) {
      throw new Error("usage: merkle-verify <proof.json> --root <hex from the anchor> --leaf-count <n from the anchor>");
    }
    const proof = await readJson(proofPath);
    if (proof.treeVersion !== TREE_VERSION) {
      throw new Error(`proof is for tree version ${JSON.stringify(proof.treeVersion)}, this verifier implements ${TREE_VERSION}`);
    }
    const leafCount = integer("--leaf-count", opts["leaf-count"]);
    const included = Array.isArray(proof.leaves)
      ? verifyMultiproof({ root: opts.root, leafCount, leaves: proof.leaves, proof: proof.proof })
      : verifyProof({ root: opts.root, leafCount, index: proof.index, leaf: proof.leaf, path: proof.path });
    console.log(JSON.stringify({ treeVersion: TREE_VERSION, root: opts.root, leafCount, included }, null, 2));
    if (!included) process.exitCode = 2;
    return;
  }
  throw new Error(
    "commands: canonicalize, manifest-hash, artifact-hash, commitment, verify-commitment, bundle, " +
      "merkle-root, merkle-prove, merkle-verify",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
