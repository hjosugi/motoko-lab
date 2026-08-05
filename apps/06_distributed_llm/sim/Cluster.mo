/// Runnable multi-canister cluster, executed by the Motoko interpreter.
///
///     moc -r --package core <core/src> apps/06_distributed_llm/sim/Cluster.mo
///
/// `moc -r` runs a real actor scheduler: `await` on another actor is a genuine
/// message send, actor classes really are separate actors, and the state of one
/// is not reachable from another. That makes this an honest end-to-end run of
/// the orchestration protocol on any machine, including ones that cannot
/// download a replica binary.
///
/// What it is not: a replica. There is no consensus, no cycle accounting, no
/// instruction limit and no upgrade. Deploy to a local network (`make
/// deploy-local`) to exercise those.
///
/// The worker and shim actor classes below wrap exactly the same
/// `WorkerEngine` / `Lm` / `LlmClient` modules the deployed canisters use; only
/// the actor plumbing is restated, because Motoko cannot import a top-level
/// actor as a library.
import Array "mo:core/Array";
import Debug "mo:core/Debug";
import Nat "mo:core/Nat";
import Runtime "mo:core/Runtime";
import VarArray "mo:core/VarArray";
import Corpus "../backend/src/Corpus";
import Lm "../backend/src/Lm";
import Pipeline "../backend/src/Pipeline";
import LlmClient "../backend/src/LlmClient";
import Quant "../backend/src/Quant";
import Sharding "../backend/src/Sharding";
import Speculative "../backend/src/Speculative";
import Tokenizer "../backend/src/Tokenizer";
import Types "../backend/src/Types";
import WorkerEngine "../backend/src/WorkerEngine";

// ---------------------------------------------------------------- actors --

persistent actor class ShardWorker(shard : Nat, count : Nat) {
  transient let engine = WorkerEngine.Engine();
  public query func info() : async Types.WorkerInfo { engine.info(shard, count) };
  public query func score(request : Types.ShardRequest) : async Sharding.WorkerReply {
    engine.handle(shard, count, request);
  };
};

