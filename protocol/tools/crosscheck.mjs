// Cross-check this repository's protocol implementations against independent
// ones in Rust and TypeScript.
//
// `provenance-cli.test.mjs` proves the implementations match their own recorded
// expectations, and those expectations came from these implementations. That is
// circular for everything except the six official RFC 8785 vectors. This script
// closes the loop by running the same inputs through code that shares nothing
// with `protocol/tools/`:
//
//   canonicalization   `serde_jcs` (Rust) and the `canonicalize` npm package,
//                      the latter by the author of the reference test data
//
//   commitment layout  `crosscheck/commitment.rs` and `crosscheck/commitment.ts`,
//                      both written from protocol/COMMITMENT_V1.md. Neither
//                      shares the base32 and CRC32 code in
//                      `protocol/tools/principal.mjs`: the Rust one validates
//                      principals with `candid::Principal`, the TypeScript one
//                      with `@dfinity/principal`. If the specification were
//                      unimplementable from its own text, or if the principal
//                      rules here disagreed with DFINITY's, this is where it
//                      would show.
//
// It is not part of `run_offline_checks.sh` and not part of CI. It needs
// `cargo`, `npm`, and network access on first run, and none of those belong in
// a gate that has to work in a sandbox. Run it when the protocol changes, and
// record the result in protocol/CANONICALIZATION.md and protocol/COMMITMENT_V1.md.
//
//   node protocol/tools/crosscheck.mjs
//   KEEP=1 node protocol/tools/crosscheck.mjs   # leave the build tree in place

import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { canonicalizeText } from "./provenance-cli.mjs";
import { JcsError } from "./jcs.mjs";
import { commitmentHex, preimage, CommitmentError } from "./commitment.mjs";

// Pinned, like every other tool in this kit. A cross-check that silently
// changes what it compares against is not a cross-check.
const VERSIONS = {
  serde_jcs: "0.2.0",
  serde_json: "1.0.151",
  candid: "0.10.34",
  sha2: "0.11.0",
  hex: "0.4.3",
  canonicalize: "3.0.0",
  "@dfinity/principal": "3.4.3",
};

const here = dirname(fileURLToPath(import.meta.url));
const protocolRoot = resolve(here, "..");
const read = (relative) => readFile(resolve(protocolRoot, relative), "utf8");

function requireTool(name) {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
  } catch {
    console.error(`${name} is required; this script is deliberately outside the offline gate`);
    process.exit(1);
  }
}

async function buildRust(root) {
  const project = resolve(root, "rust");
  await mkdir(resolve(project, "src/bin"), { recursive: true });
  await writeFile(
    resolve(project, "Cargo.toml"),
    `[package]\nname = "crosscheck"\nversion = "0.0.0"\nedition = "2021"\n\n` +
      `[dependencies]\n` +
      `serde_jcs = "=${VERSIONS.serde_jcs}"\n` +
      `serde_json = "=${VERSIONS.serde_json}"\n` +
      `candid = "=${VERSIONS.candid}"\n` +
      `sha2 = "=${VERSIONS.sha2}"\n` +
      `hex = "=${VERSIONS.hex}"\n`,
  );
  await copyFile(resolve(here, "crosscheck/jcs.rs"), resolve(project, "src/bin/jcs.rs"));
  await copyFile(resolve(here, "crosscheck/commitment.rs"), resolve(project, "src/bin/commitment.rs"));
  execFileSync("cargo", ["build", "--release", "--quiet"], { cwd: project, stdio: "inherit" });
  // `CARGO_TARGET_DIR` is commonly set to a shared cache, so ask cargo rather
  // than assuming `target/` sits next to the manifest.
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
      cwd: project,
      encoding: "utf8",
    }),
  );
  return {
    jcs: resolve(metadata.target_directory, "release", "jcs"),
    commitment: resolve(metadata.target_directory, "release", "commitment"),
  };
}

async function buildNode(root) {
  const project = resolve(root, "node");
  await mkdir(project, { recursive: true });
  await writeFile(resolve(project, "package.json"), `{"name":"crosscheck","private":true,"type":"module"}\n`);
  execFileSync(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--silent",
      `canonicalize@${VERSIONS.canonicalize}`,
      `@dfinity/principal@${VERSIONS["@dfinity/principal"]}`,
    ],
    { cwd: project, stdio: "inherit" },
  );
  for (const name of ["commitment.ts", "commitment-runner.ts"]) {
    await copyFile(resolve(here, "crosscheck", name), resolve(project, name));
  }
  return {
    project,
    canonicalize: (await import(resolve(project, "node_modules/canonicalize/lib/canonicalize.js"))).default,
  };
}

function runLines(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options })
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t"));
}

requireTool("cargo");
requireTool("npm");

const root = await mkdtemp(resolve(tmpdir(), "protocol-crosscheck-"));
let failures = 0;

