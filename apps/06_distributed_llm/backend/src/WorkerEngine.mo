/// Logic of a shard worker, factored out of the actor so that the deployed
/// canister (`worker/src/main.mo`) and the in-process cluster simulation
/// (`sim/Cluster.mo`) run the *same* code rather than two similar copies.
///
/// The engine is stateless with respect to the shard assignment: `info` and
/// `handle` take it as an argument. That keeps the only mutable state in the
/// actor, where it can be a stable variable and survive an upgrade, and it
/// keeps this module trivially testable.
///
/// A request may name the range it wants instead of taking the worker's own
/// slice. That is what makes replicated scoring possible — a range has to be
/// answerable by more than the one node that owns it — and it costs nothing in
/// trust, because the reply carries the range it covers and the orchestrator
/// rejects any reply that does not answer the question it was asked.
///
/// Honest limitation: the worker fits the whole model and then only ever
/// evaluates the requested vocabulary range. A production shard would hold just
/// its slice of the parameters; what is demonstrated here is the communication
/// pattern, not the memory saving.
import Corpus "Corpus";
import Lm "Lm";
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

    /// Range this request is about: the one it names, or the worker's own slice
    /// when it names none. Clamped to the vocabulary, so an out-of-range request
    /// comes back as a narrower range rather than as a trap — and the mismatch
    /// is then visible to the orchestrator.
    func requested(shard : Nat, count : Nat, request : Types.ShardRequest) : Sharding.Range {
      switch (request.range) {
        case null Sharding.range(model.vocabSize, shard, count);
        case (?r) {
          let hi = if (r.hi > model.vocabSize) model.vocabSize else r.hi;
          { lo = if (r.lo > hi) hi else r.lo; hi };
        };
      };
    };

    /// Scores a vocabulary range and answers in the requested wire format.
    public func handle(shard : Nat, count : Nat, request : Types.ShardRequest) : Sharding.WorkerReply {
      let r = requested(shard, count, request);
      let ctx : Lm.Ctx = { prev2 = request.ctx.prev2; prev1 = request.ctx.prev1 };
      let scores = Lm.scoreRange(model, request.order, ctx, r.lo, r.hi);
      let reply = Sharding.encode(request.mode, r.lo, scores);

      { shard; lo = r.lo; hi = r.hi; reply; bytes = Sharding.replyBytes(reply) };
    };
  };
};
