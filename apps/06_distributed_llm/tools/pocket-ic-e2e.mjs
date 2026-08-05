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
// Three of the four sections below need a replica specifically:
//
//   * **access and quota** - `caller` is a real principal, including the
//     anonymous one, which `moc -r` does not model.
//   * **cycles** - the interpreter has no cycle accounting at all, so
//     `Cycles.balance()` traps there and the metering can only be checked here.
//   * **byzantine workers** - a lying worker is a separately installed canister
//     serving the same Candid interface, which is what makes the point that the
//     orchestrator cannot tell it apart by type.
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

// Below `Validation.MIN_CYCLE_RESERVE` (3T), so every gated endpoint on this
// canister must refuse rather than fan out.
const STARVED_CYCLES = 1_000_000_000_000n;

const CANISTERS = [
  { name: 'backend', main: 'backend/src/main.mo', did: 'backend/candid/backend.did' },
  { name: 'worker', main: 'worker/src/main.mo', did: 'worker/candid/worker.did' },
  // Same interface as `worker`, hence the same `.did`: that a byzantine node is
  // indistinguishable by type is the premise of the whole section.
  { name: 'liar', main: 'test/fixtures/LyingWorker.mo', did: 'worker/candid/worker.did' },
  { name: 'llm_shim', main: 'llm_shim/src/main.mo', did: 'llm_shim/candid/llm_shim.did' },
];

