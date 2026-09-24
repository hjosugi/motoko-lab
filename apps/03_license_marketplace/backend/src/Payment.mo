/// Payment verification: what a ledger block has to say before a payment is
/// accepted, and the ledger calls that fetch it.
///
/// The rule the rest of this module serves: a grant is issued because the
/// ledger says money moved, never because a buyer or a seller says so. The
/// buyer only ever supplies a block index — a pointer — and every property of
/// the payment is read from the ledger at that index:
///
/// * `to` is the listing's payee, subaccount-normalized (ICRC-1's absent and
///   all-zero subaccounts are one account);
/// * `from` is the buyer who opened the intent, any subaccount;
/// * `amount` is at least the price, net of the fee — the fee is the sender's
///   cost on top, so a buyer who counted it as part of the price underpaid;
/// * `memo` is the intent's memo, which binds the payment to one intent on one
///   marketplace canister (see `intentMemo`);
/// * the block timestamp falls inside the intent's window, so a payment made
///   before the intent existed — somebody else's, or an old one — cannot be
///   presented for it.
///
/// Everything is checked; the first failure is reported. A rejection is not
/// terminal for the intent: a buyer who typed the wrong block index can submit
/// the right one.
import Error "mo:core/Error";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";
import Icrc3 "Icrc3";

module {
  public type Expectation = {
    payer : Principal;
    payee : Icrc3.Account;
    amount : Nat;
    memo : Blob;
    notBefore : Nat;
    notAfter : Nat;
  };

  public type Verdict = {
    #accepted : Icrc3.Transfer;
    #rejected : Text;
  };

  /// Ledger clocks and ours are both IC time but not the same reading; a
  /// payment made the moment an intent opened may be stamped a little before.
  public let clockSkewNanos : Nat = 300_000_000_000; // five minutes

  /// How long an intent accepts payments for.
  public let intentLifetimeNanos : Nat = 86_400_000_000_000; // 24 hours

  public let memoDomain : Text = "icp-license-intent:v1";

  /// `SHA-256("icp-license-intent:v1" || 0x00 || marketplace principal bytes || 0x00 || intent id as 8 bytes BE)`.
  ///
  /// 32 bytes, the ICRC-1 default maximum memo length. The marketplace principal
  /// is inside it because deduplication by (ledger, block) is only as wide as
  /// one canister: without it, one payment carrying "intent 1" could be claimed
  /// as intent 1 on every marketplace deployment that pays the same seller.
  public func intentMemo(marketplace : Principal, intentId : Nat) : Blob {
    let digest = Sha256.new(#sha256);
    digest.writeBlob(Text.encodeUtf8(memoDomain));
    digest.writeBlob("\00");
    digest.writeBlob(Principal.toBlob(marketplace));
    digest.writeBlob("\00");
    let (b7, b6, b5, b4, b3, b2, b1, b0) = Nat64.explode(Nat.toNat64(intentId));
    digest.writeArray([b7, b6, b5, b4, b3, b2, b1, b0]);
    digest.sum()
  };

  public func check(transfer : Icrc3.Transfer, expected : Expectation) : Verdict {
    if (not Icrc3.sameAccount(transfer.to, expected.payee)) {
      return #rejected("the payment went to a different account")
    };
    if (not Principal.equal(transfer.from.owner, expected.payer)) {
      return #rejected("the payment was not made by the buyer")
    };
    if (transfer.amount < expected.amount) {
      return #rejected("the payment is less than the price")
    };
    switch (transfer.memo) {
      case (?memo) {
        if (memo != expected.memo) return #rejected("the payment memo does not match this intent")
      };
      case null return #rejected("the payment carries no memo");
    };
    if (transfer.timestamp + clockSkewNanos < expected.notBefore) {
      return #rejected("the payment was made before the intent was opened")
    };
    if (transfer.timestamp > expected.notAfter) {
      return #rejected("the payment was made after the intent expired")
    };
    #accepted(transfer)
  };

  // ------------------------------------------------------------ ledger calls

  public type Fetched = {
    #block : Icrc3.Value;
    /// The ledger answered and has no block at that index.
    #missing;
    /// The ledger could not be asked: it rejected, trapped, or timed out. The
    /// only outcome that says nothing about the payment, and so the only one
    /// after which the same request should simply be retried.
    #unavailable : Text;
  };

  /// Fetches one block, following the ledger to its archive if that is where
  /// the block now lives. Every failure of the call is caught and reported as
  /// `#unavailable`; nothing here can trap the caller.
  ///
  /// The archive callback is a function reference the ledger hands back, so it
  /// is trusted exactly as far as the ledger is — which is why only a ledger a
  /// controller registered is ever asked.
  public func fetchBlock(ledger : Icrc3.Ledger, index : Nat) : async* Fetched {
    let args = [{ start = index; length = 1 }];
    let result = try {
      await ledger.icrc3_get_blocks(args)
    } catch (error) {
      return #unavailable("the ledger did not answer: " # Error.message(error))
    };
    for (entry in result.blocks.values()) {
      if (entry.id == index) return #block(entry.block)
    };
    for (archive in result.archived_blocks.values()) {
      if (covers(archive.args, index)) {
        let archived = try {
          await archive.callback(args)
        } catch (error) {
          return #unavailable("the ledger archive did not answer: " # Error.message(error))
        };
        for (entry in archived.blocks.values()) {
          if (entry.id == index) return #block(entry.block)
        };
        return #missing
      }
    };
    #missing
  };

  func covers(ranges : Icrc3.GetBlocksArgs, index : Nat) : Bool {
    for (range in ranges.values()) {
      if (index >= range.start and index < range.start + range.length) return true
    };
    false
  };
};
