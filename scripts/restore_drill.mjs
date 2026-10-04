#!/usr/bin/env node
// The quarterly restore drill (issue #25), automated.
//
//   source scripts/toolchain_env.sh && motoko_add_toolchain_to_path
//   node scripts/restore_drill.mjs
//
// A backup is a claim until a restore has been rehearsed against it. This
// drill, on a fresh PocketIC replica:
//
//   1. installs the registry, seeds a fixture with an active and a revoked
//      record, and exports it through the portable format (#19);
//   2. corrupts a page and requires verification to reject it;
//   3. simulates the lost-deploy-key scenario by moving the controller to a
//      second identity and requiring the old key to be powerless and the new
//      one able to upgrade and restore;
//   4. restores into a fresh canister and requires counts, roots, the artifact
//      index, the revoked status and a certified query to match;
//   5. writes validation/restore-drill.json with the checks, the elapsed time
//      and the RTO/RPO targets, and exits non-zero if any check failed.
//
// The report is the evidence; `docs/35_DISASTER_RECOVERY.md` is the runbook an
// independent operator follows. The scheduled `Drill` workflow runs this on a
// quarterly cron and on manual dispatch.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildCanister, repoRoot, upgradeCanister, withReplica } from '../tools/pocket-ic/harness.mjs';
import { verifyCertifiedValue } from '../tools/pocket-ic/certificate.mjs';
import { commitmentHex } from '../protocol/tools/commitment.mjs';
import { collect, verify as verifyBundle, restore as restoreBundle } from '../apps/01_creator_proof_registry/tools/export/bundle.mjs';
import { encodeRecord, recordDigest, recordPath } from '../apps/01_creator_proof_registry/test/record-digest.mjs';

const APP_DIR = resolve(repoRoot, 'apps/01_creator_proof_registry');
const REPORT = resolve(repoRoot, 'validation/restore-drill.json');
const RTO_SECONDS = 3_600; // restore into a serving canister within an hour
const RPO_SECONDS = 86_400; // an export no older than a day for tier-1 evidence
const DRILL_TARGET_SECONDS = 900; // the automated drill itself