function moc() {
  // `mops` is the normal way to find the pinned compiler. Where the Mops
  // registry is unreachable the rest of this app still builds via
  // `make check-offline`, so accept an explicit `MOC` too rather than making
  // the replica tests the one thing that needs the network.
  if (process.env.MOC) return process.env.MOC;
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

let checks = 0;
function check(condition, description) {
  checks += 1;
  if (!condition) throw new Error(`FAILED: ${description}`);
  console.log(`  ok  ${description}`);
}

/// Asserts a call came back `#err` with the expected variant, and returns its
/// payload. A test that only asserts "it failed" passes when the endpoint is
/// broken for an unrelated reason.
function expectErr(result, variant, description) {
  check('err' in result && variant in result.err, `${description} -> ${variant}`);
  return result.err[variant];
}

function expectOk(result, description) {
  if (!('ok' in result)) throw new Error(`FAILED: ${description} -> ${JSON.stringify(result, plain)}`);
  checks += 1;
  console.log(`  ok  ${description}`);
  return result.ok;
}

async function main() {
  await build_();

  const { PocketIc, PocketIcServer, createIdentity } = await import('@dfinity/pic');
  const { Principal } = await import('@icp-sdk/core/principal');
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
    const liar = await pic.setupCanister({ idlFactory: workerIdl, wasm: `${build}/liar.wasm` });
    const shim = await pic.setupCanister({ idlFactory: shimIdl, wasm: `${build}/llm_shim.wasm` });
    const backend = await pic.setupCanister({ idlFactory: backendIdl, wasm: `${build}/backend.wasm` });

    workers.forEach((w, i) => console.log(`  worker_${i}   ${w.canisterId.toText()}`));
    console.log(`  liar       ${liar.canisterId.toText()}`);
    console.log(`  llm_shim   ${shim.canisterId.toText()}`);
    console.log(`  backend    ${backend.canisterId.toText()}`);

    console.log('\nmodelInfo:', JSON.stringify(await backend.actor.modelInfo(), plain));

    // Admin endpoints reject the anonymous principal, so the harness has to
    // call as somebody. The first non-anonymous caller claims the canister.
    const operator = createIdentity('operator');
    const stranger = createIdentity('stranger');
    const guest = createIdentity('guest');
    const asOperator = () => backend.actor.setPrincipal(operator.getPrincipal());
    asOperator();

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
        padL('cycles', 12) +
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
          padL(r.cyclesSpent, 12) +
          '  ' +
          (r.lossless ? 'yes' : 'NO'),
      );
    }
    const honestText = report.ok[0].text;
    console.log(`\noutput: ${honestText}`);

    // Every strategy the orchestrator reports as lossless must have matched the
    // single-node output. A regression here is silent otherwise.
    const wrong = report.ok.filter((r) => !r.lossless && !r.strategy.includes('nearest'));
    if (wrong.length > 0) {
      throw new Error(`unexpected divergence: ${wrong.map((r) => r.strategy).join(', ')}`);
    }

    const answer = await backend.actor.askLlmCanister('llama3.1:8b', 'a canister is');
    console.log('\nv1_chat through LlmClient ->', JSON.stringify(answer));

    // ------------------------------------------------- access and quota --

    console.log('\n== access control ==');
    const local = { prompt: PROMPT, maxTokens: MAX_TOKENS, strategy: { baseline: null }, block: BLOCK, steps: STEPS };

    backend.actor.setPrincipal(Principal.anonymous());
    expectErr(await backend.actor.generate(local), 'anonymousNotAllowed', 'anonymous generate');
    expectErr(await backend.actor.benchmark(PROMPT, MAX_TOKENS, BLOCK, STEPS), 'anonymousNotAllowed', 'anonymous benchmark');
    expectErr(await backend.actor.askLlmCanister('llama3.1:8b', 'hello'), 'anonymousNotAllowed', 'anonymous askLlmCanister');

    backend.actor.setPrincipal(stranger.getPrincipal());
    expectErr(await backend.actor.generate(local), 'unauthorized', 'unknown principal generate');
    expectErr(await backend.actor.benchmark(PROMPT, MAX_TOKENS, BLOCK, STEPS), 'unauthorized', 'unknown principal benchmark');

    // The acceptance criterion is about fan-out specifically: an unauthorised
    // caller must not be able to make the cluster do work on its behalf.
    const beforeUnauthorized = (await backend.actor.stats()).calls;
    expectErr(
      await backend.actor.generate({ ...local, strategy: { shardedArgmax: null } }),
      'unauthorized',
      'unknown principal cannot cause a fan-out',
    );
    check((await backend.actor.stats()).calls === beforeUnauthorized, 'refused call did no work');

    asOperator();
    expectOk(await backend.actor.allow([stranger.getPrincipal()]), 'operator allowlists the stranger');
    backend.actor.setPrincipal(stranger.getPrincipal());
    expectOk(await backend.actor.generate(local), 'allowlisted principal may generate');

    // A paid model spends this canister's own cycles, so it is owner-only even
    // for an allowlisted caller. The free model stays open to them.
    expectErr(await backend.actor.askLlmCanister('gemma3:27b', 'hello'), 'unauthorized', 'allowlisted caller cannot pick a paid model');
    expectOk(await backend.actor.askLlmCanister('llama3.1:8b', 'hello'), 'allowlisted caller may use a free model');

    asOperator();
    expectOk(await backend.actor.revoke([stranger.getPrincipal()]), 'operator revokes the stranger');
    backend.actor.setPrincipal(stranger.getPrincipal());
    expectErr(await backend.actor.generate(local), 'unauthorized', 'revoked principal is refused again');

    asOperator();
    expectOk(await backend.actor.setOpenAccess(true), 'operator opens the canister');
    backend.actor.setPrincipal(guest.getPrincipal());
    expectOk(await backend.actor.generate(local), 'open access lets any named principal in');
    backend.actor.setPrincipal(Principal.anonymous());
    expectErr(await backend.actor.generate(local), 'anonymousNotAllowed', 'open access still excludes the anonymous principal');
    asOperator();
    expectOk(await backend.actor.setOpenAccess(false), 'operator closes the canister again');

    console.log('\n== quota ==');
    asOperator();
    // A principal that has not called yet, so the arithmetic below is exact
    // rather than "whatever the access-control section happened to spend".
    const client = createIdentity('client');
    expectOk(await backend.actor.allow([client.getPrincipal()]), 'allowlist a fresh principal');
    const strict = { windowNanos: 3_600_000_000_000n, unitsPerWindow: 200n };
    expectOk(await backend.actor.setQuota(strict), 'operator sets a strict quota');

    backend.actor.setPrincipal(client.getPrincipal());
    const before = await backend.actor.quotaOf(client.getPrincipal());
    check(before.remaining === 200n, `a fresh principal starts with the whole budget (${before.remaining})`);

    expectOk(await backend.actor.generate(local), 'a 24-token local decode fits in the budget');
    const afterOne = await backend.actor.quotaOf(client.getPrincipal());
    check(afterOne.remaining === 176n, `24 units charged, ${afterOne.remaining} left`);

    // A full benchmark is far over budget, so it must be refused *before* it
    // runs rather than truncated into a partial result.
    const callsBeforeQuota = (await backend.actor.stats()).calls;
    const exceeded = expectErr(
      await backend.actor.benchmark(PROMPT, MAX_TOKENS, BLOCK, STEPS),
      'quotaExceeded',
      'over-budget benchmark',
    );
    console.log(
      `      limit ${exceeded.limit}, used ${exceeded.used}, requested ${exceeded.requested}, reset in ${
        Number(exceeded.resetInNanos) / 1e9
      }s`,
    );
    check(exceeded.requested > exceeded.limit - exceeded.used, 'the refusal reports why it was refused');
    check((await backend.actor.stats()).calls === callsBeforeQuota, 'a refused benchmark produced no partial result');
    check((await backend.actor.stats()).quotaRejections > 0n, 'the rejection is counted');

    // The owner sets the policy, so metering it would only be theatre.
    asOperator();
    expectOk(await backend.actor.benchmark(PROMPT, MAX_TOKENS, BLOCK, STEPS), 'the owner is exempt from the quota');
    check((await backend.actor.quotaOf(operator.getPrincipal())).exempt, 'quotaOf says so');

    // The ledger is one record per authorised caller and nothing prunes it on
    // its own. Records inside a live window must survive; the endpoint is there
    // for the ones that do not.
    const dropped = expectOk(await backend.actor.pruneQuotas(), 'owner prunes the quota ledger');
    check(dropped === 0n, 'a live window is not pruned');
    check((await backend.actor.quotaOf(client.getPrincipal())).remaining === 176n, 'and the record it kept is intact');
    backend.actor.setPrincipal(client.getPrincipal());
    expectErr(await backend.actor.pruneQuotas(), 'unauthorized', 'a non-owner cannot prune');
    asOperator();
    expectOk(await backend.actor.setQuota({ windowNanos: 3_600_000_000_000n, unitsPerWindow: 20_000n }), 'quota restored');

    // ------------------------------------------------------------ cycles --

    console.log('\n== cycles ==');
    asOperator();
    const balanceBefore = await pic.getCyclesBalance(backend.canisterId);
    const metered = expectOk(await backend.actor.benchmark(PROMPT, MAX_TOKENS, BLOCK, STEPS), 'metered benchmark');
    const balanceAfter = await pic.getCyclesBalance(backend.canisterId);

    const observed = balanceBefore - balanceAfter;
    const reported = metered.reduce((sum, r) => sum + r.cyclesSpent, 0n);
    const statsAfter = await backend.actor.stats();
    console.log(`      balance before      ${balanceBefore}`);
    console.log(`      balance after       ${balanceAfter}`);
    console.log(`      observed drop       ${observed}`);
    console.log(`      sum of Report.cyclesSpent ${reported}`);
    console.log(`      stats().cyclesSpent ${statsAfter.cyclesSpent}`);
    check(reported > 0n, 'the fan-out is metered at all');
    // `Report.cyclesSpent` is the balance drop *inside* each message, so it
    // covers the calls it sent. The execution charge for the message itself
    // lands after it returns, which is why the externally observed drop is the
    // larger number. Anything else means the meter is measuring the wrong thing.
    check(observed >= reported, 'reported cycles never exceed the externally observed drop');
    check(statsAfter.cyclesBalance > 0n, 'stats reports a live balance');

    // A canister that cannot pay refuses instead of fanning out until it
    // freezes. Installed with less than `MIN_CYCLE_RESERVE` on purpose.
    const starved = await pic.setupCanister({
      idlFactory: backendIdl,
      wasm: `${build}/backend.wasm`,
      cycles: STARVED_CYCLES,
    });
    starved.actor.setPrincipal(operator.getPrincipal());
    expectOk(await starved.actor.setOpenAccess(true), 'starved canister claims an owner');
    const low = expectErr(await starved.actor.generate(local), 'lowCycles', 'starved canister refuses to decode');
    console.log(`      balance ${low.balance} against a reserve of ${low.reserve}`);
    check(low.balance < low.reserve, 'the refusal names the balance and the floor');
    expectErr(await starved.actor.benchmark(PROMPT, MAX_TOKENS, BLOCK, STEPS), 'lowCycles', 'starved canister refuses to benchmark');
    expectErr(await starved.actor.askLlmCanister('llama3.1:8b', 'hi'), 'lowCycles', 'starved canister refuses to call the LLM');

    // ------------------------------------------------- byzantine workers --

    console.log('\n== a lying worker on a replica ==');
    asOperator();
    const byzantine = [workers[0], workers[1], workers[2], liar];
    expectOk(await backend.actor.setWorkers(byzantine.map((w) => w.canisterId)), 'shard 3 is now a canister that lies');

    const sharded = { ...local, strategy: { shardedArgmax: null } };

    expectOk(await backend.actor.setVerification({ replication: 1n, spotCheck: false }), 'verification off');
    const believed = expectOk(await backend.actor.generate(sharded), 'trusting run completes');
    check(!believed.lossless, 'the trusting run is wrong, and says so in `lossless`');
    check(believed.text !== honestText, 'the lie changed the output');
    console.log(`      forged output: ${believed.text.slice(0, 72)}...`);

    expectOk(await backend.actor.setVerification({ replication: 2n, spotCheck: false }), 'two-way replication');
    const caught = expectErr(await backend.actor.generate(sharded), 'faultyWorker', 'replicated run rejects the lie');
    check('disagreement' in caught, `the fault is a disagreement (${JSON.stringify(caught, plain)})`);

    expectOk(await backend.actor.setVerification({ replication: 1n, spotCheck: true }), 'spot check on');
    const probed = expectErr(await backend.actor.generate(sharded), 'faultyWorker', 'spot check rejects the lie');
    check('spotCheckFailed' in probed, `the fault is a failed probe (${JSON.stringify(probed, plain)})`);
    check(probed.spotCheckFailed.worker === 3n, 'and it names the worker');

    // The one configuration in which a lying worker cannot change the output:
    // it drafts, and an exact local target pass decides what is emitted.
    expectOk(await backend.actor.setVerification({ replication: 1n, spotCheck: false }), 'verification off again');
    const drafted = expectOk(await backend.actor.generate({ ...local, strategy: { shardedDraft: null } }), 'sharded draft completes');
    check(drafted.lossless, 'the liar cannot change a verified draft');
    check(drafted.text === honestText, 'the output is the single-node output');
    console.log(
      `      ${drafted.interCanisterCalls} calls, acceptance ${drafted.acceptanceRatePercent}% — the lie costs acceptance, not correctness`,
    );

    const finalStats = await backend.actor.stats();
    check(finalStats.faults >= 2n, `faults are counted (${finalStats.faults})`);
    console.log('\nbackend stats:', JSON.stringify(finalStats, plain));
    console.log('shim stats   :', JSON.stringify(await shim.actor.stats(), plain));
    console.log(`\nok — ${checks} checks passed`);
  } finally {
    await pic.tearDown();
    await server.stop();
  }
}

await main();
