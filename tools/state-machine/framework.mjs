#!/usr/bin/env node
// Property-based state-machine testing for the reference apps.
//
// A state-machine test has three parts that are deliberately kept apart:
//
//   1. a **pure model** (a plain-data mirror of what the canister promises),
//   2. a **generator** that draws commands from a seed, running the model
//      forward so every generated sequence is legal for the state it found,
//   3. an **executor** that replays those commands against a real replica and
//      compares the observation with what the model predicted.
//
// Because steps are self-contained JSON and the model is pure, a failing step
// list can be replayed exactly, and a failing sequence can be shrunk by
// deleting steps until the smallest reproduction is left (delta debugging).
// The seeds are fixed, so "it failed once" is something a second run can see.
//
// This file has no canister dependencies: the replica wiring lives in
// `run.mjs`, and `framework.test.mjs` exercises this logic offline.

/// Thrown when an observation disagrees with the model. Kept separate from
/// programming errors so a suite failure reads as "the canister did X, the
/// model said Y" rather than as an unrelated crash.
export class Mismatch extends Error {
  constructor(message) {
    super(message);
    this.name = 'Mismatch';
  }
}

/// A failure bound to the step that produced it. The index is what shrinking
/// preserves: the prefix before it is context, the step at it is the trigger.
export class StepFailure extends Error {
  constructor(index, step, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'StepFailure';
    this.index = index;
    this.step = step;
  }
}

// ------------------------------------------------------------------- random

/// mulberry32: 32 bits of state, deterministic across platforms and Node
/// versions, and fast enough to draw thousands of commands. A seed is the
/// entire random state, so `--seed 7` names the same sequence forever.
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

export class Rng {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.next = mulberry32(this.seed);
  }

  /// Uniform in [0, bound). Bounds here are small (weights, list indexes); a
  /// modulo bias of 2^-32 is not a property this suite is testing.
  int(bound) {
    if (!Number.isInteger(bound) || bound <= 0) throw new Error(`int bound must be positive, got ${bound}`);
    return this.next() % bound;
  }

  pick(items) {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[this.int(items.length)];
  }

  /// True with probability `p` (0..1). `1 / p` is the number of outcomes per
  /// draw, so this is the weighted coin the generators use for rare branches.
  chance(p) {
    return this.int(1_000_000) < Math.round(p * 1_000_000);
  }
}

/// Weighted choice from `[{ value, weight }]`. Weights are relative, not
/// percentages, so a command can be made rarer by lowering its weight without
/// touching the others.
export function chooseWeighted(entries, rng) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) throw new Error('no weighted entries to choose from');
  let roll = rng.int(total);
  for (const entry of entries) {
    if (roll < entry.weight) return entry.value;
    roll -= entry.weight;
  }
  return entries[entries.length - 1].value;
}

// --------------------------------------------------------------- comparison

export const bigintSafe = (_key, value) => (typeof value === 'bigint' ? `${value}n` : value);

export function show(value) {
  return JSON.stringify(value, bigintSafe);
}

/// Our fixture bytes are compared by value, never by object identity.
export function sameBytes(a, b) {
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function eq(actual, expected, what) {
  const same = typeof expected === 'bigint' || typeof actual === 'bigint'
    ? BigInt(actual) === BigInt(expected)
    : actual === expected;
  if (!same) throw new Mismatch(`${what}: expected ${show(expected)}, got ${show(actual)}`);
  return actual;
}

/// Asserts a call returned `#ok` and hands back the payload.
export function expectOk(observed, what) {
  if (!observed || !('ok' in observed)) {
    throw new Mismatch(`${what}: expected #ok, got ${show(observed)}`);
  }
  return observed.ok;
}

/// Asserts a call returned `#err` **with the expected variant**. A test that
/// only asserted "it failed" would pass when the endpoint breaks for a reason
/// unrelated to the command being tested.
export function expectErr(observed, variant, what) {
  if (!observed || !('err' in observed) || !(variant in observed.err)) {
    throw new Mismatch(`${what}: expected #err(${variant}), got ${show(observed)}`);
  }
  return observed.err[variant];
}

/// The variant name of a Candid one-field variant, e.g. `#active` -> `active`.
export function variantOf(value) {
  return Object.keys(value)[0];
}

// ---------------------------------------------------------------- generation

const MAX_GENERATE_ATTEMPTS = 8;

/// Draws `count` steps from `seed` by running the **pure model forward**: at
/// every step the command is chosen by weight, it generates arguments from the
/// state it will see, and the model applies its own prediction. Generation
/// therefore never touches a canister, and the same seed always yields the
/// same steps.
export function generateSteps(machine, { seed, count }) {
  const rng = new Rng(seed);
  let model = machine.init(machine.generationContext());
  const steps = [];

  for (let index = 0; index < count; index += 1) {
    const choices = [];
    for (const command of Object.values(machine.commands)) {
      if (command.weight > 0) choices.push({ value: { kind: 'command', command }, weight: command.weight });
    }
    if (machine.advanceChoices?.length) {
      choices.push({ value: { kind: 'advance' }, weight: machine.advanceWeight ?? 1 });
    }
    if (machine.upgradeWeight) {
      choices.push({ value: { kind: 'upgrade' }, weight: machine.upgradeWeight });
    }

    let step = null;
    for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS && step === null; attempt += 1) {
      const choice = chooseWeighted(choices, rng);
      if (choice.kind === 'advance') {
        const ms = rng.pick(machine.advanceChoices);
        step = { type: '__advance', ms };
        model = machine.afterAdvance ? machine.afterAdvance(model, ms) : model;
      } else if (choice.kind === 'upgrade') {
        // Upgrades change no modelled state: `afterUpgrade` is where a model
        // would express a migration that does, and all four here are `stable`
        // actors whose promise is that nothing changes.
        step = { type: '__upgrade' };
      } else {
        const args = choice.command.generate(model, rng, index);
        if (args === null) continue; // no entity to act on yet; draw again
        const prediction = choice.command.predict(model, args);
        model = prediction.next;
        step = { type: choice.command.name, args };
      }
    }
    // Every machine has an always-available command, so this is a fallback
    // for a programming error rather than a normal path.
    if (step === null) step = { type: '__advance', ms: machine.advanceChoices?.[0] ?? 1_000 };
    steps.push(step);
  }
  return steps;
}

