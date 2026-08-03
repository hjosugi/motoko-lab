/// Orchestrator canister for distributed decoding.
///
/// It exposes one `generate` entry point over several strategies so the *same*
/// prompt can be decoded six ways and the results compared on identical terms:
///
///   `#baseline`          one target pass per token, no workers.
///   `#arDraft`           speculative decoding, sequential draft.
///   `#maskedDraft`       speculative decoding, diffusion-style parallel draft.
///   `#shardedArgmax`     vocabulary-parallel over worker canisters, workers
///                        return only their local winner.
///   `#shardedDense`      same, but workers return the whole score slice.
///   `#shardedQuantized`  same, with the slice quantized before it is sent.
///
/// Every report carries `lossless`, computed by re-running `#baseline` locally
/// and comparing token for token. `#shardedQuantized` is the one strategy that
/// can legitimately come back `false`, and seeing exactly when it does is the
/// point of having it here.
///
/// `generate` is an update call by necessity: a query cannot make an
/// inter-canister call, so any fan-out has to go through consensus.
import Array "mo:core/Array";
import VarArray "mo:core/VarArray";
import Error "mo:core/Error";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Corpus "Corpus";
import Env "Env";
import Lm "Lm";
import LlmClient "LlmClient";
import Sharding "Sharding";
import Speculative "Speculative";
import Tokenizer "Tokenizer";
import Types "Types";
import Validation "Validation";

