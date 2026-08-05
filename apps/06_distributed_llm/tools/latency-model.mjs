#!/usr/bin/env node
// Turns the counters measured by `make sim` into latency estimates.
//
// The simulation reports two things per strategy: how many *sequential* model
// passes it needed, and how many payload bytes crossed the wire. Neither is a
// time on its own. Which of them dominates depends entirely on the link, and
// the whole disagreement about whether distributed inference is practical comes
// down to that:
//
//   * On an Internet Computer subnet a round trip costs a consensus round,
//     around a second. Bytes are almost free by comparison. Only the *round*
//     count matters, so speculative decoding helps and activation compression
//     does not.
//
//   * On a 10 Mbit/s home link the opposite holds. A dense activation vector
//     takes longer to push through the pipe than the arithmetic took, so
//     compressing it is the whole game.
//
//   * In a datacenter neither dominates and compute is the limit.
//
// The model is deliberately crude - `rounds x rtt + bytes / bandwidth +
// compute` - because anything more detailed would imply a precision these
// counters do not have. It is here to show which term is large, not to predict
// a benchmark.
//
// No dependencies, no network. Run: node tools/latency-model.mjs [--json]

// --------------------------------------------------------------- profiles --

const PROFILES = [
  {
    name: 'ic-subnet',
    note: 'inter-canister call inside one subnet; latency is a consensus round',
    rttMs: 1000,
    mbps: 1000,
    computeMsPerEval: 0.05,
  },
  {
    name: 'ic-xnet',
    note: 'canisters on different subnets; two consensus rounds',
    rttMs: 2000,
    mbps: 1000,
    computeMsPerEval: 0.05,
  },
  {
    name: 'datacenter',
    note: 'GPUs on one fabric; neither term dominates',
    rttMs: 0.1,
    mbps: 100_000,
    computeMsPerEval: 0.05,
  },
  {
    name: 'lan',
    note: 'machines on one switch',
    rttMs: 1,
    mbps: 1000,
    computeMsPerEval: 0.05,
  },
  {
    name: 'home-p2p',
    note: 'volunteer nodes over consumer broadband; the bandwidth-bound case',
    rttMs: 40,
    mbps: 10,
    computeMsPerEval: 0.05,
  },
  {
    name: 'wan-p2p',
    note: 'volunteer nodes across regions; latency-bound',
    rttMs: 150,
    mbps: 100,
    computeMsPerEval: 0.05,
  },
];

// ------------------------------------------------------------ measurements --

// Counters produced by `make sim` on 2026-08-03 with moc 1.11.1, prompt
// "speculative decoding uses", 24-token budget, block 4, 2 unmasking steps,
// 4 shard workers, vocabulary 336. Re-run the simulation and update these if
// the corpus or the model changes.
//
// `remoteRounds`  sequential passes that cross the network.
// `localRounds`   sequential passes assumed to run on the caller (the draft
//                 model is small enough to sit next to the client; that
//                 assumption is what makes speculative decoding worth doing).
// `bytes`         payload actually transferred, summed over the run.
const MEASURED = [
  { strategy: 'baseline', tokens: 10, remoteRounds: 10, localRounds: 0, evals: 10, bytes: 0, lossless: true },
  { strategy: 'arDraft', tokens: 10, remoteRounds: 6, localRounds: 24, evals: 30, bytes: 0, lossless: true },
  { strategy: 'maskedDraft', tokens: 10, remoteRounds: 6, localRounds: 12, evals: 42, bytes: 0, lossless: true },
  { strategy: 'sharded/argmax', tokens: 10, remoteRounds: 10, localRounds: 0, evals: 40, bytes: 640, lossless: true },
  { strategy: 'sharded/dense', tokens: 10, remoteRounds: 10, localRounds: 0, evals: 40, bytes: 27200, lossless: true },
  { strategy: 'sharded/q8-floor', tokens: 10, remoteRounds: 10, localRounds: 0, evals: 40, bytes: 4000, lossless: true },
  { strategy: 'sharded/q2-floor', tokens: 10, remoteRounds: 10, localRounds: 0, evals: 40, bytes: 1480, lossless: true },
  { strategy: 'sharded/q4-nearest', tokens: 21, remoteRounds: 21, localRounds: 0, evals: 84, bytes: 4872, lossless: false },
  { strategy: 'pipeline/exact', tokens: 10, remoteRounds: 30, localRounds: 0, evals: 30, bytes: 53760, lossless: true },
  { strategy: 'pipeline/q8-floor', tokens: 10, remoteRounds: 30, localRounds: 0, evals: 30, bytes: 6880, lossless: true },
];

