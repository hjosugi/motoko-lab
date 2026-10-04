#!/usr/bin/env node
// Property-based state-machine tests for the reference apps, against a real
// replica.
//
//   node tools/state-machine/run.mjs                     # every model, default seeds
//   node tools/state-machine/run.mjs registry metering   # selected models
//   node tools/state-machine/run.mjs --steps 200 --seed 7 registry
//   node tools/state-machine/run.mjs --list
//
// Every generated step is executed against a canister; the pure model (see
// `framework.mjs`) says what should happen, and the first disagreement fails
// the run. The failing sequence is then shrunk by deleting steps while the
// failure survives, and the minimal sequence is written to
// `.state-machine-failures/` so it can be replayed exactly.
//
// A failing bundle is documentation of a real disagreement: the model in
// `models/` and the canister are two implementations of the same promise, and
// the step list is the shortest input found where they diverge. Do not "fix"
// the model to match the canister without deciding which one is wrong.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { buildCanister, repoRoot, upgradeCanister, withReplica } from '../pocket-ic/harness.mjs';
import {
  StepFailure,
  bigintSafe,
  failureBundle,
  generateSteps,
  runSequence,
  sameFailure,
  shrinkSequence,
  show,
} from './framework.mjs';
import bounty from './models/bounty.mjs';
import marketplace from './models/marketplace.mjs';
import metering from './models/metering.mjs';
import registry from './models/registry.mjs';

const MODELS = [registry, marketplace, bounty, metering];
const DEFAULT_SEEDS = [1, 2];
const DEFAULT_STEPS = 120;
const DEFAULT_SHRINK_BUDGET = 120;
const FAILURE_DIR = '.state-machine-failures';

function parseArgs(argv) {
  const options = { models: [], seeds: DEFAULT_SEEDS, steps: DEFAULT_STEPS, shrinkBudget: DEFAULT_SHRINK_BUDGET, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') options.list = true;
    else if (arg === '--seed') options.seeds = [Number(argv[++index])];
    else if (arg === '--seeds') options.seeds = argv[++index].split(',').map(Number);
    else if (arg === '--steps') options.steps = Number(argv[++index]);
    else if (arg === '--shrink-budget') options.shrinkBudget = Number(argv[++index]);
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else options.models.push(arg);
  }
  const selected = options.models.length
    ? options.models.map((name) => {
      const model = MODELS.find((candidate) => candidate.name === name);
      if (!model) throw new Error(`unknown model ${name}; have ${MODELS.map((candidate) => candidate.name).join(', ')}`);
      return model;
    })
    : MODELS;
  return { ...options, selected };
}

/// The replica-facing surface a model is allowed to use. Keeping it this small
/// is what lets the model itself stay pure and the framework stay canister-free.
function makeIo({ pic, actor, identities, fixture, wasm, sender }) {
  const context = {
    principals: Object.fromEntries(
      Object.entries(identities).map(([name, identity]) => [name, identity.getPrincipal().toText()]),
    ),
    canisterId: fixture.canisterId.toText(),
    baseNs: 0n,
  };
  return {
    canister: () => actor,
    principal: (name) => identities[name].getPrincipal(),
    principalText: (name) => identities[name].getPrincipal().toText(),
    actor: (name) => {
      actor.setIdentity(identities[name]);
      return actor;
    },
    async context() {
      if (context.baseNs === 0n) context.baseNs = await this.nowNs();
      return context;
    },
    async nowNs() {
      return BigInt(await pic.getTime()) * 1_000_000n;
    },
    async advance(ms) {
      await pic.advanceTime(ms);
      await pic.tick();
    },
    async upgrade() {
      await upgradeCanister({ pic, canisterId: fixture.canisterId, wasm, sender });
    },
  };
}

