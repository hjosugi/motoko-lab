import Corpus "../backend/src/Corpus";
import Lm "../backend/src/Lm";
import Quant "../backend/src/Quant";
import Tokenizer "../backend/src/Tokenizer";

let model = Lm.train(Corpus.text);

// Byte accounting, which the reports quote.
assert Quant.denseBytes(336) == 2_688;
assert Quant.quantizedBytes(Quant.quantize([1, 2, 3, 4], 8)) == 12; // 4 codes + 8-byte scale
assert Quant.quantizedBytes(Quant.quantize([1, 2, 3, 4], 2)) == 9; // 8 bits packed + scale

// Degenerate inputs.
assert Quant.quantize([], 8).codes == [];
assert Quant.quantize([0, 0, 0], 8).scale == 0;
assert Quant.dequantize(Quant.quantize([0, 0, 0], 8)) == [0, 0, 0];

// The maximum survives a round trip exactly, at any width. This is the fact the
// argmax guarantee rests on.
for (bits in [2, 4, 8, 16].vals()) {
  let restored = Quant.roundTrip([10, 500, 3, 499], bits, #floor);
  assert restored[1] == 500;
  assert restored[0] <= 10;
  assert restored[2] <= 3;
  assert restored[3] <= 499;
};

// Truncating quantization is argmax-preserving by construction: no value other
// than the maximum can reach the top code, and every value is rounded down, so
// the leader can never lose ground. Swept over every context of the corpus, for
// both heads, at every width that matters.
let corpus = Tokenizer.encode(model.vocab, Corpus.text);
let samples = if (corpus.size() > 300) 300 else corpus.size();

var nearestFlips = 0;
var checked = 0;

for (order in [Lm.TARGET, Lm.DRAFT].vals()) {
  var i = 2;
  while (i < samples) {
    let ctx : Lm.Ctx = { prev2 = ?corpus[i - 2]; prev1 = ?corpus[i - 1] };
    let scores = Lm.scoreVector(model, order, ctx);
    let (exact, _) = Lm.argmax(scores);

    for (bits in [2, 4, 8].vals()) {
      let (floored, _) = Lm.argmax(Quant.roundTrip(scores, bits, #floor));
      assert floored == exact;

      let (nearest, _) = Lm.argmax(Quant.roundTrip(scores, bits, #nearest));
      if (nearest != exact) nearestFlips += 1;
      checked += 1;
    };
    i += 1;
  };
};

// Round-to-nearest has two-sided error and therefore does flip tokens. If this
// ever became zero the two rounding modes would be indistinguishable and the
// experiment in `sim/Cluster.mo` would be measuring nothing.
assert checked > 0;
assert nearestFlips > 0;