// A real deployment scales these up. The counters above come from a 336-entry
// vocabulary; a production model has 32k-256k logits and a hidden state of
// several thousand dimensions, so the byte term grows by three to four orders
// of magnitude while the round term does not move at all.
const SCALE_NOTE_VOCAB = 336;

// ----------------------------------------------------------------- model --

export function estimateMs(measurement, profile, byteScale = 1) {
  const networkMs = measurement.remoteRounds * profile.rttMs;
  const transferMs = ((measurement.bytes * byteScale * 8) / (profile.mbps * 1e6)) * 1000;
  const computeMs = measurement.evals * profile.computeMsPerEval + measurement.localRounds * profile.computeMsPerEval;
  return { networkMs, transferMs, computeMs, totalMs: networkMs + transferMs + computeMs };
}

export function dominantTerm(parts) {
  const entries = [
    ['network', parts.networkMs],
    ['transfer', parts.transferMs],
    ['compute', parts.computeMs],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

export function tokensPerSecond(measurement, parts) {
  if (parts.totalMs <= 0) return Infinity;
  return (measurement.tokens / parts.totalMs) * 1000;
}

// ---------------------------------------------------------------- report --

function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padLeft(text, width) {
  const s = String(text);
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function fmt(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(1)}ms`;
  return `${ms.toFixed(3)}ms`;
}

function report({ byteScale, scaleLabel }) {
  for (const profile of PROFILES) {
    console.log('');
    console.log(`== ${profile.name} — ${profile.note}`);
    console.log(`   rtt ${profile.rttMs}ms, ${profile.mbps} Mbit/s${scaleLabel}`);
    console.log(
      `   ${pad('strategy', 20)}${padLeft('network', 10)}${padLeft('transfer', 10)}${padLeft('compute', 10)}${padLeft('total', 10)}${padLeft('tok/s', 9)}  dominant  lossless`,
    );
    for (const m of MEASURED) {
      const parts = estimateMs(m, profile, byteScale);
      console.log(
        `   ${pad(m.strategy, 20)}${padLeft(fmt(parts.networkMs), 10)}${padLeft(fmt(parts.transferMs), 10)}${padLeft(
          fmt(parts.computeMs),
          10,
        )}${padLeft(fmt(parts.totalMs), 10)}${padLeft(tokensPerSecond(m, parts).toFixed(2), 9)}  ${pad(
          dominantTerm(parts),
          10,
        )}${m.lossless ? 'yes' : 'NO'}`,
      );
    }
  }
}

function main(argv) {
  const wantsJson = argv.includes('--json');
  // A production-sized model moves far more per hop. `--scale N` multiplies the
  // measured byte counts so the crossover can be located without pretending the
  // toy produced those numbers.
  const scaleIndex = argv.indexOf('--scale');
  const byteScale = scaleIndex >= 0 ? Number(argv[scaleIndex + 1]) : 1;
  if (!Number.isFinite(byteScale) || byteScale <= 0) {
    console.error('--scale expects a positive number');
    process.exit(2);
  }

  if (wantsJson) {
    const out = [];
    for (const profile of PROFILES) {
      for (const m of MEASURED) {
        const parts = estimateMs(m, profile, byteScale);
        out.push({
          profile: profile.name,
          strategy: m.strategy,
          byteScale,
          ...parts,
          tokensPerSecond: tokensPerSecond(m, parts),
          dominant: dominantTerm(parts),
          lossless: m.lossless,
        });
      }
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log('latency model for apps/06_distributed_llm');
  console.log('counters measured by `make sim`; times are estimates, not a benchmark');
  console.log(
    `vocabulary of the measured model: ${SCALE_NOTE_VOCAB} tokens` +
      (byteScale === 1 ? ' (use --scale N to project a larger model)' : ''),
  );
  report({
    byteScale,
    scaleLabel: byteScale === 1 ? '' : `, byte counts x${byteScale}`,
  });
  console.log('');
  console.log('reading the table:');
  console.log('  network dominant  -> cut sequential rounds (speculative / diffusion drafting)');
  console.log('  transfer dominant -> cut bytes per hop (argmax reduction, quantized activations)');
  console.log('  compute dominant  -> the distribution is not buying anything');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}

export { PROFILES, MEASURED, main };
