/// Orchestrator canister for distributed decoding.
///
/// It exposes one `generate` entry point over several strategies so the *same*
/// prompt can be decoded seven ways and the results compared on identical terms:
///
///   `#baseline`          one target pass per token, no workers.
///   `#arDraft`           speculative decoding, sequential draft.
///   `#maskedDraft`       speculative decoding, diffusion-style parallel draft.
///   `#shardedArgmax`     vocabulary-parallel over worker canisters, workers
///                        return only their local winner.
///   `#shardedDense`      same, but workers return the whole score slice.
///   `#shardedQuantized`  same, with the slice quantized before it is sent.
///   `#shardedDraft`      the fan-out drafts, an exact *local* target pass
///                        verifies. The one sharded strategy whose output a
///                        malicious worker cannot change.
///
/// Every report carries `lossless`, computed by re-running `#baseline` locally
/// and comparing token for token. `#shardedQuantized` is the one strategy that
/// can legitimately come back `false`, and seeing exactly when it does is the
/// point of having it here.
///
/// `generate` is an update call by necessity: a query cannot make an
/// inter-canister call, so any fan-out has to go through consensus.
///
/// Two things guard the fan-out, because one ingress message can turn into
/// hundreds of downstream calls:
///
///   * **Who may call.** Every decoding endpoint requires a non-anonymous,
///     authorised caller. `setOpenAccess(true)` reopens the canister to any
///     non-anonymous principal for demos; it is off after install.
///   * **How much they may spend.** `Quota` charges each caller an upper bound
///     on the work *before* it runs, and refuses rather than truncates.
///
/// And the workers themselves are not trusted by default any more than the
/// callers are: see `setVerification` and `docs/THREAT_MODEL.md`.
import Array "mo:core/Array";
import VarArray "mo:core/VarArray";
import Cycles "mo:core/Cycles";
import Error "mo:core/Error";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Time "mo:core/Time";
import Corpus "Corpus";
import Env "Env";
import Lm "Lm";
import LlmClient "LlmClient";
import Quota "Quota";
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

  // ------------------------------------------------------------- access --
  //
  // Off by default: after install nobody but the owner can make this canister
  // talk to anything. That is the opposite of a reference app's usual posture,
  // and it is deliberate — `benchmark` is a fan-out amplifier and the cycles it
  // burns are the canister's, not the caller's.

  let allowed = Map.empty<Principal, ()>();
  var openAccess : Bool = false;
  let quotas = Map.empty<Principal, Quota.Usage>();
  var policy : Quota.Policy = Quota.DEFAULT;
  var quotaRejections : Nat = 0;
  var faults : Nat = 0;
  var totalCyclesSpent : Nat = 0;

  var verification : Types.Verification = { replication = 1; spotCheck = false };

  func requireOwner(caller : Principal) : ?Types.Error {
    if (Principal.isAnonymous(caller)) return ?#anonymousNotAllowed;
    switch (owner) {
      case null { owner := ?caller; null };
      case (?o) if (o == caller) null else ?#unauthorized;
    };
  };

  func isOwner(caller : Principal) : Bool {
    switch (owner) { case (?o) o == caller; case null false };
  };

  /// `Time.Time` is an `Int`; `Quota` counts in `Nat` because a window that can
  /// start before the epoch is not a window. The conversion is total here —
  /// `Prim.time()` is a `Nat64` — and doing it once keeps the arithmetic in
  /// `Quota` free of sign handling.
  func now() : Nat { Int.toNat(Time.now()) };

  /// May this principal make the canister do work?
  ///
  /// Deliberately not "may this principal read": `modelInfo`, `stats` and the
  /// other queries stay open, because a rate limiter that hides its own
  /// counters cannot be operated.
  func requireCaller(caller : Principal) : ?Types.Error {
    if (Principal.isAnonymous(caller)) return ?#anonymousNotAllowed;
    if (isOwner(caller)) return null;
    if (openAccess) return null;
    switch (Map.get(allowed, Principal.compare, caller)) {
      case (?_) null;
      case null ?#unauthorized;
    };
  };

  /// Charges `units` of work to `caller` and refuses if that would exceed the
  /// window budget.
  ///
  /// The owner is exempt. Metering it would be theatre: it sets `policy`, so any
  /// limit it hit it could lift in the next message. What the owner is *not*
  /// exempt from is `requireCycles` — running the canister into its freezing
  /// threshold is not a permission, it is an outage.
  func chargeQuota(caller : Principal, units : Nat) : ?Types.Error {
    if (isOwner(caller)) return null;
    switch (Quota.charge(Map.get(quotas, Principal.compare, caller), now(), policy, units)) {
      case (#ok usage) {
        Map.add(quotas, Principal.compare, caller, usage);
        null;
      };
      case (#err exceeded) {
        quotaRejections += 1;
        ?#quotaExceeded(exceeded);
      };
    };
  };

  /// Refuses work that would run the canister towards its freezing threshold.
  ///
  /// A frozen canister answers nothing at all, including the endpoints an
  /// operator needs to diagnose and refill it, so the floor is checked before
  /// the fan-out rather than discovered during it.
  func requireCycles() : ?Types.Error {
    let balance = Cycles.balance();
    if (balance < Validation.MIN_CYCLE_RESERVE) {
      return ?#lowCycles({ balance; reserve = Validation.MIN_CYCLE_RESERVE });
    };
    null;
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

  /// Grants principals the right to make this canister work, under the quota.
  public shared ({ caller }) func allow(ids : [Principal]) : async Types.Result<Nat> {
    switch (requireOwner(caller)) { case (?e) return #err(e); case null {} };
    for (id in ids.vals()) {
      if (Principal.isAnonymous(id)) {
        return #err(#invalidInput("the anonymous principal cannot be allowlisted"));
      };
      Map.add(allowed, Principal.compare, id, ());
    };
    #ok(Map.size(allowed));
  };

  public shared ({ caller }) func revoke(ids : [Principal]) : async Types.Result<Nat> {
    switch (requireOwner(caller)) { case (?e) return #err(e); case null {} };
    for (id in ids.vals()) { Map.remove(allowed, Principal.compare, id) };
    #ok(Map.size(allowed));
  };

  /// Reopens the canister to every non-anonymous principal, still under the
  /// quota. This is the demo switch; it is off after install and it should stay
  /// off anywhere the canister holds cycles worth taking.
  public shared ({ caller }) func setOpenAccess(open : Bool) : async Types.Result<Bool> {
    switch (requireOwner(caller)) { case (?e) return #err(e); case null {} };
    openAccess := open;
    #ok(openAccess);
  };

  /// Drops usage records whose window has already ended.
  ///
  /// The ledger holds one record per *authorised* calling principal, so under
  /// the default posture it is bounded by the allowlist. Under
  /// `setOpenAccess(true)` it is bounded by the number of principals that ever
  /// called, which is not a bound. Expired records carry no information — a
  /// principal with no record is treated as having spent nothing, which is what
  /// an expired window means — so this frees the state without changing any
  /// answer. Returns how many were dropped.
  public shared ({ caller }) func pruneQuotas() : async Types.Result<Nat> {
    switch (requireOwner(caller)) { case (?e) return #err(e); case null {} };
    let at = now();
    // Collected before removing: mutating a map while iterating it is not
    // something to rely on.
    let stale = Iter.toArray(
      Iter.filterMap<(Principal, Quota.Usage), Principal>(
        Map.entries(quotas),
        func((id, usage) : (Principal, Quota.Usage)) : ?Principal {
          if (Quota.resetIn(usage, at, policy) == 0) ?id else null;
        },
      )
    );
    for (id in stale.vals()) { Map.remove(quotas, Principal.compare, id) };
    #ok(stale.size());
  };

  public shared ({ caller }) func setQuota(next : Quota.Policy) : async Types.Result<Quota.Policy> {
    switch (requireOwner(caller)) { case (?e) return #err(e); case null {} };
    if (next.windowNanos == 0) return #err(#invalidInput("windowNanos must be positive"));
    policy := next;
    #ok(policy);
  };

  /// Sets how hard the orchestrator checks its workers.
  ///
  /// `replication = k` has every range scored by `k` distinct workers whose
  /// replies must match exactly; it costs `k` times the calls and bytes and no
  /// extra rounds. `spotCheck` has the orchestrator recompute one range per
  /// round itself; it costs local instructions and no bytes. What each one is
  /// and is not proof against is tabulated in `docs/THREAT_MODEL.md`.
  public shared ({ caller }) func setVerification(next : Types.Verification) : async Types.Result<Types.Verification> {
    switch (requireOwner(caller)) { case (?e) return #err(e); case null {} };
    verification := {
      replication = Validation.replication(next.replication, workers.size());
      spotCheck = next.spotCheck;
    };
    #ok(verification);
  };

  // --------------------------------------------------------------- reads --

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

  public query func stats() : async Types.Stats {
    {
      calls = totalCalls;
      wireBytes = totalWireBytes;
      workers = workers.size();
      quotaRejections;
      faults;
      cyclesBalance = Cycles.balance();
      cyclesSpent = totalCyclesSpent;
    };
  };

  public query func access() : async {
    owner : ?Principal;
    open : Bool;
    allowed : [Principal];
    policy : Quota.Policy;
    verification : Types.Verification;
  } {
    {
      owner;
      open = openAccess;
      allowed = Iter.toArray(Map.keys(allowed));
      policy;
      verification;
    };
  };

  /// What a principal has left this window. A caller that is about to be
  /// refused should be able to find that out without being refused first.
  public query func quotaOf(id : Principal) : async {
    limit : Nat;
    remaining : Nat;
    resetInNanos : Nat;
    exempt : Bool;
  } {
    let at = now();
    let usage = Map.get(quotas, Principal.compare, id);
    {
      limit = policy.unitsPerWindow;
      remaining = Quota.remaining(usage, at, policy);
      resetInNanos = Quota.resetIn(Quota.current(usage, at, policy), at, policy);
      exempt = isOwner(id);
    };
  };

  // ------------------------------------------------------------ sharding --

  type StepResult = { token : Nat; bytes : Nat; calls : Nat; spotChecks : Nat };

  /// One decoding position, fanned out across the registered workers.
  ///
  /// The requests are issued before any of them is awaited, so the workers run
  /// concurrently and the step costs one round trip rather than `n` — including
  /// when replication multiplies the number of calls, which is why replication
  /// costs bandwidth and not latency.
  ///
  /// `round` drives the spot-check rotation; see `Sharding.spotCheckTarget`.
  func shardedStep(order : Nat, ctx : Types.Ctx, mode : Types.ReplyMode, round : Nat) : async {
    #ok : StepResult;
    #err : Sharding.Fault;
  } {
    let n = workers.size();
    let tasks = Sharding.plan(model.vocabSize, n, verification.replication);

    let pending = VarArray.repeat<?(async Sharding.WorkerReply)>(null, tasks.size());
    var i = 0;
    while (i < tasks.size()) {
      pending[i] := ?workerAt(tasks[i].worker).score({
        order;
        ctx;
        mode;
        range = ?tasks[i].range;
      });
      i += 1;
    };

    var replies : [Sharding.WorkerReply] = [];
    i := 0;
    while (i < tasks.size()) {
      switch (pending[i]) {
        case (?future) replies := Array.concat(replies, [await future]);
        case null {};
      };
      i += 1;
    };

    let verified = switch (Sharding.verify(tasks, replies, n)) {
      case (#ok v) v;
      case (#err fault) return #err(fault);
    };

    // Spot check: recompute one range locally and compare. This is the only
    // check that survives every replica of a range being controlled by the same
    // adversary, and the only one whose cost is instructions rather than bytes.
    var spotChecks = 0;
    if (verification.spotCheck) {
      switch (Sharding.spotCheckTarget(round, n)) {
        case (?shard) {
          let reply = verified.accepted[shard];
          let exact = Lm.scoreRange(
            model,
            order,
            { prev2 = ctx.prev2; prev1 = ctx.prev1 },
            reply.lo,
            reply.hi,
          );
          spotChecks := 1;
          if (not Sharding.spotCheck(reply, mode, exact)) {
            return #err(#spotCheckFailed { shard; worker = reply.shard });
          };
        };
        case null {};
      };
    };

    let merged = Sharding.merge(verified.accepted);
    #ok({ token = merged.token; bytes = verified.bytes; calls = tasks.size(); spotChecks });
  };

  type ShardedRun = {
    tokens : [Nat];
    bytes : Nat;
    calls : Nat;
    rounds : Nat;
    spotChecks : Nat;
  };

  func shardedGenerate(prompt : [Nat], maxTokens : Nat, mode : Types.ReplyMode) : async {
    #ok : ShardedRun;
    #err : Sharding.Fault;
  } {
    var history = prompt;
    var out : [Nat] = [];
    var bytes = 0;
    var calls = 0;
    var rounds = 0;
    var spotChecks = 0;

    label decode while (out.size() < maxTokens) {
      let step = switch (await shardedStep(Lm.TARGET, Lm.ctxOf(history), mode, rounds)) {
        case (#ok s) s;
        case (#err fault) return #err(fault);
      };
      bytes += step.bytes;
      calls += step.calls;
      spotChecks += step.spotChecks;
      rounds += 1;
      history := Array.concat(history, [step.token]);
      out := Array.concat(out, [step.token]);
      if (step.token == model.stop) break decode;
    };

    #ok({ tokens = out; bytes; calls; rounds; spotChecks });
  };

  /// Speculative decoding whose *draft* comes from the worker cluster and whose
  /// verification is an exact local target pass.
  ///
  /// This inverts the usual assumption — normally the target is the expensive
  /// remote head and the draft is local — and it only makes sense when the
  /// orchestrator can hold the target head itself. What it buys is the one
  /// guarantee no amount of cross-checking gives: the emitted tokens are the
  /// target's own greedy continuation by construction, so a worker that lies
  /// about every score it owns changes the acceptance rate and nothing else.
  func shardedDraftGenerate(prompt : [Nat], maxTokens : Nat, block : Nat) : async {
    #ok : { run : ShardedRun; metrics : Speculative.Metrics };
    #err : Sharding.Fault;
  } {
    var history = prompt;
    var out : [Nat] = [];
    var bytes = 0;
    var calls = 0;
    var draftRounds = 0;
    var targetRounds = 0;
    var targetEvals = 0;
    var proposed = 0;
    var accepted = 0;
    var spotChecks = 0;

    label decode while (out.size() < maxTokens) {
      // Draft phase: `block` sequential fan-out rounds of the cheap head.
      var draft : [Nat] = [];
      var context = history;
      var i = 0;
      while (i < block) {
        let step = switch (await shardedStep(Lm.DRAFT, Lm.ctxOf(context), #argmax, draftRounds)) {
          case (#ok s) s;
          case (#err fault) return #err(fault);
        };
        bytes += step.bytes;
        calls += step.calls;
        spotChecks += step.spotChecks;
        draftRounds += 1;
        draft := Array.concat(draft, [step.token]);
        context := Array.concat(context, [step.token]);
        i += 1;
      };
      proposed += block;

      // Verify phase: one exact target pass, local and authoritative.
      let v = Speculative.verifyBlock(model, history, draft);
      let kept = Speculative.truncateAtStop(model, v.emitted, maxTokens - out.size());
      targetRounds += 1;
      targetEvals += v.evals;
      accepted += v.accepted;
      out := Array.concat(out, kept);
      history := Array.concat(history, kept);
      if (Speculative.hitStop(model, kept)) break decode;
    };

    #ok({
      run = { tokens = out; bytes; calls; rounds = targetRounds; spotChecks };
      metrics = {
        tokens = out.size();
        targetRounds;
        targetEvals;
        draftRounds;
        draftEvals = draftRounds;
        proposed;
        accepted;
      };
    });
  };

  // ------------------------------------------------------------ decoding --

  /// What a run cost the cluster. A record rather than four positional `Nat`s,
  /// because `calls`, `bytes`, `spotChecks` and `cyclesSpent` are mutually
  /// substitutable at a call site and nothing would catch a transposition.
  type Cost = {
    calls : Nat;
    bytes : Nat;
    spotChecks : Nat;
    cyclesSpent : Nat;
  };

  let noCost : Cost = { calls = 0; bytes = 0; spotChecks = 0; cyclesSpent = 0 };

  func report(
    strategy : Text,
    tokens : [Nat],
    metrics : Speculative.Metrics,
    cost : Cost,
    reference : [Nat],
  ) : Types.Report {
    let { calls; bytes; spotChecks; cyclesSpent } = cost;
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
      replication = if (calls == 0) 0 else verification.replication;
      spotChecks;
      cyclesSpent;
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
      case (#shardedDraft) "shardedDraft";
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

  /// Does this strategy leave the canister?
  func fansOut(strategy : Types.Strategy) : Bool {
    switch strategy {
      case (#baseline or #arDraft or #maskedDraft) false;
      case _ true;
    };
  };

  /// Upper bound on the model passes one request costs, in `Quota` units.
  ///
  /// Charged before the work starts, so it has to be an over-estimate: `block`
  /// draft rounds per block for `#shardedDraft`, one fan-out per token for the
  /// rest, and the orchestrator's own reference pass on top of both.
  func cost(strategy : Types.Strategy, tokens : Nat) : Nat {
    let fanOut = if (fansOut(strategy)) workers.size() * verification.replication else 0;
    Quota.estimate(tokens, fanOut);
  };

  /// Runs one strategy. No access control and no metering: the public endpoints
  /// below do that once, so that `benchmark` charges for its whole fan-out
  /// instead of seven times over, and so an internal call cannot slip past a
  /// check by not being an ingress message.
  func run(request : Types.GenerateRequest) : async Types.Result<Types.Report> {
    if (not Validation.promptOk(request.prompt)) {
      return #err(#invalidInput("prompt must be 1.." # debug_show Validation.MAX_PROMPT_CHARS # " characters"));
    };
    let budget = Validation.tokenBudget(request.maxTokens);
    let prompt = Tokenizer.encode(model.vocab, request.prompt);
    let reference = Speculative.baseline(model, prompt, budget).tokens;
    let before = Cycles.balance();
    totalCalls += 1;

    switch (runLocal(request, prompt, budget)) {
      case (?local) {
        let cost = { noCost with cyclesSpent = recordSpend(before) };
        return #ok(report(strategyName(request.strategy), local.tokens, local.metrics, cost, reference));
      };
      case null {};
    };

    if (workers.size() == 0) {
      return #err(#notConfigured("call setWorkers first"));
    };

    switch (request.strategy) {
      case (#shardedDraft) {
        let block = Validation.blockSize(request.block);
        try {
          switch (await shardedDraftGenerate(prompt, budget, block)) {
            case (#ok r) {
              totalWireBytes += r.run.bytes;
              #ok(
                report(
                  strategyName(request.strategy),
                  r.run.tokens,
                  r.metrics,
                  {
                    calls = r.run.calls;
                    bytes = r.run.bytes;
                    spotChecks = r.run.spotChecks;
                    cyclesSpent = recordSpend(before);
                  },
                  reference,
                )
              );
            };
            case (#err fault) { faults += 1; #err(#faultyWorker(fault)) };
          };
        } catch (e) {
          #err(#workerFailed(Error.message(e)));
        };
      };
      case _ {
        let ?mode = shardMode(request.strategy) else return #err(#invalidInput("unknown strategy"));
        try {
          switch (await shardedGenerate(prompt, budget, mode)) {
            case (#ok sharded) {
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
              #ok(
                report(
                  strategyName(request.strategy),
                  sharded.tokens,
                  metrics,
                  {
                    calls = sharded.calls;
                    bytes = sharded.bytes;
                    spotChecks = sharded.spotChecks;
                    cyclesSpent = recordSpend(before);
                  },
                  reference,
                )
              );
            };
            case (#err fault) { faults += 1; #err(#faultyWorker(fault)) };
          };
        } catch (e) {
          #err(#workerFailed(Error.message(e)));
        };
      };
    };
  };

  /// Cycles this message has burned so far, as the drop in the canister's own
  /// balance. Also accumulates into `totalCyclesSpent`, which is why it is named
  /// for what it does rather than for what it returns.
  ///
  /// What it covers is the fan-out: the cost of the calls this message sent and
  /// of any cycles it attached. What it does not cover is the execution charge
  /// for the message itself, which the replica applies after the message
  /// returns — so read it next to `interCanisterCalls`, not as a total. On
  /// `moc -r` there is no cycle accounting at all and this is zero.
  func recordSpend(before : Nat) : Nat {
    let now = Cycles.balance();
    totalCyclesSpent += (if (before > now) before - now else 0);
    if (before > now) before - now else 0;
  };

  public shared ({ caller }) func generate(request : Types.GenerateRequest) : async Types.Result<Types.Report> {
    switch (requireCaller(caller)) { case (?e) return #err(e); case null {} };
    switch (requireCycles()) { case (?e) return #err(e); case null {} };
    let budget = Validation.tokenBudget(request.maxTokens);
    switch (chargeQuota(caller, cost(request.strategy, budget))) {
      case (?e) return #err(e);
      case null {};
    };
    await run(request);
  };

  /// Runs every strategy on one prompt. This is the endpoint the README quotes:
  /// it is the only fair comparison, because all of them share a prompt, a token
  /// budget and a reference output.
  ///
  /// It is also the endpoint worth gating: one message here is eight decodes and
  /// `tokens * workers * replication` inter-canister calls, all of them billed
  /// to this canister.
  public shared ({ caller }) func benchmark(prompt : Text, maxTokens : Nat, block : Nat, steps : Nat) : async Types.Result<[Types.Report]> {
    switch (requireCaller(caller)) { case (?e) return #err(e); case null {} };
    switch (requireCycles()) { case (?e) return #err(e); case null {} };

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
        #shardedDraft,
      ];
    };

    let budget = Validation.tokenBudget(maxTokens);
    var units = 0;
    for (s in strategies.vals()) { units += cost(s, budget) };
    switch (chargeQuota(caller, units)) { case (?e) return #err(e); case null {} };

    var reports : [Types.Report] = [];
    for (s in strategies.vals()) {
      let result = await run({
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
  ///
  /// Who pays: this canister does, out of its own balance, and only for the
  /// owner. A paid model draws `LlmClient.CYCLES_PER_CHAT` per prompt, so
  /// letting an allowlisted — never mind an anonymous — caller pick the model is
  /// handing them a spending key. Free models stay open to allowlisted callers
  /// under the quota, because they cost this canister nothing but the call.
  public shared ({ caller }) func askLlmCanister(llmModel : Text, prompt : Text) : async Types.Result<Text> {
    switch (requireCaller(caller)) { case (?e) return #err(e); case null {} };
    switch (requireCycles()) { case (?e) return #err(e); case null {} };
    if (not Validation.promptOk(prompt)) {
      return #err(#invalidInput("prompt must be 1.." # debug_show Validation.MAX_PROMPT_CHARS # " characters"));
    };
    if (not LlmClient.isFreeModel(llmModel) and not isOwner(caller)) {
      return #err(#unauthorized);
    };
    switch (chargeQuota(caller, Quota.estimate(1, 1))) { case (?e) return #err(e); case null {} };

    let before = Cycles.balance();
    try {
      let answer = await LlmClient.prompt<system>(llmOverride, llmModel, prompt);
      ignore recordSpend(before);
      #ok(answer);
    } catch (e) {
      ignore recordSpend(before);
      #err(#workerFailed(Error.message(e)));
    };
  };

  public query func llmTarget() : async Text {
    switch (llmOverride) { case (?id) id; case null defaultLlmTarget };
  };
};
