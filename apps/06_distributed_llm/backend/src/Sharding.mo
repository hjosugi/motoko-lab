/// Vocabulary sharding and the wire format between orchestrator and workers.
///
/// Three reply shapes are supported on purpose, because the choice between them
/// is the whole distributed-inference bandwidth question in miniature:
///
///   `#argmax`    – each worker returns only its local winner. Tiny, exact, but
///                  only usable when the merge is a max reduction.
///   `#dense`     – each worker returns its whole score slice. Exact and
///                  composable, but the payload is the activation itself and it
///                  is what saturates a slow link.
///   `#quantized` – the dense slice, scaled to `bits` levels. Small, and lossy:
///                  it can flip the winner. Safe behind an exact verifier.
import Quant "Quant";

module {

  public type Range = { lo : Nat; hi : Nat };

  /// Contiguous slice of the vocabulary owned by shard `index` of `count`.
  /// Deterministic and gap-free: the earlier shards absorb the remainder.
  public func range(vocabSize : Nat, index : Nat, count : Nat) : Range {
    if (count == 0 or index >= count) return { lo = 0; hi = 0 };
    let base = vocabSize / count;
    let extra = vocabSize % count;
    let lo = index * base + (if (index < extra) index else extra);
    let width = base + (if (index < extra) 1 else 0);
    { lo; hi = lo + width };
  };

  public type Reply = {
    #argmax : { token : Nat; score : Nat };
    #dense : { lo : Nat; scores : [Nat] };
    #quantized : { lo : Nat; codes : Quant.Quantized; rounding : Quant.Rounding };
  };

  public type WorkerReply = {
    shard : Nat;
    reply : Reply;
    /// Payload size of `reply` on the wire, in bytes. Counted, not estimated
    /// after the fact, so the bandwidth numbers in the report are honest.
    bytes : Nat;
  };

  /// Wire size of a reply. Candid overhead is ignored; what is compared here is
  /// the payload, which is where the orders of magnitude live.
  public func replyBytes(reply : Reply) : Nat {
    switch reply {
      case (#argmax _) 16; // two 64-bit words
      case (#dense d) 8 + Quant.denseBytes(d.scores.size());
      case (#quantized q) 8 + Quant.quantizedBytes(q.codes);
    };
  };

  /// Merges worker replies into a global winner.
  ///
  /// Ties break on the lowest token id, exactly as in `Lm.argmax`. Without that
  /// rule a cluster could legally return a different token than a single node
  /// and the sharding would stop being an implementation detail.
  public func merge(replies : [WorkerReply]) : { token : Nat; score : Nat; bytes : Nat } {
    var bestToken = 0;
    var bestScore = 0;
    var found = false;
    var bytes = 0;

    func offer(token : Nat, score : Nat) {
      if (not found or score > bestScore or (score == bestScore and token < bestToken)) {
        bestToken := token;
        bestScore := score;
        found := true;
      };
    };

    func offerSlice(lo : Nat, scores : [Nat]) {
      var i = 0;
      while (i < scores.size()) {
        offer(lo + i, scores[i]);
        i += 1;
      };
    };

    for (r in replies.vals()) {
      bytes += r.bytes;
      switch (r.reply) {
        case (#argmax a) offer(a.token, a.score);
        case (#dense d) offerSlice(d.lo, d.scores);
        case (#quantized q) offerSlice(q.lo, Quant.dequantizeWith(q.codes, q.rounding));
      };
    };

    { token = bestToken; score = bestScore; bytes };
  };
};
