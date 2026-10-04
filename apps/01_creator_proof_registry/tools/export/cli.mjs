#!/usr/bin/env node
// Offline CLI over a bundle directory: prove one before trusting it.
//
//   node tools/export/cli.mjs verify <bundle-dir>
//   node tools/export/cli.mjs files  <bundle-dir>
//
// `verify` recomputes every page checksum and both roots and exits non-zero on
// any disagreement, so it is the command a restore runbook wraps. Collecting
// and restoring need a canister actor; that is the `collect`/`restore` API in
// `bundle.mjs`, used by the replica suite and by any client holding an agent.

import { bundleFiles, readBundle, verify } from './bundle.mjs';

const USAGE = `usage: cli.mjs verify <bundle-dir>\n       cli.mjs files <bundle-dir>`;

const [command, directory] = process.argv.slice(2);
if (!command || !directory) {
  console.error(USAGE);
  process.exit(2);
}

try {
  if (command === 'verify') {
    const { bundle } = await verify(directory);
    const summary = bundle.summary;
    console.log(`${summary.format}`);
    console.log(`  source     ${bundle.source.canister}`);
    console.log(`  module     ${bundle.source.moduleHash}`);
    console.log(`  candid     ${bundle.source.candidHash}`);
    console.log(`  policy     storageUris=${summary.policy.includeStorageUris}`);
    console.log(`  commitments ${summary.commitments}  root ${summary.commitmentRoot}`);
    console.log(`  records     ${summary.records} (${summary.activeRecords} active, ${summary.revokedRecords} revoked)  root ${summary.recordRoot}`);
    console.log('  every page checksum and both roots verify');
  } else if (command === 'files') {
    for (const file of await bundleFiles(directory)) console.log(file);
  } else {
    console.error(USAGE);
    process.exit(2);
  }
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
}
