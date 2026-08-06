// Cross-check this repository's RFC 8785 implementation against two others.
//
// `provenance-cli.test.mjs` proves the implementation matches its own recorded
// expectations, and those expectations came from this implementation. That is
// circular for everything except the six official vectors. This script closes
// the loop by running the same inputs through two implementations nobody here
// wrote:
//
//   * `serde_jcs`, the Rust crate, via a throwaway cargo project
//   * `canonicalize`, the npm package by the author of the reference test data
//
// It is not part of `run_offline_checks.sh` and not part of CI. It needs
// `cargo`, `npm`, and network access on first run, and none of those belong in
// a gate that has to work in a sandbox. Run it when the canonicalization
// changes, and record the result in protocol/CANONICALIZATION.md.
//
//   node protocol/tools/crosscheck.mjs
//   KEEP=1 node protocol/tools/crosscheck.mjs   # leave the build tree in place

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { canonicalizeText } from "./provenance-cli.mjs";
import { JcsError } from "./jcs.mjs";

// Pinned, like every other tool in this kit. A cross-check that silently
// changes what it compares against is not a cross-check.
const SERDE_JCS = "0.2.0";
const SERDE_JSON = "1.0.151";
const CANONICALIZE_NPM = "3.0.0";

const here = dirname(fileURLToPath(import.meta.url));
const protocolRoot = resolve(here, "..");
const read = (relative) => readFile(resolve(protocolRoot, relative), "utf8");

const RUST_MAIN = `use std::io::Read;
fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let value: serde_json::Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(e) => { eprintln!("PARSE_ERROR {e}"); std::process::exit(2); }
    };
    match serde_jcs::to_string(&value) {
        Ok(s) => print!("{s}"),
        Err(e) => { eprintln!("SERIALIZE_ERROR {e}"); std::process::exit(3); }
    }
}
`;

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
  await mkdir(resolve(project, "src"), { recursive: true });
  await writeFile(
    resolve(project, "Cargo.toml"),
    `[package]\nname = "jcs-crosscheck"\nversion = "0.0.0"\nedition = "2021"\n\n` +
      `[dependencies]\nserde_jcs = "=${SERDE_JCS}"\nserde_json = "=${SERDE_JSON}"\n`,
  );
  await writeFile(resolve(project, "src/main.rs"), RUST_MAIN);
  execFileSync("cargo", ["build", "--release", "--quiet"], { cwd: project, stdio: "inherit" });
  // `CARGO_TARGET_DIR` is commonly set to a shared cache, so ask cargo rather
  // than assuming `target/` sits next to the manifest.
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
      cwd: project,
      encoding: "utf8",
    }),
  );
  return resolve(metadata.target_directory, "release", "jcs-crosscheck");
}

async function installNpm(root) {
  const project = resolve(root, "npm");
  await mkdir(project, { recursive: true });
  await writeFile(resolve(project, "package.json"), `{"name":"jcs-crosscheck","private":true,"type":"module"}\n`);
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--silent", `canonicalize@${CANONICALIZE_NPM}`], {
    cwd: project,
    stdio: "inherit",
  });
  return (await import(resolve(project, "node_modules/canonicalize/lib/canonicalize.js"))).default;
}

function viaRust(binary, text) {
  try {
    // Pipe stderr rather than letting it inherit: half these calls are supposed
    // to fail, and their parse errors are the answer, not output.
    return {
      ok: true,
      output: execFileSync(binary, { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }),
    };
  } catch (error) {
    return { ok: false, output: String(error.stderr ?? error.message).trim() };
  }
}

requireTool("cargo");
requireTool("npm");

const root = await mkdtemp(resolve(tmpdir(), "jcs-crosscheck-"));
let failures = 0;
let compared = 0;
const stricter = [];

try {
  const rustBinary = await buildRust(root);
  const npmCanonicalize = await installNpm(root);

  const cases = [];
  for (const name of ["arrays", "french", "structures", "unicode", "values", "weird"]) {
    cases.push({ name: `official/${name}`, input: await read(`test-vectors/jcs/input/${name}.json`) });
  }
  const edge = JSON.parse(await read("test-vectors/jcs/edge-cases.json"));
  for (const vector of edge.accept) cases.push({ name: `accept/${vector.name}`, input: vector.input });
  for (const name of ["human-only", "ai-assisted"]) {
    cases.push({ name: `example/${name}`, input: await read(`examples/${name}.json`) });
  }

  for (const item of cases) {
    const ours = canonicalizeText(item.input);
    const npm = npmCanonicalize(JSON.parse(item.input));
    const rust = viaRust(rustBinary, item.input);
    compared += 1;
    if (npm !== ours || !rust.ok || rust.output !== ours) {
      failures += 1;
      console.log(`MISMATCH ${item.name}`);
      console.log(`  ours: ${JSON.stringify(ours)}`);
      if (npm !== ours) console.log(`  npm : ${JSON.stringify(npm)}`);
      if (rust.output !== ours) console.log(`  rust: ${JSON.stringify(rust.output)}`);
    }
  }

  // The rejected inputs are the interesting asymmetry. Where `serde_jcs`
  // accepts one, this implementation is stricter than RFC 8785 requires, and
  // that has to be a listed decision rather than an accident.
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
      console.log(`NOT REJECTED ${vector.name}`);
      continue;
    }
    const rust = viaRust(rustBinary, vector.input);
    if (rust.ok !== !vector.alsoRejectedBySerdeJcs) {
      failures += 1;
      console.log(
        `STALE alsoRejectedBySerdeJcs for ${vector.name}: ` +
          `recorded ${vector.alsoRejectedBySerdeJcs}, serde_jcs ${rust.ok ? "accepted" : "rejected"} it`,
      );
    }
    if (rust.ok) stricter.push(vector.name);
  }

  console.log();
  console.log(`serde_jcs ${SERDE_JCS}, serde_json ${SERDE_JSON}, canonicalize ${CANONICALIZE_NPM}`);
  console.log(`${compared} inputs canonicalized identically by all three implementations`);
  console.log(`${edge.reject.length} rejected inputs, of which serde_jcs also rejects ${edge.reject.length - stricter.length}`);
  for (const name of stricter) console.log(`  stricter than serde_jcs: ${name}`);
  console.log(failures === 0 ? "\nCROSS-CHECK: PASS" : `\nCROSS-CHECK: FAIL (${failures})`);
} finally {
  if (!process.env.KEEP) await rm(root, { recursive: true, force: true });
  else console.log(`\nbuild tree kept at ${root}`);
}

process.exitCode = failures === 0 ? 0 : 1;
