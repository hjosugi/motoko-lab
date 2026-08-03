/// Candid-facing types shared by the orchestrator, the workers and the tests.
import Quant "Quant";
import Sharding "Sharding";

module {

  public type Error = {
    #anonymousNotAllowed;
    #unauthorized;
    #invalidInput : Text;
    #notConfigured : Text;
    #workerFailed : Text;
  };

  public type Result<T> = { #ok : T; #err : Error };

  /// Left context handed to a worker. `null` is a masked or absent neighbour.
  public type Ctx = {
    prev2 : ?Nat;
    prev1 : ?Nat;
  };

  /// What the orchestrator asks a worker to send back. See `Sharding.Reply`.
  public type ReplyMode = {
    #argmax;
    #dense;
    #quantized : { bits : Nat; rounding : Quant.Rounding };
  };

  public type ShardRequest = {
    order : Nat;
    ctx : Ctx;
    mode : ReplyMode;
  };

  public type WorkerReply = Sharding.WorkerReply;

  public type WorkerInfo = {
    shard : Nat;
    shardCount : Nat;
    lo : Nat;
    hi : Nat;
    vocabSize : Nat;
  };

  /// Decoding strategy.
  ///
  /// The first three run entirely inside the orchestrator and differ only in how
  /// tokens are drafted. The `#sharded*` ones fan out to worker canisters and
  /// differ only in what crosses the wire.
  public type Strategy = {
    #baseline;
    #arDraft;
    #maskedDraft;
    #shardedArgmax;
    #shardedDense;
    #shardedQuantized : { bits : Nat; rounding : Quant.Rounding };
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
};