// ------------------------------------------------------------------ running

/// Replays `steps` against one canister through `io`, comparing every
/// observation with the model. Throws `StepFailure` naming the first step that
/// disagrees. `observe` runs after every step; a `full` observation (every
/// `observeEvery` steps and at the end) additionally sweeps all modelled
/// entities, which is what catches a corruption whose counters still add up.
export async function runSequence(machine, steps, io, { observeEvery = 25 } = {}) {
  let model = machine.init(await io.context());

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    try {
      if (step.type === '__advance') {
        await io.advance(step.ms);
        model = machine.afterAdvance ? machine.afterAdvance(model, step.ms) : model;
      } else if (step.type === '__upgrade') {
        await io.upgrade();
        model = machine.afterUpgrade ? machine.afterUpgrade(model) : model;
      } else {
        const command = machine.commands[step.type];
        if (!command) throw new Mismatch(`unknown step type ${step.type}`);
        const prediction = command.predict(model, step.args);
        const observed = await command.run(io, step.args);
        model = command.check(model, step.args, prediction, observed);
      }
      const full = (index + 1) % observeEvery === 0 || index === steps.length - 1;
      await machine.observe(io, model, { full, index });
    } catch (error) {
      if (error instanceof StepFailure) throw error;
      throw new StepFailure(index, step, error.message, error);
    }
  }
  return model;
}

// ----------------------------------------------------------------- shrinker

export function splitChunks(items, parts) {
  const size = Math.ceil(items.length / parts);
  const chunks = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

/// Delta debugging: repeatedly try to delete a chunk of the sequence while the
/// failure stays. Budgeted because every attempt is a fresh canister and a
/// replay; a run that fails will spend it, a green run spends nothing.
export async function shrinkSequence(steps, replay, { budget = 120, log = () => {} } = {}) {
  let best = steps;
  let attempts = 0;
  let granularity = 2;

  const stillFails = async (candidate) => {
    if (candidate.length === 0) return false;
    attempts += 1;
    const result = await replay(candidate);
    return result.failed;
  };

  while (best.length > 1 && attempts < budget) {
    const chunks = splitChunks(best, granularity);
    let reduced = false;
    let start = 0;
    for (let index = 0; index < chunks.length && attempts < budget; index += 1) {
      const chunk = chunks[index];
      const candidate = [...best.slice(0, start), ...best.slice(start + chunk.length)];
      start += chunk.length;
      if (candidate.length === 0) continue;
      if (await stillFails(candidate)) {
        log(`  shrink: ${best.length} -> ${candidate.length} steps`);
        best = candidate;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= best.length) break;
      granularity = Math.min(best.length, granularity * 2);
    }
  }
  return { steps: best, attempts };
}

/// A coarse identity for a failure, used by the shrinker so it never accepts a
/// candidate that fails for a different reason than the original. Digit runs
/// are normalised because ids legitimately change when earlier steps are
/// removed; the command and the expected error variant are what must survive.
export function failureSignature(failure) {
  const step = failure.step?.type ?? 'none';
  const message = String(failure.message)
    .replace(/\d+/g, 'N')
    .replace(/\{[^}]*\}/g, '{...}');
  const expected = /expected #err\((\w+)\)/.exec(message);
  if (expected) return `${step}|err:${expected[1]}`;
  const cut = message.indexOf(', got');
  return `${step}|${cut >= 0 ? message.slice(0, cut) : message}`;
}

/// True when `candidate` is the *same* failure as `original`: the same step
/// invocation fails, for the same kind of reason. A shrink candidate that
/// merely fails somewhere else is not a reproduction.
export function sameFailure(original, candidate) {
  return failureSignature(original) === failureSignature(candidate)
    && JSON.stringify(original.step, bigintSafe) === JSON.stringify(candidate.step, bigintSafe);
}

// ----------------------------------------------------------------- evidence

/// A failure artifact is just the everything-needed-to-replay file: model,
/// seed, steps, and the message. Nothing here depends on the process that
/// produced it.
export function failureBundle({ model, seed, steps, message }) {
  return {
    format: 'motoko-lab:state-machine-failure:v1',
    model,
    seed,
    message,
    steps,
  };
}

export function formatSteps(steps) {
  return JSON.stringify(steps, bigintSafe, 2);
}
