import Array "mo:core/Array";
import Corpus "../backend/src/Corpus";
import Lm "../backend/src/Lm";
import Quant "../backend/src/Quant";
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

// ------------------------------------------------------------------- plan --

// Every shard is scored `replication` times, by that many *distinct* workers,
// and every worker carries the same load. Skew here would turn replication into
// a hot spot instead of a cross-check.
for (workers in [1, 2, 3, 4, 7].vals()) {
  for (requested in [0, 1, 2, 3, 9].vals()) {
    let tasks = Sharding.plan(model.vocabSize, workers, requested);
    let k = if (requested == 0) 1 else if (requested > workers) workers else requested;
    assert tasks.size() == workers * k;

    var shard = 0;
    while (shard < workers) {
      var seen : [Nat] = [];
      for (t in tasks.vals()) {
        if (t.shard == shard) {
          assert t.range == Sharding.range(model.vocabSize, shard, workers);
          for (w in seen.vals()) { assert w != t.worker }; // distinct workers
          seen := Array.concat(seen, [t.worker]);
        };
      };
      assert seen.size() == k;
      shard += 1;
    };

    var worker = 0;
    while (worker < workers) {
      var load = 0;
      for (t in tasks.vals()) { if (t.worker == worker) load += 1 };
      assert load == k;
      worker += 1;
    };
  };
};

// ------------------------------------------------------------------ merge --

// A cluster must choose the same token a single canister would, for every shard
// count and every wire format that is supposed to be exact.
let corpus = Tokenizer.encode(model.vocab, Corpus.text);
let modes : [Types.ReplyMode] = [
  #argmax,
  #dense,
  #quantized { bits = 8; rounding = #floor },
  #quantized { bits = 2; rounding = #floor },
];

func honest(shard : Nat, count : Nat, ctx : Types.Ctx, mode : Types.ReplyMode) : Sharding.WorkerReply {
  engine.handle(shard, count, { order = Lm.TARGET; ctx; mode; range = null });
};

