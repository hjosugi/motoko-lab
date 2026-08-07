#!/usr/bin/env node
// Shared machinery for the per-application replica suites.
//
// `mops test` runs pure modules in the Motoko interpreter, which is the fast
// loop and the right place for input bounds and state-machine logic. It is not
// a replica: `moc -r` has no canister installation, no Candid encoding on the
// wire, no upgrade, and no `caller`. Everything an application says about
// authorization, duplicate suppression, and state surviving an upgrade is
// therefore unproven until it runs here.
//
// Each application owns `test/replica.test.mjs` and exports a `suite`. This
// file gives those suites a compiler, a replica, and assertions, so a suite is
// only the part that differs: which canister, which identities, which claims.
//
//   node tools/pocket-ic/setup.mjs     # once
//   node tools/pocket-ic/run.mjs       # all suites
//   node tools/pocket-ic/run.mjs 01    # one

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { didcPath, vendorDir } from './setup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../..');
const buildRoot = resolve(vendorDir, 'build');

/// The pinned compiler. `mops toolchain bin moc` is the normal way to find it;
/// `MOC` overrides so a machine that cannot reach the Mops registry can still
/// run these, the same escape hatch `scripts/vendor_core_offline.sh` exists for.
function moc(appDir) {
  if (process.env.MOC) return process.env.MOC;
  return execFileSync('mops', ['toolchain', 'bin', 'moc'], { cwd: appDir }).toString().trim();
}

/// `--package` for every dependency the app has installed, not just `mo:core`.
///
/// Hardcoding `core` was fine while it was the only dependency in the kit and
/// stopped being fine the moment an app had a second one:
/// `apps/01_creator_proof_registry` imports `mo:sha2` and `mo:ic-certification`.
///
/// `mops sources` is asked rather than `.mops/` scanned, because the directory
/// name is not the package name once two major versions of the same package are
/// installed. `ic-certification` brings its own `base`, `core` and `sha2`, and
/// mops resolves those to `base@0`, `core@1` and `sha2@0` while ours stay
/// unqualified. A scan would emit `--package core` twice and the compiler would
/// take whichever came first.
function packageArgs(appDir) {
  return execFileSync('mops', ['sources'], { cwd: appDir })
    .toString()
    .split('\n')
    .filter((line) => line.startsWith('--package'))
    .flatMap((line) => {
      const [, name, path] = line.split(/\s+/);
      return ['--package', name, resolve(appDir, path)];
    });
}

/// Compiles one canister with the pinned compiler and generates its JS binding
/// from the **checked-in** `.did`. Using the committed interface rather than
/// one regenerated here is deliberate: `scripts/check_candid_compat.py` already
/// proves the two agree, so a suite that fails to encode is telling you the
/// interface is wrong, not that the harness disagrees with the compiler.
export async function buildCanister({ appDir, main, did, name }) {
  const out = resolve(buildRoot, name);
  await mkdir(out, { recursive: true });
  const compiler = moc(appDir);

  execFileSync(
    compiler,
    ['-c', ...packageArgs(appDir), '-o', `${out}/${name}.wasm`, resolve(appDir, main)],
    { cwd: appDir, stdio: ['ignore', 'inherit', 'pipe'] },
  );
  const js = execFileSync(didcPath, ['bind', resolve(appDir, did), '-t', 'js']).toString();
  await writeFile(`${out}/${name}.idl.mjs`, js);

  return { wasm: `${out}/${name}.wasm`, idl: `${out}/${name}.idl.mjs` };
}

// ---------------------------------------------------------------- assertions

/// Counts assertions so a suite that silently stops testing is visible. A run
/// that reports fewer checks than the last one is a regression even when it is
/// green.
export class Checks {
  constructor(label) {
    this.label = label;
    this.count = 0;
  }

  ok(condition, description) {
    this.count += 1;
    if (!condition) throw new Error(`FAILED: ${description}`);
    console.log(`  ok  ${description}`);
  }

  /// Asserts a call returned `#ok` and hands back the payload.
  expectOk(result, description) {
    if (!result || !('ok' in result)) {
      throw new Error(`FAILED: ${description} -> ${JSON.stringify(result, bigintSafe)}`);
    }
    this.count += 1;
    console.log(`  ok  ${description}`);
    return result.ok;
  }

