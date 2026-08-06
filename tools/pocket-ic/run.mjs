#!/usr/bin/env node
// Runs the per-application replica suites.
//
//   node tools/pocket-ic/setup.mjs     # once
//   node tools/pocket-ic/run.mjs       # every suite
//   node tools/pocket-ic/run.mjs 01 03 # only these
//
// Each suite gets a **fresh replica**. Sharing one would let a canister
// installed by an earlier suite change what a later one observes, and the point
// of these tests is that nothing carries over except through an upgrade the
// suite performs itself.

import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isInstalled, PIC_SERVER_VERSION } from './setup.mjs';
import { Checks, repoRoot, withReplica } from './harness.mjs';

const SUITE = 'test/replica.test.mjs';

async function discover(filters) {
  const appsDir = resolve(repoRoot, 'apps');
  const apps = (await readdir(appsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const selected = [];
  for (const app of apps) {
    if (filters.length && !filters.some((f) => app.startsWith(f) || app === f)) continue;
    const appDir = resolve(appsDir, app);
    try {
      const module = await import(resolve(appDir, SUITE));
      selected.push({ app, appDir, module });
    } catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND') continue;
      throw error;
    }
  }
  return selected;
}

async function main() {
  if (!(await isInstalled())) {
    console.error('pocket-ic is not installed. Run: node tools/pocket-ic/setup.mjs');
    return 127;
  }

  const filters = process.argv.slice(2);
  const suites = await discover(filters);
  if (!suites.length) {
    console.error(filters.length ? `no replica suite matches ${filters.join(', ')}` : 'no replica suites found');
    return 1;
  }

  console.log(`pocket-ic ${PIC_SERVER_VERSION}, ${suites.length} suite(s)\n`);

  const results = [];
  let failed = 0;
  for (const { app, appDir, module } of suites) {
    console.log(`== ${app} ==`);
    // The counter is created here, not inside the suite, so a suite that throws
    // still reports how far it got. "Failed after 34 checks" locates the
    // problem; "failed" does not.
    const checks = new Checks(app);
    try {
      await withReplica(({ pic, createIdentity }) => module.suite({ appDir, pic, createIdentity, checks }));
      results.push({ app, checks: checks.count });
      console.log(`   ${checks.count} checks passed\n`);
    } catch (error) {
      failed += 1;
      results.push({ app, checks: checks.count, error: error.message });
      console.error(`   after ${checks.count} checks: ${error.message}\n`);
    }
  }

  const total = results.reduce((sum, r) => sum + (r.checks ?? 0), 0);
  console.log('== summary ==');
  for (const r of results) {
    console.log(`  ${r.error ? 'FAIL' : ' ok '}  ${r.app}  ${r.checks} checks${r.error ? ` — ${r.error}` : ''}`);
  }
  console.log(`\n${total} checks across ${results.length} application(s), ${failed} failed`);
  return failed ? 1 : 0;
}

process.exit(await main());
