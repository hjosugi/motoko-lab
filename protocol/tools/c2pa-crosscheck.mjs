// Cross-check the C2PA writer and validator against c2patool, the Content
// Authenticity Initiative's reference tool (contentauth/c2pa-rs).
//
// `c2pa.test.mjs` proves the implementation agrees with itself. This proves it
// agrees with the reference implementation, in both directions:
//
//   ours -> c2patool   the published example credential, and a fresh one per
//                      signing algorithm, are read by c2patool. With the test
//                      root configured as its trust anchor it must report
//                      `validation_state: Trusted` with no failure codes;
//                      without it, exactly one failure: `signingCredential.untrusted`.
//
//   c2patool -> ours   c2patool signs a PNG with its own sample ES256 chain,
//                      and `validatePng` must verify the claim signature, every
//                      hashed URI and the data hash.
//
// Not part of `run_offline_checks.sh` or CI: it downloads a release binary.
// Run it when the writer or validator changes and record the result in
// protocol/C2PA_BRIDGE.md.
//
//   node protocol/tools/c2pa-crosscheck.mjs
//   C2PATOOL=/path/to/c2patool node protocol/tools/c2pa-crosscheck.mjs

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';

import { buildExample, EXAMPLE_DIR } from './c2pa-bridge.mjs';
import { signPng, validatePng } from './c2pa.mjs';
import { issue, testPki } from './x509.mjs';

// Pinned. A cross-check that silently changes what it compares against is not
// a cross-check.
const C2PATOOL = 'c2patool-v0.27.22';
const ASSET = `${C2PATOOL}-x86_64-unknown-linux-gnu.tar.gz`;

const root = await mkdtemp(resolve(tmpdir(), 'c2pa-crosscheck-'));
let failures = 0;
const expect = (condition, description) => {
  console.log(`${condition ? '  ok  ' : '  FAIL'} ${description}`);
  if (!condition) failures += 1;
};

function c2patool() {
  if (process.env.C2PATOOL) return process.env.C2PATOOL;
  execFileSync('gh', ['release', 'download', C2PATOOL, '-R', 'contentauth/c2pa-rs', '-p', ASSET, '-D', root], { stdio: 'inherit' });
  execFileSync('tar', ['xzf', resolve(root, ASSET), '-C', root]);
  return resolve(root, 'c2patool/c2patool');
}

const run = (tool, args) => JSON.parse(execFileSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const failuresOf = (report) =>
  Object.values(report.validation_results?.activeManifest?.failure ?? []).map((entry) => entry.code);

try {
  const tool = c2patool();
  console.log(execFileSync(tool, ['--version'], { encoding: 'utf8' }).trim());
  const anchors = resolve(EXAMPLE_DIR, 'test-root-ca.pem');

  // ---- ours -> c2patool
  const example = resolve(EXAMPLE_DIR, 'gradient.c2pa.png');
  let report = run(tool, [example, 'trust', '--trust_anchors', anchors]);
  expect(report.validation_state === 'Trusted' && failuresOf(report).length === 0,
    `the example credential is Trusted with the test root as anchor (${report.validation_state})`);
  report = run(tool, [example]);
  expect(report.validation_state === 'Valid' && failuresOf(report).join() === 'signingCredential.untrusted',
    `without the anchor it is Valid, failing only signingCredential.untrusted (${failuresOf(report).join() || 'none'})`);
  const manifest = report.manifests[report.active_manifest];
  expect(manifest.assertions.some((a) => a.label === 'io.github.hjosugi.icp-proof'), 'c2patool reads the ICP proof assertion');

  // An ES256 signer, to cover the ECDSA path as well as Ed25519.
  const pki = testPki();
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecCert = issue({
    subject: { C: 'JP', O: 'motoko-lab test PKI', OU: 'FOR TESTING ONLY', CN: 'motoko-lab es256 signer' },
    publicKey: ec.publicKey,
    issuer: { name: { C: 'JP', O: 'motoko-lab test PKI', OU: 'FOR TESTING ONLY', CN: 'motoko-lab Test Root CA' }, ...pki.rootKeys },
    serial: Buffer.from([0x42]),
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2035-12-31T23:59:59Z'),
  });
  const { files } = await buildExample();
  const es256 = signPng({
    png: files['gradient.png'],
    assertions: [{ label: 'c2pa.actions.v2', data: { actions: [{ action: 'c2pa.created', digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalArt' }] } }],
    signer: { privateKey: ec.privateKey, chain: [ecCert], alg: -7 },
    claimGenerator: { name: 'motoko-lab c2pa-crosscheck', version: '1' },
    title: 'gradient.png',
  });
  const es256Path = resolve(root, 'es256.png');
  await writeFile(es256Path, es256.png);
  report = run(tool, [es256Path, 'trust', '--trust_anchors', anchors]);
  expect(report.validation_state === 'Trusted', `an ES256 credential written here is Trusted by c2patool (${report.validation_state})`);

  // ---- c2patool -> ours
  const manifestPath = resolve(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({
    claim_generator_info: [{ name: 'crosscheck', version: '1' }],
    title: 'from c2patool',
    assertions: [{ label: 'org.example.crosscheck', data: { written: 'by c2patool' } }],
  }));
  const plain = resolve(root, 'plain.png');
  await writeFile(plain, files['gradient.png']);
  const theirs = resolve(root, 'theirs.png');
  execFileSync(tool, [plain, '-m', manifestPath, '-o', theirs, '-f'], { stdio: 'ignore' });
  const validated = validatePng(await readFile(theirs));
  const codes = validated.status.map((s) => s.code);
  expect(validated.valid, `a c2patool credential validates here (${codes.filter((c) => !c.endsWith('match') && !c.endsWith('validated')).join() || 'no failures'})`);
  expect(codes.includes('claimSignature.validated') && codes.includes('assertion.dataHash.match'),
    'its claim signature and data hash verify');
  expect(validated.assertions.get('org.example.crosscheck')?.value?.written === 'by c2patool', 'its assertions are readable');
} finally {
  if (!process.env.KEEP) await rm(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} cross-check(s) FAILED` : '\nall cross-checks passed');
process.exitCode = failures ? 1 : 0;
