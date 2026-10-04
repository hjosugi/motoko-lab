#!/usr/bin/env node
// Offline self-test for the state-machine framework and its four models.
//
//   node tools/state-machine/framework.test.mjs
//
// This runs in the ordinary CI job (no replica, no toolchain): it proves the
// generator is seeded and deterministic, the shrinker really reduces a failing
// sequence, the runner attributes failures to the step that caused them, and
// every model can be simulated forward without touching a canister. The
// replica-backed half runs in the Replica workflow.

import {
  Mismatch,
  Rng,
  StepFailure,
  bigintSafe,
  chooseWeighted,
  failureSignature,
  generateSteps,
  runSequence,
  sameFailure,
  shrinkSequence,
} from './framework.mjs';
import bounty from './models/bounty.mjs';
import marketplace from './models/marketplace.mjs';
import metering from './models/metering.mjs';
import registry from './models/registry.mjs';

const MODELS = [registry, marketplace, bounty, metering];

let checks = 0;
function ok(condition, description) {
  checks += 1;
  if (!condition) throw new Error(`FAILED: ${description}`);
  console.log(`  ok  ${description}`);
}

// ------------------------------------------------------------------- random

{
  const first = new Rng(7);
  const second = new Rng(7);
  const other = new Rng(8);
  const left = Array.from({ length: 32 }, () => first.int(1_000));
  const right = Array.from({ length: 32 }, () => second.int(1_000));
  const different = Array.from({ length: 32 }, () => other.int(1_000));
  ok(left.join() === right.join(), 'the same seed replays the same draws');
  ok(left.join() !== different.join(), 'a different seed gives a different sequence');
}

{
  const always = chooseWeighted([
    { value: 'never', weight: 0 },
    { value: 'always', weight: 5 },
  ], new Rng(1));
  ok(always === 'always', 'a zero-weight choice is never drawn');
}

// ------------------------------------------------------------------ models

for (const model of MODELS) {
  const steps = generateSteps(model, { seed: 1, count: 300 });
  ok(steps.length === 300, `${model.name}: 300 steps are generated`);
  const again = generateSteps(model, { seed: 1, count: 300 });
  ok(JSON.stringify(steps, bigintSafe) === JSON.stringify(again, bigintSafe), `${model.name}: generation is deterministic per seed`);
  const other = generateSteps(model, { seed: 2, count: 300 });
  ok(JSON.stringify(steps, bigintSafe) !== JSON.stringify(other, bigintSafe), `${model.name}: a different seed explores differently`);
  const unknown = steps.find((step) => step.type !== '__advance' && step.type !== '__upgrade' && !(step.type in model.commands));
  ok(unknown === undefined, `${model.name}: every generated step names a command`);

  // The generator runs `predict` on every step, so a clean pass over several
  // seeds and long sequences is the model's own consistency check: no step is
  // generated from a state where its prediction throws.
  for (const seed of [3, 4, 5, 6, 7]) {
    generateSteps(model, { seed, count: 400 });
  }
  ok(true, `${model.name}: five more seeds x 400 steps predict without a contradiction`);
}

// ------------------------------------------------------------------ runner

{
  const machine = {
    generationContext: () => ({}),
    init: () => ({ count: 0n }),
    commands: {
      tick: {
        weight: 1,
        generate: () => ({}),
        predict: (model) => ({ result: { kind: 'ok' }, next: { count: model.count + 1n } }),
        check: (model, args, prediction, observed) => {
          if (observed !== 'good') throw new Mismatch(`observed ${observed}`);
          return prediction.next;
        },
        run: async (io) => io.answer,
      },
    },
    observe: async () => {},
  };
  const io = {
    answer: 'good',
    context: async () => ({}),
    advance: async () => {},
    upgrade: async () => {},
  };
  const steps = [{ type: 'tick', args: {} }, { type: 'tick', args: {} }, { type: 'tick', args: {} }];
  const final = await runSequence(machine, steps, io);
  ok(final.count === 3n, 'the runner advances the model once per step');
  io.answer = 'bad';
  let thrown = null;
  try {
    await runSequence(machine, steps, io);
  } catch (error) {
    thrown = error;
  }
  ok(thrown instanceof StepFailure && thrown.index === 0, 'a mismatched observation fails at its step');
}

// ----------------------------------------------------------------- shrinker

{
  const first = {
    step: { type: 'revokeRecord' },
    message: 'revokeRecord(emptyReason): expected #err(invalidInput), got {"err":{"notFound":null}}',
  };
  const same = {
    step: { type: 'revokeRecord' },
    message: 'revokeRecord(emptyReason): expected #err(invalidInput), got {"ok":{"id":"7n"}}',
  };
  const different = {
    step: { type: 'commit' },
    message: 'commit(duplicate): expected #err(duplicate), got {"ok":{"id":"1n"}}',
  };
  ok(failureSignature(first) === failureSignature(same), 'the same disagreement with different ids has one signature');
  ok(failureSignature(first) !== failureSignature(different), 'a different command or variant has a different signature');
  ok(sameFailure(first, same), 'the same failing step failing the same way is the same failure');
  ok(!sameFailure(first, different), 'a different failing step is not the same failure');
}

{
  const sequence = [
    { type: 'setup' },
    { type: 'noise' },
    { type: 'setup' },
    { type: 'boom' },
    { type: 'noise' },
    { type: 'noise' },
  ];
  const replay = async (candidate) => ({
    failed: candidate.some((step) => step.type === 'boom') && candidate.some((step) => step.type === 'setup'),
  });
  const { steps: minimal, attempts } = await shrinkSequence(sequence, replay, { budget: 100 });
  ok(minimal.length === 2 && minimal[0].type === 'setup' && minimal[1].type === 'boom',
    `the shrinker reduces six steps to the two that trigger the failure (${attempts} attempts)`);
  const nothing = await shrinkSequence([{ type: 'noise' }], replay, { budget: 10 });
  ok(nothing.steps.length === 1, 'the shrinker leaves a passing sequence alone');
}

console.log(`\nstate-machine framework: ${checks} checks passed`);
