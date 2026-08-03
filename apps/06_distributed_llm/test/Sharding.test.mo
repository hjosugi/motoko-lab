import Array "mo:core/Array";
import Corpus "../backend/src/Corpus";
import Lm "../backend/src/Lm";
import Sharding "../backend/src/Sharding";
import Tokenizer "../backend/src/Tokenizer";
import Types "../backend/src/Types";
import WorkerEngine "../backend/src/WorkerEngine";

let model = Lm.train(Corpus.text);
let engine = WorkerEngine.Engine();
assert engine.vocabSize() == model.vocabSize;

// Ranges must tile the vocabulary exactly: no gap (a token nobody scores) and
// no overlap (a token two shards both claim).
for (count in [1, 2, 3, 4, 5, 7, 16].vals()) {
  var expected = 0;
  var shard = 0;
  while (shard < count) {
    let r = Sharding.range(model.vocabSize, shard, count);
    assert r.lo == expected;
    assert r.hi >= r.lo;
    expected := r.hi;
    shard += 1;
  };
  assert expected == model.vocabSize;
};

// Out-of-range shard indices produce an empty slice rather than trapping.
assert Sharding.range(10, 5, 3) == { lo = 0; hi = 0 };
assert Sharding.range(10, 0, 0) == { lo = 0; hi = 0 };

// A cluster must choose the same token a single canister would, for every shard
// count and every wire format that is supposed to be exact.
let corpus = Tokenizer.encode(model.vocab, Corpus.text);
let modes : [Types.ReplyMode] = [
  #argmax,
  #dense,
  #quantized { bits = 8; rounding = #floor },
  #quantized { bits = 2; rounding = #floor },
];

var position = 2;
while (position < 120) {
  let ctx : Types.Ctx = { prev2 = ?corpus[position - 2]; prev1 = ?corpus[position - 1] };
  let single = Lm.nextFromCtx(model, Lm.TARGET, { prev2 = ctx.prev2; prev1 = ctx.prev1 });

  for (count in [1, 2, 3, 4, 7].vals()) {
    for (mode in modes.vals()) {
      var replies : [Sharding.WorkerReply] = [];
      var shard = 0;
      while (shard < count) {
        let reply = engine.handle(shard, count, { order = Lm.TARGET; ctx; mode });
        assert reply.shard == shard;
        assert reply.bytes > 0;
        replies := Array.concat(replies, [reply]);
        shard += 1;
      };
      let merged = Sharding.merge(replies);
      assert merged.token == single;
    };
  };
  position += 1;
};

// The wire cost ordering the design rests on: a max reduction is orders of
// magnitude cheaper than shipping the activation, and quantizing sits between.
let ctx : Types.Ctx = { prev2 = ?corpus[5]; prev1 = ?corpus[6] };
let argmaxReply = engine.handle(0, 1, { order = Lm.TARGET; ctx; mode = #argmax });
let denseReply = engine.handle(0, 1, { order = Lm.TARGET; ctx; mode = #dense });
let quantReply = engine.handle(0, 1, { order = Lm.TARGET; ctx; mode = #quantized { bits = 8; rounding = #floor } });
assert argmaxReply.bytes < quantReply.bytes;
assert quantReply.bytes < denseReply.bytes;
assert denseReply.bytes >= model.vocabSize * 8;

// Sharding splits the payload: four workers each send a quarter of the slice.
let whole = engine.handle(0, 1, { order = Lm.TARGET; ctx; mode = #dense }).bytes;
var split = 0;
var shard = 0;
while (shard < 4) {
  split += engine.handle(shard, 4, { order = Lm.TARGET; ctx; mode = #dense }).bytes;
  shard += 1;
};
assert split >= whole; // same payload plus three extra headers
assert split < whole * 2;

// Worker metadata reports the slice it actually serves.
let info = engine.info(2, 4);
assert info.shard == 2;
assert info.shardCount == 4;
assert info.vocabSize == model.vocabSize;
assert info.hi > info.lo;

assert Sharding.merge([]).token == 0;
