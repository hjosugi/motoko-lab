#!/usr/bin/env node
// The migration chain (#16) compiled with the pinned moc and rehearsed on a
// real replica.
//
//   node tools/pocket-ic/setup.mjs                          # once
//   (cd labs/migration-chain && mops install)               # once
//   node labs/migration-chain/test/migration-chain.test.mjs
//
// Version N is built with `--enhanced-migration` over the first N files of
// migrations/ — what the repository would have held when N shipped. Every
// step is checked against what the fixture data must look like, computed here
// from the same rules src/Fixture.mo uses, so "the data survived" means "every
// sampled record is exactly what it should be", not "the canister still
// answers".

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Checks, upgradeCanister, withReplica } from '../../../tools/pocket-ic/harness.mjs';
import { didcPath, isInstalled } from '../../../tools/pocket-ic/setup.mjs';

const lab = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = resolve(lab, 'migrations');

// ------------------------------------------------------------------- building

const moc = () => process.env.MOC ?? execFileSync('mops', ['toolchain', 'bin', 'moc'], { cwd: lab }).toString().trim();
const packages = () =>
  execFileSync('mops', ['sources'], { cwd: lab }).toString().split('\n')
    .filter((line) => line.startsWith('--package'))
    .flatMap((line) => {
      const [, name, path] = line.split(/\s+/);
      return ['--package', name, resolve(lab, path)];
    });

/// Stages the first `steps` migrations, optionally replacing some by name.
async function stageMigrations(dir, steps, replace = {}) {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.mo')).sort().slice(0, steps);
  await mkdir(dir, { recursive: true });
  for (const file of files) await copyFile(replace[file] ?? resolve(MIGRATIONS, file), resolve(dir, file));
  return files;
}

function compile({ main, migrations, out, extra = [] }) {
  return spawnSync(moc(), [...packages(), '--enhanced-migration', migrations, ...extra, main, '-o', out], {
    cwd: lab,
    encoding: 'utf8',
  });
}

async function build(work, name, { main, steps, replace }) {
  const dir = resolve(work, name);
  const migrations = resolve(dir, 'migrations');
  await stageMigrations(migrations, steps, replace);
  const wasm = resolve(dir, `${name}.wasm`);
  let result = compile({ main, migrations, out: wasm, extra: ['-c', '--stable-types'] });
  if (result.status !== 0) throw new Error(`${name} did not compile:\n${result.stderr}`);
  result = compile({ main, migrations, out: resolve(dir, `${name}.did`), extra: ['--idl'] });
  if (result.status !== 0) throw new Error(`${name} --idl failed:\n${result.stderr}`);
  const js = execFileSync(didcPath, ['bind', resolve(dir, `${name}.did`), '-t', 'js']).toString();
  await writeFile(resolve(dir, `${name}.idl.mjs`), js);
  const { idlFactory } = await import(resolve(dir, `${name}.idl.mjs`));
  return { wasm, most: resolve(dir, `${name}.most`), idlFactory };
}

// --------------------------------------------------------------- expectations

const SEEDED_REASON = 'fixture revocation';
const seededHash = (id) => Uint8Array.from({ length: 32 }, (_, i) => (id * 31 + i * 7) % 256);

/// What a seeded record must look like at schema `version`, from the rules in
/// src/Fixture.mo and the three migrations.
function expected(id, version) {
  const revoked = id % 7 === 0;
  const status = !revoked ? { active: null }
    : version === 1 ? { revoked: SEEDED_REASON }
      : { revoked: { reason: SEEDED_REASON, at: [] } };
  return { title: `fixture-${id}`, hash: Buffer.from(seededHash(id)).toString('hex'), status, license: version >= 3 ? [] : undefined };
}

/// JSON with bigints as strings and object keys sorted: Candid decodes record
/// fields in hash order, which is not the order anyone writes them in.
const bigintJson = (value) => JSON.stringify(value, (_, v) => {
  if (typeof v === 'bigint') return v.toString();
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)) {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
  }
  return v;
});

function matches(view, id, version) {
  if (!view) return false;
  const want = expected(id, version);
  return view.title === want.title
    && Buffer.from(view.artifactHash).toString('hex') === want.hash
    && bigintJson(view.status) === bigintJson(want.status)
    && (want.license === undefined ? !('license' in view) : bigintJson(view.license) === bigintJson(want.license));
}

/// Ids worth looking at in a store of `count` seeded records: both ends, the
/// middle, revoked ones, and a deterministic spread.
function sample(count) {
  const ids = new Set([1, 7, 14, Math.max(1, Math.floor(count / 2)), count, count - 1]);
  for (let k = 1; k <= 40; k++) ids.add(1 + ((k * 2654435761) % count));
  return [...ids].filter((id) => id >= 1 && id <= count).sort((a, b) => a - b);
}

