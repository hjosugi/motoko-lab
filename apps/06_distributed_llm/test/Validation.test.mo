import LlmClient "../backend/src/LlmClient";
import Validation "../backend/src/Validation";

assert Validation.promptOk("a canister is");
assert not Validation.promptOk("");

// Budgets clamp rather than reject: an over-large request gets a short answer,
// not an error, because the real limit is the per-message instruction budget.
assert Validation.tokenBudget(0) == 1;
assert Validation.tokenBudget(7) == 7;
assert Validation.tokenBudget(10_000) == Validation.MAX_TOKENS;

assert Validation.blockSize(0) == 4;
assert Validation.blockSize(3) == 3;
assert Validation.blockSize(99) == Validation.MAX_BLOCK;

// Unmasking steps can never exceed the block: more steps than slots would mean
// a round that unmasks nothing.
assert Validation.unmaskSteps(0, 4) == 2;
assert Validation.unmaskSteps(9, 4) == 4;
assert Validation.unmaskSteps(2, 4) == 2;

assert Validation.quantBits(0) == 2;
assert Validation.quantBits(8) == 8;
assert Validation.quantBits(64) == 32;

assert not Validation.workerCountOk(0);
assert Validation.workerCountOk(1);
assert Validation.workerCountOk(Validation.MAX_WORKERS);
assert not Validation.workerCountOk(Validation.MAX_WORKERS + 1);

// Cycle policy of the LLM canister: free models must not have cycles attached,
// paid ones must, and getting this backwards traps the calling canister.
assert LlmClient.isFreeModel("llama3.1:8b");
assert LlmClient.isFreeModel("qwen3:32b");
assert not LlmClient.isFreeModel("gemma3:27b");
assert not LlmClient.isFreeModel("");

// Explicit override wins over the environment and over the mainnet default.
assert LlmClient.MAINNET == "w36hm-eqaaa-aaaal-qr76a-cai";
