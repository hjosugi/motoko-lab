import Corpus "../backend/src/Corpus";
import Lm "../backend/src/Lm";
import Speculative "../backend/src/Speculative";
import Tokenizer "../backend/src/Tokenizer";

let model = Lm.train(Corpus.text);

let prompts = [
  "a canister is",
  "speculative decoding uses",
  "a diffusion language model",
  "the activation that moves between two pipeline stages",
  "distributed inference splits one model",
  "quantizing an activation to eight bits",
  "consensus requires that every replica",
  "totally unseen words here",
  "",
];

// The claim under test: both accelerated decoders reproduce the plain
// autoregressive output exactly, for every prompt, block size and unmasking
// schedule. If any combination diverges the whole design is unsound, so this is
// swept rather than spot-checked.
for (prompt in prompts.vals()) {
  let ids = Tokenizer.encode(model.vocab, prompt);
  let reference = Speculative.baseline(model, ids, 24);

  for (block in [1, 2, 3, 4, 8, 16].vals()) {
    let ar = Speculative.arDraft(model, ids, 24, block);
    assert Speculative.identical(ar.tokens, reference.tokens);
    assert ar.metrics.accepted <= ar.metrics.proposed;
    assert ar.metrics.targetRounds <= reference.metrics.targetRounds;
    assert Speculative.acceptanceRatePercent(ar.metrics) <= 100;

    for (steps in [1, 2, 3, 4].vals()) {
      let masked = Speculative.maskedDraft(model, ids, 24, block, steps);
      assert Speculative.identical(masked.tokens, reference.tokens);
      assert masked.metrics.accepted <= masked.metrics.proposed;

      // The point of a diffusion-style draft: the draft stage costs at most
      // `steps` sequential passes per block, never `block` of them.
      let blocks = masked.metrics.proposed / block;
      assert masked.metrics.draftRounds <= blocks * steps;

      // ...and it pays for that with extra arithmetic inside each pass.
      assert masked.metrics.draftEvals >= masked.metrics.draftRounds;
    };
  };
};

// A block size of zero is clamped rather than dividing by zero.
let clamped = Speculative.arDraft(model, Tokenizer.encode(model.vocab, "a canister is"), 8, 0);
assert clamped.tokens.size() <= 8;

// Token budgets are respected exactly, including budgets that do not divide the
// block size.
for (budget in [1, 3, 5, 7, 24].vals()) {
  let ids = Tokenizer.encode(model.vocab, "a canister is");
  let reference = Speculative.baseline(model, ids, budget);
  assert reference.tokens.size() <= budget;
  let ar = Speculative.arDraft(model, ids, budget, 4);
  assert ar.tokens.size() <= budget;
  assert Speculative.identical(ar.tokens, reference.tokens);
};

// Metric bookkeeping.
let empty : Speculative.Metrics = {
  tokens = 0;
  targetRounds = 0;
  targetEvals = 0;
  draftRounds = 0;
  draftEvals = 0;
  proposed = 0;
  accepted = 0;
};
assert Speculative.acceptanceRatePercent(empty) == 0;
assert Speculative.roundReductionPercent(0, empty) == 0;
assert Speculative.roundReductionPercent(10, { empty with targetRounds = 4; draftRounds = 1 }) == 50;
assert Speculative.roundReductionPercent(10, { empty with targetRounds = 20 }) == 0;

assert Speculative.identical([], []);
assert not Speculative.identical([1], []);
assert not Speculative.identical([1, 2], [1, 3]);
