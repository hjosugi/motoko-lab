/// Candid-facing types shared by the orchestrator, the workers and the tests.
import Quant "Quant";
import Quota "Quota";
import Sharding "Sharding";

module {

  public type Error = {
    #anonymousNotAllowed;
    #unauthorized;
    #invalidInput : Text;
    #notConfigured : Text;
    #workerFailed : Text;
    /// A worker's answer did not survive verification. Carries which shard and
    /// which check, because the operator's next move is to pull that node.
    #faultyWorker : Sharding.Fault;
    /// The caller is over its budget for this window. Carries the limit and the
    /// time to reset, so a client can back off rather than retry blindly.
    #quotaExceeded : Quota.Exceeded;
    /// The canister is close enough to its freezing threshold that a fan-out
    /// could push it over. Refusing here keeps the canister answerable.
    #lowCycles : { balance : Nat; reserve : Nat };
  };

  public type Result<T> = { #ok : T; #err : Error };

  /// Left context handed to a worker. `null` is a masked or absent neighbour.
  public type Ctx = {
    prev2 : ?Nat;
    prev1 : ?Nat;
  };

  /// What the orchestrator asks a worker to send back. See `Sharding.Reply`.
  public type ReplyMode = Sharding.Mode;

  public type ShardRequest = {
    order : Nat;
    ctx : Ctx;
    mode : ReplyMode;
    /// Vocabulary range to score. `null` means the worker's own slice, which is
    /// the unreplicated case. An explicit range is what lets a second worker
    /// score somebody else's slice, and the reply names the range it answered so
    /// the orchestrator can check it got what it asked for.
    range : ?Sharding.Range;
  };

  public type WorkerReply = Sharding.WorkerReply;

  public type WorkerInfo = {
    shard : Nat;
    shardCount : Nat;
    lo : Nat;
    hi : Nat;
    vocabSize : Nat;
  };

  /// How much the orchestrator distrusts its workers.
  ///
  /// The default (`replication = 1`, no spot check) is the fastest and the one
  /// with no byzantine protection at all: each range is scored by exactly one
  /// node and believed. See `docs/THREAT_MODEL.md` for what each setting buys
  /// and what it costs.
  public type Verification = {
    /// Distinct workers that must score each range and agree. `1` disables the
    /// cross-check; `k` detects up to `k-1` colluding liars per range.
    replication : Nat;
    /// Whether the orchestrator recomputes one range per round itself and
    /// compares. Costs local instructions, no extra bytes.
    spotCheck : Bool;
  };

  /// Decoding strategy.
  ///
  /// The first three run entirely inside the orchestrator and differ only in how
  /// tokens are drafted. The `#sharded*` ones fan out to worker canisters and
  /// differ only in what crosses the wire. `#shardedDraft` is the odd one out
  /// and the interesting one for trust: the fan-out produces a *draft*, which an
  /// exact local target pass then verifies, so worker output cannot reach the
  /// caller unchecked.
  public type Strategy = {
    #baseline;
    #arDraft;
    #maskedDraft;
    #shardedArgmax;
    #shardedDense;
    #shardedQuantized : { bits : Nat; rounding : Quant.Rounding };
    #shardedDraft;
  };

  public type GenerateRequest = {
    prompt : Text;
    maxTokens : Nat;
    strategy : Strategy;
    /// Draft block size; ignored by the non-speculative strategies.
    block : Nat;
    /// Parallel unmasking steps; only used by `#maskedDraft`.
    steps : Nat;
  };

  public type Report = {
    strategy : Text;
    text : Text;
    tokens : Nat;
    /// Sequential passes of the *target* model. On a real deployment each one
    /// is a remote round trip, so this is the latency-relevant number.
    targetRounds : Nat;
    /// Sequential passes of the *draft* model. Assumed local, hence cheap.
    draftRounds : Nat;
    targetEvals : Nat;
    draftEvals : Nat;
    proposed : Nat;
    accepted : Nat;
    acceptanceRatePercent : Nat;
    /// Inter-canister calls actually issued.
    interCanisterCalls : Nat;
    /// Payload bytes actually received from workers.
    wireBytes : Nat;
    /// Distinct workers that scored each range in this run. `1` means no
    /// cross-check was possible.
    replication : Nat;
    /// Ranges the orchestrator recomputed itself and compared.
    spotChecks : Nat;
    /// Cycles this call burned, measured as the drop in the canister's own
    /// balance across the call. Zero on a replica-less run (`moc -r` has no
    /// cycle accounting), so read it next to `interCanisterCalls`.
    cyclesSpent : Nat;
    /// Whether this run reproduced the plain autoregressive output exactly.
    lossless : Bool;
  };

  public type ModelInfo = {
    vocabSize : Nat;
    stopToken : Nat;
    corpusTokens : Nat;
    targetOrder : Nat;
    draftOrder : Nat;
    workers : Nat;
  };

  /// Cumulative counters, plus the live resource figures an operator watches.
  public type Stats = {
    calls : Nat;
    wireBytes : Nat;
    workers : Nat;
    /// Requests refused because the caller was over budget.
    quotaRejections : Nat;
    /// Rounds a worker's answer failed verification.
    faults : Nat;
    cyclesBalance : Nat;
    cyclesSpent : Nat;
  };
};
