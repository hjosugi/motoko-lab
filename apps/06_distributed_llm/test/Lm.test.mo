import Corpus "../backend/src/Corpus";
import Lm "../backend/src/Lm";
import Tokenizer "../backend/src/Tokenizer";

let model = Lm.train(Corpus.text);

assert model.vocabSize > 100;
assert model.unigramTotal > 0;
assert Tokenizer.textOf(model.vocab, model.stop) == ".";

// Training twice from the same corpus gives the same scores everywhere. This is
// the property a subnet depends on: no float, no hash seed, no wall clock.
let twin = Lm.train(Corpus.text);
assert twin.vocabSize == model.vocabSize;

let probe = Tokenizer.encode(model.vocab, "a canister is");
let ctx = Lm.ctxOf(probe);
let a = Lm.scoreVector(model, Lm.TARGET, ctx);
let b = Lm.scoreVector(twin, Lm.TARGET, ctx);
assert a.size() == b.size();
var i = 0;
while (i < a.size()) {
  assert a[i] == b[i];
  i += 1;
};

// The score vector is exactly the sum of the stage terms. `Pipeline.mo` splits
// the model along this decomposition, so if it drifts the pipeline stops being
// a refactoring of the same arithmetic.
let stages = Lm.stagesFor(Lm.TARGET);
assert stages.size() == 3;
var position = 0;
while (position < model.vocabSize) {
  var sum = 0;
  for (stage in stages.vals()) {
    sum += Lm.stageRange(model, stage, ctx, position, position + 1)[0];
  };
  assert sum == a[position];
  position += 1;
};

// A shard's slice is exactly the corresponding window of the full vector.
let slice = Lm.scoreRange(model, Lm.TARGET, ctx, 10, 20);
assert slice.size() == 10;
i := 0;
while (i < 10) {
  assert slice[i] == a[10 + i];
  i += 1;
};

// Argmax breaks ties on the lowest id, which is what makes a sharded merge
// agree with a single node.
assert Lm.argmax([5, 9, 9, 2]) == (1, 9);
assert Lm.argmax([0, 0, 0]) == (0, 0);
assert Lm.argmax([]) == (0, 0);

// A masked left neighbour backs the model off instead of failing.
let masked : Lm.Ctx = { prev2 = null; prev1 = null };
let backoff = Lm.scoreVector(model, Lm.TARGET, masked);
assert backoff.size() == model.vocabSize;
let unigramOnly = Lm.scoreVector(model, 1, masked);
i := 0;
while (i < backoff.size()) {
  assert backoff[i] == unigramOnly[i];
  i += 1;
};

// The draft head is a strictly shorter context than the target head, and the
// two genuinely disagree — otherwise speculative decoding would be free and the
// acceptance rate would carry no information.
var disagreements = 0;
let corpus = Tokenizer.encode(model.vocab, Corpus.text);
var p = 2;
while (p < 200) {
  let c : Lm.Ctx = { prev2 = ?corpus[p - 2]; prev1 = ?corpus[p - 1] };
  if (Lm.nextFromCtx(model, Lm.TARGET, c) != Lm.nextFromCtx(model, Lm.DRAFT, c)) {
    disagreements += 1;
  };
  p += 1;
};
assert disagreements > 0;
assert disagreements < 198;

// Generation stops at the stop token and respects the budget.
let generated = Lm.generate(model, Lm.TARGET, probe, 40);
assert generated.size() <= 40;
assert generated.size() > 0;

// Confidence is a fraction of SCALE.
assert Lm.confidence(a) <= Lm.SCALE;
assert Lm.confidence([]) == 0;
assert Lm.confidence([0, 0]) == 0;
assert Lm.confidence([7]) == Lm.SCALE;
