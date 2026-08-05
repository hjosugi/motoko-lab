/// Decoding strategies, all producing byte-identical output.
///
/// Three decoders share one verification rule:
///
///   * `baseline`  – plain autoregressive greedy decoding with the target head.
///   * `arDraft`   – classic speculative decoding. A cheap head drafts `block`
///                   tokens left to right, the target head verifies the whole
///                   block at once.
///   * `maskedDraft` – diffusion-style drafting. The same cheap head fills the
///                   `block` positions *in parallel* over a few confidence
///                   ordered unmasking steps, then the same exact verifier runs.
///
/// The verification rule is the standard greedy one: let `t_i` be the target's
/// greedy token given the prompt plus `draft[0 .. i-1]`. Accept the draft up to
/// the first `i` where `draft[i] != t_i`, then emit `t_i`. Everything after the
/// mismatch is discarded. The emitted sequence is therefore *by construction*
/// the target's own greedy continuation, whatever the draft did. `verify` in
/// `Metrics` records that this held for the whole run.
///
/// What differs between `arDraft` and `maskedDraft` is not the output but the
/// number of **sequential** model passes, which on a distributed deployment is
/// the number of network round trips:
///
///   * `arDraft`     needs `block` sequential draft passes per block.
///   * `maskedDraft` needs `steps` sequential draft passes per block, with
///                   `steps < block`, at the price of more total arithmetic.
import Array "mo:core/Array";
import Nat "mo:core/Nat";
import Order "mo:core/Order";
import Lm "Lm";

