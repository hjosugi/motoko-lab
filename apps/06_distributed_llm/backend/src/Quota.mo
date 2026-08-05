/// Per-principal rate accounting for the orchestrator's fan-out endpoints.
///
/// `benchmark` runs seven strategies over one prompt, and each sharded strategy
/// issues `workers * replication` inter-canister calls per token. A single
/// ingress message can therefore cost hundreds of downstream calls, and the
/// caller pays for exactly one of them. That is the right trade for a reference
/// app that anybody may poke at, and the wrong one for anything holding cycles.
///
/// The unit of account is one **model pass**: either a score-vector evaluation
/// the orchestrator runs itself, or one scoring call to a worker. It is charged
/// from an upper bound computed *before* the work starts, so a request that
/// would exceed the caller's budget is refused instead of half-run.
///
/// The window is tumbling rather than sliding: a sliding window needs the
/// timestamps of individual calls, which is unbounded state per principal, and
/// unbounded state is how a rate limiter becomes the denial-of-service vector.
/// A tumbling window costs two numbers per principal and lets a caller spend two
/// budgets across a window boundary — a factor of two, documented, in exchange
/// for O(1) state.
///
/// Everything here is a pure function of the state passed in, including `now`.
/// The actor owns the clock and the map; this module owns the arithmetic, and
/// the tests can therefore run the year 2031 in a millisecond.
module {

  /// Nanoseconds, matching `Time.now()`.
  public type Nanos = Nat;

  public type Policy = {
    /// Length of the accounting window.
    windowNanos : Nanos;
    /// Model passes a principal may spend per window.
    unitsPerWindow : Nat;
  };

  public type Usage = {
    /// Start of the window this record is accounted against.
    windowStart : Nanos;
    /// Units spent inside it.
    used : Nat;
  };

  /// What a caller is told when it is refused: enough to know the limit, what it
  /// has already spent, what it just asked for, and when to come back. A rate
  /// limiter that only says "no" cannot be programmed against.
  public type Exceeded = {
    limit : Nat;
    used : Nat;
    requested : Nat;
    resetInNanos : Nanos;
  };

  public type Decision = { #ok : Usage; #err : Exceeded };

  /// One hour, 20 000 model passes. At four workers and no replication that is
  /// roughly forty `benchmark` calls an hour per principal — generous for a
  /// human, restrictive for a script.
  public let DEFAULT : Policy = {
    windowNanos = 3_600_000_000_000;
    unitsPerWindow = 20_000;
  };

  /// Usage record rolled forward to the window containing `now`.
  public func current(usage : ?Usage, now : Nanos, policy : Policy) : Usage {
    switch (usage) {
      case null { { windowStart = now; used = 0 } };
      case (?u) {
        if (policy.windowNanos == 0 or now >= u.windowStart + policy.windowNanos) {
          { windowStart = now; used = 0 };
        } else u;
      };
    };
  };

  /// Cost of a request, in model passes.
  ///
  /// `fanOut` is the number of scoring calls one decoding position issues —
  /// `workers * replication` for a sharded strategy, `0` for one that runs
  /// entirely inside the orchestrator. The `1 +` is the orchestrator's own pass:
  /// it always computes the reference output, and on the local strategies that
  /// is the whole cost.
  ///
  /// This is an upper bound. A run that hits the stop token early, or a
  /// speculative run whose drafts are accepted, costs less — the caller is not
  /// refunded, because refunding after the fact means the limit is only enforced
  /// once the work is already done.
  public func estimate(tokens : Nat, fanOut : Nat) : Nat {
    tokens * (1 + fanOut);
  };

  /// Charges `units` against a principal's budget.
  ///
  /// Refuses rather than clamps. A clamped request looks like a successful one
  /// with a surprising result, and the caller has no way to tell the difference
  /// between "the model stopped early" and "you ran out of budget".
  public func charge(usage : ?Usage, now : Nanos, policy : Policy, units : Nat) : Decision {
    let window = current(usage, now, policy);
    if (window.used + units > policy.unitsPerWindow) {
      return #err({
        limit = policy.unitsPerWindow;
        used = window.used;
        requested = units;
        resetInNanos = resetIn(window, now, policy);
      });
    };
    #ok({ window with used = window.used + units });
  };

  /// Units still available to this principal in the current window.
  public func remaining(usage : ?Usage, now : Nanos, policy : Policy) : Nat {
    let window = current(usage, now, policy);
    if (window.used >= policy.unitsPerWindow) 0 else policy.unitsPerWindow - window.used;
  };

  /// Nanoseconds until the current window rolls over.
  public func resetIn(window : Usage, now : Nanos, policy : Policy) : Nanos {
    let ends = window.windowStart + policy.windowNanos;
    if (ends <= now) 0 else ends - now;
  };
};
