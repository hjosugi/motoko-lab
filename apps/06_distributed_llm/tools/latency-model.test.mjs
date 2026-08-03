import assert from "node:assert/strict";
import { MEASURED, PROFILES, dominantTerm, estimateMs, tokensPerSecond } from "./latency-model.mjs";

const byName = (name) => PROFILES.find((p) => p.name === name);
const strategy = (name) => MEASURED.find((m) => m.strategy === name);

// The measurements must stay internally consistent, otherwise the estimates are
// arithmetic on nonsense.
for (const m of MEASURED) {
  assert.ok(m.tokens > 0, `${m.strategy}: produced no tokens`);
  assert.ok(m.remoteRounds > 0, `${m.strategy}: no remote rounds`);
  assert.ok(m.evals >= m.remoteRounds, `${m.strategy}: fewer evaluations than rounds`);
  assert.ok(m.bytes >= 0);
}

// Speculative decoding must reduce remote rounds against the baseline; that is
// the only reason to run it.
const baseline = strategy("baseline");
for (const name of ["arDraft", "maskedDraft"]) {
  assert.ok(strategy(name).remoteRounds < baseline.remoteRounds, `${name} did not cut remote rounds`);
}

// A diffusion-style draft trades sequential draft passes for extra arithmetic.
assert.ok(strategy("maskedDraft").localRounds < strategy("arDraft").localRounds);
assert.ok(strategy("maskedDraft").evals > strategy("arDraft").evals);

// Wire formats, cheapest first.
assert.ok(strategy("sharded/argmax").bytes < strategy("sharded/q2-floor").bytes);
assert.ok(strategy("sharded/q2-floor").bytes < strategy("sharded/q8-floor").bytes);
assert.ok(strategy("sharded/q8-floor").bytes < strategy("sharded/dense").bytes);

// Every strategy that claims losslessness must have been checked against the
// single-node output in the simulation, and the one lossy strategy must be
// flagged. A silent `lossless: true` here would be the worst kind of error.
assert.equal(strategy("sharded/q4-nearest").lossless, false);
assert.equal(strategy("sharded/q8-floor").lossless, true);

// --- the model itself -------------------------------------------------------

// Latency is monotone in every term.
const home = byName("home-p2p");
const slower = { ...home, rttMs: home.rttMs * 2 };
assert.ok(estimateMs(baseline, slower).totalMs > estimateMs(baseline, home).totalMs);

const dense = strategy("sharded/dense");
assert.ok(estimateMs(dense, home, 2).transferMs > estimateMs(dense, home, 1).transferMs);
assert.equal(estimateMs(dense, home, 2).networkMs, estimateMs(dense, home, 1).networkMs);

// Bytes are free on a subnet: a consensus round swamps them, so compressing the
// activation buys nothing there.
const subnet = byName("ic-subnet");
assert.equal(dominantTerm(estimateMs(dense, subnet)), "network");
assert.equal(dominantTerm(estimateMs(strategy("sharded/argmax"), subnet)), "network");
assert.ok(
  Math.abs(estimateMs(dense, subnet).totalMs - estimateMs(strategy("sharded/q2-floor"), subnet).totalMs) < 1,
  "quantization changed subnet latency by more than a millisecond",
);

// At production-sized activations on a consumer link the picture inverts:
// transfer dominates and quantization is worth multiples.
const scaled = 1000;
assert.equal(dominantTerm(estimateMs(dense, home, scaled)), "transfer");
const denseMs = estimateMs(dense, home, scaled).totalMs;
const quantMs = estimateMs(strategy("sharded/q8-floor"), home, scaled).totalMs;
assert.ok(quantMs * 4 < denseMs, `expected a large win from 8-bit activations, got ${denseMs / quantMs}x`);

// ...while cutting rounds is worth nothing there, because rounds are not the
// bottleneck any more. Both levers exist; neither is universal.
assert.ok(estimateMs(strategy("arDraft"), home, scaled).totalMs < estimateMs(dense, home, scaled).totalMs);

// tokens/s is derived from the run's own token count, not assumed.
const parts = estimateMs(baseline, home);
assert.ok(Math.abs(tokensPerSecond(baseline, parts) - (baseline.tokens / parts.totalMs) * 1000) < 1e-9);

// Every profile must classify every strategy.
for (const profile of PROFILES) {
  for (const m of MEASURED) {
    const p = estimateMs(m, profile);
    assert.ok(Number.isFinite(p.totalMs) && p.totalMs > 0, `${profile.name}/${m.strategy}`);
    assert.ok(["network", "transfer", "compute"].includes(dominantTerm(p)));
  }
}

console.log(`ok: ${MEASURED.length} strategies x ${PROFILES.length} network profiles`);