async function writeFailure(model, seed, bundle) {  const directory = resolve(repoRoot, FAILURE_DIR);
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${model.name}-seed-${seed}.json`);
  await writeFile(path, `${JSON.stringify(bundle, bigintSafe, 2)}\n`, 'utf-8');
  return path;
}

/// `install_code` is rate limited by instruction count per subnet, and a
/// state-machine run installs one canister per seed and per shrink candidate.
/// The replica is created with that limiter disabled; this retry is the belt to
/// that braces, so an environment that ignores the flag produces a slow run
/// rather than a bogus model failure.
async function setupWithRetry(pic, { idlFactory, wasm, sender, attempts = 4 }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await pic.setupCanister({ idlFactory, wasm, sender });
    } catch (error) {
      const message = String(error?.message ?? error);
      const transient = message.includes('rate limited') || message.includes('RateLimited') || message.includes('SysTransient');
      if (!transient || attempt >= attempts) throw error;
      console.log(`  install rate limited; retrying (${attempt}/${attempts})`);
      await new Promise((done) => setTimeout(done, 15_000 * attempt));
    }
  }
}

async function runModel(model, { seeds, steps, shrinkBudget }) {
  console.log(`== ${model.name} ==`);
  const appDir = resolve(repoRoot, model.appDir);
  const { wasm, idl } = await buildCanister({ appDir, ...model.canister });
  const { idlFactory } = await import(idl);
  const failures = [];

  await withReplica(async ({ pic, createIdentity }) => {
    const deployer = createIdentity('deployer');
    const identities = { deployer };
    for (const name of model.identities) identities[name] = createIdentity(name);
    // `icp deploy` makes the *selected* identity the controller, and an app
    // whose gate is `Principal.isController` (the metering app) must be
    // installed by the identity its model calls the admin.
    const controllerName = model.controller ?? 'deployer';
    const sender = identities[controllerName].getPrincipal();
    const attempt = async (stepsList) => {
      // A fresh canister per attempt: sharing one across seeds or shrink
      // candidates would let an earlier sequence's state decide a later one.
      // The install happens inside a retry because the replica rate-limits
      // install_code messages by instruction count, and the state-machine run
      // installs one canister per attempt.
      const fixture = await setupWithRetry(pic, { idlFactory, wasm, sender });
      const io = makeIo({ pic, actor: fixture.actor, identities, fixture, wasm, sender });
      try {
        const finalModel = await runSequence(model, stepsList, io);
        return { failed: false, finalModel };
      } catch (error) {
        if (process.env.STATE_MACHINE_DEBUG) console.error(error);
        const failure = error instanceof StepFailure
          ? error
          : new StepFailure(-1, null, error.stack ?? String(error));
        return { failed: true, failure };
      }
    };

    for (const seed of seeds) {
      const generated = generateSteps(model, { seed, count: steps });
      const first = await attempt(generated);
      if (!first.failed) {
        console.log(`  seed ${seed}: ${generated.length} steps ok`);
        continue;
      }

      console.log(`  seed ${seed}: FAILED at step ${first.failure.index}: ${first.failure.message}`);
      console.log('  shrinking...');
      const { steps: minimal, attempts } = await shrinkSequence(
        generated,
        async (candidate) => {
          const result = await attempt(candidate);
          // Only the same step invocation failing the same way counts: removing
          // a step can turn one refusal into another, and accepting that would
          // shrink towards a different bug than the one being reproduced.
          return { failed: result.failed && sameFailure(first.failure, result.failure) };
        },
        { budget: shrinkBudget, log: (line) => console.log(line) },
      );
      const replay = await attempt(minimal);
      const reproduced = replay.failed && sameFailure(first.failure, replay.failure);
      const failure = reproduced ? replay.failure : first.failure;
      const stepsToWrite = reproduced ? minimal : generated;
      const bundle = failureBundle({
        model: model.name,
        seed,
        steps: stepsToWrite,
        message: failure.message,
      });
      const path = await writeFailure(model, seed, bundle);
      console.log(`  minimal reproduction (${attempts} shrink attempts): ${stepsToWrite.length} steps${reproduced ? '' : ' (not reducible)'}`);
      console.log(`  failing step: ${show(failure.step)}`);
      console.log(`  ${failure.message}`);
      console.log(`  steps written to ${path}`);
      failures.push({ seed, failure, path, minimal });
    }
  }, {
    // The state-machine runner installs a canister per attempt; the replica's
    // install-code limiter would start refusing long before shrinking is done.
    icpConfig: { canisterExecutionRateLimiting: 'Disabled' },
  });

  return failures;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.list) {
    for (const model of MODELS) console.log(`${model.name}\t${model.appDir}`);
    return 0;
  }

  console.log(`state-machine tests: ${options.selected.map((model) => model.name).join(', ')}`);
  console.log(`seeds ${options.seeds.join(', ')}, ${options.steps} steps per seed\n`);

  let failed = 0;
  for (const model of options.selected) {
    const failures = await runModel(model, options);
    failed += failures.length;
    console.log('');
  }
  if (failed > 0) {
    console.error(`state-machine tests: ${failed} failing seed(s)`);
    return 1;
  }
  console.log('state-machine tests: PASS');
  return 0;
}

process.exit(await main());
