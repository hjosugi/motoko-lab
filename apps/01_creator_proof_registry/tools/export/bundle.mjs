// Collecting, verifying, resuming and restoring a portable export.
//
// The canister's pages are the source of truth, but nothing about them is
// believed until `format.mjs` has recomputed the checksums and the roots. This
// module is the loop around that:
//
//   collect()  fetches pages, verifies each one before writing it, and keeps
//              enough state on disk that an interrupted export resumes at the
//              page it stopped at rather than starting over.
//   verify()   reads a bundle back and proves it is the snapshot its summary
//              names — counts, roots, contiguous pages, checksums.
//   restore()  replays a verified bundle into a fresh canister through the
//              restore endpoints and requires the restored summary to equal
//              the exported one.
//
// The bundle is a directory, not one JSON blob: a page is written as soon as
// it verifies, so a crash loses at most the page in flight.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  COMMITMENT_KIND,
  FORMAT_V1,
  PAGE_MAX,
  RECORD_KIND,
  bytesToHex,
  commitmentRoot,
  recordRoot,
  verifyPage,
} from './format.mjs';

export const BUNDLE_FORMAT = 'icp-creator-proof:export-bundle:v1';

const KINDS = {
  commitments: { kind: COMMITMENT_KIND, fetch: 'exportCommitments', restore: 'restoreCommitments' },
  records: { kind: RECORD_KIND, fetch: 'exportRecords', restore: 'restoreRecords' },
};

const bigintSafe = (_key, value) => (typeof value === 'bigint' ? `${value}n` : value);
const bigintFrom = (value) => (value === null || value === undefined ? null : BigInt(value));

/// The bundle codec. JSON has no bigint, blob or principal, so each becomes a
/// tagged object: `{$bigint}`, `{$bytes}`, `{$principal}`. The principal tag
/// restores an object Candid accepts (`_isPrincipal` plus `toUint8Array`),
/// which is all a restore call needs; a real `@dfinity/principal` instance is
/// not required to encode one.
///
/// The checks read `this[key]` rather than `value`: `JSON.stringify` calls
/// `toJSON` before the replacer, and a Principal's `toJSON` is exactly the
/// `__principal__` object that has already lost its bytes.
const encodeValue = function (key, value) {
  const raw = this[key];
  if (raw instanceof Uint8Array) return { $bytes: Buffer.from(raw).toString('hex') };
  if (raw && raw._isPrincipal === true && typeof raw.toUint8Array === 'function') {
    return { $principal: Buffer.from(raw.toUint8Array()).toString('hex') };
  }
  if (typeof raw === 'bigint') return { $bigint: raw.toString() };
  return value;
};

