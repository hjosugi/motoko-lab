import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, commitmentHex, sha256Hex } from "./provenance-cli.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const protocolRoot = resolve(here, "..");
const vectors = JSON.parse(await readFile(resolve(protocolRoot, "test-vectors/test-vectors.json"), "utf8"));

assert.equal(canonicalize({ b: 2, a: { z: 1, y: 0 } }), '{"a":{"y":0,"z":1},"b":2}');
assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));

for (const vector of vectors.vectors) {
  const manifestPath = resolve(protocolRoot, "test-vectors", vector.manifest);
  const artifactPath = resolve(protocolRoot, "test-vectors", vector.artifact);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const artifact = await readFile(artifactPath);
  assert.equal(sha256Hex(Buffer.from(canonicalize(manifest), "utf8")), vector.manifestSha256);
  assert.equal(sha256Hex(artifact), vector.artifactSha256);
  assert.equal(commitmentHex({
    principal: vector.principal,
    manifestHash: vector.manifestSha256,
    salt: vector.saltHex,
  }), vector.commitmentSha256);
}

console.log(`ok: ${vectors.vectors.length} provenance test vectors`);
