import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, canonicalizeText, commitmentHex, sha256Hex } from "./provenance-cli.mjs";
import { CANONICALIZATION_ID, JcsError, parse } from "./jcs.mjs";
import { CommitmentError, parsePreimage, preimage, spec } from "./commitment.mjs";
import { decode as decodePrincipal, encode as encodePrincipal, PrincipalError } from "./principal.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const protocolRoot = resolve(here, "..");
const read = (relative) => readFile(resolve(protocolRoot, relative), "utf8");

let checks = 0;
const check = (fn) => {
  fn();
  checks += 1;
};

// -- RFC 8785, against the vectors published with the specification ---------
//
// cyberphone/json-canonicalization is the reference test data the RFC's author
// maintains. The `output/` files are the canonical bytes, so they are compared
// exactly: no trailing newline, no reformatting.

const OFFICIAL = ["arrays", "french", "structures", "unicode", "values", "weird"];
for (const name of OFFICIAL) {
  const input = await read(`test-vectors/jcs/input/${name}.json`);
  const expected = await read(`test-vectors/jcs/output/${name}.json`);
  check(() => assert.equal(canonicalizeText(input), expected, `official vector ${name}`));
  check(() => assert.equal(canonicalizeText(expected), expected, `official vector ${name} is a fixed point`));
}

// -- Edge vectors, cross-checked against two other implementations ----------

const edge = JSON.parse(await read("test-vectors/jcs/edge-cases.json"));
assert.equal(edge.canonicalization, CANONICALIZATION_ID);

for (const vector of edge.accept) {
  check(() => assert.equal(canonicalizeText(vector.input), vector.output, `accept ${vector.name}`));
  // Canonicalizing the canonical form is the identity. A scheme where it is not
  // has no fixed point, and two verifiers can disagree by canonicalizing a
  // different number of times.
  check(() => assert.equal(canonicalizeText(vector.output), vector.output, `idempotent ${vector.name}`));
}

for (const vector of edge.reject) {
  check(() => {
    assert.throws(
      () => canonicalizeText(vector.input),
      (error) => error instanceof JcsError && error.message === vector.error,
      `reject ${vector.name}`,
    );
  });
}

// -- Canonicalization is not order-sensitive --------------------------------

check(() => assert.equal(canonicalize({ b: 2, a: { z: 1, y: 0 } }), '{"a":{"y":0,"z":1},"b":2}'));
check(() => assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 })));

// A JavaScript value can hold things JSON text cannot, and those have to fail
// rather than serialize to something plausible.
check(() => assert.throws(() => canonicalize({ a: Number.NaN }), JcsError));
check(() => assert.throws(() => canonicalize({ a: Number.POSITIVE_INFINITY }), JcsError));
check(() => assert.throws(() => canonicalize({ a: undefined }), JcsError));
check(() => assert.throws(() => canonicalize({ a: 1n }), JcsError));
check(() => assert.throws(() => parse(Buffer.from("{}")), JcsError));

// -- Protocol vectors -------------------------------------------------------
//
// These predate RFC 8785 conformance. They are unchanged because the previous
// recursive-key-sort implementation produced identical bytes for both example
// manifests — which is exactly why the subset survived as long as it did.

const vectors = JSON.parse(await read("test-vectors/test-vectors.json"));
assert.equal(vectors.canonicalization, CANONICALIZATION_ID);

for (const vector of vectors.vectors) {
  const manifest = await readFile(resolve(protocolRoot, "test-vectors", vector.manifest), "utf8");
  const artifact = await readFile(resolve(protocolRoot, "test-vectors", vector.artifact));
  check(() => assert.equal(sha256Hex(Buffer.from(canonicalizeText(manifest), "utf8")), vector.manifestSha256));
  check(() => assert.equal(sha256Hex(artifact), vector.artifactSha256));
  check(() =>
    assert.equal(
      commitmentHex({
        principal: vector.principal,
        manifestHash: vector.manifestSha256,
        salt: vector.saltHex,
      }),
      vector.commitmentSha256,
    ),
  );
}

// -- Commitment layout v1, frozen ------------------------------------------

const commitment = JSON.parse(await read("test-vectors/commitment/vectors.json"));
assert.deepEqual(commitment.spec, spec());

const byName = new Map(commitment.accept.map((vector) => [vector.name, vector]));

for (const vector of commitment.accept) {
  const input = { principal: vector.principal, manifestHash: vector.manifestHashHex, salt: vector.saltHex };
  const bytes = preimage(input);

  check(() => assert.equal(bytes.toString("hex"), vector.preimageHex, `preimage ${vector.name}`));
  check(() => assert.equal(bytes.length, vector.preimageBytes, `preimage length ${vector.name}`));
  check(() => assert.equal(commitmentHex(input), vector.commitmentHex, `commitment ${vector.name}`));

  // The layout is injective, demonstrated rather than asserted: every field
  // boundary is recoverable from the bytes alone, so no two distinct triples
  // can produce the same preimage. This is what "no concatenation ambiguity"
  // means, and it is why `salt-all-zero` and `digest-all-zero` are vectors.
  check(() =>
    assert.deepEqual(
      parsePreimage(bytes),
      {
        principal: vector.principal.trim(),
        manifestHash: vector.manifestHashHex.toLowerCase(),
        salt: vector.saltHex.toLowerCase(),
      },
      `injective ${vector.name}`,
    ),
  );

  // A vector carrying `equivalentTo` exists to pin that a different spelling of
  // the same three fields gives the same answer. Everything else must be
  // distinct.
  if (vector.equivalentTo) {
    check(() =>
      assert.equal(vector.commitmentHex, byName.get(vector.equivalentTo).commitmentHex, `equivalent ${vector.name}`),
    );
  }
}

const distinct = new Set(
  commitment.accept.filter((vector) => !vector.equivalentTo).map((vector) => vector.commitmentHex),
);
check(() =>
  assert.equal(
    distinct.size,
    commitment.accept.filter((vector) => !vector.equivalentTo).length,
    "distinct triples produce distinct commitments",
  ),
);

for (const vector of commitment.reject) {
  check(() =>
    assert.throws(
      () =>
        commitmentHex({
          principal: vector.principal,
          manifestHash: vector.manifestHashHex,
          salt: vector.saltHex,
        }),
      (error) => error instanceof CommitmentError && error.message === vector.error,
      `reject ${vector.name}`,
    ),
  );
}

// -- Principal textual form -------------------------------------------------

for (const text of ["aaaaa-aa", "2vxsx-fae", "ryjl3-tyaaa-aaaaa-aaaba-cai"]) {
  check(() => assert.equal(encodePrincipal(decodePrincipal(text)), text, `principal round trip ${text}`));
}
check(() => assert.equal(decodePrincipal("aaaaa-aa").length, 0, "the management canister is the empty blob"));
check(() => assert.throws(() => decodePrincipal(Buffer.from("aaaaa-aa")), PrincipalError));

console.log(
  `ok: ${checks} assertions — ${OFFICIAL.length} official RFC 8785 vectors, ` +
    `${edge.accept.length} accepted and ${edge.reject.length} rejected edge vectors, ` +
    `${commitment.accept.length} accepted and ${commitment.reject.length} rejected commitment vectors, ` +
    `${vectors.vectors.length} provenance vectors`,
);