persistent actor DistributedLlm {

  /// `score` and `info` are `query` on the worker. An update call may still
  /// invoke them; the replica just runs them in replicated mode. The saving is
  /// on the ingress side, where a client can read a worker directly without
  /// consensus.
  type WorkerActor = actor {
    configure : shared (Nat, Nat) -> async Types.Result<Types.WorkerInfo>;
    info : shared query () -> async Types.WorkerInfo;
    score : shared query (Types.ShardRequest) -> async Sharding.WorkerReply;
  };


  /// Re-exported so the Candid surface of this canister names its own error and
  /// result types, matching the other reference apps in this kit.
  public type Error = Types.Error;
  public type Result<T> = Types.Result<T>;

  transient let model = Lm.train(Corpus.text);

  /// Resolved once at install time, where the `system` capability is available.
  /// A `query` has no such capability, so `llmTarget` reads this instead of
  /// consulting the environment again.
  transient let defaultLlmTarget : Text = LlmClient.resolve<system>(null);

  var owner : ?Principal = null;
  var workers : [Principal] = [];
  var llmOverride : ?Text = null;
  var totalCalls : Nat = 0;
  var totalWireBytes : Nat = 0;

  func requireOwner(caller : Principal) : ?Types.Error {
    if (Principal.isAnonymous(caller)) return ?#anonymousNotAllowed;
    switch (owner) {
      case null { owner := ?caller; null };
      case (?o) if (o == caller) null else ?#unauthorized;
    };
  };

  func workerAt(index : Nat) : WorkerActor {
    actor (Principal.toText(workers[index])) : WorkerActor;
  };

  // ---------------------------------------------------------------- admin --

  /// Registers the shard workers and assigns each one its vocabulary slice.
  public shared ({ caller }) func setWorkers(ids : [Principal]) : async Types.Result<[Types.WorkerInfo]> {
    switch (requireOwner(caller)) { case (?e) return #err(e); case null {} };
    if (not Validation.workerCountOk(ids.size())) {
      return #err(#invalidInput("worker count must be 1.." # debug_show Validation.MAX_WORKERS));
    };

    workers := ids;
    var infos : [Types.WorkerInfo] = [];
    var i = 0;
    while (i < ids.size()) {
      try {
        switch (await workerAt(i).configure(i, ids.size())) {
          case (#ok info) infos := Array.concat(infos, [info]);
          case (#err e) return #err(e);
        };
      } catch (e) {
        return #err(#workerFailed(Error.message(e)));
      };
      i += 1;
    };
    #ok(infos);
  };

  /// Discovers the cluster from the canister environment.
  ///
  /// `icp deploy` injects `PUBLIC_CANISTER_ID:<name>` for every canister in the
  /// project, so `worker_0`, `worker_1`, ... and `llm_shim` can be found
  /// without anyone pasting principals. Scanning stops at the first gap, which
  /// makes a partial deployment (two workers instead of four) wire itself
  /// correctly instead of failing.
  ///
  /// Use `setWorkers` when the workers are not part of this project or the
  /// environment does not carry them.
  public shared ({ caller }) func autoWire() : async Types.Result<[Types.WorkerInfo]> {
    switch (requireOwner(caller)) { case (?e) return #err(e); case null {} };

    var discovered : [Principal] = [];
    var i = 0;
    label scan while (i < Validation.MAX_WORKERS) {
      switch (Env.canisterId<system>("worker_" # Nat.toText(i))) {
        case (?id) discovered := Array.concat(discovered, [Principal.fromText(id)]);
        case null break scan;
      };
      i += 1;
    };
    if (discovered.size() == 0) {
      return #err(#notConfigured("no PUBLIC_CANISTER_ID:worker_N in the environment; use setWorkers"));
    };

    // Prefer a real `llm` canister if the project pulled one; otherwise fall
    // back to the local shim.
    switch (Env.canisterId<system>("llm"), Env.canisterId<system>("llm_shim")) {
      case (?_, _) llmOverride := null; // LlmClient resolves `llm` on its own
      case (null, ?shim) llmOverride := ?shim;
      case (null, null) {};
    };

    workers := discovered;
    var infos : [Types.WorkerInfo] = [];
    i := 0;
    while (i < discovered.size()) {
      try {
        switch (await workerAt(i).configure(i, discovered.size())) {
          case (#ok info) infos := Array.concat(infos, [info]);
          case (#err e) return #err(e);
        };
      } catch (e) {
        return #err(#workerFailed(Error.message(e)));
      };
      i += 1;
    };
    #ok(infos);
  };

  /// Points `LlmClient` at a specific LLM canister. Use it to target the local
  /// `llm_shim`; leave it unset to fall back to `PUBLIC_CANISTER_ID:llm` and
  /// then to mainnet.
  public shared ({ caller }) func setLlmCanister(id : ?Text) : async Types.Result<Text> {
    switch (requireOwner(caller)) { case (?e) return #err(e); case null {} };
    llmOverride := id;
    #ok(switch (llmOverride) { case (?value) value; case null defaultLlmTarget });
  };

  public query func modelInfo() : async Types.ModelInfo {
    {
      vocabSize = model.vocabSize;
      stopToken = model.stop;
      corpusTokens = Tokenizer.words(Corpus.text).size();
      targetOrder = Lm.TARGET;
      draftOrder = Lm.DRAFT;
      workers = workers.size();
    };
  };

  public query func stats() : async { calls : Nat; wireBytes : Nat; workers : Nat } {
    { calls = totalCalls; wireBytes = totalWireBytes; workers = workers.size() };
  };

  // ------------------------------------------------------------ sharding --

  type StepResult = { token : Nat; bytes : Nat; calls : Nat };

  /// One decoding position, fanned out across the registered workers.
  ///
  /// The requests are issued before any of them is awaited, so the workers run
  /// concurrently and the step costs one round trip rather than `n`.
  func shardedStep(order : Nat, ctx : Types.Ctx, mode : Types.ReplyMode) : async StepResult {
    let n = workers.size();
    let request : Types.ShardRequest = { order; ctx; mode };

    let pending = VarArray.repeat<?(async Sharding.WorkerReply)>(null, n);
    var i = 0;
    while (i < n) {
      pending[i] := ?workerAt(i).score(request);
      i += 1;
    };

    var replies : [Sharding.WorkerReply] = [];
    i := 0;
    while (i < n) {
      switch (pending[i]) {
        case (?future) replies := Array.concat(replies, [await future]);
        case null {};
      };
      i += 1;
    };

    let merged = Sharding.merge(replies);
    { token = merged.token; bytes = merged.bytes; calls = n };
  };

  func shardedGenerate(prompt : [Nat], maxTokens : Nat, mode : Types.ReplyMode) : async {
    tokens : [Nat];
    bytes : Nat;
    calls : Nat;
    rounds : Nat;
  } {
    var history = prompt;
    var out : [Nat] = [];
    var bytes = 0;
    var calls = 0;
    var rounds = 0;

    label decode while (out.size() < maxTokens) {
      let step = await shardedStep(Lm.TARGET, Lm.ctxOf(history), mode);
      bytes += step.bytes;
      calls += step.calls;
      rounds += 1;
      history := Array.concat(history, [step.token]);
      out := Array.concat(out, [step.token]);
      if (step.token == model.stop) break decode;
    };

    { tokens = out; bytes; calls; rounds };
  };

  // ------------------------------------------------------------ decoding --

  func report(
    strategy : Text,
    tokens : [Nat],
    metrics : Speculative.Metrics,
    calls : Nat,
    bytes : Nat,
    reference : [Nat],
  ) : Types.Report {
    {
      strategy;
      text = Tokenizer.decode(model.vocab, tokens);
      tokens = tokens.size();
      targetRounds = metrics.targetRounds;
      draftRounds = metrics.draftRounds;
      targetEvals = metrics.targetEvals;
      draftEvals = metrics.draftEvals;
      proposed = metrics.proposed;
      accepted = metrics.accepted;
      acceptanceRatePercent = Speculative.acceptanceRatePercent(metrics);
      interCanisterCalls = calls;
      wireBytes = bytes;
      lossless = Speculative.identical(tokens, reference);
    };
  };

  func strategyName(s : Types.Strategy) : Text {
    switch s {
      case (#baseline) "baseline";
      case (#arDraft) "arDraft";
      case (#maskedDraft) "maskedDraft";
      case (#shardedArgmax) "shardedArgmax";
      case (#shardedDense) "shardedDense";
      case (#shardedQuantized q) {
        "shardedQuantized/" # debug_show q.bits # "bit/"
        # (switch (q.rounding) { case (#floor) "floor"; case (#nearest) "nearest" });
      };
    };
  };

  func runLocal(request : Types.GenerateRequest, prompt : [Nat], budget : Nat) : ?Speculative.Run {
    let block = Validation.blockSize(request.block);
    switch (request.strategy) {
      case (#baseline) ?Speculative.baseline(model, prompt, budget);
      case (#arDraft) ?Speculative.arDraft(model, prompt, budget, block);
      case (#maskedDraft) ?Speculative.maskedDraft(model, prompt, budget, block, Validation.unmaskSteps(request.steps, block));
      case _ null;
    };
  };

  func shardMode(strategy : Types.Strategy) : ?Types.ReplyMode {
    switch strategy {
      case (#shardedArgmax) ?#argmax;
      case (#shardedDense) ?#dense;
      case (#shardedQuantized q) ?#quantized {
        bits = Validation.quantBits(q.bits);
        rounding = q.rounding;
      };
      case _ null;
    };
  };

  public shared func generate(request : Types.GenerateRequest) : async Types.Result<Types.Report> {
    if (not Validation.promptOk(request.prompt)) {
      return #err(#invalidInput("prompt must be 1.." # debug_show Validation.MAX_PROMPT_CHARS # " characters"));
    };
    let budget = Validation.tokenBudget(request.maxTokens);
    let prompt = Tokenizer.encode(model.vocab, request.prompt);
    let reference = Speculative.baseline(model, prompt, budget).tokens;
    totalCalls += 1;

    switch (runLocal(request, prompt, budget)) {
      case (?run) return #ok(report(strategyName(request.strategy), run.tokens, run.metrics, 0, 0, reference));
      case null {};
    };

    let ?mode = shardMode(request.strategy) else return #err(#invalidInput("unknown strategy"));
    if (workers.size() == 0) {
      return #err(#notConfigured("call setWorkers first"));
    };

    try {
      let sharded = await shardedGenerate(prompt, budget, mode);
      totalWireBytes += sharded.bytes;
      let metrics : Speculative.Metrics = {
        tokens = sharded.tokens.size();
        targetRounds = sharded.rounds;
        targetEvals = sharded.rounds;
        draftRounds = 0;
        draftEvals = 0;
        proposed = 0;
        accepted = 0;
      };
      #ok(report(strategyName(request.strategy), sharded.tokens, metrics, sharded.calls, sharded.bytes, reference));
    } catch (e) {
      #err(#workerFailed(Error.message(e)));
    };
  };

  /// Runs every strategy on one prompt. This is the endpoint the README quotes:
  /// it is the only fair comparison, because all six share a prompt, a token
  /// budget and a reference output.
  public shared func benchmark(prompt : Text, maxTokens : Nat, block : Nat, steps : Nat) : async Types.Result<[Types.Report]> {
    let strategies : [Types.Strategy] = if (workers.size() == 0) {
      [#baseline, #arDraft, #maskedDraft];
    } else {
      [
        #baseline,
        #arDraft,
        #maskedDraft,
        #shardedArgmax,
        #shardedDense,
        #shardedQuantized { bits = 8; rounding = #floor },
        #shardedQuantized { bits = 4; rounding = #nearest },
      ];
    };

    var reports : [Types.Report] = [];
    for (s in strategies.vals()) {
      let result = await generate({
        prompt;
        maxTokens;
        strategy = s;
        block;
        steps;
      });
      switch result {
        case (#ok r) reports := Array.concat(reports, [r]);
        case (#err e) return #err(e);
      };
    };
    #ok(reports);
  };

  // ----------------------------------------------------------- llm canister --

  /// Calls the Internet Computer LLM canister (or the local shim) and returns
  /// its answer. This is the path that reaches a *real* model; everything above
  /// is the on-chain toy model.
  public shared func askLlmCanister(llmModel : Text, prompt : Text) : async Types.Result<Text> {
    if (not Validation.promptOk(prompt)) {
      return #err(#invalidInput("prompt must be 1.." # debug_show Validation.MAX_PROMPT_CHARS # " characters"));
    };
    try {
      #ok(await LlmClient.prompt<system>(llmOverride, llmModel, prompt));
    } catch (e) {
      #err(#workerFailed(Error.message(e)));
    };
  };

  public query func llmTarget() : async Text {
    switch (llmOverride) { case (?id) id; case null defaultLlmTarget };
  };
};