  /// Asserts a call returned `#err` **with the expected variant**, and hands
  /// back its payload. Asserting only "it failed" passes when the endpoint is
  /// broken for a reason that has nothing to do with the test.
  expectErr(result, variant, description) {
    const failed = result && 'err' in result;
    if (!failed || !(variant in result.err)) {
      throw new Error(`FAILED: ${description} -> expected #${variant}, got ${JSON.stringify(result, bigintSafe)}`);
    }
    this.count += 1;
    console.log(`  ok  ${description} -> ${variant}`);
    return result.err[variant];
  }

  /// Asserts `body` rejects, **with the expected error class**. Used for the
  /// client-side verification failures, which are thrown rather than returned:
  /// a check that only asserted "it threw" would pass on a typo in the test.
  async expectThrows(body, expected, description) {
    let thrown = null;
    try {
      await body();
    } catch (error) {
      thrown = error;
    }
    if (thrown === null) {
      throw new Error(`FAILED: ${description} -> it did not throw`);
    }
    if (!(thrown instanceof expected)) {
      throw new Error(`FAILED: ${description} -> expected ${expected.name}, got ${thrown}`);
    }
    this.count += 1;
    console.log(`  ok  ${description} -> ${thrown.name}`);
    return thrown;
  }
}

/// Byte-wise equality for the digests and roots the certified paths compare.
export function equalBytes(a, b) {
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export const bigintSafe = (_key, value) => (typeof value === 'bigint' ? Number(value) : value);

/// 32 bytes, the digest width every application validates against. Derived from
/// a seed so a suite reads as data rather than as a wall of hex.
export function digest(seed) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed * 31 + i * 7) & 0xff;
  return bytes;
}

/// A salt inside the 16..64 byte window the applications accept.
export function salt(seed, length = 32) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (seed * 17 + i * 11) & 0xff;
  return bytes;
}

// ------------------------------------------------------------------ replica

/// Upgrades a canister, keeping its heap.
///
/// `pic.upgradeCanister()` cannot do this. Every application here is a
/// `persistent actor`, which compiles to enhanced orthogonal persistence, and
/// the replica refuses an upgrade of such a canister unless the install request
/// carries `wasm_memory_persistence`:
///
///     Missing upgrade option: Enhanced orthogonal persistence requires the
///     `wasm_memory_persistence` upgrade option.
///
/// `UpgradeCanisterOptions` in `@dfinity/pic@0.22.0` has no field for it, so the
/// convenience method cannot upgrade any of these canisters. Going to
/// `install_code` on the management canister directly is what is left.
///
/// `keep`, not `replace`: `replace` discards the heap, which would make every
/// "state survives an upgrade" assertion below pass for the wrong reason — a
/// blank canister has no stale state to disagree with either.
export async function upgradeCanister({ pic, canisterId, wasm, sender, arg = new Uint8Array() }) {
  const { MANAGEMENT_CANISTER_ID, encodeInstallCodeRequest } = await import(
    '@dfinity/pic/dist/management-canister.js'
  );
  const payload = encodeInstallCodeRequest({
    arg,
    wasm_module: new Uint8Array(await readFile(wasm)),
    mode: { upgrade: [{ skip_pre_upgrade: [], wasm_memory_persistence: [{ keep: null }] }] },
    canister_id: canisterId,
  });
  // `sender` must be a controller. `icp deploy` makes the currently selected
  // identity the controller, so passing the installer here is what a real
  // upgrade looks like; anyone else gets `CanisterInvalidController`.
  await pic.updateCall({
    canisterId: MANAGEMENT_CANISTER_ID,
    sender,
    method: 'install_code',
    arg: payload,
  });
}

/// Runs `body` against a fresh replica and shuts it down afterwards, including
/// when the suite throws. A leaked `pocket-ic` process holds its port and makes
/// the *next* run fail with something unrelated.
export async function withReplica(body) {
  const { PocketIc, PocketIcServer, createIdentity } = await import('@dfinity/pic');

  const server = await PocketIcServer.start();
  let pic;
  try {
    pic = await PocketIc.create(server.getUrl());
    return await body({ pic, createIdentity });
  } finally {
    if (pic) await pic.tearDown().catch(() => {});
    await server.stop().catch(() => {});
  }
}
