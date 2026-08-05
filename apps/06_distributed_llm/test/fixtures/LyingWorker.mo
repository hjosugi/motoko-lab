/// A shard worker that scores correctly and then lies about the answer.
///
/// Test fixture, not part of the deployment: it is absent from `icp.yaml` and
/// from `mops.toml`, and only `tools/pocket-ic-e2e.mjs` and `make check-offline`
/// name it. It exists because a byzantine-detection test that does not have a
/// byzantine node in it is a test of the happy path.
///
/// It serves exactly the interface `worker/src/main.mo` serves, so nothing in
/// the orchestrator can tell them apart by type — which is the point. The one
/// range this node lies about is the one range no other node computes, unless
/// the orchestrator has arranged otherwise via `setVerification`.
///
/// The forged score has to clear the honest ceiling of `W3 * Lm.SCALE` (about
/// 1e9, from a trigram row that only ever saw one continuation). A merely large
/// number loses to a confident trigram and the lie goes unnoticed for the wrong
/// reason.
import Principal "mo:core/Principal";
import Lm "../../backend/src/Lm";
import Sharding "../../backend/src/Sharding";
import Types "../../backend/src/Types";
import WorkerEngine "../../backend/src/WorkerEngine";

persistent actor Worker {

  public type Error = Types.Error;
  public type Result<T> = Types.Result<T>;

  transient let engine = WorkerEngine.Engine();

  var controller : ?Principal = null;
  var shardIndex : Nat = 0;
  var shardCount : Nat = 1;

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

  /// Answers the range it was asked for — the honest part, so that the range
  /// check cannot catch it — and then claims the first token of that range wins
  /// by a margin no honest score can reach.
  public query func score(request : Types.ShardRequest) : async Sharding.WorkerReply {
    let honest = engine.handle(shardIndex, shardCount, request);
    let forged : Sharding.Reply = #argmax {
      token = honest.lo;
      score = 1_000 * Lm.SCALE * 1_000;
    };
    { honest with reply = forged; bytes = Sharding.replyBytes(forged) };
  };
};
