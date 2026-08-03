import Corpus "../backend/src/Corpus";
import Lm "../backend/src/Lm";
import Pipeline "../backend/src/Pipeline";
import Quant "../backend/src/Quant";
import Speculative "../backend/src/Speculative";
import Tokenizer "../backend/src/Tokenizer";

let model = Lm.train(Corpus.text);
let prompt = Tokenizer.encode(model.vocab, "speculative decoding uses");
let reference = Speculative.baseline(model, prompt, 24).tokens;

// Splitting the model across stages is a refactoring, not a change: run at full
// width with the model's own weights, a pipeline must reproduce single-node
// decoding token for token.
let exact = Pipeline.generate(model, Lm.TARGET, prompt, 24, null, #natural, #floor);
assert Speculative.identical(exact.tokens, reference);

// It costs round trips to do so: three stages means two extra hops per token.
assert exact.hops == exact.tokens.size() * 2;
assert exact.rounds == exact.tokens.size() * 3;
assert exact.bytes == exact.hops * Quant.denseBytes(model.vocabSize);

// Truncating quantization on every hop leaves the output alone, at any width,
// because the error is one-sided and cannot promote a competitor.
for (bits in [2, 4, 8, 12].vals()) {
  let run = Pipeline.generate(model, Lm.TARGET, prompt, 24, ?bits, #natural, #floor);
  assert Speculative.identical(run.tokens, reference);
  assert run.bytes < exact.bytes;
};

// Fewer bits must mean fewer bytes, monotonically.
let wide = Pipeline.generate(model, Lm.TARGET, prompt, 24, ?12, #natural, #floor);
let narrow = Pipeline.generate(model, Lm.TARGET, prompt, 24, ?4, #natural, #floor);
assert narrow.bytes < wide.bytes;

// A shorter head has fewer stages and therefore fewer hops.
let draftPipeline = Pipeline.generate(model, Lm.DRAFT, prompt, 24, null, #natural, #floor);
assert draftPipeline.hops == draftPipeline.tokens.size();

// The balanced profile is a different model, so it is compared against itself.
// What must hold is that quantization is measured against the right reference.
let balancedExact = Pipeline.generate(model, Lm.TARGET, prompt, 24, null, #balanced, #floor);
for (bits in [2, 4, 8].vals()) {
  let run = Pipeline.generate(model, Lm.TARGET, prompt, 24, ?bits, #balanced, #floor);
  assert Speculative.identical(run.tokens, balancedExact.tokens);
};

// Round-to-nearest is the mode that can diverge. Somewhere in this sweep it
// must actually do so, or the two rounding modes are indistinguishable and the
// pipeline experiment is measuring nothing.
var divergences = 0;
for (profile in [#natural, #balanced].vals()) {
  let profileExact = Pipeline.generate(model, Lm.TARGET, prompt, 24, null, profile, #floor);
  for (bits in [2, 4, 6, 8].vals()) {
    let run = Pipeline.generate(model, Lm.TARGET, prompt, 24, ?bits, profile, #nearest);
    if (not Speculative.identical(run.tokens, profileExact.tokens)) divergences += 1;
  };
};
assert divergences > 0;
