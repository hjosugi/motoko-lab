import Quota "../backend/src/Quota";

// `Quota` takes `now` as an argument, so a year of traffic costs a millisecond
// here and no test has to sleep.
let HOUR : Nat = 3_600_000_000_000;
let policy : Quota.Policy = { windowNanos = HOUR; unitsPerWindow = 100 };

// A fresh principal starts with the whole budget.
assert Quota.remaining(null, 0, policy) == 100;

// Spending accumulates inside a window.
let first = switch (Quota.charge(null, 0, policy, 30)) {
  case (#ok u) u;
  case (#err _) { assert false; { windowStart = 0; used = 0 } };
};
assert first.used == 30;
assert Quota.remaining(?first, 0, policy) == 70;

let second = switch (Quota.charge(?first, 10, policy, 70)) {
  case (#ok u) u;
  case (#err _) { assert false; { windowStart = 0; used = 0 } };
};
assert second.used == 100;
assert Quota.remaining(?second, 10, policy) == 0;

// Over budget is refused, not clamped: the record is unchanged and the caller
// is told the limit, what it had spent and when the window rolls over. A
// clamped request would look like a small successful one and the caller could
// not tell the difference.
switch (Quota.charge(?second, 20, policy, 1)) {
  case (#ok _) assert false;
  case (#err e) {
    assert e.limit == 100;
    assert e.used == 100;
    assert e.requested == 1;
    assert e.resetInNanos == HOUR - 20;
  };
};

// A single request larger than the whole window budget is refused outright
// rather than partially served.
switch (Quota.charge(null, 0, policy, 101)) {
  case (#ok _) assert false;
  case (#err e) { assert e.used == 0; assert e.requested == 101 };
};

// The window tumbles: at the boundary the budget is whole again.
assert Quota.remaining(?second, HOUR - 1, policy) == 0;
assert Quota.remaining(?second, HOUR, policy) == 100;
let rolled = Quota.current(?second, HOUR + 5, policy);
assert rolled.used == 0;
assert rolled.windowStart == HOUR + 5;

// Documented consequence of a tumbling window: the window is anchored at the
// caller's first charge, so a caller that saves its budget for the last instant
// of one window and spends the next window's budget immediately afterwards gets
// two budgets one nanosecond apart. That factor of two is the price of O(1)
// state per principal, and it is bounded — a third budget needs a third window.
func ok(decision : Quota.Decision) : Quota.Usage {
  switch decision {
    case (#ok u) u;
    case (#err _) { assert false; { windowStart = 0; used = 0 } };
  };
};
let opened = ok(Quota.charge(null, 0, policy, 1)); // anchors the window at 0
let saved = ok(Quota.charge(?opened, HOUR - 1, policy, 99)); // 100 spent by now
assert saved.used == 100;
let burst = ok(Quota.charge(?saved, HOUR, policy, 100)); // 1ns later, budget again
assert burst.used == 100;
assert burst.windowStart == HOUR;

// Reset time never goes negative, including for a window that has already ended.
assert Quota.resetIn({ windowStart = 0; used = 0 }, HOUR * 3, policy) == 0;

// A zero-length window degenerates to no limit at all rather than to a trap.
let open : Quota.Policy = { windowNanos = 0; unitsPerWindow = 1 };
switch (Quota.charge(?{ windowStart = 0; used = 1 }, 0, open, 1)) {
  case (#ok u) assert u.used == 1;
  case (#err _) assert false;
};

// ------------------------------------------------------------------ cost --

// The unit is one model pass. A local strategy costs one per token; a sharded
// one adds the fan-out, which is what makes `benchmark` expensive enough to be
// worth rate limiting in the first place.
assert Quota.estimate(24, 0) == 24;
assert Quota.estimate(24, 4) == 120;
assert Quota.estimate(24, 4 * 3) == 312; // three-way replication
assert Quota.estimate(0, 4) == 0;

// The default policy has to leave room for a real `benchmark` — eight
// strategies over 24 tokens with four workers — or the reference app refuses
// its own README command.
let benchmarkCost = Quota.estimate(24, 0) * 3 + Quota.estimate(24, 4) * 5;
assert benchmarkCost < Quota.DEFAULT.unitsPerWindow;
assert Quota.DEFAULT.unitsPerWindow / benchmarkCost >= 20;
