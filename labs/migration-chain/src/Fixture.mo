// Deterministic fixture data, shared by every version so a record seeded under
// V1 can be recognized under V3.
//
// This module holds no stable types on purpose. Stable types belong to the
// migration that introduced them (see migrations/), and a helper module that
// declared them would drift from the chain the first time either changed.
import Array "mo:core/Array";
import Nat "mo:core/Nat";

module {
  /// At most this many records per `seed` call: enough for a large map in a
  /// few calls, bounded so one call stays far below the instruction limit.
  public let maxSeedBatch = 20_000;

  /// Every 7th seeded record is revoked, so each step has revoked variants to
  /// carry through as well as active ones.
  public func seededRevoked(id : Nat) : Bool { id % 7 == 0 };

  public func seededTitle(id : Nat) : Text { "fixture-" # Nat.toText(id) };

  public let seededReason = "fixture revocation";

  public func seededHash(id : Nat) : Blob {
    Array.toBlob(Array.tabulate<Nat8>(32, func(i : Nat) : Nat8 { Nat.toNat8((id * 31 + i * 7) % 256) }))
  };
};