async function allMatch(actor, count, version) {
  for (const id of sample(count)) {
    const [view] = await actor.get(BigInt(id));
    if (!matches(view, id, version)) {
      console.error(`   record ${id} at schema ${version}: ${bigintJson(view)} vs ${bigintJson(expected(id, version))}`);
      return false;
    }
  }
  return true;
}

const seededRevoked = (count) => Math.floor(count / 7);

async function seed(actor, count) {
  for (let done = 0; done < count;) {
    const batch = Math.min(20_000, count - done);
    await actor.seed(BigInt(batch));
    done += batch;
  }
}

async function rejects(body) {
  try {
    await body();
    return null;
  } catch (error) {
    return error;
  }
}

// ---------------------------------------------------------------------- suite

async function suite({ pic, createIdentity, checks: c, builds }) {
  const deployer = createIdentity('deployer');
  const sender = deployer.getPrincipal();
  const alice = createIdentity('alice');

  async function install(build) {
    const fixture = await pic.setupCanister({ idlFactory: build.idlFactory, wasm: build.wasm, sender });
    fixture.actor.setIdentity(deployer);
    return fixture.canisterId;
  }
  const actorFor = (build, canisterId, identity = deployer) => {
    const actor = pic.createActor(build.idlFactory, canisterId);
    actor.setIdentity(identity);
    return actor;
  };
  const upgrade = (canisterId, build) => upgradeCanister({ pic, canisterId, wasm: build.wasm, sender });

  // ------------------------------------------------------------ empty state
  let id = await install(builds.V1);
  let stats = await actorFor(builds.V1, id).stats();
  c.ok(stats.schemaVersion === 1n && stats.records === 0n && stats.nextId === 1n, 'empty: V1 installs from the Init migration alone');
  await upgrade(id, builds.V2);
  stats = await actorFor(builds.V2, id).stats();
  c.ok(stats.schemaVersion === 2n && stats.records === 0n && stats.revoked === 0n, 'empty: V1 -> V2 applies migration 2 to no records');
  await upgrade(id, builds.V3);
  stats = await actorFor(builds.V3, id).stats();
  c.ok(stats.schemaVersion === 3n && stats.records === 0n && stats.legacy === 0n, 'empty: V2 -> V3 applies migration 3');
  const fresh = await install(builds.V3);
  stats = await actorFor(builds.V3, fresh).stats();
  c.ok(stats.schemaVersion === 3n && stats.nextId === 1n, 'a fresh V3 install runs the whole chain, which is the only source of initial values');

  // --------------------------------------------- large map, revoked variants
  const LARGE = 30_000;
  const main = await install(builds.V1);
  let v1 = actorFor(builds.V1, main);
  await seed(v1, LARGE);
  const asAlice1 = actorFor(builds.V1, main, alice);
  const aliceId = Number(await asAlice1.register(seededHash(0), 'alice original'));
  c.ok(await asAlice1.revoke(BigInt(aliceId), 'withdrawn by alice'), 'V1: alice registers and revokes a record of her own');
  stats = await v1.stats();
  const total = LARGE + 1;
  c.ok(stats.records === BigInt(total) && stats.revoked === BigInt(seededRevoked(LARGE) + 1), `V1 holds ${total} records, ${seededRevoked(LARGE) + 1} revoked`);
  c.ok(await allMatch(v1, LARGE, 1), 'V1: every sampled record is exactly the seeded one');

  await upgrade(main, builds.V2);
  const v2 = actorFor(builds.V2, main);
  stats = await v2.stats();
  c.ok(stats.schemaVersion === 2n && stats.records === BigInt(total) && stats.nextId === BigInt(total + 1),
    'V1 -> V2: no record lost, ids keep counting');
  c.ok(stats.revoked === BigInt(seededRevoked(LARGE) + 1), 'the revoked counter migration 2 derived equals the V1 scan');
  c.ok(await allMatch(v2, LARGE, 2), 'V2: every sampled record is carried over, revocations reshaped with at = null');
  const [aliceV2] = await v2.get(BigInt(aliceId));
  c.ok(bigintJson(aliceV2.status) === bigintJson({ revoked: { reason: 'withdrawn by alice', at: [] } }) && aliceV2.owner.toText() === alice.getPrincipal().toText(),
    'a pre-V2 revocation keeps its reason and does not invent a time');
  const eager = stats.upgradeInstructions;

  await upgrade(main, builds.V2);
  stats = await v2.stats();
  c.ok(stats.schemaVersion === 2n && stats.records === BigInt(total) && stats.upgradeInstructions < eager / 10n,
    `redeploying V2 is a no-op: migration 2 is not applied twice (${stats.upgradeInstructions} vs ${eager} instructions)`);

  await upgrade(main, builds.V3);
  const v3 = actorFor(builds.V3, main);
  stats = await v3.stats();
  c.ok(stats.schemaVersion === 3n && stats.records === BigInt(total) && stats.legacy === BigInt(total), 'V2 -> V3: every record is still legacy — migration 3 touched none');
  c.ok(await allMatch(v3, LARGE, 3), 'V3: every sampled legacy record reads in the V3 shape, license null');
  const lazy = stats.upgradeInstructions;
  const afterV3 = stats;
  c.ok(lazy * 5n < eager, `the lazy step costs a fraction of the eager one on the same data (${lazy} vs ${eager})`);

  const asAlice3 = actorFor(builds.V3, main, alice);
  const second = Number(await asAlice3.register(seededHash(1), 'alice second'));
  c.ok(await asAlice3.setLicense(BigInt(second), 'CC-BY-4.0'), 'V3: alice licenses a new record');
  c.ok(!(await asAlice3.revoke(BigInt(aliceId), 'again')), 'a record revoked under V1 stays revoked under V3');
  stats = await v3.stats();
  c.ok(stats.legacy === BigInt(total), 'writes to new records do not disturb the legacy map');
  let remaining = await v3.drainLegacy(12_000n);
  c.ok(remaining === BigInt(total - 12_000), 'drainLegacy moves a bounded batch');
  while (remaining > 0n) remaining = await v3.drainLegacy(12_000n);
  stats = await v3.stats();
  c.ok(stats.legacy === 0n && stats.records === BigInt(total + 1), 'after draining, every record is in the V3 map and none was lost');
  c.ok(await allMatch(v3, LARGE, 3), 'and every sampled record reads exactly as before the drain');
  const [licensed] = await v3.get(BigInt(second));
  c.ok(bigintJson(licensed.license) === bigintJson(['CC-BY-4.0']), 'the license written under V3 survives the drain');

  // ----------------------------------------------------------------- sizes
  const measurements = [];
  for (const size of [0, 1_000, 10_000]) {
    const canister = await install(builds.V1);
    await seed(actorFor(builds.V1, canister), size);
    await upgrade(canister, builds.V2);
    const s2 = await actorFor(builds.V2, canister).stats();
    await upgrade(canister, builds.V3);
    const s3 = await actorFor(builds.V3, canister).stats();
    measurements.push({ size, eager: s2.upgradeInstructions, lazy: s3.upgradeInstructions, heap: s3.heapBytes, memory: s3.memoryBytes });
  }
  measurements.push({ size: total, eager, lazy, heap: afterV3.heapBytes, memory: afterV3.memoryBytes });
  console.log('     records    eager (V1->V2)    lazy (V2->V3)    heap bytes');
  for (const m of measurements) {
    console.log(`  ${String(m.size).padStart(10)} ${String(m.eager).padStart(17)} ${String(m.lazy).padStart(16)} ${String(m.heap).padStart(13)}`);
  }
  const [m0, m1k, m10k] = measurements;
  c.ok(m10k.eager > m1k.eager * 5n, 'the eager step grows with the data (10k vs 1k records)');
  c.ok(m10k.lazy < m0.lazy * 2n + 1_000_000n, 'the lazy step does not');

  // ---------------------------------------------------------- fast-forward
  const behind = await install(builds.V1);
  await seed(actorFor(builds.V1, behind), 2_000);
  await upgrade(behind, builds.V3);
  stats = await actorFor(builds.V3, behind).stats();
  c.ok(stats.schemaVersion === 3n && stats.records === 2_000n && stats.revoked === BigInt(seededRevoked(2_000)),
    'fast-forward: a canister left on V1 upgrades straight to V3, applying migrations 2 and 3 in order');
  c.ok(await allMatch(actorFor(builds.V3, behind), 2_000, 3), 'and ends in exactly the state of one that took every step');

  // ------------------------------------------------- interrupted rollout
  const rollout = await install(builds.V2);
  const r2 = actorFor(builds.V2, rollout);
  await seed(r2, 700);
  const failure = await rejects(() => upgrade(rollout, builds.V3trapping));
  c.ok(failure !== null && /unexpected revoked record/.test(failure.message), 'the broken migration 3 traps during the upgrade');
  stats = await r2.stats();
  c.ok(stats.schemaVersion === 2n && stats.records === 700n && await allMatch(r2, 700, 2), 'the upgrade rolled back: V2 still serves the untouched state');
  c.ok((await r2.register(seededHash(2), 'written after the failed rollout')) === 701n, 'and keeps accepting writes');
  await upgrade(rollout, builds.V3);
  stats = await actorFor(builds.V3, rollout).stats();
  c.ok(stats.schemaVersion === 3n && stats.records === 701n && stats.legacy === 701n,
    'the fixed V3 then applies migration 3 as if the broken one had never been tried');

  // ------------------------------------------------------------- downgrade
  const down = await rejects(() => upgrade(rollout, builds.V2));
  c.ok(down !== null, 'downgrading V3 -> V2 is refused by the replica');
  const downV1 = await rejects(() => upgrade(rollout, builds.V1));
  c.ok(downV1 !== null, 'and so is V3 -> V1');
  stats = await actorFor(builds.V3, rollout).stats();
  c.ok(stats.schemaVersion === 3n && stats.records === 701n, 'the refused downgrades left V3 and its data in place');
  return { down: down.message, measurements };
}

