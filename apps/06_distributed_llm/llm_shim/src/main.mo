/// Local stand-in for the Internet Computer LLM canister.
///
/// It serves the same `v1_chat` interface as `w36hm-eqaaa-aaaal-qr76a-cai`, so
/// code written against `mo:llm` (or against `LlmClient.mo` in this app) runs
/// unchanged against it. What it does *not* do is run Llama: it answers from the
/// on-chain n-gram model in `Lm.mo`.
///
/// Why this exists. The documented local workflow for the real LLM canister is
/// `dfx deps pull` plus either a local Ollama serving `llama3.1:8b` (a ~4 GiB
/// download and a process outside the replica) or an Intelligence Gateway API
/// key. Both are reasonable on a workstation and both are unavailable in a
/// sandbox, in CI, and on any machine without the model cached. This shim keeps
/// the *shape* of the integration testable everywhere; swap the target back to
/// the pulled `llm` canister for a real model.
///
/// It is deliberately obvious that this is not a real LLM: the response is
/// prefixed so no test can mistake shim output for model output.
import Array "mo:core/Array";
import Corpus "../../backend/src/Corpus";
import Lm "../../backend/src/Lm";
import Types "../../backend/src/Types";
import LlmClient "../../backend/src/LlmClient";
import Tokenizer "../../backend/src/Tokenizer";

persistent actor LlmShim {

  /// The shim never fails in a way the caller can act on - it answers from an
  /// in-canister model - but the kit's reference apps all name these types, and
  /// a future backend that can fail should not have to change its signature.
  public type Error = Types.Error;
  public type Result<T> = Types.Result<T>;

  transient let model = Lm.train(Corpus.text);

  var calls : Nat = 0;
  var maxTokens : Nat = 32;

  /// Marker prepended to every answer so shim output can never be mistaken for
  /// a real model response in a log or a test fixture.
  transient let MARKER = "[shim] ";

  func lastUserMessage(messages : [LlmClient.ChatMessage]) : Text {
    var found = "";
    for (m in messages.vals()) {
      switch m {
        case (#user u) found := u.content;
        case (#system_ _) {};
        case (#assistant _) {};
        case (#tool _) {};
      };
    };
    found;
  };

  func systemPreamble(messages : [LlmClient.ChatMessage]) : [Nat] {
    var ids : [Nat] = [];
    for (m in messages.vals()) {
      switch m {
        case (#system_ s) ids := Array.concat(ids, Tokenizer.encode(model.vocab, s.content));
        case _ {};
      };
    };
    ids;
  };

  public func v1_chat(request : LlmClient.Request) : async LlmClient.Response {
    calls += 1;
    let prompt = Array.concat(
      systemPreamble(request.messages),
      Tokenizer.encode(model.vocab, lastUserMessage(request.messages)),
    );
    let generated = Lm.generate(model, Lm.TARGET, prompt, maxTokens);
    {
      message = {
        content = ?(MARKER # Tokenizer.decode(model.vocab, generated));
        tool_calls = [];
      };
    };
  };

  public func setMaxTokens(n : Nat) : async Nat {
    maxTokens := if (n == 0) 1 else if (n > 256) 256 else n;
    maxTokens;
  };

  public query func stats() : async { calls : Nat; maxTokens : Nat; vocabSize : Nat } {
    { calls; maxTokens; vocabSize = model.vocabSize };
  };
};
