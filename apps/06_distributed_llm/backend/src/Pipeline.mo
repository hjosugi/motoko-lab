/// Pipeline-parallel decoding, and the one place where quantization actually
/// costs something.
///
/// Two facts sit behind this module, and they point in opposite directions.
///
/// **Vocabulary parallelism is quantization-proof.** When each worker owns a
/// slice and the merge is a max reduction, truncating absolute-max quantization
/// cannot change the answer. `code = v * L / max` is monotone non-decreasing,
/// and `code = L` requires `v * L >= L * max`, i.e. `v = max`. The winner is
/// therefore the only element that reaches the top code, so the argmax survives
/// any bit width — even two bits. `Cluster.mo` measures this and finds zero
/// flips, which is not luck. Note what carries the proof: truncation. Under
/// round-to-nearest the error is two-sided and the guarantee is gone.
///
/// **Pipeline parallelism is not.** Here the receiver needs the *values*, not
/// the ranking: every stage adds its term to a running vector and forwards it.
/// Each hop re-quantizes with its own scale, the errors accumulate, and a later
/// stage can no longer separate two tokens the exact arithmetic would have
/// separated. That is where a low bit width starts changing the output.
///
/// So "quantize the activations" is not one decision. It is free on a reduction
/// and lossy on an accumulation, and a design that mixes the two has to say
/// which links are which.
import Array "mo:core/Array";
import VarArray "mo:core/VarArray";
import Lm "Lm";
import Quant "Quant";

module {

  public type Step = {
    token : Nat;
    /// Payload bytes handed to the next stage, summed over hops.
    bytes : Nat;
    /// Stage-to-stage transfers.
    hops : Nat;
  };

  public type Run = {
    tokens : [Lm.TokenId];
    bytes : Nat;
    hops : Nat;
    /// Sequential stage executions. A pipeline trades round trips for memory:
    /// this is `hops` per token, against one for a single node.
    rounds : Nat;
  };

  /// How much each stage contributes relative to the others.
  ///
  /// `#natural` uses the model's own interpolation weights, which are
  /// hierarchical by design: the trigram term outweighs the bigram term by
  /// roughly 16x and the unigram term by 1000x. The first stage therefore
  /// decides the winner on its own, and no amount of quantization downstream
  /// can overturn it.
  ///
  /// `#balanced` rescales every stage to the same magnitude before it is added.
  /// That is not what this n-gram does, but it *is* what a transformer residual
  /// stream looks like — successive layers contribute comparable amounts — and
  /// it is the regime in which accumulated quantization error can actually
  /// change the output. Keeping both makes the comparison a controlled one
  /// rather than a lucky null result.
  public type Profile = { #natural; #balanced };

  func rescale(term : [Nat], target : Nat) : [Nat] {
    var maximum = 0;
    for (v in term.vals()) { if (v > maximum) maximum := v };
    if (maximum == 0) return term;
    Array.map<Nat, Nat>(term, func(v : Nat) : Nat { v * target / maximum });
  };

  /// One decoding position, walked through the stages of the model.
  ///
  /// `bits = null` sends the accumulator at full width. `bits = ?n` quantizes
  /// it on every hop, which is the behaviour under test.
  public func step(
    model : Lm.Model,
    order : Lm.Order,
    ctx : Lm.Ctx,
    bits : ?Nat,
    profile : Profile,
    rounding : Quant.Rounding,
  ) : Step {
    let stages = Lm.stagesFor(order);
    let width = model.vocabSize;
    let accumulator = VarArray.repeat<Nat>(0, width);
    var bytes = 0;
    var hops = 0;

    var s = 0;
    while (s < stages.size()) {
      let raw = Lm.stageRange(model, stages[s], ctx, 0, width);
      let term = switch profile {
        case (#natural) raw;
        case (#balanced) rescale(raw, Lm.SCALE);
      };
      var k = 0;
      while (k < width) {
        accumulator[k] += term[k];
        k += 1;
      };

      // The last stage produces the answer; it has nobody to forward to.
      if (s + 1 < stages.size()) {
        let payload = Array.tabulate<Nat>(width, func(i : Nat) : Nat { accumulator[i] });
        switch bits {
          case (?b) {
            let q = Quant.quantizeWith(payload, b, rounding);
            let restored = Quant.dequantizeWith(q, rounding);
            var i = 0;
            while (i < width) {
              accumulator[i] := restored[i];
              i += 1;
            };
            bytes += Quant.quantizedBytes(q);
          };
          case null bytes += Quant.denseBytes(width);
        };
        hops += 1;
      };
      s += 1;
    };

    let (token, _) = Lm.argmax(Array.tabulate<Nat>(width, func(i : Nat) : Nat { accumulator[i] }));
    { token; bytes; hops };
  };

  public func generate(
    model : Lm.Model,
    order : Lm.Order,
    prompt : [Lm.TokenId],
    maxTokens : Nat,
    bits : ?Nat,
    profile : Profile,
    rounding : Quant.Rounding,
  ) : Run {
    var history = prompt;
    var out : [Lm.TokenId] = [];
    var bytes = 0;
    var hops = 0;
    var rounds = 0;

    label decode while (out.size() < maxTokens) {
      let s = step(model, order, Lm.ctxOf(history), bits, profile, rounding);
      bytes += s.bytes;
      hops += s.hops;
      rounds += s.hops + 1;
      history := Array.concat(history, [s.token]);
      out := Array.concat(out, [s.token]);
      if (s.token == model.stop) break decode;
    };

    { tokens = out; bytes; hops; rounds };
  };
};