// ------------------------------------------------------- compile-time gates

async function gates(work, builds, c) {
  // Stable signatures are compared semantically, with moc itself. They are
  // not committed as snapshots: the type names in a .most file carry hashes
  // that depend on the absolute source paths, so a byte comparison would fail
  // on every other machine for no reason.
  const compatible = (pre, post) =>
    spawnSync(moc(), ['--stable-compatible', builds[pre].most, builds[post].most], { encoding: 'utf8' });
  for (const [pre, post] of [['V1', 'V2'], ['V2', 'V3'], ['V1', 'V3']]) {
    c.ok(compatible(pre, post).status === 0, `moc --stable-compatible ${pre}.most ${post}.most passes`);
  }
  for (const [pre, post] of [['V3', 'V2'], ['V2', 'V1']]) {
    const result = compatible(pre, post);
    c.ok(result.status !== 0 && result.stderr.includes('M0169'), `moc --stable-compatible ${pre}.most ${post}.most fails with M0169 (a downgrade drops stable variables)`);
  }

  // The gate that must bite: V3 with one edit no migration accounts for. The
  // legacy record type gains a required field. The actor body still
  // type-checks (nothing constructs a legacy record, and a wider record is a
  // subtype of a narrower one), so the only thing that can reject it is the
  // chain check: migration 2 produced records without that field, and nothing
  // since has added it. If this ever compiles, that check has stopped working.
  const source = await readFile(resolve(lab, 'src/V3.mo'), 'utf8');
  const broken = source.replace('  type LegacyRecord = {\n    owner : Principal;', '  type LegacyRecord = {\n    note : Text;\n    owner : Principal;');
  c.ok(broken !== source, 'the incompatible fixture differs from V3 in exactly one declaration');
  const dir = resolve(work, 'incompatible');
  await mkdir(resolve(dir, 'src'), { recursive: true });
  await writeFile(resolve(dir, 'src/V3.mo'), broken);
  await copyFile(resolve(lab, 'src/Fixture.mo'), resolve(dir, 'src/Fixture.mo'));
  await stageMigrations(resolve(dir, 'migrations'), 3);
  const result = compile({ main: resolve(dir, 'src/V3.mo'), migrations: resolve(dir, 'migrations'), out: resolve(dir, 'out.wasm'), extra: ['-c'] });
  const code = /\[(M\d{4})\]/.exec(result.stderr)?.[1];
  c.ok(result.status !== 0 && code === 'M0170' && result.stderr.includes('stable variable `records`'),
    `a legacy record type the chain never produced does not compile: ${code}, a compatibility error, not a type error`);
  return code;
}

