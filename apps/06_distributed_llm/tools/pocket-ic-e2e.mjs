#!/usr/bin/env node
// End-to-end run of the whole cluster on a real replica.
//
//   node tools/pocket-ic-setup.mjs   # once
//   node tools/pocket-ic-e2e.mjs
//
// `sim/Cluster.mo` already exercises the orchestration protocol in the Motoko
// interpreter, and it is the faster loop. This script exists because the
// interpreter is not a replica: it has no canister installation, no Candid
// encoding on the wire, no instruction limit, no cycle accounting and no
// `ic0.*` system API. Several things can only fail here - and one did. The
// `Prim.envVar` rope trap documented in `backend/src/Env.mo` is invisible to
// `moc -r` and traps at install time on a replica.
//
// The script compiles each canister with the same `moc` the rest of the app
// uses, generates JS bindings from the checked-in `.did` files with `didc`, then
// installs and calls them.

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const build = resolve(here, '.pocket-ic/build');
const didc = resolve(here, '.pocket-ic/didc');

const WORKERS = 4;
const PROMPT = 'speculative decoding uses';
const MAX_TOKENS = 24n;
const BLOCK = 4n;
const STEPS = 2n;

const CANISTERS = [
  { name: 'backend', main: 'backend/src/main.mo', did: 'backend/candid/backend.did' },
  { name: 'worker', main: 'worker/src/main.mo', did: 'worker/candid/worker.did' },
  { name: 'llm_shim', main: 'llm_shim/src/main.mo', did: 'llm_shim/candid/llm_shim.did' },
];

function moc() {
  return execFileSync('mops', ['toolchain', 'bin', 'moc'], { cwd: app }).toString().trim();
}

async function build_() {
  await mkdir(build, { recursive: true });
  const compiler = moc();
  const core = resolve(app, '.mops/core@2.6.0/src');
  for (const c of CANISTERS) {
    execFileSync(compiler, ['-c', '--package', 'core', core, '-o', `${build}/${c.name}.wasm`, resolve(app, c.main)], {
      cwd: app,
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    const js = execFileSync(didc, ['bind', resolve(app, c.did), '-t', 'js']).toString();
    await writeFile(`${build}/${c.name}.idl.mjs`, js);
    console.log(`built ${c.name}`);
  }
}

const plain = (_key, value) => (typeof value === 'bigint' ? Number(value) : value);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

async function main() {
  await build_();

  const { PocketIc, PocketIcServer, createIdentity } = await import('@dfinity/pic');
  const { idlFactory: backendIdl } = await import(`${build}/backend.idl.mjs`);
  const { idlFactory: workerIdl } = await import(`${build}/worker.idl.mjs`);
  const { idlFactory: shimIdl } = await import(`${build}/llm_shim.idl.mjs`);

  const server = await PocketIcServer.start();
  const pic = await PocketIc.create(server.getUrl());
  console.log(`\nreplica up at ${server.getUrl()}\n`);

  try {
    const workers = [];
    for (let i = 0; i < WORKERS; i++) {
      workers.push(await pic.setupCanister({ idlFactory: workerIdl, wasm: `${build}/worker.wasm` }));
    }
    const shim = await pic.setupCanister({ idlFactory: shimIdl, wasm: `${build}/llm_shim.wasm` });
    const backend = await pic.setupCanister({ idlFactory: backendIdl, wasm: `${build}/backend.wasm` });

    workers.forEach((w, i) => console.log(`  worker_${i}   ${w.canisterId.toText()}`));
    console.log(`  llm_shim   ${shim.canisterId.toText()}`);
    console.log(`  backend    ${backend.canisterId.toText()}`);

    console.log('\nmodelInfo:', JSON.stringify(await backend.actor.modelInfo(), plain));

    // Admin endpoints reject the anonymous principal, so the harness has to
    // call as somebody. The first non-anonymous caller claims the canister.
    const operator = createIdentity('operator');
    backend.actor.setPrincipal(operator.getPrincipal());

    const wired = await backend.actor.setWorkers(workers.map((w) => w.canisterId));
    if ('err' in wired) throw new Error(`setWorkers: ${JSON.stringify(wired.err)}`);
    for (const info of wired.ok) {
      console.log(`  shard ${info.shard}/${info.shardCount} owns vocabulary [${info.lo}, ${info.hi})`);
    }

    await backend.actor.setLlmCanister([shim.canisterId.toText()]);
    console.log('llmTarget:', await backend.actor.llmTarget());

    const report = await backend.actor.benchmark(PROMPT, MAX_TOKENS, BLOCK, STEPS);
    if ('err' in report) throw new Error(JSON.stringify(report.err));

    console.log(`\n== benchmark on a replica — prompt "${PROMPT}" ==`);
    console.log(
      pad('strategy', 30) +
        padL('tgtRnd', 7) +
        padL('drfRnd', 7) +
        padL('accept%', 8) +
        padL('calls', 7) +
        padL('bytes', 8) +
        '  lossless',
    );
    for (const r of report.ok) {
      console.log(
        pad(r.strategy, 30) +
          padL(r.targetRounds, 7) +
          padL(r.draftRounds, 7) +
          padL(r.acceptanceRatePercent, 8) +
          padL(r.interCanisterCalls, 7) +
          padL(r.wireBytes, 8) +
          '  ' +
          (r.lossless ? 'yes' : 'NO'),
      );
    }
    console.log(`\noutput: ${report.ok[0].text}`);

    // Every strategy the orchestrator reports as lossless must have matched the
    // single-node output. A regression here is silent otherwise.
    const wrong = report.ok.filter((r) => !r.lossless && !r.strategy.includes('nearest'));
    if (wrong.length > 0) {
      throw new Error(`unexpected divergence: ${wrong.map((r) => r.strategy).join(', ')}`);
    }

    const answer = await backend.actor.askLlmCanister('llama3.1:8b', 'a canister is');
    console.log('\nv1_chat through LlmClient ->', JSON.stringify(answer));

    console.log('backend stats:', JSON.stringify(await backend.actor.stats(), plain));
    console.log('shim stats   :', JSON.stringify(await shim.actor.stats(), plain));
    console.log('\nok');
  } finally {
    await pic.tearDown();
    await server.stop();
  }
}

await main();