try {
  const rust = await buildRust(root);
  const node = await buildNode(root);

  // ---------------------------------------------------- canonicalization --

  const canonicalizationCases = [];
  for (const name of ["arrays", "french", "structures", "unicode", "values", "weird"]) {
    canonicalizationCases.push({
      name: `official/${name}`,
      input: await read(`test-vectors/jcs/input/${name}.json`),
    });
  }
  const edge = JSON.parse(await read("test-vectors/jcs/edge-cases.json"));
  for (const vector of edge.accept) canonicalizationCases.push({ name: `accept/${vector.name}`, input: vector.input });
  for (const name of ["human-only", "ai-assisted"]) {
    canonicalizationCases.push({ name: `example/${name}`, input: await read(`examples/${name}.json`) });
  }

  for (const item of canonicalizationCases) {
    const ours = canonicalizeText(item.input);
    const viaNpm = node.canonicalize(JSON.parse(item.input));
    let viaRust;
    try {
      viaRust = execFileSync(rust.jcs, { input: item.input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      viaRust = `<rejected: ${String(error.stderr ?? error.message).trim()}>`;
    }
    if (viaNpm !== ours || viaRust !== ours) {
      failures += 1;
      console.log(`MISMATCH canonicalization ${item.name}`);
      console.log(`  ours: ${JSON.stringify(ours)}`);
      if (viaNpm !== ours) console.log(`  npm : ${JSON.stringify(viaNpm)}`);
      if (viaRust !== ours) console.log(`  rust: ${JSON.stringify(viaRust)}`);
    }
  }

  const stricterCanonicalization = [];
  for (const vector of edge.reject) {
    let rejected = false;
    try {
      canonicalizeText(vector.input);
    } catch (error) {
      if (!(error instanceof JcsError)) throw error;
      rejected = true;
    }
    if (!rejected) {
      failures += 1;
      console.log(`NOT REJECTED canonicalization ${vector.name}`);
      continue;
    }
    let rustAccepted = true;
    try {
      execFileSync(rust.jcs, { input: vector.input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      rustAccepted = false;
    }
    if (rustAccepted === vector.alsoRejectedBySerdeJcs) {
      failures += 1;
      console.log(
        `STALE alsoRejectedBySerdeJcs for ${vector.name}: recorded ${vector.alsoRejectedBySerdeJcs}, ` +
          `serde_jcs ${rustAccepted ? "accepted" : "rejected"} it`,
      );
    }
    if (rustAccepted) stricterCanonicalization.push(vector.name);
  }

  // --------------------------------------------------- commitment layout --

  const commitment = JSON.parse(await read("test-vectors/commitment/vectors.json"));
  const all = [
    ...commitment.accept.map((vector) => ({ ...vector, expect: "accept" })),
    ...commitment.reject.map((vector) => ({ ...vector, expect: "reject" })),
  ];
  // JSON per line rather than tab-separated fields: one vector deliberately
  // carries surrounding whitespace, and an escaping scheme that mangled it
  // would manufacture a disagreement that is not there.
  const wire = all.map((v) => JSON.stringify([v.principal, v.manifestHashHex, v.saltHex])).join("\n");
  const wirePath = resolve(root, "vectors.tsv");
  await writeFile(wirePath, `${wire}\n`);

  const fromRust = runLines(rust.commitment, [], { input: `${wire}\n` });
  const fromTs = runLines("node", [resolve(node.project, "commitment-runner.ts"), wirePath], { cwd: node.project });

  for (const [index, vector] of all.entries()) {
    const input = {
      principal: vector.principal,
      manifestHash: vector.manifestHashHex,
      salt: vector.saltHex,
    };
    let ours;
    try {
      ours = { ok: true, preimage: preimage(input).toString("hex"), commitment: commitmentHex(input) };
    } catch (error) {
      if (!(error instanceof CommitmentError)) throw error;
      ours = { ok: false };
    }

    if (ours.ok !== (vector.expect === "accept")) {
      failures += 1;
      console.log(`WRONG VERDICT commitment ${vector.name}: vectors say ${vector.expect}`);
      continue;
    }

    for (const [label, row] of [
      ["rust", fromRust[index]],
      ["ts", fromTs[index]],
    ]) {
      const accepted = row?.[0] === "OK";
      if (accepted !== ours.ok) {
        failures += 1;
        console.log(
          `DISAGREEMENT commitment ${vector.name}: ours ${ours.ok ? "accepted" : "rejected"}, ` +
            `${label} ${accepted ? "accepted" : `rejected (${row?.[1] ?? "?"})`}`,
        );
        continue;
      }
      // The rejection *reason* is not compared. Each implementation words its
      // own errors; what the specification fixes is which inputs are refused.
      if (accepted && (row[1] !== ours.preimage || row[2] !== ours.commitment)) {
        failures += 1;
        console.log(`MISMATCH commitment ${vector.name} (${label})`);
        console.log(`  ours preimage: ${ours.preimage}`);
        console.log(`  ${label} preimage: ${row[1]}`);
      }
    }
  }

  console.log();
  console.log(
    Object.entries(VERSIONS)
      .map(([name, version]) => `${name} ${version}`)
      .join(", "),
  );
  console.log();
  console.log(
    `canonicalization: ${canonicalizationCases.length} inputs identical across all three implementations; ` +
      `${edge.reject.length} rejected, of which serde_jcs also rejects ${edge.reject.length - stricterCanonicalization.length}`,
  );
  for (const name of stricterCanonicalization) console.log(`  stricter than serde_jcs: ${name}`);
  console.log(
    `commitment: ${commitment.accept.length} accepted and ${commitment.reject.length} rejected, ` +
      `same verdict and same bytes from crosscheck/commitment.rs and crosscheck/commitment.ts`,
  );
  console.log(failures === 0 ? "\nCROSS-CHECK: PASS" : `\nCROSS-CHECK: FAIL (${failures})`);
} finally {
  if (!process.env.KEEP) await rm(root, { recursive: true, force: true });
  else console.log(`\nbuild tree kept at ${root}`);
}

process.exitCode = failures === 0 ? 0 : 1;
