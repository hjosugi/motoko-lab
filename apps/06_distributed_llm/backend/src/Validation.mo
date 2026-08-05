/// Input and resource bounds for the orchestrator.
///
/// A canister pays cycles for every instruction it executes and traps if it
/// exceeds the per-message instruction limit, so an unbounded `maxTokens` or an
/// unbounded prompt is a denial-of-service vector, not a usability nicety.
module {

  public let MAX_PROMPT_CHARS : Nat = 2_000;
  public let MAX_TOKENS : Nat = 128;
  public let MAX_BLOCK : Nat = 16;
  public let MAX_WORKERS : Nat = 16;

  /// Balance below which the orchestrator stops accepting work.
  ///
  /// A canister that falls under its freezing threshold stops answering ingress
  /// entirely, including the endpoints an operator would use to top it up or
  /// read what went wrong. The threshold itself is a subnet setting this
  /// canister cannot read portably, so this is a self-imposed floor well above
  /// any plausible one: 3T cycles, against the ~100B a single paid `v1_chat`
  /// attaches. Refusing at the floor turns "the canister is gone" into "the
  /// canister says no".
  public let MIN_CYCLE_RESERVE : Nat = 3_000_000_000_000;

  public func promptOk(prompt : Text) : Bool {
    prompt.size() > 0 and prompt.size() <= MAX_PROMPT_CHARS;
  };

  /// Clamps rather than rejects: a caller asking for more tokens than the
  /// instruction budget allows should get a short answer, not an error.
  public func tokenBudget(requested : Nat) : Nat {
    if (requested == 0) 1 else if (requested > MAX_TOKENS) MAX_TOKENS else requested;
  };

  public func blockSize(requested : Nat) : Nat {
    if (requested == 0) 4 else if (requested > MAX_BLOCK) MAX_BLOCK else requested;
  };

  public func unmaskSteps(requested : Nat, block : Nat) : Nat {
    if (requested == 0) 2 else if (requested > block) block else requested;
  };

  public func quantBits(requested : Nat) : Nat {
    if (requested < 2) 2 else if (requested > 32) 32 else requested;
  };

  public func workerCountOk(n : Nat) : Bool {
    n > 0 and n <= MAX_WORKERS;
  };

  /// Replication factor a cluster of `workers` nodes can actually serve.
  ///
  /// Clamped rather than rejected because the ceiling is a property of the
  /// cluster, not of the request: asking three replicas of a two-worker cluster
  /// is a configuration that shrinks when a worker is removed, and it should
  /// keep running at the best available factor rather than stop.
  public func replication(requested : Nat, workers : Nat) : Nat {
    if (workers == 0) return 1;
    if (requested == 0) 1 else if (requested > workers) workers else requested;
  };
};
