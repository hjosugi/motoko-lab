/// Integer quantization for the activation that travels between nodes.
///
/// In a sharded decoder the message that dominates the wire is the dense score
/// (activation) vector: one number per vocabulary entry, per position, per hop.
/// On a slow link that transfer costs more wall clock than the arithmetic that
/// produced it, which is the observation the low-bandwidth distributed
/// inference literature is built on.
///
/// The compression here is per-message absolute-max scaling to `bits` levels,
/// integer arithmetic only, so the encoder and the decoder agree exactly on
/// every replica.
///
/// Rounding is a parameter, and it is not a detail. With `#floor` the error is
/// **one-sided**: every value is rounded down, the maximum is the one element
/// that is reproduced exactly, and the current leader can therefore never lose
/// ground to a competitor. That makes a floor-rounded argmax essentially
/// immune to quantization, which is a property of the rounding rule and not
/// evidence that low bit widths are safe. `#nearest` has the two-sided error
/// that real kernels have, and it is the mode to measure against.
///
/// Quantization is **lossy**. Used on its own it can flip the argmax of a step.
/// Used on the *draft* path of a speculative decoder it cannot change the
/// output at all, because an exact verifier re-derives every emitted token —
/// it only changes the acceptance rate. That composition is the point.
import Array "mo:core/Array";

module {

  /// `#floor` truncates, `#nearest` rounds to the closest level.
  public type Rounding = { #floor; #nearest };

  public type Quantized = {
    /// Largest value in the original vector; the dequantizer needs it.
    scale : Nat;
    bits : Nat;
    codes : [Nat];
  };

  /// Bytes a dense vector occupies on the wire, assuming 64-bit words.
  public func denseBytes(size : Nat) : Nat { size * 8 };

  /// Bytes the quantized form occupies: the codes, packed at `bits` each, plus
  /// a 64-bit scale header.
  public func quantizedBytes(q : Quantized) : Nat {
    (q.codes.size() * q.bits + 7) / 8 + 8;
  };

  func levels(bits : Nat) : Nat {
    if (bits == 0) return 1;
    var n = 1;
    var i = 0;
    while (i < bits) { n *= 2; i += 1 };
    n - 1;
  };

  public func quantizeWith(vector : [Nat], bits : Nat, rounding : Rounding) : Quantized {
    var maximum = 0;
    for (v in vector.vals()) { if (v > maximum) maximum := v };
    let l = levels(bits);
    if (maximum == 0) {
      return { scale = 0; bits; codes = Array.repeat<Nat>(0, vector.size()) };
    };
    let half = maximum / 2;
    {
      scale = maximum;
      bits;
      codes = Array.map<Nat, Nat>(
        vector,
        func(v : Nat) : Nat {
          switch rounding {
            case (#floor) v * l / maximum;
            case (#nearest) (v * l + half) / maximum;
          };
        },
      );
    };
  };

  /// Default rounding is `#floor`, matching a truncating integer kernel.
  public func quantize(vector : [Nat], bits : Nat) : Quantized {
    quantizeWith(vector, bits, #floor);
  };

  public func dequantizeWith(q : Quantized, rounding : Rounding) : [Nat] {
    if (q.scale == 0) return Array.repeat<Nat>(0, q.codes.size());
    let l = levels(q.bits);
    let half = l / 2;
    Array.map<Nat, Nat>(
      q.codes,
      func(c : Nat) : Nat {
        switch rounding {
          case (#floor) c * q.scale / l;
          case (#nearest) (c * q.scale + half) / l;
        };
      },
    );
  };

  public func dequantize(q : Quantized) : [Nat] {
    dequantizeWith(q, #floor);
  };

  public func roundTrip(vector : [Nat], bits : Nat, rounding : Rounding) : [Nat] {
    dequantizeWith(quantizeWith(vector, bits, rounding), rounding);
  };
};
