/// A small language model that is safe to run inside a canister.
///
/// It is an order-3 back-off n-gram model over the word vocabulary produced by
/// `Tokenizer.mo`. Two properties matter more than model quality here:
///
///  1. **Integer only.** Every score is a `Nat`. Replicas in a subnet must agree
///     bit for bit, and floating point is the classic way to lose that. Scores
///     are fixed point: a probability `c / n` is carried as `SCALE * c / n`.
///
///  2. **One model, two capability levels.** `order = 3` is the *target* head
///     and `order = 2` is the strictly cheaper *draft* head. They share the
///     tokenizer and the vocabulary, which is exactly the relation a real draft
///     model has to its target, and it is what makes speculative decoding
///     applicable.
///
/// The context is deliberately `?TokenId` rather than `TokenId`. A masked
/// position in the diffusion-style draft is simply a `null` neighbour, and the
/// model backs off to a shorter n-gram instead of failing.
import Array "mo:core/Array";
import VarArray "mo:core/VarArray";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Tokenizer "Tokenizer";

module {

  public type TokenId = Tokenizer.TokenId;

  /// Fixed point scale for conditional probabilities.
  public let SCALE : Nat = 1_000_000;

  /// Interpolation weights. Longer contexts dominate, shorter contexts act as
  /// the back-off so no token ever scores exactly zero everywhere.
  let W3 : Nat = 1_000;
  let W2 : Nat = 60;
  let W1 : Nat = 1;

  type Row = {
    counts : Map.Map<TokenId, Nat>;
    var total : Nat;
  };

  public type Model = {
    vocab : Tokenizer.Vocab;
    unigram : [Nat];
    unigramTotal : Nat;
    bigram : Map.Map<Nat, Row>;
    trigram : Map.Map<Nat, Row>;
    vocabSize : Nat;
    /// Token id of `.`, used as the end-of-sentence stop token.
    stop : TokenId;
  };

  /// Left context of a position. `null` means "masked or unavailable", which is
  /// what a diffusion draft produces before that slot is unmasked.
  public type Ctx = {
    prev2 : ?TokenId;
    prev1 : ?TokenId;
  };

  /// Highest order the head is allowed to use: 3 = target, 2 = draft, 1 = the
  /// context-free unigram baseline.
  public type Order = Nat;

  public let TARGET : Order = 3;
  public let DRAFT : Order = 2;

  func emptyRow() : Row { { counts = Map.empty<TokenId, Nat>(); var total = 0 } };

  func bump(table : Map.Map<Nat, Row>, key : Nat, token : TokenId) {
    let row = switch (Map.get(table, Nat.compare, key)) {
      case (?r) r;
      case null {
        let r = emptyRow();
        Map.add(table, Nat.compare, key, r);
        r;
      };
    };
    let previous = switch (Map.get(row.counts, Nat.compare, token)) {
      case (?c) c;
      case null 0;
    };
    Map.add(row.counts, Nat.compare, token, previous + 1);
    row.total += 1;
  };

  /// Fits the model to raw text. Deterministic: same text in, same counts out.
  public func train(raw : Text) : Model {
    let ws = Tokenizer.words(raw);
    let vocab = Tokenizer.buildVocab(ws);
    let v = Tokenizer.size(vocab);
    let ids = Array.map<Text, TokenId>(ws, func(w : Text) : TokenId { Tokenizer.idOf(vocab, w) });

    let uni = VarArray.repeat<Nat>(0, v);
    let bi = Map.empty<Nat, Row>();
    let tri = Map.empty<Nat, Row>();
    var total = 0;

    var i = 0;
    while (i < ids.size()) {
      let t = ids[i];
      uni[t] += 1;
      total += 1;
      if (i >= 1) bump(bi, ids[i - 1], t);
      if (i >= 2) bump(tri, ids[i - 2] * v + ids[i - 1], t);
      i += 1;
    };

    {
      vocab;
      unigram = Array.tabulate<Nat>(v, func(k : Nat) : Nat { uni[k] });
      unigramTotal = if (total == 0) 1 else total;
      bigram = bi;
      trigram = tri;
      vocabSize = v;
      stop = Tokenizer.idOf(vocab, ".");
    };
  };

  /// Context for the position that follows `history`.
  public func ctxOf(history : [TokenId]) : Ctx {
    let n = history.size();
    {
      prev2 = if (n >= 2) ?history[n - 2] else null;
      prev1 = if (n >= 1) ?history[n - 1] else null;
    };
  };

  func rowOf(table : Map.Map<Nat, Row>, key : Nat) : ?Row {
    Map.get(table, Nat.compare, key);
  };

  func countIn(row : Row, token : TokenId) : Nat {
    switch (Map.get(row.counts, Nat.compare, token)) { case (?c) c; case null 0 };
  };

  /// One interpolation term of the score.
  ///
  /// The final score is the sum of the applicable terms. Splitting them out is
  /// what lets `Pipeline.mo` place each term on a different node: this is the
  /// toy stand-in for a residual stream, where every stage adds its
  /// contribution and hands the running vector to the next one.
  public type Stage = { #trigram; #bigram; #unigram };

  /// Stages a head of the given order actually uses, deepest first, which is
  /// also the order a pipeline would traverse them in.
  public func stagesFor(order : Order) : [Stage] {
    if (order >= 3) [#trigram, #bigram, #unigram] else if (order >= 2) [#bigram, #unigram] else [#unigram];
  };

  /// Contribution of a single stage to tokens `[lo, hi)`.
  public func stageRange(model : Model, stage : Stage, ctx : Ctx, lo : Nat, hi : Nat) : [Nat] {
    let upper = if (hi > model.vocabSize) model.vocabSize else hi;
    if (lo >= upper) return [];

    switch stage {
      case (#unigram) {
        Array.tabulate<Nat>(
          upper - lo,
          func(k : Nat) : Nat { W1 * SCALE * model.unigram[lo + k] / model.unigramTotal },
        );
      };
      case (#bigram) {
        let row = switch (ctx.prev1) {
          case (?b) rowOf(model.bigram, b);
          case null null;
        };
        switch (row) {
          case (?r) if (r.total > 0) {
            Array.tabulate<Nat>(upper - lo, func(k : Nat) : Nat { W2 * SCALE * countIn(r, lo + k) / r.total });
          } else Array.repeat<Nat>(0, upper - lo);
          case null Array.repeat<Nat>(0, upper - lo);
        };
      };
      case (#trigram) {
        let row = switch (ctx.prev2, ctx.prev1) {
          case (?a, ?b) rowOf(model.trigram, a * model.vocabSize + b);
          case _ null;
        };
        switch (row) {
          case (?r) if (r.total > 0) {
            Array.tabulate<Nat>(upper - lo, func(k : Nat) : Nat { W3 * SCALE * countIn(r, lo + k) / r.total });
          } else Array.repeat<Nat>(0, upper - lo);
          case null Array.repeat<Nat>(0, upper - lo);
        };
      };
    };
  };

  /// Scores tokens `[lo, hi)` under `ctx`. This is the shard entry point: a
  /// worker canister owns a vocabulary slice and only ever computes its own
  /// range, which is what "vocabulary parallelism" means in practice.
  public func scoreRange(model : Model, order : Order, ctx : Ctx, lo : Nat, hi : Nat) : [Nat] {
    let upper = if (hi > model.vocabSize) model.vocabSize else hi;
    if (lo >= upper) return [];

    let width : Nat = upper - lo;
    let accumulator = VarArray.repeat<Nat>(0, width);
    for (stage in stagesFor(order).vals()) {
      let term = stageRange(model, stage, ctx, lo, upper);
      var k = 0;
      while (k < width) {
        accumulator[k] += term[k];
        k += 1;
      };
    };
    Array.tabulate<Nat>(width, func(k : Nat) : Nat { accumulator[k] });
  };

  /// Full score vector. This is the "activation" that a pipeline stage would
  /// hand to the next stage, and the thing `Quant.mo` compresses.
  public func scoreVector(model : Model, order : Order, ctx : Ctx) : [Nat] {
    scoreRange(model, order, ctx, 0, model.vocabSize);
  };

  /// Argmax with ties broken by the lowest token id. The tie-break is not a
  /// detail: without it two shards could legally disagree and the cluster would
  /// produce a different answer than a single node.
  public func argmax(scores : [Nat]) : (TokenId, Nat) {
    var bestId = 0;
    var bestScore = 0;
    var i = 0;
    while (i < scores.size()) {
      if (scores[i] > bestScore) {
        bestScore := scores[i];
        bestId := i;
      };
      i += 1;
    };
    (bestId, bestScore);
  };

  /// Greedy next token for a head of the given order.
  public func next(model : Model, order : Order, history : [TokenId]) : TokenId {
    let (id, _) = argmax(scoreVector(model, order, ctxOf(history)));
    id;
  };

  /// Greedy next token from an explicit (possibly masked) context.
  public func nextFromCtx(model : Model, order : Order, ctx : Ctx) : TokenId {
    let (id, _) = argmax(scoreVector(model, order, ctx));
    id;
  };

  /// Confidence of the greedy choice, in `[0, SCALE]`: the winning score over
  /// the total mass. The diffusion-style draft unmasks the most confident slots
  /// first, so this is what orders the parallel unmasking schedule.
  public func confidence(scores : [Nat]) : Nat {
    var sum = 0;
    var best = 0;
    for (s in scores.vals()) {
      sum += s;
      if (s > best) best := s;
    };
    if (sum == 0) return 0;
    best * SCALE / sum;
  };

  /// Plain autoregressive greedy decoding. This is the reference output that
  /// every accelerated decoder in `Speculative.mo` must reproduce exactly.
  public func generate(model : Model, order : Order, prompt : [TokenId], maxTokens : Nat) : [TokenId] {
    var history = prompt;
    var out : [TokenId] = [];
    var produced = 0;
    while (produced < maxTokens) {
      let t = next(model, order, history);
      history := Array.concat(history, [t]);
      out := Array.concat(out, [t]);
      produced += 1;
      if (t == model.stop) return out;
    };
    out;
  };
};
