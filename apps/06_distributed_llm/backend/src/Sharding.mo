/// Vocabulary sharding, the wire format between orchestrator and workers, and
/// the cross-checks that make a worker's answer verifiable.
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
///
/// A max reduction believes whatever a worker says about its own slice, and that
/// slice is the one range no other node computes. So the merge here works from
/// the ranges the orchestrator *asked* for rather than from whatever a worker
/// chose to answer, and rejects replies it cannot account for:
///
///   * `plan` assigns each range to `replication` distinct workers, so a range
///     is scored more than once by construction.
///   * `verify` checks that every requested range came back, that each reply
///     answers the range it was asked for, and that replicas of one range agree
///     exactly.
///   * `encode` is the single definition of what an honest reply looks like, so
///     the orchestrator can recompute a range itself and compare it against a
///     worker's answer without restating the wire format.
import Array "mo:core/Array";
import Quant "Quant";

module {

  public type Range = { lo : Nat; hi : Nat };

  /// What the orchestrator asks a worker to send back.
  ///
  /// Declared here rather than in `Types` because `encode` is the authority on
  /// what each mode produces; `Types.ReplyMode` is an alias for it.
  public type Mode = {
    #argmax;
    #dense;
    #quantized : { bits : Nat; rounding : Quant.Rounding };
  };

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

  /// One scoring call: worker `worker` is asked for the range of shard `shard`.
  public type Task = {
    worker : Nat;
    shard : Nat;
    range : Range;
  };

  /// Scoring calls for one decoding position.
  ///
  /// With `replication = 1` this is the identity assignment (`worker == shard`),
  /// which is what the app did before any of this existed. Above that, shard `s`
  /// is handed to workers `s, s+1, ..., s+replication-1` (mod `workers`), so
  /// every range is scored by that many *distinct* nodes and no worker is asked
  /// for the same range twice.
  ///
  /// The cost is explicit and linear: `workers * replication` inter-canister
  /// calls, and that multiple of the bytes. The number of *rounds* does not
  /// change, because the calls are independent and are all issued before the
  /// first await — replication buys detection with bandwidth, not with latency.
  public func plan(vocabSize : Nat, workers : Nat, replication : Nat) : [Task] {
    if (workers == 0) return [];
    let k = if (replication == 0) 1 else if (replication > workers) workers else replication;

    var tasks : [Task] = [];
    var shard = 0;
    while (shard < workers) {
      let r = range(vocabSize, shard, workers);
      var copy = 0;
      while (copy < k) {
        tasks := Array.concat(tasks, [{ worker = (shard + copy) % workers; shard; range = r }]);
        copy += 1;
      };
      shard += 1;
    };
    tasks;
  };

  public type Reply = {
    #argmax : { token : Nat; score : Nat };
    #dense : { lo : Nat; scores : [Nat] };
    #quantized : { lo : Nat; codes : Quant.Quantized; rounding : Quant.Rounding };
  };

  public type WorkerReply = {
    /// Index of the worker that answered — *who*, not *what*. Under replication
    /// a worker answers ranges it does not own, so this is the node to name when
    /// a check fails, and `lo`/`hi` below are the range it answered about.
    shard : Nat;
    /// Range this reply claims to cover. The orchestrator asked for a specific
    /// one, so a reply naming a different range is rejected rather than merged.
    /// It is the cheapest byzantine check there is.
    lo : Nat;
    hi : Nat;
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

  /// Argmax over a slice, ties broken by the lowest token id.
  public func sliceWinner(lo : Nat, scores : [Nat]) : (Nat, Nat) {
    var bestIndex = 0;
    var bestScore = 0;
    var i = 0;
    while (i < scores.size()) {
      if (scores[i] > bestScore) {
        bestScore := scores[i];
        bestIndex := i;
      };
      i += 1;
    };
    (lo + bestIndex, bestScore);
  };

  /// The one definition of an honest reply: exact scores for `[lo, hi)`, in the
  /// requested wire format.
  ///
  /// The worker uses it to answer and the orchestrator uses it to recompute a
  /// range during a spot check, so "what a correct worker would have said" is a
  /// single expression rather than two implementations that have to be kept in
  /// step.
  public func encode(mode : Mode, lo : Nat, scores : [Nat]) : Reply {
    switch mode {
      case (#argmax) {
        let (token, score) = sliceWinner(lo, scores);
        #argmax { token; score };
      };
      case (#dense) #dense { lo; scores };
      case (#quantized q) #quantized {
        lo;
        codes = Quant.quantizeWith(scores, if (q.bits == 0) 8 else q.bits, q.rounding);
        rounding = q.rounding;
      };
    };
  };

  /// Structural equality of two replies.
  ///
  /// Written out rather than left to `==` because it is the predicate every
  /// byzantine check rests on: two honest workers given the same range, mode and
  /// context produce identical replies — the arithmetic is integer throughout —
  /// so any difference at all is a fault rather than a rounding artefact.
  public func sameReply(a : Reply, b : Reply) : Bool {
    switch (a, b) {
      case (#argmax x, #argmax y) x.token == y.token and x.score == y.score;
      case (#dense x, #dense y) x.lo == y.lo and sameVector(x.scores, y.scores);
      case (#quantized x, #quantized y) {
        x.lo == y.lo
        and x.rounding == y.rounding
        and x.codes.bits == y.codes.bits
        and x.codes.scale == y.codes.scale
        and sameVector(x.codes.codes, y.codes.codes);
      };
      case _ false;
    };
  };

  func sameVector(a : [Nat], b : [Nat]) : Bool {
    if (a.size() != b.size()) return false;
    var i = 0;
    while (i < a.size()) {
      if (a[i] != b[i]) return false;
      i += 1;
    };
    true;
  };

  /// Merges worker replies into a global winner.
  ///
  /// Ties break on the lowest token id, exactly as in `Lm.argmax`. Without that
  /// rule a cluster could legally return a different token than a single node
  /// and the sharding would stop being an implementation detail.
  ///
  /// This is the unchecked reduction: it trusts every reply. `verify` is what
  /// decides whether the replies deserve it.
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

  /// Why a round of replies was rejected. Every case names the shard, because an
  /// operator's next question is always which worker to pull out of the cluster.
  public type Fault = {
    #missing : { shard : Nat };
    #wrongRange : { shard : Nat; expected : Range; got : Range };
    #disagreement : { shard : Nat; workers : (Nat, Nat) };
    #spotCheckFailed : { shard : Nat; worker : Nat };
  };

  public type Verified = {
    /// One accepted reply per shard, in shard order. This is what `merge` runs
    /// on, so a replica never contributes twice to the reduction.
    accepted : [WorkerReply];
    /// Every byte received, replicas included. Replication is paid for here.
    bytes : Nat;
  };

  /// Checks a round of replies against the plan that produced them.
  ///
  /// `replies[i]` must be the answer to `tasks[i]`. Three faults are caught, in
  /// increasing order of what they cost to catch: a reply for a range nobody
  /// asked about (free), a shard no worker answered (free), and two workers
  /// disagreeing about one range (costs `replication` times the calls and
  /// bytes).
  ///
  /// What it cannot catch on its own: every replica of a range lying the same
  /// way, which is what happens when one principal controls them all. That needs
  /// either a replica the adversary does not control, or the orchestrator
  /// recomputing the range itself — see `spotCheck`.
  public func verify(tasks : [Task], replies : [WorkerReply], shards : Nat) : { #ok : Verified; #err : Fault } {
    if (tasks.size() != replies.size()) {
      // The caller pairs replies with tasks positionally, so a size mismatch
      // means the round is not interpretable at all.
      return #err(#missing { shard = shards });
    };

    var bytes = 0;
    for (r in replies.vals()) { bytes += r.bytes };

    var accepted : [WorkerReply] = [];
    var shard = 0;
    while (shard < shards) {
      var chosen : ?WorkerReply = null;
      var chosenWorker = 0;
      var i = 0;
      while (i < tasks.size()) {
        let task = tasks[i];
        if (task.shard == shard) {
          let reply = replies[i];
          if (reply.lo != task.range.lo or reply.hi != task.range.hi) {
            return #err(#wrongRange { shard; expected = task.range; got = { lo = reply.lo; hi = reply.hi } });
          };
          switch (chosen) {
            case null { chosen := ?reply; chosenWorker := task.worker };
            case (?first) {
              if (not sameReply(first.reply, reply.reply)) {
                return #err(#disagreement { shard; workers = (chosenWorker, task.worker) });
              };
            };
          };
        };
        i += 1;
      };
      switch (chosen) {
        case null return #err(#missing { shard });
        case (?reply) accepted := Array.concat(accepted, [reply]);
      };
      shard += 1;
    };

    #ok { accepted; bytes };
  };

  /// Which shard the orchestrator recomputes itself on round `round`.
  ///
  /// A rotation rather than a draw: a canister has no private randomness. The
  /// only unpredictable source on the Internet Computer is `raw_rand`, which is
  /// an extra async call per round — a cost the caller can choose to pay, but not
  /// one to hide inside a merge. So the schedule is public and a colluding
  /// worker can compute it. What the rotation still buys is that a worker which
  /// lies on *every* round is caught within `shards` rounds, deterministically:
  /// staying uncaught means staying honest whenever it is looked at, and the
  /// orchestrator looks at every shard eventually.
  public func spotCheckTarget(round : Nat, shards : Nat) : ?Nat {
    if (shards == 0) return null;
    ?(round % shards);
  };

  /// Compares a worker's accepted reply against what the orchestrator computed
  /// for the same range. `exact` is the orchestrator's own score slice.
  public func spotCheck(reply : WorkerReply, mode : Mode, exact : [Nat]) : Bool {
    sameReply(reply.reply, encode(mode, reply.lo, exact));
  };
};