module {

  public type TokenId = Lm.TokenId;

  public type Metrics = {
    /// Tokens emitted (excluding the prompt).
    tokens : Nat;
    /// Sequential target passes. On a cluster this is one network round trip
    /// each, and it is the number that actually sets latency.
    targetRounds : Nat;
    /// Target score-vector evaluations. Parallel work inside a round.
    targetEvals : Nat;
    /// Sequential draft passes.
    draftRounds : Nat;
    /// Draft score-vector evaluations.
    draftEvals : Nat;
    /// Draft tokens offered to the verifier.
    proposed : Nat;
    /// Draft tokens the verifier kept.
    accepted : Nat;
  };

  public type Run = {
    tokens : [TokenId];
    metrics : Metrics;
  };

  let zero : Metrics = {
    tokens = 0;
    targetRounds = 0;
    targetEvals = 0;
    draftRounds = 0;
    draftEvals = 0;
    proposed = 0;
    accepted = 0;
  };

  /// Acceptance rate in percent. Reported rather than a bare speedup, because a
  /// speedup without an acceptance rate cannot be reproduced.
  public func acceptanceRatePercent(m : Metrics) : Nat {
    if (m.proposed == 0) return 0;
    m.accepted * 100 / m.proposed;
  };

  /// Sequential passes saved against the baseline, in percent.
  public func roundReductionPercent(baselineRounds : Nat, m : Metrics) : Nat {
    let rounds = m.targetRounds + m.draftRounds;
    if (baselineRounds == 0 or rounds >= baselineRounds) return 0;
    (baselineRounds - rounds) * 100 / baselineRounds;
  };

  /// Plain autoregressive greedy decoding with the target head.
  public func baseline(model : Lm.Model, prompt : [TokenId], maxTokens : Nat) : Run {
    var history = prompt;
    var out : [TokenId] = [];
    var rounds = 0;
    var produced = 0;
    label decode while (produced < maxTokens) {
      let t = Lm.next(model, Lm.TARGET, history);
      rounds += 1;
      history := Array.concat(history, [t]);
      out := Array.concat(out, [t]);
      produced += 1;
      if (t == model.stop) break decode;
    };
    {
      tokens = out;
      metrics = {
        zero with
        tokens = out.size();
        targetRounds = rounds;
        targetEvals = rounds;
      };
    };
  };

  /// Verifies a draft block against the target head and returns the tokens the
  /// target itself would have produced.
  ///
  /// Every `t_i` depends only on the prompt and on already-fixed draft tokens,
  /// so all `block + 1` evaluations are independent and belong to a single
  /// batched pass — one round trip, not `block + 1` of them.
  func verifyBlock(
    model : Lm.Model,
    history : [TokenId],
    draft : [TokenId],
  ) : { emitted : [TokenId]; accepted : Nat; evals : Nat } {
    var context = history;
    var emitted : [TokenId] = [];
    var accepted = 0;
    var evals = 0;
    var i = 0;
    while (i < draft.size()) {
      let t = Lm.next(model, Lm.TARGET, context);
      evals += 1;
      if (t == draft[i]) {
        emitted := Array.concat(emitted, [t]);
        context := Array.concat(context, [t]);
        accepted += 1;
        i += 1;
      } else {
        // Mismatch: keep the target's token, drop the rest of the draft.
        return { emitted = Array.concat(emitted, [t]); accepted; evals };
      };
    };
    // Whole block survived, so the target also contributes a free bonus token.
    let bonus = Lm.next(model, Lm.TARGET, context);
    { emitted = Array.concat(emitted, [bonus]); accepted; evals = evals + 1 };
  };

  func truncateAtStop(model : Lm.Model, tokens : [TokenId], budget : Nat) : [TokenId] {
    var out : [TokenId] = [];
    var i = 0;
    while (i < tokens.size() and out.size() < budget) {
      out := Array.concat(out, [tokens[i]]);
      if (tokens[i] == model.stop) return out;
      i += 1;
    };
    out;
  };

  func hitStop(model : Lm.Model, tokens : [TokenId]) : Bool {
    for (t in tokens.vals()) { if (t == model.stop) return true };
    false;
  };

  /// Classic speculative decoding: sequential cheap draft, batched exact verify.
  public func arDraft(model : Lm.Model, prompt : [TokenId], maxTokens : Nat, block : Nat) : Run {
    let blockSize = if (block == 0) 1 else block;
    var history = prompt;
    var out : [TokenId] = [];
    var m = zero;

    label decode while (out.size() < maxTokens) {
      // Draft phase: `blockSize` sequential passes of the cheap head.
      var draft : [TokenId] = [];
      var context = history;
      var i = 0;
      while (i < blockSize) {
        let d = Lm.next(model, Lm.DRAFT, context);
        draft := Array.concat(draft, [d]);
        context := Array.concat(context, [d]);
        i += 1;
      };
      m := {
        m with
        draftRounds = m.draftRounds + blockSize;
        draftEvals = m.draftEvals + blockSize;
        proposed = m.proposed + blockSize;
      };

      // Verify phase: one batched target pass.
      let v = verifyBlock(model, history, draft);
      let kept = truncateAtStop(model, v.emitted, maxTokens - out.size());
      m := {
        m with
        targetRounds = m.targetRounds + 1;
        targetEvals = m.targetEvals + v.evals;
        accepted = m.accepted + v.accepted;
      };
      out := Array.concat(out, kept);
      history := Array.concat(history, kept);
      if (hitStop(model, kept)) break decode;
    };

    { tokens = out; metrics = { m with tokens = out.size() } };
  };

  type Slot = {
    var token : ?TokenId;
  };

  /// Left context of draft slot `i`, treating still-masked slots as unknown.
  /// A masked neighbour becomes `null`, and `Lm` backs off to a shorter n-gram
  /// rather than failing — this is what lets positions be filled out of order.
  func slotCtx(history : [TokenId], slots : [Slot], i : Nat) : Lm.Ctx {
    func at(offset : Nat) : ?TokenId {
      // `offset` counts back from slot `i`: 1 = immediate left neighbour.
      if (i >= offset) {
        slots[i - offset].token;
      } else {
        let back = offset - i;
        if (history.size() >= back) ?history[history.size() - back] else null;
      };
    };
    { prev2 = at(2); prev1 = at(1) };
  };

  /// Diffusion-style parallel drafting.
  ///
  /// All masked slots are scored from the *current* partial sequence in one
  /// sequential pass; the most confident `ceil(remaining / stepsLeft)` of them
  /// are unmasked; repeat. `steps` passes fill `block` positions, so the draft
  /// stage costs `steps` round trips instead of `block`.
  func maskedDraftBlock(
    model : Lm.Model,
    history : [TokenId],
    block : Nat,
    steps : Nat,
  ) : { draft : [TokenId]; rounds : Nat; evals : Nat } {
    let slots = Array.tabulate<Slot>(block, func(_ : Nat) : Slot { { var token = null : ?TokenId } });
    var remaining = block;
    var rounds = 0;
    var evals = 0;
    var stepsLeft = if (steps == 0) 1 else steps;

    while (remaining > 0) {
      // Score every masked slot. Independent of each other, so one round.
      var proposals : [(Nat, TokenId, Nat)] = []; // (slot, token, confidence)
      var i = 0;
      while (i < block) {
        if (slots[i].token == null) {
          let scores = Lm.scoreVector(model, Lm.DRAFT, slotCtx(history, slots, i));
          let (token, _) = Lm.argmax(scores);
          proposals := Array.concat(proposals, [(i, token, Lm.confidence(scores))]);
          evals += 1;
        };
        i += 1;
      };
      rounds += 1;

      // Highest confidence first; slot index breaks ties so the schedule is
      // reproducible on every replica.
      let ordered = Array.sort<(Nat, TokenId, Nat)>(
        proposals,
        func(a : (Nat, TokenId, Nat), b : (Nat, TokenId, Nat)) : Order.Order {
          switch (Nat.compare(b.2, a.2)) {
            case (#equal) Nat.compare(a.0, b.0);
            case (other) other;
          };
        },
      );

      let unmaskCount = if (stepsLeft <= 1) {
        remaining;
      } else {
        // ceil(remaining / stepsLeft), written without Nat subtraction.
        let whole = remaining / stepsLeft;
        Nat.max(1, if (remaining % stepsLeft == 0) whole else whole + 1);
      };
      var k = 0;
      while (k < unmaskCount and k < ordered.size()) {
        let (slot, token, _) = ordered[k];
        slots[slot].token := ?token;
        remaining -= 1;
        k += 1;
      };
      if (stepsLeft > 1) stepsLeft -= 1;
    };

    {
      draft = Array.tabulate<TokenId>(
        block,
        func(i : Nat) : TokenId { switch (slots[i].token) { case (?t) t; case null 0 } },
      );
      rounds;
      evals;
    };
  };

  /// Diffusion draft plus exact autoregressive verification.
  public func maskedDraft(
    model : Lm.Model,
    prompt : [TokenId],
    maxTokens : Nat,
    block : Nat,
    steps : Nat,
  ) : Run {
    let blockSize = if (block == 0) 1 else block;
    let stepCount = if (steps == 0 or steps > blockSize) blockSize else steps;
    var history = prompt;
    var out : [TokenId] = [];
    var m = zero;

    label decode while (out.size() < maxTokens) {
      let d = maskedDraftBlock(model, history, blockSize, stepCount);
      m := {
        m with
        draftRounds = m.draftRounds + d.rounds;
        draftEvals = m.draftEvals + d.evals;
        proposed = m.proposed + blockSize;
      };

      let v = verifyBlock(model, history, d.draft);
      let kept = truncateAtStop(model, v.emitted, maxTokens - out.size());
      m := {
        m with
        targetRounds = m.targetRounds + 1;
        targetEvals = m.targetEvals + v.evals;
        accepted = m.accepted + v.accepted;
      };
      out := Array.concat(out, kept);
      history := Array.concat(history, kept);
      if (hitStop(model, kept)) break decode;
    };

    { tokens = out; metrics = { m with tokens = out.size() } };
  };

  /// True when two decoders produced exactly the same tokens. Losslessness is a
  /// claim that has to be checked, not asserted.
  public func identical(a : [TokenId], b : [TokenId]) : Bool {
    if (a.size() != b.size()) return false;
    var i = 0;
    while (i < a.size()) {
      if (a[i] != b[i]) return false;
      i += 1;
    };
    true;
  };
};