persistent actor class LlmShim() {
  transient let model = Lm.train(Corpus.text);
  public func v1_chat(request : LlmClient.Request) : async LlmClient.Response {
    var text = "";
    for (m in request.messages.vals()) {
      switch m { case (#user u) text := u.content; case _ {} };
    };
    let ids = Tokenizer.encode(model.vocab, text);
    {
      message = {
        content = ?("[shim] " # Tokenizer.decode(model.vocab, Lm.generate(model, Lm.TARGET, ids, 24)));
        tool_calls = [];
      };
    };
  };
};

type WorkerRef = actor {
  info : shared query () -> async Types.WorkerInfo;
  score : shared query (Types.ShardRequest) -> async Sharding.WorkerReply;
};

type ShimRef = actor {
  v1_chat : shared (LlmClient.Request) -> async LlmClient.Response;
};

persistent actor class Orchestrator(workers : [WorkerRef], shim : ShimRef) {
  transient let model = Lm.train(Corpus.text);

  /// One decoding position fanned out over every worker. All requests are
  /// issued before the first `await`, so the workers run concurrently and the
  /// step costs one round trip instead of `workers.size()`.
  func step(ctx : Lm.Ctx, mode : Types.ReplyMode) : async { token : Nat; bytes : Nat; calls : Nat } {
    let n = workers.size();
    let request : Types.ShardRequest = {
      order = Lm.TARGET;
      ctx = { prev2 = ctx.prev2; prev1 = ctx.prev1 };
      mode;
    };
    let pending = VarArray.repeat<?(async Sharding.WorkerReply)>(null, n);
    var i = 0;
    while (i < n) { pending[i] := ?workers[i].score(request); i += 1 };

    var replies : [Sharding.WorkerReply] = [];
    i := 0;
    while (i < n) {
      switch (pending[i]) { case (?f) replies := Array.concat(replies, [await f]); case null {} };
      i += 1;
    };
    let merged = Sharding.merge(replies);
    { token = merged.token; bytes = merged.bytes; calls = n };
  };

  public func shardedGenerate(prompt : Text, maxTokens : Nat, mode : Types.ReplyMode) : async {
    tokens : [Nat];
    text : Text;
    bytes : Nat;
    calls : Nat;
    rounds : Nat;
    lossless : Bool;
  } {
    let ids = Tokenizer.encode(model.vocab, prompt);
    let reference = Speculative.baseline(model, ids, maxTokens).tokens;
    var history = ids;
    var out : [Nat] = [];
    var bytes = 0;
    var calls = 0;
    var rounds = 0;

    label decode while (out.size() < maxTokens) {
      let s = await step(Lm.ctxOf(history), mode);
      bytes += s.bytes;
      calls += s.calls;
      rounds += 1;
      history := Array.concat(history, [s.token]);
      out := Array.concat(out, [s.token]);
      if (s.token == model.stop) break decode;
    };

    {
      tokens = out;
      text = Tokenizer.decode(model.vocab, out);
      bytes;
      calls;
      rounds;
      lossless = Speculative.identical(out, reference);
    };
  };

  public func askShim(prompt : Text) : async Text {
    let response = await shim.v1_chat({
      model = "llama3.1:8b";
      messages = [#user { content = prompt }];
      tools = null;
    });
    switch (response.message.content) { case (?c) c; case null "" };
  };

  public query func workerCount() : async Nat { workers.size() };
};

// ------------------------------------------------------------------ main --

func pad(text : Text, width : Nat) : Text {
  var out = text;
  while (out.size() < width) { out #= " " };
  out;
};

func padLeft(value : Nat, width : Nat) : Text {
  var out = Nat.toText(value);
  while (out.size() < width) { out := " " # out };
  out;
};

func yesNo(b : Bool) : Text { if b "yes" else "NO" };

let model = Lm.train(Corpus.text);
let SHARDS = 4;
let PROMPTS = [
  "speculative decoding uses",
  "a diffusion language model",
  "the activation that moves between two pipeline stages",
  "distributed inference splits one model",
];

Debug.print("cluster: " # Nat.toText(SHARDS) # " shard workers + 1 orchestrator + 1 llm shim");
Debug.print("model  : order-3 backoff n-gram, vocab " # Nat.toText(model.vocabSize) # ", integer scores only");
Debug.print("");

// Each `await ShardWorker(...)` installs a separate actor: distinct state,
// reachable only by message.
let built = VarArray.repeat<?WorkerRef>(null, SHARDS);
var w = 0;
while (w < SHARDS) {
  built[w] := ?(await ShardWorker(w, SHARDS));
  w += 1;
};
let refs = Array.tabulate<WorkerRef>(
  SHARDS,
  func(i : Nat) : WorkerRef {
    let ?r = built[i] else Runtime.trap("worker " # Nat.toText(i) # " not started");
    r;
  },
);

var s = 0;
while (s < SHARDS) {
  let info = await refs[s].info();
  Debug.print(
    "  worker " # Nat.toText(info.shard) # "/" # Nat.toText(info.shardCount)
    # " owns vocabulary [" # Nat.toText(info.lo) # ", " # Nat.toText(info.hi) # ")"
  );
  s += 1;
};

let shim = await LlmShim();
let orchestrator = await Orchestrator(refs, shim);
Debug.print("  orchestrator sees " # Nat.toText(await orchestrator.workerCount()) # " workers");
Debug.print("");

// ------------------------------------------------- single node strategies --

Debug.print("== decoding strategies, single canister (no fan-out) ==");
Debug.print("target = sequential target passes (a remote round trip each)");
Debug.print("draft  = sequential draft passes (assumed local, hence cheap)");
Debug.print("");
Debug.print(pad("strategy", 14) # "  target   draft  accept%  lossless");

for (p in PROMPTS.vals()) {
  let ids = Tokenizer.encode(model.vocab, p);
  let base = Speculative.baseline(model, ids, 24);
  let ar = Speculative.arDraft(model, ids, 24, 4);
  let md = Speculative.maskedDraft(model, ids, 24, 4, 2);

  Debug.print("prompt: " # p);
  func row(name : Text, run : Speculative.Run) {
    Debug.print(
      pad("  " # name, 14)
      # padLeft(run.metrics.targetRounds, 8)
      # padLeft(run.metrics.draftRounds, 8)
      # padLeft(Speculative.acceptanceRatePercent(run.metrics), 9)
      # "  " # yesNo(Speculative.identical(run.tokens, base.tokens))
    );
  };
  row("baseline", base);
  row("arDraft", ar);
  row("maskedDraft", md);
  Debug.print("  -> " # Tokenizer.decode(model.vocab, base.tokens));
  Debug.print("");
};
Debug.print("");

// ------------------------------------------------------ sharded strategies --

Debug.print("== vocabulary-parallel decoding across " # Nat.toText(SHARDS) # " worker canisters ==");
Debug.print(pad("wire format", 22) # "rounds  calls   bytes  lossless  output");

let modes : [(Text, Types.ReplyMode)] = [
  ("argmax", #argmax),
  ("dense", #dense),
  ("quantized 8b floor", #quantized { bits = 8; rounding = #floor }),
  ("quantized 4b floor", #quantized { bits = 4; rounding = #floor }),
  ("quantized 2b floor", #quantized { bits = 2; rounding = #floor }),
  ("quantized 4b near", #quantized { bits = 4; rounding = #nearest }),
  ("quantized 2b near", #quantized { bits = 2; rounding = #nearest }),
];

for ((name, mode) in modes.vals()) {
  let r = await orchestrator.shardedGenerate("speculative decoding uses", 24, mode);
  Debug.print(
    pad(name, 22)
    # padLeft(r.rounds, 6)
    # padLeft(r.calls, 7)
    # padLeft(r.bytes, 8)
    # pad("  " # yesNo(r.lossless), 10)
    # "  " # r.text
  );
};
Debug.print("");

Debug.print("== how often quantizing the activation changes the chosen token ==");
Debug.print("swept over every context position of the corpus");
Debug.print("floor rounding is provably argmax-preserving; nearest is the realistic case");
Debug.print("");
Debug.print(pad("head", 9) # pad("rounding", 10) # pad("bits", 6) # pad("bytes/step", 12) # pad("flipped", 13) # "near-ties (top2 within 1%)");

let corpusIds = Tokenizer.encode(model.vocab, Corpus.text);
let SAMPLES = if (corpusIds.size() > 400) 400 else corpusIds.size();

/// Second highest score, used to report how close the decision actually was.
func runnerUp(scores : [Nat], winner : Nat) : Nat {
  var best = 0;
  var i = 0;
  while (i < scores.size()) {
    if (i != winner and scores[i] > best) best := scores[i];
    i += 1;
  };
  best;
};

for ((headName, order) in [("target", Lm.TARGET), ("draft", Lm.DRAFT)].vals()) {
  for ((roundName, rounding) in [("floor", #floor), ("nearest", #nearest)].vals()) {
    for (bits in [2, 4, 8].vals()) {
      var flipped = 0;
      var nearTies = 0;
      var checked = 0;
      var bytes = 0;
      var i = 2;
      while (i < SAMPLES) {
        let ctx : Lm.Ctx = { prev2 = ?corpusIds[i - 2]; prev1 = ?corpusIds[i - 1] };
        let scores = Lm.scoreVector(model, order, ctx);
        let (exact, top1) = Lm.argmax(scores);
        if (runnerUp(scores, exact) * 100 >= top1 * 99) nearTies += 1;
        let q = Quant.quantizeWith(scores, bits, rounding);
        let (approx, _) = Lm.argmax(Quant.dequantizeWith(q, rounding));
        if (approx != exact) flipped += 1;
        bytes := Quant.quantizedBytes(q);
        checked += 1;
        i += 1;
      };
      Debug.print(
        pad(headName, 9)
        # pad(roundName, 10)
        # pad(Nat.toText(bits), 6)
        # pad(Nat.toText(bytes), 12)
        # pad(Nat.toText(flipped) # " / " # Nat.toText(checked), 13)
        # Nat.toText(nearTies) # " / " # Nat.toText(checked)
      );
    };
  };
};
Debug.print(
  pad("exact", 9) # pad("-", 10) # pad("64", 6) # pad(Nat.toText(Quant.denseBytes(model.vocabSize)), 12) # "0 (by definition)"
);
Debug.print("");

Debug.print("== the same quantization on a pipeline, where stages accumulate ==");
Debug.print("3 stages (trigram -> bigram -> unigram), activation re-quantized on every hop");
Debug.print("natural  = the model's own 1000:60:1 stage weights, so stage 1 decides alone");
Debug.print("balanced = stages rescaled to equal magnitude, as in a transformer residual stream");
Debug.print("=exact   = same tokens as this profile run at full width (isolates quantization error)");
Debug.print("");
Debug.print(pad("profile", 10) # pad("rounding", 10) # pad("bits", 7) # pad("bytes", 9) # pad("hops", 6) # pad("=exact", 8) # "output");

let pipePrompt = Tokenizer.encode(model.vocab, "speculative decoding uses");

for ((profileName, profile) in [("natural", #natural), ("balanced", #balanced)].vals()) {
  let exactRun = Pipeline.generate(model, Lm.TARGET, pipePrompt, 24, null, profile, #floor);
  for ((roundName, rounding) in [("floor", #floor), ("nearest", #nearest)].vals()) {
    for (bits in [?12, ?8, ?4, ?2].vals()) {
      let r = Pipeline.generate(model, Lm.TARGET, pipePrompt, 24, bits, profile, rounding);
      let bitLabel = switch bits { case null "exact"; case (?b) Nat.toText(b) };
      Debug.print(
        pad(profileName, 10)
        # pad(roundName, 10)
        # pad(bitLabel, 7)
        # pad(Nat.toText(r.bytes), 9)
        # pad(Nat.toText(r.hops), 6)
        # pad(yesNo(Speculative.identical(r.tokens, exactRun.tokens)), 8)
        # Tokenizer.decode(model.vocab, r.tokens)
      );
    };
  };
  Debug.print(
    pad(profileName, 10) # pad("-", 10) # pad("exact", 7)
    # pad(Nat.toText(exactRun.bytes), 9) # pad(Nat.toText(exactRun.hops), 6) # pad("yes", 8)
    # Tokenizer.decode(model.vocab, exactRun.tokens)
  );
  Debug.print("");
};

Debug.print("== llm canister interface (v1_chat) ==");
Debug.print("target principal resolved by LlmClient on mainnet: " # LlmClient.MAINNET);
Debug.print("free models (no cycles attached): llama3.1:8b -> " # debug_show LlmClient.isFreeModel("llama3.1:8b"));
Debug.print("paid model example: gemma3:27b   -> free? " # debug_show LlmClient.isFreeModel("gemma3:27b"));
let answer = await orchestrator.askShim("a canister is");
Debug.print("shim answer: " # answer);