const decodeValue = (_key, value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.$bigint === 'string') return BigInt(value.$bigint);
    if (typeof value.$bytes === 'string') return new Uint8Array(Buffer.from(value.$bytes, 'hex'));
    if (typeof value.$principal === 'string') {
      const bytes = new Uint8Array(Buffer.from(value.$principal, 'hex'));
      return { _isPrincipal: true, toUint8Array: () => bytes };
    }
  }
  return value;
};

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, encodeValue, 2)}\n`, 'utf-8');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf-8'), decodeValue);
}

/// A JSON-safe summary. Bigints become strings; the roots become hex. The
/// canister-side type is what `restoreBegin` takes, so `toCanisterSummary`
/// converts back.
function normalizeSummary(summary) {
  return {
    format: summary.format,
    canister: typeof summary.canister === 'string' ? summary.canister : summary.canister.toText(),
    policy: { includeStorageUris: summary.policy.includeStorageUris },
    commitments: summary.commitments.toString(),
    records: summary.records.toString(),
    activeRecords: summary.activeRecords.toString(),
    revokedRecords: summary.revokedRecords.toString(),
    commitmentRoot: bytesToHex(summary.commitmentRoot),
    recordRoot: bytesToHex(summary.recordRoot),
  };
}

export function toCanisterSummary(summary, canister) {
  return {
    format: summary.format,
    canister,
    policy: { includeStorageUris: summary.policy.includeStorageUris },
    commitments: BigInt(summary.commitments),
    records: BigInt(summary.records),
    activeRecords: BigInt(summary.activeRecords),
    revokedRecords: BigInt(summary.revokedRecords),
    commitmentRoot: Buffer.from(summary.commitmentRoot, 'hex'),
    recordRoot: Buffer.from(summary.recordRoot, 'hex'),
  };
}

export async function readBundle(directory) {
  try {
    return await readJson(resolve(directory, 'bundle.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function loadPages(directory, bundle, name) {
  const pages = [];
  for (const descriptor of bundle.pages[name]) {
    pages.push(await readJson(resolve(directory, descriptor.file)));
  }
  return pages;
}

/// Fetches every page of a fresh export, or continues one that stopped. The
/// `source` is anything with the three query methods; the replica suite passes
/// a canister actor, and the offline tests pass a fake.
export async function collect({
  source,
  policy,
  directory,
  sourceInfo,
  pageLimit = PAGE_MAX,
  log = () => {},
}) {
  await mkdir(resolve(directory, 'pages'), { recursive: true });
  let bundle = await readBundle(directory);
  if (bundle === null) {
    const summary = await source.exportSummary(policy);
    if (summary.format !== FORMAT_V1) throw new Error(`unknown export format ${summary.format}`);
    bundle = {
      format: BUNDLE_FORMAT,
      source: sourceInfo,
      policy: { includeStorageUris: policy.includeStorageUris },
      summary: normalizeSummary(summary),
      pages: { commitments: [], records: [] },
      state: { commitments: '0', records: '0' },
      complete: false,
    };
    await writeJson(resolve(directory, 'bundle.json'), bundle);
    log(`summary: ${bundle.summary.commitments} commitments, ${bundle.summary.records} records`);
  } else if (bundle.policy.includeStorageUris !== policy.includeStorageUris) {
    throw new Error('the bundle was started under a different policy');
  } else {
    log(`resuming from ${bundle.state.commitments}/${bundle.state.records}`);
  }

  for (const [name, { fetch }] of Object.entries(KINDS)) {
    let next = bigintFrom(bundle.state[name]);
    while (next !== null) {
      const page = await source[fetch](next, BigInt(pageLimit), policy);
      verifyPage(page, policy);
      const file = `pages/${name}-${String(page.start).padStart(12, '0')}.json`;
      await writeJson(resolve(directory, file), page);
      const pageNext = page.next.length === 0 ? null : page.next[0];
      bundle.pages[name].push({
        file,
        start: page.start.toString(),
        next: pageNext === null ? null : pageNext.toString(),
        checksum: bytesToHex(page.checksum),
        entries: page.entries.length,
      });
      next = pageNext;
      bundle.state[name] = pageNext === null ? null : pageNext.toString();
      await writeJson(resolve(directory, 'bundle.json'), bundle);
      log(`${name}: page at ${page.start} verified (${page.entries.length} entries)`);
    }
  }

  bundle.complete = true;
  await writeJson(resolve(directory, 'bundle.json'), bundle);
  return verify(directory);
}

/// Proves the bundle is the snapshot its summary names. Returns the decoded
/// entries and digests for a caller that wants to inspect or restore them.
export async function verify(directory) {
  const bundle = await readBundle(directory);
  if (bundle === null) throw new Error(`no bundle at ${directory}`);
  if (bundle.format !== BUNDLE_FORMAT) throw new Error(`unknown bundle format ${bundle.format}`);

  const out = { bundle, entries: { commitments: [], records: [] }, digests: { commitments: [], records: [] } };
  for (const [name, { kind }] of Object.entries(KINDS)) {
    const pages = await loadPages(directory, bundle, name);
    if (pages.length !== bundle.pages[name].length) {
      throw new Error(`${name}: the manifest lists ${bundle.pages[name].length} pages, ${pages.length} are present`);
    }
    let expectedStart = 0n;
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const descriptor = bundle.pages[name][index];
      if (page.kind !== kind) throw new Error(`${name} page at ${page.start} has kind ${page.kind}`);
      if (page.start.toString() !== descriptor.start) throw new Error(`${name} page ${index} is not the page the manifest names`);
      if (page.start !== expectedStart) throw new Error(`${name} pages are not contiguous at ${page.start}`);
      const digests = verifyPage(page, bundle.policy);
      if (page.entries.length !== descriptor.entries) {
        throw new Error(`${name} page at ${page.start} has a different entry count than the manifest`);
      }
      out.entries[name].push(...page.entries);
      out.digests[name].push(...digests);
      expectedStart = page.next.length === 0 ? null : page.next[0];
      if (expectedStart === null && index !== pages.length - 1) {
        throw new Error(`${name} has pages after the end of the stream`);
      }
    }
    if (pages.length > 0 && expectedStart !== null) {
      throw new Error(`${name} ends before the stream does`);
    }
    if (out.entries[name].length !== Number(bundle.summary[name])) {
      throw new Error(`${name}: summary says ${bundle.summary[name]}, pages hold ${out.entries[name].length}`);
    }
    const root = name === 'commitments'
      ? commitmentRoot(out.digests[name])
      : recordRoot(out.digests[name]);
    if (bytesToHex(root) !== bundle.summary[name === 'commitments' ? 'commitmentRoot' : 'recordRoot']) {
      throw new Error(`${name}: pages do not hash to the summary root`);
    }
  }
  return out;
}

/// Replays a verified bundle into a fresh canister. The target's `restoreBegin`
/// must be accepted (an empty canister, a controller caller); every page is
/// re-chunked to the size the source used, and `restoreFinish` must return the
/// summary the bundle names.
export async function restore({ directory, target, targetCanister, chunk = PAGE_MAX, log = () => {} }) {
  const verified = await verify(directory);
  const summary = toCanisterSummary(verified.bundle.summary, targetCanister);
  await target.restoreBegin(summary);
  for (const [name, { restore: method }] of Object.entries(KINDS)) {
    const entries = verified.entries[name];
    for (let start = 0; start < entries.length; start += chunk) {
      const slice = entries.slice(start, start + chunk);
      const result = await target[method](slice);
      if (!result || !('ok' in result)) {
        throw new Error(`${method} refused at ${start}: ${JSON.stringify(result, bigintSafe)}`);
      }
      log(`${method}: ${result.ok} imported`);
    }
  }
  const finished = await target.restoreFinish();
  if (!finished || !('ok' in finished)) {
    throw new Error(`restoreFinish refused: ${JSON.stringify(finished, bigintSafe)}`);
  }
  const actual = normalizeSummary(finished.ok);
  for (const field of ['commitments', 'records', 'activeRecords', 'revokedRecords', 'commitmentRoot', 'recordRoot']) {
    if (String(actual[field]) !== String(verified.bundle.summary[field])) {
      throw new Error(`restored ${field} is ${actual[field]}, exported was ${verified.bundle.summary[field]}`);
    }
  }
  return finished.ok;
}

/// The files a bundle directory holds, for a caller that wants to archive them.
export async function bundleFiles(directory) {
  const pages = await readdir(resolve(directory, 'pages'));
  return ['bundle.json', ...pages.map((page) => `pages/${page}`)].sort();
}
