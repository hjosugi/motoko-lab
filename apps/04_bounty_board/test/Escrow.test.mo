// The escrow's accounting, in the interpreter, where every combination is
// cheap. The replica suite checks the same books against real ledger balances;
// this checks that the arithmetic those books come from can never create or
// lose a token, whatever the reward, the platform rate, and the fee at funding
// and at payout.
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Escrow "../backend/src/Escrow";

// -- identifiers ---------------------------------------------------------------------
assert Escrow.subaccount(1).size() == 32;
assert Escrow.subaccount(1) == "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01";
assert Escrow.subaccount(1) != Escrow.subaccount(256);
assert Escrow.memo(7, #fund) == "bounty:7:fund";
assert Escrow.memo(9_999_999_999_999_999, #payPlatform).size() <= 32;
assert Escrow.memo(7, #payWinner) != Escrow.memo(7, #refund);

// -- terms ---------------------------------------------------------------------------
assert Escrow.platformFee(1_000_000, 250) == 25_000;
assert Escrow.platformFee(1_000_000, 0) == 0;
assert Escrow.platformFee(39, 250) == 0; // rounds down: the owner is never charged more than the rate
assert Escrow.deposit(1_000_000, 0, 10_000) == 1_010_000;
assert Escrow.deposit(1_000_000, 25_000, 10_000) == 1_045_000;

// -- the invariant ---------------------------------------------------------------------
// winner + platform + the fees of the transfers actually made + dust == deposit,
// dust never exceeds one fee, and at the funding fee (or a lower one) the
// winner receives exactly the reward and the platform exactly its cut.
var cases = 0;
for (reward in [1, 7, 10_000, 999_999, 1_000_000, 123_456_789].values()) {
  for (bps in [0, 1, 250, 2_000].values()) {
    for (fee in [0, 1, 10_000, 250_000].values()) {
      let cut = Escrow.platformFee(reward, bps);
      let deposit = Escrow.deposit(reward, cut, fee);
      for (later in [0, fee / 2, fee, fee + 1, fee * 2, fee * 5 + 3].values()) {
        let split = Escrow.release(deposit, reward, later);
        let fees = (if (split.winner > 0) later else 0) + (if (split.platform > 0) later else 0);
        assert split.winner + split.platform + fees + split.dust == deposit;
        assert split.dust <= later;
        assert split.winner <= reward;
        if (later <= fee) {
          assert split.winner == reward;
          if (later == fee) {
            assert split.platform == cut;
            assert split.dust == 0
          }
        };
        // Paid first and in full whenever the escrow can cover it.
        if (deposit >= reward + later) assert split.winner == reward;
        let back = Escrow.refund(deposit, later);
        assert back + (if (back > 0) later else deposit) == deposit;
        cases += 1
      }
    }
  }
};
assert cases == 6 * 4 * 4 * 6;

// -- the books ----------------------------------------------------------------------------
let owner : Escrow.Account = { owner = Principal.fromText("2vxsx-fae"); subaccount = null };
let pool : Escrow.Account = { owner = Principal.fromText("aaaaa-aa"); subaccount = ?Escrow.subaccount(3) };
func op(kind : Escrow.OpKind, amount : Nat, status : Escrow.OpStatus) : Escrow.Op {
  { kind; from = owner; to = pool; amount; fee = 10; memo = Escrow.memo(3, kind); createdAtTime = 0; attempts = 1; status }
};
let done : Escrow.OpStatus = #done({ block = ?1; at = 0 });
let books : Escrow.Escrow = {
  bountyId = 3; ledger = Principal.fromText("aaaaa-aa"); funder = owner.owner; subaccount = Escrow.subaccount(3);
  reward = 100; platformFee = 5; platform = ?owner; fee = 10; deposit = 125; state = #releasing;
  ops = [
    op(#fund, 125, #failed({ reason = "insufficient allowance"; at = 0 })),
    op(#fund, 125, done),
    op(#payWinner, 100, done),
    op(#payPlatform, 5, #pending),
  ];
};
// A failed pull moved nothing; the executed one brought 125; the winner's payout
// took 100 + 10; the pending platform transfer has not happened yet.
assert Escrow.expectedBalance(books) == 15;
assert Escrow.pendingIndex(books) == ?3;
assert Escrow.doneCount(books, #fund) == 1 and Escrow.doneCount(books, #payPlatform) == 0;
assert Escrow.approval(books) == 135;