var position = 2;
while (position < 120) {
  let ctx : Types.Ctx = { prev2 = ?corpus[position - 2]; prev1 = ?corpus[position - 1] };
  let single = Lm.nextFromCtx(model, Lm.TARGET, { prev2 = ctx.prev2; prev1 = ctx.prev1 });

  for (count in [1, 2, 3, 4, 7].vals()) {
    for (mode in modes.vals()) {
      var replies : [Sharding.WorkerReply] = [];
      var shard = 0;
      while (shard < count) {
        let reply = honest(shard, count, ctx, mode);
        assert reply.shard == shard;
        assert reply.bytes > 0;
        assert reply.lo == Sharding.range(model.vocabSize, shard, count).lo;
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
let argmaxReply = honest(0, 1, ctx, #argmax);
let denseReply = honest(0, 1, ctx, #dense);
let quantReply = honest(0, 1, ctx, #quantized { bits = 8; rounding = #floor });
assert argmaxReply.bytes < quantReply.bytes;
assert quantReply.bytes < denseReply.bytes;
assert denseReply.bytes >= model.vocabSize * 8;

// Sharding splits the payload: four workers each send a quarter of the slice.
let whole = honest(0, 1, ctx, #dense).bytes;
var split = 0;
var shard = 0;
while (shard < 4) {
  split += honest(shard, 4, ctx, #dense).bytes;
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

// -------------------------------------------------------- byzantine checks --

let WORKERS = 4;

/// Answers the range it was asked for, honestly. `worker` is who answered.
func answer(worker : Nat, task : Sharding.Task, mode : Types.ReplyMode) : Sharding.WorkerReply {
  engine.handle(worker, WORKERS, { order = Lm.TARGET; ctx; mode; range = ?task.range });
};

func round(tasks : [Sharding.Task], mode : Types.ReplyMode) : [Sharding.WorkerReply] {
  Array.map<Sharding.Task, Sharding.WorkerReply>(tasks, func(t : Sharding.Task) : Sharding.WorkerReply { answer(t.worker, t, mode) });
};

// A worker asked for somebody else's range answers that range, not its own.
// Without this replication cannot work at all.
let borrowed = engine.handle(
  0,
  WORKERS,
  { order = Lm.TARGET; ctx; mode = #dense; range = ?Sharding.range(model.vocabSize, 3, WORKERS) },
);
assert borrowed.lo == Sharding.range(model.vocabSize, 3, WORKERS).lo;
assert borrowed.hi == Sharding.range(model.vocabSize, 3, WORKERS).hi;
assert Sharding.sameReply(borrowed.reply, honest(3, WORKERS, ctx, #dense).reply);

// An honest round verifies, at every replication factor, and the accepted set
// is one reply per shard however many replicas were collected.
for (k in [1, 2, 3, 4].vals()) {
  let tasks = Sharding.plan(model.vocabSize, WORKERS, k);
  switch (Sharding.verify(tasks, round(tasks, #argmax), WORKERS)) {
    case (#ok v) {
      assert v.accepted.size() == WORKERS;
      assert v.bytes == 16 * WORKERS * k; // every reply counted, replicas included
      assert Sharding.merge(v.accepted).token == Lm.nextFromCtx(model, Lm.TARGET, { prev2 = ctx.prev2; prev1 = ctx.prev1 });
    };
    case (#err _) assert false;
  };
};

/// A worker that inflates one token's score so the max reduction picks it.
///
/// The forged score has to clear the honest ceiling, which is `W3 * Lm.SCALE`
/// (a trigram row that only ever saw one continuation) — about 1e9. A "very
/// large" number that is merely large is not a lie the merge notices.
func lie(reply : Sharding.WorkerReply, token : Nat) : Sharding.WorkerReply {
  let forged : Sharding.Reply = #argmax { token; score = 1_000 * Lm.SCALE * 1_000 };
  { reply with reply = forged; bytes = Sharding.replyBytes(forged) };
};

let honestTasks = Sharding.plan(model.vocabSize, WORKERS, 1);
let honestRound = round(honestTasks, #argmax);
let truth = Sharding.merge(honestRound).token;

// Unreplicated: the lie passes verification and changes the answer. If this
// assertion ever fails the byzantine tests below are proving nothing.
let unprotected = Array.tabulate<Sharding.WorkerReply>(
  honestRound.size(),
  func(i : Nat) : Sharding.WorkerReply {
    if (honestTasks[i].shard == 3) lie(honestRound[i], honestTasks[i].range.lo) else honestRound[i];
  },
);
switch (Sharding.verify(honestTasks, unprotected, WORKERS)) {
  case (#ok v) {
    assert Sharding.merge(v.accepted).token != truth;
    assert Sharding.merge(v.accepted).token == honestTasks[3].range.lo;
  };
  case (#err _) assert false;
};

// Replicated: worker 3 tells the same lie, one other worker scores the same
// range honestly, and the round is rejected instead of merged.
let dupTasks = Sharding.plan(model.vocabSize, WORKERS, 2);
let dupRound = round(dupTasks, #argmax);
let withLiar = Array.tabulate<Sharding.WorkerReply>(
  dupRound.size(),
  func(i : Nat) : Sharding.WorkerReply {
    if (dupTasks[i].worker == 3) lie(dupRound[i], dupTasks[i].range.lo) else dupRound[i];
  },
);
switch (Sharding.verify(dupTasks, withLiar, WORKERS)) {
  case (#err(#disagreement d)) {
    // Both ranges worker 3 covers are contested, and shard order means the
    // lower-numbered one is reported first.
    assert d.workers.0 == 3 or d.workers.1 == 3;
  };
  case _ assert false;
};

// A reply about a range nobody asked for is rejected before any of that.
let renamed = Array.tabulate<Sharding.WorkerReply>(
  honestRound.size(),
  func(i : Nat) : Sharding.WorkerReply {
    if (i == 1) ({ honestRound[i] with lo = 0; hi = 1 }) else honestRound[i];
  },
);
switch (Sharding.verify(honestTasks, renamed, WORKERS)) {
  case (#err(#wrongRange r)) assert r.shard == 1;
  case _ assert false;
};

// A shard nobody answered is a missing shard, not a silently smaller merge.
switch (Sharding.verify([honestTasks[0]], [honestRound[0]], WORKERS)) {
  case (#err(#missing m)) assert m.shard == 1;
  case _ assert false;
};

// -------------------------------------------------------------- spot check --

// The orchestrator recomputes a range itself. An honest reply matches in every
// wire format; the lie does not, including the quantized format where the
// orchestrator has to quantize its own slice the same way to compare.
for (mode in modes.vals()) {
  let tasks = Sharding.plan(model.vocabSize, WORKERS, 1);
  let replies = round(tasks, mode);
  var i = 0;
  while (i < tasks.size()) {
    let exact = Lm.scoreRange(model, Lm.TARGET, { prev2 = ctx.prev2; prev1 = ctx.prev1 }, tasks[i].range.lo, tasks[i].range.hi);
    assert Sharding.spotCheck(replies[i], mode, exact);
    assert not Sharding.spotCheck(lie(replies[i], tasks[i].range.lo), mode, exact);
    i += 1;
  };
};

// The rotation visits every shard within `shards` rounds, so a worker that lies
// on every round is caught deterministically rather than eventually.
var visited : [Nat] = [];
var r = 0;
while (r < WORKERS) {
  switch (Sharding.spotCheckTarget(r, WORKERS)) {
    case (?shard) visited := Array.concat(visited, [shard]);
    case null assert false;
  };
  r += 1;
};
var s = 0;
while (s < WORKERS) {
  var hits = 0;
  for (v in visited.vals()) { if (v == s) hits += 1 };
  assert hits == 1;
  s += 1;
};
assert Sharding.spotCheckTarget(0, 0) == null;

// ------------------------------------------------------------ reply equality --

// `sameReply` is the predicate every cross-check rests on, so it has to be
// exact rather than approximately right.
let dense = #dense { lo = 0; scores = [1, 2, 3] };
assert Sharding.sameReply(dense, #dense { lo = 0; scores = [1, 2, 3] });
assert not Sharding.sameReply(dense, #dense { lo = 1; scores = [1, 2, 3] });
assert not Sharding.sameReply(dense, #dense { lo = 0; scores = [1, 2, 4] });
assert not Sharding.sameReply(dense, #dense { lo = 0; scores = [1, 2] });
assert not Sharding.sameReply(dense, #argmax { token = 2; score = 3 });

let q = Quant.quantizeWith([1, 2, 3], 8, #floor);
assert Sharding.sameReply(#quantized { lo = 0; codes = q; rounding = #floor }, #quantized { lo = 0; codes = q; rounding = #floor });
assert not Sharding.sameReply(
  #quantized { lo = 0; codes = q; rounding = #floor },
  #quantized { lo = 0; codes = Quant.quantizeWith([1, 2, 4], 8, #floor); rounding = #floor },
);