async function main() {
  if (!(await isInstalled())) {
    console.error('pocket-ic is not installed. Run: node tools/pocket-ic/setup.mjs');
    return 127;
  }
  console.log(`== migration chain (${execFileSync(moc(), ['--version']).toString().trim()}) ==`);
  const checks = new Checks('migration-chain');
  const work = await mkdtemp(resolve(tmpdir(), 'migration-chain-'));
  try {
    // Everything is compiled before the replica starts: pocket-ic stops itself
    // after a minute without requests.
    const builds = {
      V1: await build(work, 'V1', { main: resolve(lab, 'src/V1.mo'), steps: 1 }),
      V2: await build(work, 'V2', { main: resolve(lab, 'src/V2.mo'), steps: 2 }),
      V3: await build(work, 'V3', { main: resolve(lab, 'src/V3.mo'), steps: 3 }),
      V3trapping: await build(work, 'V3trapping', {
        main: resolve(lab, 'src/V3.mo'),
        steps: 3,
        replace: { '20261001_000000_LicenseLazy.mo': resolve(lab, 'fixtures/trapping-migration/20261001_000000_LicenseLazy.mo') },
      }),
    };
    const code = await gates(work, builds, checks);
    const result = await withReplica(({ pic, createIdentity }) => suite({ pic, createIdentity, checks, builds }));
    console.log(`   incompatible edit rejected with ${code}; downgrade refused with: ${result.down.split('\n').find((l) => /rror|trap/.test(l))?.trim().slice(0, 160)}`);
  } catch (error) {
    console.error(`   after ${checks.count} checks: ${error.message}`);
    return 1;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  console.log(`   ${checks.count} checks passed`);
  return 0;
}

process.exit(await main());
