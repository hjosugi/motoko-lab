/// Shard worker canister.
///
/// Deploy this source once per shard (`worker_0`, `worker_1`, ... in
/// `icp.yaml`). Each instance is told which slice of the vocabulary it owns by
/// the orchestrator, then answers scoring requests for that slice only.
///
/// Every scoring endpoint is a `query`: a worker never mutates model state, so
/// the orchestrator can reach it without paying for consensus on the worker
/// side. The orchestrator itself must still be an update call, because a query
/// cannot make an inter-canister call.
import Principal "mo:core/Principal";
import Sharding "../../backend/src/Sharding";
import Types "../../backend/src/Types";
import WorkerEngine "../../backend/src/WorkerEngine";

persistent actor Worker {

  public type Error = Types.Error;
  public type Result<T> = Types.Result<T>;

  /// Rebuilt from the baked-in corpus on install and on every upgrade. It is
  /// derived data, so it is `transient` rather than persisted.
  transient let engine = WorkerEngine.Engine();

  var controller : ?Principal = null;
  var shardIndex : Nat = 0;
  var shardCount : Nat = 1;

  /// First caller claims the worker; afterwards only that principal may
  /// reconfigure it. Anonymous callers are rejected so an unclaimed worker
  /// cannot be captured by anyone who can reach the boundary node.
  public shared ({ caller }) func configure(shard : Nat, count : Nat) : async Types.Result<Types.WorkerInfo> {
    if (Principal.isAnonymous(caller)) return #err(#anonymousNotAllowed);
    switch (controller) {
      case (?owner) if (owner != caller) return #err(#unauthorized);
      case null controller := ?caller;
    };
    if (count == 0) return #err(#invalidInput("count must be positive"));
    if (shard >= count) return #err(#invalidInput("shard must be < count"));

    shardIndex := shard;
    shardCount := count;
    #ok(engine.info(shardIndex, shardCount));
  };

  public query func info() : async Types.WorkerInfo {
    engine.info(shardIndex, shardCount);
  };

  /// Scores a vocabulary range for one decoding position.
  ///
  /// The range is the worker's own slice unless the request names another one.
  /// Answering somebody else's slice is what makes replicated scoring possible,
  /// and it gives nothing away: the model is baked into every worker's wasm, the
  /// reply names the range it covers, and it is the orchestrator that decides
  /// whether two answers about one range are allowed to differ.
  public query func score(request : Types.ShardRequest) : async Sharding.WorkerReply {
    engine.handle(shardIndex, shardCount, request);
  };
};
