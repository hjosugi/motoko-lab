#!/usr/bin/env node
// Fetches everything the replica suites need that is not in the repository:
//
//   * `@dfinity/pic`  - the TypeScript client, from npm
//   * `pocket-ic`     - the replica itself, a GitHub release asset
//   * `didc`          - Candid tooling, used to turn each `.did` into a JS
//                       interface so calls are encoded properly rather than by
//                       hand
//
// Run once:  node tools/pocket-ic/setup.mjs
//
// Version pinning matters here. `@dfinity/pic` speaks one revision of the
// PocketIC HTTP API and the server rejects anything else outright - a
// mismatched pair fails with `missing field ...` from the server's JSON
// deserializer, not with anything that mentions versions. `PIC_SERVER_VERSION`
// is the version `@dfinity/pic@0.22.0` asks for in its own postinstall, and
// `DIDC_RELEASE` is the one `scripts/install_didc.sh` pins for the Candid gate,
// so the whole repository talks to one `didc`.

import { createWriteStream } from 'node:fs';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const PIC_CLIENT_VERSION = '0.22.0';
export const PIC_SERVER_VERSION = '14.0.0';
export const DIDC_RELEASE = '2024-07-29';

const PIC_SERVER_URL = `https://github.com/dfinity/pocketic/releases/download/${PIC_SERVER_VERSION}/pocket-ic-x86_64-linux.gz`;
const DIDC_URL = `https://github.com/dfinity/candid/releases/download/${DIDC_RELEASE}/didc-linux64`;

export const vendorDir = resolve(here, '.pocket-ic');
export const didcPath = resolve(vendorDir, 'didc');
export const serverPath = resolve(here, 'node_modules/@dfinity/pic/pocket-ic');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, destination, { gunzip = false } = {}) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }
  const body = Readable.fromWeb(response.body);
  const out = createWriteStream(destination);
  if (gunzip) {
    await pipeline(body, createGunzip(), out);
  } else {
    await pipeline(body, out);
  }
}

/// True when `setup.mjs` has already run. The suites check this so they can
/// say what to run rather than failing on a missing import.
export async function isInstalled() {
  return (await exists(serverPath)) && (await exists(didcPath));
}

async function main() {
  await mkdir(vendorDir, { recursive: true });

  console.log(`installing @dfinity/pic@${PIC_CLIENT_VERSION}`);
  execFileSync(
    'npm',
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', `@dfinity/pic@${PIC_CLIENT_VERSION}`],
    { cwd: here, stdio: 'inherit' },
  );

  // `--ignore-scripts` skips the package's own postinstall, which would fetch
  // the server for us. Doing it here keeps the version visible in this file
  // instead of hidden in a dependency.
  if (await exists(serverPath)) await rm(serverPath);
  console.log(`downloading pocket-ic ${PIC_SERVER_VERSION}`);
  await download(PIC_SERVER_URL, serverPath, { gunzip: true });
  await chmod(serverPath, 0o755);

  if (!(await exists(didcPath))) {
    console.log(`downloading didc ${DIDC_RELEASE}`);
    await download(DIDC_URL, didcPath);
    await chmod(didcPath, 0o755);
  }

  console.log('');
  console.log('pocket-ic:', execFileSync(serverPath, ['--version']).toString().trim());
  console.log('didc     :', execFileSync(didcPath, ['--version']).toString().trim());
  console.log('');
  console.log('now run: node tools/pocket-ic/run.mjs');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