const checks = [];
function ok(condition, description) {
  checks.push({ check: description, passed: Boolean(condition) });
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${description}`);
}

function digest(seed) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 31 + i * 7) & 0xff;
  return bytes;
}

function salt(seed) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 17 + i * 11) & 0xff;
  return bytes;
}

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const unhex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
const equalBytes = (a, b) => Buffer.from(a).equals(Buffer.from(b));

async function main() {
  const startedAt = new Date();
  console.log(`restore drill: ${startedAt.toISOString()}\n`);

  const { wasm, idl } = await buildCanister({
    appDir: APP_DIR,
    name: 'creator_proof_registry',
    main: 'backend/src/main.mo',
    did: 'backend/candid/backend.did',
  });
  const { idlFactory } = await import(idl);
  const moduleHash = createHash('sha256').update(await readFile(wasm)).digest('hex');
  const candidHash = createHash('sha256')
    .update(await readFile(resolve(APP_DIR, 'backend/candid/backend.did')))
    .digest('hex');

  const directory = await mkdtemp(join(tmpdir(), 'restore-drill-'));
  const report = {
    format: 'motoko-lab:restore-drill:v1',
    startedAt: startedAt.toISOString(),
    completedAt: null,
    targetSeconds: { rto: RTO_SECONDS, rpo: RPO_SECONDS, drill: DRILL_TARGET_SECONDS },
    versions: { pocketIc: '14.0.0', moduleSha256: moduleHash, candidSha256: candidHash },
    checks,
  };
  let failure = null;

  try {
    await withReplica(async ({ pic, createIdentity }) => {
      const oldController = createIdentity('lost-deploy-key');
      const newController = createIdentity('recovery-controller');
      const alice = createIdentity('alice');
      const oldSender = oldController.getPrincipal();

      // ------------------------------------------------ source and fixture
      const source = await pic.setupCanister({ idlFactory, wasm, sender: oldSender });
      const actor = source.actor;
      actor.setIdentity(alice);
      const commitmentFor = (principal, seed) => unhex(commitmentHex({
        principal: principal.toText(),
        manifestHash: hex(digest(seed + 100)),
        salt: hex(salt(seed)),
      }));
      const revealInput = (id, seed, overrides = {}) => ({
        commitmentId: id,
        artifactHash: digest(seed),
        manifestHash: digest(seed + 100),
        salt: salt(seed),
        title: `drill artifact ${seed}`,
        kind: 'image',
        mimeType: 'image/png',
        storageUri: `ipfs://drill-${seed}`,
        parents: [],
        ai: { assisted: false, mode: { none: null }, provider: [], model: [], promptHash: [], humanContribution: [] },
        algorithm: [],
        collection: [],
        ...overrides,
      });
      const first = await actor.commit({ commitmentHash: commitmentFor(alice.getPrincipal(), 1), metadataHash: [], expiresAt: [] });
      const firstRecord = await actor.reveal(revealInput(first.ok.id, 1));
      const second = await actor.commit({ commitmentHash: commitmentFor(alice.getPrincipal(), 2), metadataHash: [], expiresAt: [] });
      await actor.reveal(revealInput(second.ok.id, 2));
      await actor.revokeRecord(firstRecord.ok.id, 'drill revocation');
      const before = await actor.stats();
      ok(before.records === 2n && before.revokedRecords === 1n, 'the fixture has two records, one revoked');

      // ------------------------------------------------------------ export
      const bundle = await collect({
        source: actor,
        policy: { includeStorageUris: true },
        directory,
        sourceInfo: {
          canister: source.canisterId.toText(),
          moduleHash,
          candidHash,
          schema: 'icp-creator-proof:export:v1',
        },
        pageLimit: 1,
      });
      ok(bundle.entries.records.length === 2 && bundle.entries.commitments.length === 2,
        'the export holds every commitment and record');

      // A corrupt snapshot is detected, not trusted. The page is restored
      // afterwards so the drill can continue.
      const pageFile = resolve(directory, bundle.bundle.pages.records[0].file);
      const originalPage = await readFile(pageFile, 'utf-8');
      const tampered = JSON.parse(originalPage);
      tampered.entries[0].title = 'corrupted snapshot';
      await writeFile(pageFile, JSON.stringify(tampered), 'utf-8');
      let corruptionCaught = false;
      try {
        await verifyBundle(directory);
      } catch (error) {
        corruptionCaught = error.message.includes('checksum');
      }
      ok(corruptionCaught, 'a corrupted snapshot fails verification');
      await writeFile(pageFile, originalPage, 'utf-8');

      // -------------------------------------------- controller recovery
      // The deploy key is presumed lost. The recovery controller is added
      // through the management canister; the old key must then be powerless.
      await pic.updateCanisterSettings({
        canisterId: source.canisterId,
        controllers: [newController.getPrincipal()],
        sender: oldSender,
      });
      let oldKeyPowerless = false;
      try {
        await upgradeCanister({ pic, canisterId: source.canisterId, wasm, sender: oldSender });
      } catch (error) {
        oldKeyPowerless = String(error.message).includes('InvalidController')
          || String(error.message).toLowerCase().includes('controller');
      }
      ok(oldKeyPowerless, 'the lost key can no longer upgrade the canister');
      await upgradeCanister({ pic, canisterId: source.canisterId, wasm, sender: newController.getPrincipal() });
      ok(true, 'the recovery controller can upgrade the canister');

      // ----------------------------------------------------------- restore
      const restoreStarted = Date.now();
      const target = await pic.setupCanister({ idlFactory, wasm, sender: newController.getPrincipal() });
      target.actor.setIdentity(newController);
      const restored = await restoreBundle({
        directory,
        target: target.actor,
        targetCanister: target.canisterId,
        chunk: 1,
      });
      const restoreSeconds = (Date.now() - restoreStarted) / 1000;
      ok(restored.commitments === before.commitments && restored.records === before.records,
        'the restored counts equal the exported ones');
      const after = await target.actor.stats();
      ok(after.activeRecords === 1n && after.revokedRecords === 1n, 'the revoked ratio survives the restore');
      ok(equalBytes(
        (await target.actor.exportSummary({ includeStorageUris: true })).recordRoot,
        (await actor.exportSummary({ includeStorageUris: true })).recordRoot,
      ), 'the restored record root equals the source root');
      ok((await target.actor.getByArtifactHash(digest(1)))[0] !== undefined,
        'the artifact index was rebuilt');

      const subnetId = await pic.getCanisterSubnetId(target.canisterId);
      const rootKey = await pic.getPubKey(subnetId);
      const certified = (await target.actor.getRecordCertified(firstRecord.ok.id))[0];
      ok(equalBytes(await verifyCertifiedValue({
        certificate: certified.certificate,
        witness: certified.witness,
        canisterId: target.canisterId,
        rootKey,
        path: recordPath(firstRecord.ok.id),
      }), recordDigest(certified.record)), 'a restored record is certified by the new subnet');
      ok(encodeRecord(certified.record).length > 0, 'the restored record re-encodes for a reader');

      report.restoreSeconds = restoreSeconds;
      ok(restoreSeconds <= RTO_SECONDS, `the restore completed within the RTO (${restoreSeconds.toFixed(1)}s <= ${RTO_SECONDS}s)`);
    });
  } catch (error) {
    failure = error.message;
    console.error(`\ndrill failed: ${error.stack ?? error.message}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const completedAt = new Date();
  const elapsed = (completedAt - startedAt) / 1000;
  report.completedAt = completedAt.toISOString();
  report.elapsedSeconds = elapsed;
  report.status = failure === null && checks.every((entry) => entry.passed) ? 'pass' : 'fail';
  report.failure = failure;
  report.checks = checks;
  await writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  console.log(`\nreport: ${REPORT}`);
  console.log(`status: ${report.status.toUpperCase()} (${checks.filter((entry) => entry.passed).length}/${checks.length} checks, ${elapsed.toFixed(1)}s)`);
  if (report.status !== 'pass') return 1;
  return 0;
}

process.exit(await main());
