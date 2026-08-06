#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { CANONICALIZATION_ID, canonicalizeValue, parse as parseJson } from "./jcs.mjs";

const DOMAIN = Buffer.from("icp-creator-proof:v1", "utf8");
const ZERO = Buffer.from([0]);

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

function parseHex(name, value, expectedBytes = null) {
  if (typeof value !== "string" || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${name} must be even-length hexadecimal`);
  }
  const bytes = Buffer.from(value, "hex");
  if (expectedBytes !== null && bytes.length !== expectedBytes) {
    throw new Error(`${name} must be ${expectedBytes} bytes`);
  }
  return bytes;
}

export function commitmentHex({ principal, manifestHash, salt }) {
  const canonicalPrincipal = principal.trim().toLowerCase();
  if (canonicalPrincipal.length < 5 || canonicalPrincipal.length > 100) {
    throw new Error("principal text length is invalid");
  }
  const manifestBytes = parseHex("manifest hash", manifestHash, 32);
  const saltBytes = parseHex("salt", salt);
  if (saltBytes.length < 16 || saltBytes.length > 64) {
    throw new Error("salt must contain 16 to 64 bytes");
  }
  const preimage = Buffer.concat([
    DOMAIN, ZERO, Buffer.from(canonicalPrincipal, "utf8"), ZERO,
    manifestBytes, ZERO, saltBytes,
  ]);
  return sha256Hex(preimage);
}

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
    const calculated = commitmentHex({
      principal: opts.principal ?? "",
      manifestHash: opts["manifest-hash"] ?? "",
      salt: opts.salt ?? "",
    });
    const expected = (opts.commitment ?? "").toLowerCase();
    const valid = /^[0-9a-f]{64}$/.test(expected) && expected === calculated;
    console.log(JSON.stringify({ valid, expected, calculated }, null, 2));
    if (!valid) process.exitCode = 2;
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
      principal: (opts.principal ?? "").trim().toLowerCase(),
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
  throw new Error("commands: canonicalize, manifest-hash, artifact-hash, commitment, verify-commitment, bundle");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
