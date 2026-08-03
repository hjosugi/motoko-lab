/// Logic of a shard worker, factored out of the actor so that the deployed
/// canister (`worker/src/main.mo`) and the in-process cluster simulation
/// (`sim/Cluster.mo`) run the *same* code rather than two similar copies.
///
/// The engine is stateless with respect to the shard assignment: `info` and
/// `handle` take it as an argument. That keeps the only mutable state in the
/// actor, where it can be a stable variable and survive an upgrade, and it
/// keeps this module trivially testable.
///
/// Honest limitation: the worker fits the whole model and then only ever
/// evaluates its own vocabulary range. A production shard would hold just its
/// slice of the parameters; what is demonstrated here is the communication
/// pattern, not the memory saving.
import Corpus "Corpus";
import Lm "Lm";
import Quant "Quant";
import Sharding "Sharding";
import Types "Types";

module {

  public class Engine() {
    let model = Lm.train(Corpus.text);

    public func vocabSize() : Nat { model.vocabSize };

    public func info(shard : Nat, count : Nat) : Types.WorkerInfo {
      let r = Sharding.range(model.vocabSize, shard, count);
      {
        shard;
        shardCount = count;
        lo = r.lo;
        hi = r.hi;
        vocabSize = model.vocabSize;
      };
    };

    /// Scores this worker's vocabulary slice and answers in the requested wire
    /// format.
    public func handle(shard : Nat, count : Nat, request : Types.ShardRequest) : Sharding.WorkerReply {
      let r = Sharding.range(model.vocabSize, shard, count);
      let ctx : Lm.Ctx = { prev2 = request.ctx.prev2; prev1 = request.ctx.prev1 };
      let scores = Lm.scoreRange(model, request.order, ctx, r.lo, r.hi);

      let reply : Sharding.Reply = switch (request.mode) {
        case (#argmax) {
          let (localIndex, score) = Lm.argmax(scores);
          #argmax { token = r.lo + localIndex; score };
        };
        case (#dense) #dense { lo = r.lo; scores };
        case (#quantized q) #quantized {
          lo = r.lo;
          codes = Quant.quantizeWith(scores, if (q.bits == 0) 8 else q.bits, q.rounding);
          rounding = q.rounding;
        };
      };

      { shard; reply; bytes = Sharding.replyBytes(reply) };
    };
  };
};
