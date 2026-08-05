/// Input bounds for the orchestrator.
///
/// A canister pays cycles for every instruction it executes and traps if it
/// exceeds the per-message instruction limit, so an unbounded `maxTokens` or an
/// unbounded prompt is a denial-of-service vector, not a usability nicety.
module {

  public let MAX_PROMPT_CHARS : Nat = 2_000;
  public let MAX_TOKENS : Nat = 128;
  public let MAX_BLOCK : Nat = 16;
  public let MAX_WORKERS : Nat = 16;

  public func promptOk(prompt : Text) : Bool {
    prompt.size() > 0 and prompt.size() <= MAX_PROMPT_CHARS;
  };

  /// Clamps rather than rejects: a caller asking for more tokens than the
  /// instruction budget allows should get a short answer, not an error.
  public func tokenBudget(requested : Nat) : Nat {
    if (requested == 0) 1 else if (requested > MAX_TOKENS) MAX_TOKENS else requested;
  };

  public func blockSize(requested : Nat) : Nat {
    if (requested == 0) 4 else if (requested > MAX_BLOCK) MAX_BLOCK else requested;
  };

  public func unmaskSteps(requested : Nat, block : Nat) : Nat {
    if (requested == 0) 2 else if (requested > block) block else requested;
  };

  public func quantBits(requested : Nat) : Nat {
    if (requested < 2) 2 else if (requested > 32) 32 else requested;
  };

  public func workerCountOk(n : Nat) : Bool {
    n > 0 and n <= MAX_WORKERS;
  };
};
